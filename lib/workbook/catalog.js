"use strict";

/**
 * Turns an official merit badge requirements catalog entry into a badge
 * definition, so a workbook can be seeded without pasting text.
 *
 *   defFromCatalogEntry(catalog.badges.cooking) -> { def, warnings }
 *
 * The catalog is the scrape of scouting.org produced by the sibling
 * MeritBadgeWorkbook project (mbworkbook/data/requirements.json): one entry per
 * badge, each with a nested requirements tree of { marker, level, text, notes,
 * children }. That tree already carries the official wording, so this module
 * only translates structure and re-uses the same capture-area guessing the
 * paste path uses.
 *
 * Same contract as parseRequirements(): the output is a DRAFT. Review the JSON
 * before a Scout sees the workbook. Anything that cannot be translated cleanly
 * ends up in `warnings` rather than being silently dropped.
 *
 * No TroopWebHost data is involved - a catalog entry is published requirement
 * text, identical for every troop, with no Scout attached to it.
 */

const { inferBlocks } = require("./parse");

// ── Note classification ────────────────────────────────────────────────
// The catalog's `notes` arrays are a mixed bag, and the kinds need very
// different treatment, so classification happens up front.

// "Resource:" / "Resources:" lines and the bare continuation lines that follow
// them, which end in a media marker. Same idea as parse.js's RESOURCE_LINE /
// RESOURCE_CONT, widened for every marker spelling the catalog actually uses
// ("(website w/ video)", "( video)", "(PPT)", "(picture)" and friends).
const RESOURCE_PREFIX = /^\s*(?:Resources?|Suggested (?:Books?|Reading))\s*:/i;
const RESOURCE_MARKER = new RegExp(
  "\\(\\s*(?:video|photo|picture|image|pdf|ppt|web\\s?site|webpage|website|playlist|audio|podcast|app|game" +
  "|fillable|worksheet|chart|diagram|infographic|link|document)s?" +
  "(?:\\s*(?:w\\/|with|and|\\/|,)\\s*[a-z ]+)?\\s*\\)\\s*$",
  "i"
);

// "Note: ..." is official requirement text the page sets apart. It belongs with
// the requirement it qualifies, which is what a reviewed definition does by
// hand (see badges/cooking.json requirement 4).
const OFFICIAL_NOTE = /^\s*Note\b\s*[:\-—]?\s*/i;

// "Option A-Beef Cattle. Do ALL of the following:" introduces the *next* run of
// siblings, but the catalog attaches it as a trailing note on the last item of
// the previous group. Kept as a caption so the option boundary stays visible.
const GROUP_HEADING = /^\s*(?:Option\b|Choose\b|Complete\b)|Do ALL of the following:?\s*$/i;

// A handful of catalog entries lost a whole requirement to the scrape: the item
// arrives as a note that still looks like numbered requirement text ("6 Plan
// the Program. Outline with your counselor...") or a stray sub-marker
// ("(5)(b) Cotton"). Never drop these - they are content, and the badge needs a
// human before it is handed to a Scout.
const ORPHAN_REQUIREMENT = /^\s*(?:\d{1,2}\s+[A-Z(]|\(\d{1,2}\)\s*\(?[a-z0-9]\)?\s+\S)/;

function classifyNote(note) {
  const t = String(note || "").trim();
  if (!t) return { kind: "empty" };
  if (RESOURCE_PREFIX.test(t) || RESOURCE_MARKER.test(t)) return { kind: "resource" };
  if (OFFICIAL_NOTE.test(t)) return { kind: "official", text: t };
  if (ORPHAN_REQUIREMENT.test(t)) return { kind: "orphan", text: t };
  if (GROUP_HEADING.test(t)) return { kind: "heading", text: t };
  return { kind: "guidance", text: t };
}

// ── Helpers ────────────────────────────────────────────────────────────

/** "(a)" -> "a", "(1)" -> "1", "3." -> "3" */
function marker(raw) {
  return String(raw || "").replace(/[()\[\].\s]/g, "").trim();
}

// The same resource links sometimes arrive glued onto the end of the
// requirement text itself ("...Share your scrapbook with your counselor.
// Resources: How To Start a Bug Collection (video) ..."), where no note filter
// can reach them. Ten requirements across eight badges in the shipped catalog
// are like this.
const RESOURCE_TAIL = /\s*\bResources?\s*:[\s\S]*$/i;
const MEDIA_ANYWHERE = new RegExp(
  "\\(\\s*(?:video|photo|picture|image|pdf|ppt|web\\s?site|webpage|website|playlist|audio" +
  "|podcast|app|game|fillable|worksheet|chart|diagram|infographic|link|document)s?" +
  "(?:\\s*(?:w\\/|with|and|\\/|,)\\s*[a-z ]+)?\\s*\\)",
  "i"
);

/**
 * Cut a run of resource links off the end of requirement text. Conservative on
 * purpose: only when the tail actually contains a media marker, so a
 * requirement that legitimately says "Resources:" keeps every word.
 */
function stripResourceTail(text) {
  const m = RESOURCE_TAIL.exec(String(text || ""));
  if (!m || !MEDIA_ANYWHERE.test(m[0])) return text;
  return String(text).slice(0, m.index).trimEnd();
}

function tidy(text) {
  return stripResourceTail(String(text || "").replace(/\s+/g, " ")).trim();
}

/**
 * Apply an item's notes. Official notes extend its text; headings and rescued
 * requirement text become trailing blocks; resources are dropped.
 * @returns {{ text: string, trailing: object[] }}
 */
function applyNotes(item, ctx, where) {
  let text = tidy(item.text);
  const trailing = [];

  (item.notes || []).forEach((n) => {
    const c = classifyNote(n);
    if (c.kind === "resource" || c.kind === "empty") return;

    if (c.kind === "official") {
      text = `${text} ${tidy(c.text)}`.trim();
      return;
    }
    if (c.kind === "heading") {
      // A caption, not official text of the item it hangs off - it introduces
      // whatever comes next.
      trailing.push({ type: "label", text: tidy(c.text), bold: true, wide: true });
      ctx.warnings.push(`${where}: "${tidy(c.text).slice(0, 60)}" kept as a caption - check it sits above the right group.`);
      return;
    }
    if (c.kind === "orphan") {
      trailing.push({ type: "label", text: tidy(c.text), bold: true, wide: true });
      trailing.push({ type: "lines", rows: 5, wide: true });
      ctx.needsReview = true;
      ctx.warnings.push(
        `${where}: the catalog lost requirement text into a note - "${tidy(c.text).slice(0, 70)}". ` +
        `Rescued as a caption with a lined area, but it should be promoted to a real requirement by hand.`
      );
      return;
    }
    trailing.push({ type: "note", text: tidy(c.text), wide: true });
    ctx.warnings.push(`${where}: kept unclassified note as guidance - "${tidy(c.text).slice(0, 60)}".`);
  });

  return { text, trailing };
}

/** Flag repeated or restarted markers within one list of siblings. */
function checkSiblings(items, ctx, where) {
  const seen = new Set();
  items.forEach((it) => {
    const m = marker(it.marker);
    if (!m) {
      ctx.warnings.push(`${where}: an item has no marker - numbered by position.`);
      return;
    }
    if (seen.has(m)) {
      ctx.needsReview = true;
      ctx.warnings.push(
        `${where}: marker "${m}" appears more than once - the source restarts numbering here ` +
        `(usually an Option A/B/C badge). Worth splitting by hand.`
      );
    }
    seen.add(m);
  });
}

// ── Conversion ─────────────────────────────────────────────────────────

function convertLeaf(item, ctx, where) {
  const { text, trailing } = applyNotes(item, ctx, where);
  const blocks = inferBlocks(text, false) || [];
  return { text, blocks: [...blocks, ...trailing] };
}

function convertSub(item, index, ctx, parentPath) {
  const letter = marker(item.marker) || String(index + 1);
  const where = `${parentPath}${letter}`;
  const kids = item.children || [];

  if (!kids.length) {
    const leaf = convertLeaf(item, ctx, where);
    return { letter, text: leaf.text, blocks: leaf.blocks };
  }

  const { text, trailing } = applyNotes(item, ctx, where);
  checkSiblings(kids, ctx, where);
  const nested = kids.map((k, i) => {
    const nLetter = marker(k.marker) || String(i + 1);
    const leaf = convertLeaf(k, ctx, `${where}${nLetter}`);
    return { letter: nLetter, text: leaf.text, blocks: leaf.blocks };
  });

  // A stem carries no capture area of its own and the schema gives it nowhere
  // to hold one, so a caption it picked up rides on its first child instead.
  // Position is off by one item; the warning says so.
  if (trailing.length && nested.length) {
    nested[0].blocks = [...trailing, ...(nested[0].blocks || [])];
    ctx.warnings.push(`${where}: a caption on this stem was moved onto ${where}${nested[0].letter} - check its placement.`);
  }

  return { letter, text, subs: nested };
}

function convertRequirement(item, index, ctx) {
  const parsed = parseInt(marker(item.marker), 10);
  const num = Number.isFinite(parsed) ? parsed : index + 1;
  const where = `req ${num}`;
  const kids = item.children || [];

  if (!kids.length) {
    const leaf = convertLeaf(item, ctx, where);
    return { num, text: leaf.text, after: leaf.blocks };
  }

  const { text, trailing } = applyNotes(item, ctx, where);
  checkSiblings(kids, ctx, where);
  const req = {
    num,
    text,
    subs: kids.map((k, i) => convertSub(k, i, ctx, `${num}`)),
  };
  // "before" is the documented slot for anything that belongs above the
  // sub-list, which is exactly where a stem's caption goes.
  if (trailing.length) req.before = trailing;
  return req;
}

/**
 * @param {object} entry  One catalog badge entry.
 * @param {object} meta   { requirementsRevised, workbookUpdated, font, creditLine,
 *                          rightsLine, pageBreakPerRequirement, provenance }
 * @returns {{ def: object, warnings: string[], needsReview: boolean }}
 */
function defFromCatalogEntry(entry, meta = {}) {
  if (!entry || typeof entry !== "object") throw new Error("No catalog entry supplied.");
  if (!entry.name) throw new Error("Catalog entry has no badge name.");
  if (!Array.isArray(entry.requirements) || entry.requirements.length === 0) {
    throw new Error(`Catalog entry "${entry.name}" has no requirements.`);
  }

  const ctx = { warnings: [], needsReview: false };
  checkSiblings(entry.requirements, ctx, "top level");
  const requirements = entry.requirements.map((r, i) => convertRequirement(r, i, ctx));

  requirements.forEach((r, i) => {
    if (r.num !== i + 1) {
      ctx.needsReview = true;
      ctx.warnings.push(`Requirement numbering jumps: saw ${r.num} where ${i + 1} was expected.`);
    }
  });

  const def = { badge: entry.name, requirements };
  if (meta.requirementsRevised) def.requirementsRevised = meta.requirementsRevised;
  if (meta.workbookUpdated) def.workbookUpdated = meta.workbookUpdated;
  if (meta.font) def.font = meta.font;
  if (meta.creditLine) def.creditLine = meta.creditLine;
  if (meta.rightsLine) def.rightsLine = meta.rightsLine;

  // Provenance, so a stale import is visible in the file rather than guessed
  // at. Unknown keys are ignored by validate() and by the renderer.
  if (meta.provenance !== false) {
    if (entry.url) def.sourceUrl = entry.url;
    if (entry.source_retrieved) def.verifiedOn = String(entry.source_retrieved).slice(0, 10);
  }

  if (meta.pageBreakPerRequirement) {
    def.requirements.forEach((r, i) => { if (i > 0) r.pageBreakBefore = true; });
  }

  return { def, warnings: ctx.warnings, needsReview: ctx.needsReview };
}

/**
 * Render a catalog entry back to the indented text the paste path accepts, so
 * a badge can be re-parsed or hand-edited through the documented pipeline.
 */
function textFromCatalogEntry(entry) {
  const lines = [];
  const walk = (items, depth) => {
    items.forEach((it) => {
      const m = marker(it.marker);
      const pad = "    ".repeat(depth);
      lines.push(`${pad}${depth === 0 ? `${m}.` : `(${m})`} ${tidy(it.text)}`);
      (it.notes || []).forEach((n) => {
        const c = classifyNote(n);
        if (c.kind !== "resource" && c.kind !== "empty") lines.push(`${pad}    ${tidy(c.text)}`);
      });
      if (it.children && it.children.length) walk(it.children, depth + 1);
    });
  };
  walk(entry.requirements, 0);
  return `${lines.join("\n")}\n`;
}

module.exports = { defFromCatalogEntry, textFromCatalogEntry, classifyNote };
