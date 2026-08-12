"use strict";

/**
 * Merit Badge Workbook generator for Troop Tools.
 *
 * buildWorkbook(badgeDef, options) -> Promise<Buffer>   (a .docx)
 *
 * The badge definition is plain JSON. See badges/personal-fitness.json for a
 * worked example and README.md for the schema. No code changes are needed to
 * add a badge; drop a new JSON file in badges/.
 */

const {
  Document, Packer, Paragraph, TextRun, Header, Footer, PageNumber, PageBreak,
  AlignmentType, TabStopType, BorderStyle,
} = require("docx");

const { LAYOUT, makeRunner, renderBlocks } = require("./blocks");

const DEFAULT_FONT = "Arial"; // Arial Narrow is not in the Google Docs font menu.

const BOILERPLATE = [
  { text: "This workbook is a study aid. It does not replace the merit badge pamphlet, which you still need to read." },
  { text: "Use it to organize your thinking and track your progress before you meet with your counselor.", after: 140 },
  { text: "Counselors may not require you to use this or any other workbook.", bold: true },
  { text: "You still have to satisfy your counselor that you have learned the material and can demonstrate each skill." },
  { text: "The space provided is for notes to discuss with your counselor, not for full written answers." },
  { text: "Where a requirement says discuss, show, tell, explain, demonstrate, or identify, that is the action you must actually perform.", after: 140 },
  { text: "No one may add to or subtract from the official requirements published in Scouts BSA Requirements and on Scouting.org." },
];

const RELIGIOUS_NOTE =
  "If meeting any requirement for this merit badge conflicts with the Scout's religious convictions, that requirement " +
  "does not have to be completed, provided the Scout's parents and the appropriate religious advisors state so in " +
  "writing. The parents must also accept full responsibility for anything that results from the exemption.";

function validate(def) {
  if (!def || typeof def !== "object") throw new Error("Badge definition must be an object.");
  if (!def.badge) throw new Error("Badge definition is missing a \"badge\" name.");
  if (!Array.isArray(def.requirements) || def.requirements.length === 0) {
    throw new Error(`Badge "${def.badge}" has no requirements array.`);
  }
  def.requirements.forEach((req, i) => {
    if (req.num === undefined) throw new Error(`Requirement at index ${i} is missing "num".`);
    if (!req.text) throw new Error(`Requirement ${req.num} is missing "text".`);
    const checkSubs = (subs, path) => {
      (subs || []).forEach((sub) => {
        if (!sub.letter) throw new Error(`A sub-requirement of ${path} is missing "letter".`);
        if (!sub.text) throw new Error(`Requirement ${path}${sub.letter} is missing "text".`);
        checkSubs(sub.subs, `${path}${sub.letter}`);
      });
    };
    checkSubs(req.subs, String(req.num));
  });
}

function buildCover(def, ctx, opts) {
  const { run, font } = ctx;
  const tab = () => new TextRun({ text: "\t", font, size: LAYOUT.bodySize });
  const centered = (text, o = {}) => new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: o.after === undefined ? 60 : o.after },
    children: [run(text, { size: o.size || LAYOUT.smallSize, bold: o.bold })],
  });

  const out = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [run(def.badge, { bold: true, size: 56 })],
    }),
    centered("Merit Badge Workbook", { size: 32, after: 200 }),
    ...BOILERPLATE.map((b) => centered(b.text, b)),
  ];

  const revised = def.requirementsRevised
    ? `The requirements were last issued or revised in ${def.requirementsRevised}.`
    : "";
  const updated = def.workbookUpdated
    ? `This workbook was updated in ${def.workbookUpdated}.`
    : "";
  if (revised || updated) {
    out.push(centered([revised, updated].filter(Boolean).join("   \u2022   "), { after: 240 }));
  }

  // Scout / unit line
  out.push(new Paragraph({
    spacing: { before: 200, after: 200 },
    tabStops: [
      { type: TabStopType.LEFT, position: 5400, leader: "underscore" },
      { type: TabStopType.LEFT, position: 5580 },
      { type: TabStopType.LEFT, position: 10600, leader: "underscore" },
    ],
    children: [run("Scout's Name: "), tab(), tab(), run("Unit: "), tab()],
  }));

  // Counselor line
  out.push(new Paragraph({
    spacing: { after: 200 },
    tabStops: [
      { type: TabStopType.LEFT, position: 3800, leader: "underscore" },
      { type: TabStopType.LEFT, position: 3960 },
      { type: TabStopType.LEFT, position: 7200, leader: "underscore" },
      { type: TabStopType.LEFT, position: 7360 },
      { type: TabStopType.LEFT, position: 10600, leader: "underscore" },
    ],
    children: [run("Counselor's Name: "), tab(), tab(), run("Phone: "), tab(), tab(), run("Email: "), tab()],
  }));

  out.push(new Paragraph({
    spacing: { before: 200, after: 200 },
    border: { bottom: { style: BorderStyle.DASHED, size: 8, color: "000000", space: 4 } },
    children: [run("")],
  }));

  out.push(new Paragraph({
    spacing: { after: 200 },
    indent: { left: 720, hanging: 720 },
    children: [
      run("Note:  ", { bold: true, italics: true }),
      run(def.religiousNote || RELIGIOUS_NOTE, { italics: true }),
    ],
  }));

  return out;
}

function buildRequirements(def, ctx) {
  const { run, font } = ctx;
  const tab = () => new TextRun({ text: "\t", font, size: LAYOUT.bodySize });
  const out = [];

  def.requirements.forEach((req) => {
    if (req.pageBreakBefore) out.push(ctx.pageBreak());

    out.push(new Paragraph({
      spacing: { before: 240, after: 80 },
      keepNext: true,
      indent: { left: 720, hanging: 360 },
      children: [run(`${req.num}.`), tab(), run(req.text)],
    }));

    out.push(...renderBlocks(req.before, ctx));

    const renderSubs = (subs, depth) => {
      const left = depth === 1 ? 1440 : 2160;
      const hanging = 720;
      const markerTab = depth === 1 ? 1080 : 1800;
      (subs || []).forEach((sub) => {
        out.push(new Paragraph({
          spacing: { before: 140, after: 80 },
          keepNext: true,
          indent: { left, hanging },
          tabStops: [{ type: TabStopType.LEFT, position: markerTab }],
          children: [run("\u2610"), tab(), run(`${sub.letter}.`), tab(), run(sub.text)],
        }));
        out.push(...renderBlocks(sub.blocks, ctx, left));
        if (sub.subs && sub.subs.length) renderSubs(sub.subs, depth + 1);
      });
    };
    renderSubs(req.subs, 1);

    out.push(...renderBlocks(req.after, ctx));
  });

  (def.appendices || []).forEach((appendix) => {
    out.push(ctx.pageBreak());
    if (appendix.title) {
      out.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        keepNext: true,
        children: [run(appendix.title, { bold: true, size: 28 })],
      }));
    }
    if (appendix.subtitle) {
      out.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        keepNext: true,
        children: [run(appendix.subtitle, { italics: true, size: LAYOUT.smallSize })],
      }));
    }
    out.push(...renderBlocks(appendix.blocks, ctx));
  });

  return out;
}

function buildHeaders(def, ctx, opts) {
  const { run, font } = ctx;
  const title = `${def.badge} Merit Badge Workbook`;
  const credit = opts.creditLine || def.creditLine ||
    "Merit badge requirements are the property of Scouting America and are reproduced here for the use of Scouts and Scouters.";
  const rights = opts.rightsLine || def.rightsLine ||
    "This workbook may be copied and used locally for purposes consistent with the programs of Scouting America.";

  return {
    headers: {
      first: new Header({ children: [new Paragraph({ children: [run("")] })] }),
      default: new Header({
        children: [new Paragraph({
          spacing: { after: 120 },
          tabStops: [{ type: TabStopType.RIGHT, position: 10350 }],
          children: [
            run(title, { size: LAYOUT.smallSize }),
            new TextRun({ text: "\t", font, size: LAYOUT.smallSize }),
            run("Scout's Name: ______________________________", { size: LAYOUT.smallSize }),
          ],
        })],
      }),
    },
    footers: {
      first: new Footer({
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 120 },
            children: [run(credit, { size: LAYOUT.tinySize, bold: true })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [run(rights, { size: LAYOUT.tinySize, bold: true })],
          }),
        ],
      }),
      default: new Footer({
        children: [new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: 10350 }],
          children: [
            run(title, { size: LAYOUT.smallSize }),
            new TextRun({ text: "\t", font, size: LAYOUT.smallSize }),
            new TextRun({
              children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
              font,
              size: LAYOUT.smallSize,
            }),
          ],
        })],
      }),
    },
  };
}

function buildWorkbook(def, options = {}) {
  validate(def);

  const font = options.font || def.font || DEFAULT_FONT;
  const ctx = {
    font,
    run: makeRunner(font),
    pageBreak: () => new Paragraph({ children: [new PageBreak()] }),
  };

  const { headers, footers } = buildHeaders(def, ctx, options);

  const doc = new Document({
    title: def.badge,
    description: `${def.badge} Merit Badge Workbook`,
    styles: {
      default: {
        document: {
          run: { font, size: LAYOUT.bodySize },
          paragraph: { spacing: { after: 0, line: 240 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: LAYOUT.pageWidth, height: LAYOUT.pageHeight },
          margin: LAYOUT.margin,
        },
        titlePage: true,
      },
      headers,
      footers,
      children: [
        ...buildCover(def, ctx, options),
        ...buildRequirements(def, ctx),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

/** Filename-safe slug, e.g. "Personal Fitness" -> "Personal-Fitness-Workbook.docx" */
function workbookFilename(def) {
  const slug = String(def.badge).trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug}-Workbook.docx`;
}

const { parseRequirements, slugify } = require("./parse");

/**
 * One-shot: pasted requirement text in, .docx Buffer out.
 * Returns the intermediate definition and any parser warnings so callers can
 * surface them or save the JSON for later editing.
 */
async function workbookFromText(text, meta = {}) {
  const { def, warnings } = parseRequirements(text, meta);
  const buffer = await buildWorkbook(def, meta);
  return { buffer, def, warnings, filename: workbookFilename(def) };
}

module.exports = {
  buildWorkbook, workbookFromText, workbookFilename, validate,
  parseRequirements, slugify, DEFAULT_FONT,
};
