"use strict";

/**
 * Turns pasted merit badge requirement text into a badge definition object.
 *
 *   parseRequirements(text, { badge: "Personal Fitness" }) -> badge def
 *
 * The output is a DRAFT. It gets the structure and the official wording right,
 * and it guesses at what capture area belongs under each item. Review the JSON
 * and adjust the blocks before you hand the workbook to a Scout. That review
 * step is the point of having JSON in the middle rather than going straight
 * from text to .docx.
 *
 * Accepted input shapes (mix and match, most sources use one consistently):
 *
 *   1. Requirement text            1) Requirement text        1 Requirement text
 *      (a) Sub text                a. Sub text                a) Sub text
 *          (1) Nested text             1. Nested text
 *
 * Lines introducing linked resources are dropped. See RESOURCE_LINE.
 */

/** "Resource:" / "Resources:" and the continuation lines that follow them. */
const RESOURCE_LINE = /^\s*Resources?\s*:/i;
const RESOURCE_CONT = /\((?:video|pdf|website|playlist|audio|app|game|fillable|worksheet|image|chart)\)\s*$/i;

const TOP_LEVEL = /^(\d{1,2})\s*[.)]?\s+(\S.*)$/;
const LETTERED = /^\(?([a-z])\s*[.)]\s+(\S.*)$/;
const NESTED_NUM = /^\(?(\d{1,2})\s*[.)]\s+(\S.*)$/;

/** Indent (in spaces) at or below which a line is considered top level. */
const TOP_INDENT = 3;

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};

function leadingSpaces(line) {
  const m = line.match(/^[ \t]*/)[0];
  return m.replace(/\t/g, "    ").length;
}

/** Drop resource pointers, keep everything else. */
function stripResources(lines) {
  const out = [];
  let inResourceBlock = false;
  for (const line of lines) {
    if (RESOURCE_LINE.test(line)) {
      inResourceBlock = true;
      continue;
    }
    if (inResourceBlock) {
      // Continuation lines list more resources; they end with a media marker.
      if (line.trim() === "" || RESOURCE_CONT.test(line)) {
        if (line.trim() === "") inResourceBlock = false;
        continue;
      }
      inResourceBlock = false;
    }
    out.push(line);
  }
  return out;
}

/**
 * Decide what capture area, if any, belongs under an item.
 * Deliberately conservative: a lined box unless there is a clear signal.
 */
function inferBlocks(text, hasChildren) {
  // A stem that introduces sub-items gets no capture area of its own.
  if (hasChildren) return undefined;

  const t = text.toLowerCase();

  // Pure discussion with the counselor and nothing to record.
  if (/^discuss (with|your counselor)/.test(t) && t.length < 120) {
    return [{ type: "lines", rows: 3 }];
  }

  // "identify at least two ...", "explore three ...", "list four ..."
  const listed = t.match(/\b(?:identify|explore|list|name|find out about|research)\b[^.]*?\b(one|two|three|four|five|six|seven|eight|\d+)\b/);
  if (listed) {
    const n = WORD_NUMBERS[listed[1]] || parseInt(listed[1], 10);
    if (n >= 2 && n <= 8) return [{ type: "numbered", count: n }];
  }

  // Multi-day food or activity logs.
  if (/\blog of what you eat and drink\b/.test(t) || /\bkeep track of what you eat\b/.test(t)) {
    const days = t.match(/\b(three|four|five|seven|\d+)\s+days?\b/);
    const n = days ? (WORD_NUMBERS[days[1]] || parseInt(days[1], 10)) : 3;
    const cols = Math.min(Math.max(n, 2), 7);
    return [{
      type: "grid",
      headers: Array.from({ length: cols }, (_, i) => `Day ${i + 1}`),
      widths: Array.from({ length: cols }, () => 1),
      rows: 10,
    }];
  }

  // Everything else: a lined box sized to the length of the ask.
  const rows = text.length < 110 ? 4 : text.length < 240 ? 5 : 6;
  return [{ type: "lines", rows }];
}

/** Build the nested item tree from cleaned lines. */
function buildTree(lines, warnings) {
  const requirements = [];
  let req = null;
  let sub = null;
  let nested = null;

  const attach = (text) => {
    // Continuation of whatever item we are currently inside.
    const target = nested || sub || req;
    if (!target) return false;
    target.text = `${target.text} ${text}`.replace(/\s+/g, " ").trim();
    return true;
  };

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") return;

    const indent = leadingSpaces(line);
    const body = line.trim();

    const top = body.match(TOP_LEVEL);
    const lettered = body.match(LETTERED);
    const nestedNum = body.match(NESTED_NUM);

    // Top level: a number at little or no indentation.
    if (top && indent <= TOP_INDENT) {
      const num = parseInt(top[1], 10);
      const expected = requirements.length + 1;
      if (num !== expected) {
        warnings.push(`Requirement numbering jumps: saw ${num} where ${expected} was expected (input line ${i + 1}).`);
      }
      req = { num, text: top[2].trim(), subs: [] };
      requirements.push(req);
      sub = null;
      nested = null;
      return;
    }

    if (!req) {
      warnings.push(`Ignored text before the first numbered requirement: "${body.slice(0, 60)}"`);
      return;
    }

    // Lettered sub-requirement.
    if (lettered) {
      sub = { letter: lettered[1], text: lettered[2].trim() };
      req.subs.push(sub);
      nested = null;
      return;
    }

    // Numbered item nested under a lettered sub.
    if (nestedNum && sub && indent > TOP_INDENT) {
      sub.subs = sub.subs || [];
      nested = { letter: nestedNum[1], text: nestedNum[2].trim() };
      sub.subs.push(nested);
      return;
    }

    // Anything else continues the current item.
    if (!attach(body)) {
      warnings.push(`Could not place line: "${body.slice(0, 60)}"`);
    }
  });

  return requirements;
}

/** Walk the tree and attach inferred capture blocks. */
function applyBlocks(requirements) {
  requirements.forEach((req) => {
    const hasSubs = req.subs && req.subs.length > 0;
    if (!hasSubs) {
      req.after = inferBlocks(req.text, false);
      delete req.subs;
      return;
    }
    req.subs.forEach((sub) => {
      const hasNested = sub.subs && sub.subs.length > 0;
      if (hasNested) {
        sub.subs.forEach((n) => {
          n.blocks = inferBlocks(n.text, false);
        });
      } else {
        sub.blocks = inferBlocks(sub.text, false);
      }
    });
  });
  return requirements;
}

/**
 * @param {string} text  Pasted requirement text.
 * @param {object} meta  { badge, requirementsRevised, workbookUpdated, font, ... }
 * @returns {{ def: object, warnings: string[] }}
 */
function parseRequirements(text, meta = {}) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("No requirement text supplied.");
  }

  const warnings = [];
  const lines = stripResources(text.replace(/\r\n?/g, "\n").split("\n"));
  const requirements = applyBlocks(buildTree(lines, warnings));

  if (requirements.length === 0) {
    throw new Error("No numbered requirements found. Each requirement should start with a number at the left margin, e.g. \"1. Do the following:\"");
  }

  const def = {
    badge: meta.badge || "Untitled Merit Badge",
    requirements,
  };
  if (meta.requirementsRevised) def.requirementsRevised = meta.requirementsRevised;
  if (meta.workbookUpdated) def.workbookUpdated = meta.workbookUpdated;
  if (meta.font) def.font = meta.font;
  if (meta.creditLine) def.creditLine = meta.creditLine;
  if (meta.rightsLine) def.rightsLine = meta.rightsLine;
  if (meta.appendices) def.appendices = meta.appendices;

  // Long badges read better with each requirement starting fresh.
  if (meta.pageBreakPerRequirement) {
    def.requirements.forEach((r, i) => { if (i > 0) r.pageBreakBefore = true; });
  }

  return { def, warnings };
}

/** "Personal Fitness" -> "personal-fitness" */
function slugify(name) {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = { parseRequirements, slugify, stripResources, inferBlocks };
