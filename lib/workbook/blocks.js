"use strict";

/**
 * Low-level docx building blocks for merit badge workbooks.
 * Nothing in here knows about a specific badge; it only knows how to draw
 * the recurring visual elements a workbook is made of.
 */

const {
  Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, TabStopType, VerticalAlign, ShadingType,
} = require("docx");

// Letter page, 0.5in side margins.
const LAYOUT = {
  pageWidth: 12240,
  pageHeight: 15840,
  margin: { top: 540, right: 720, bottom: 540, left: 720, header: 360, footer: 360 },
  contentWidth: 10800,
  // Capture areas sitting under a lettered sub-requirement.
  indent: 1440,
  boxWidth: 9350,
  // Capture areas that need the full text column (big grids, logs).
  wideIndent: 720,
  wideWidth: 10080,
  rowHeight: 360,
  bodySize: 22,   // half-points, so 11pt
  smallSize: 20,  // 10pt
  tinySize: 18,   // 9pt
};

const THIN = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const ALL_BORDERS = {
  top: THIN, bottom: THIN, left: THIN, right: THIN,
  insideHorizontal: THIN, insideVertical: THIN,
};

/** Capture areas hang off the item they belong to. */
function geometry(block, ctx) {
  if (block.wide) return { indent: LAYOUT.wideIndent, width: LAYOUT.contentWidth - LAYOUT.wideIndent };
  const indent = (ctx && ctx.baseIndent) || LAYOUT.indent;
  return { indent, width: LAYOUT.contentWidth - indent };
}

function makeRunner(font) {
  return function run(text, o = {}) {
    return new TextRun({
      text,
      font,
      size: o.size || LAYOUT.bodySize,
      bold: o.bold,
      italics: o.italics,
    });
  };
}

function makeTab(font, size) {
  return new TextRun({ text: "\t", font, size: size || LAYOUT.bodySize });
}

/**
 * Turn proportional weights into dxa widths that sum exactly to `total`.
 * Lets badge JSON say [3,1,1,1] instead of doing twip arithmetic by hand.
 */
function resolveWidths(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor((w / sum) * total));
  out[out.length - 1] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

function blankCell(width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    children: [new Paragraph({ children: [new TextRun({ text: "" })] })],
  });
}

function textCell(font, width, text, o = {}) {
  const run = makeRunner(font);
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: o.shade
      ? { type: ShadingType.CLEAR, fill: "EDEDED", color: "auto" }
      : undefined,
    children: [new Paragraph({
      alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [run(text, { bold: o.bold, size: o.size })],
    })],
  });
}

function tableRow(children, o = {}) {
  return new TableRow({
    cantSplit: true,
    tableHeader: o.header || undefined,
    height: { value: LAYOUT.rowHeight, rule: "atLeast" },
    children,
  });
}

function wrapTable(rows, widths, indent) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    indent: { size: indent, type: WidthType.DXA },
    borders: ALL_BORDERS,
    rows,
  });
}

/* ------------------------------------------------------------------ *
 * Block renderers. Each returns an array of docx elements.
 * ------------------------------------------------------------------ */

const renderers = {
  /** Plain lined answer area. { type:"lines", rows:4 } */
  lines(block, ctx) {
    const { indent, width } = geometry(block, ctx);
    const rows = Array.from({ length: block.rows || 4 }, () =>
      tableRow([blankCell(width)]));
    return [wrapTable(rows, [width], indent)];
  },

  /** Label/value rows. { type:"fields", labels:[...], labelWidth:2400, blanksAfter:0 } */
  fields(block, ctx) {
    const { indent, width } = geometry(block, ctx);
    const labelW = block.labelWidth || 2400;
    const valueW = width - labelW;
    const rows = [];
    (block.labels || []).forEach((label) => {
      rows.push(tableRow([
        textCell(ctx.font, labelW, label),
        blankCell(valueW),
      ]));
      for (let i = 0; i < (block.blanksAfter || 0); i++) {
        rows.push(tableRow([blankCell(labelW), blankCell(valueW)]));
      }
    });
    return [wrapTable(rows, [labelW, valueW], indent)];
  },

  /** Numbered slots. { type:"numbered", count:3 } */
  numbered(block, ctx) {
    const { indent, width } = geometry(block, ctx);
    const numW = 560;
    const valueW = width - numW;
    const rows = Array.from({ length: block.count || 3 }, (_, i) =>
      tableRow([
        textCell(ctx.font, numW, `${i + 1}.`, { center: true }),
        blankCell(valueW),
      ]));
    return [wrapTable(rows, [numW, valueW], indent)];
  },

  /**
   * Header row plus blank rows, optionally with a fixed label in column 1.
   * { type:"grid", headers:[...], widths:[3,1,1], rows:4, rowLabels:[...], wide:true }
   */
  grid(block, ctx) {
    const { indent, width } = geometry(block, ctx);
    const headers = block.headers || [];
    const weights = block.widths || headers.map(() => 1);
    const widths = resolveWidths(weights, width);
    const labels = block.rowLabels || null;
    const count = block.rows || (labels ? labels.length : 4);

    const rows = [tableRow(
      headers.map((h, i) => textCell(ctx.font, widths[i], h,
        { bold: true, center: true, shade: true, size: block.headerSize })),
      { header: true },
    )];
    for (let r = 0; r < count; r++) {
      rows.push(tableRow(widths.map((w, i) =>
        (labels && i === 0)
          ? textCell(ctx.font, w, labels[r] || "", { size: block.cellSize })
          : blankCell(w))));
    }
    return [wrapTable(rows, widths, indent)];
  },

  /**
   * Repeating grid, one block per period. Used for activity logs.
   * { type:"repeatgrid", count:12, caption:"Week {n}", headers:[...],
   *   widths:[...], rowLabels:["Sun",...], perPage:3 }
   */
  repeatgrid(block, ctx) {
    const out = [];
    const count = block.count || 1;
    const perPage = block.perPage || 0;
    for (let n = 1; n <= count; n++) {
      if (block.caption) {
        out.push(new Paragraph({
          spacing: { before: 180, after: 60 },
          keepNext: true,
          indent: { left: block.wide === false ? geometry(block, ctx).indent : LAYOUT.wideIndent },
          children: [ctx.run(block.caption.replace("{n}", String(n)), { bold: true })],
        }));
      }
      out.push(...renderers.grid({ ...block, type: "grid", wide: block.wide !== false }, ctx));
      if (perPage && n % perPage === 0 && n < count) {
        out.push(ctx.pageBreak());
      }
    }
    return out;
  },

  /** Italic guidance line that is not part of the official requirement. */
  note(block, ctx) {
    return [new Paragraph({
      spacing: { before: 120, after: 60 },
      keepNext: true,
      indent: { left: geometry(block, ctx).indent },
      children: [ctx.run(block.text, { italics: true, size: LAYOUT.smallSize })],
    })];
  },

  /** Plain caption above a capture area. */
  label(block, ctx) {
    return [new Paragraph({
      spacing: { before: 120, after: 60 },
      keepNext: true,
      indent: { left: geometry(block, ctx).indent },
      children: [ctx.run(block.text, { bold: block.bold })],
    })];
  },

  /** Centered section heading, used by appendices. */
  heading(block, ctx) {
    return [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      keepNext: true,
      children: [ctx.run(block.text, { bold: true, size: block.size || 28 })],
    })];
  },

  pagebreak(block, ctx) {
    return [ctx.pageBreak()];
  },
};

function renderBlocks(blocks, ctx, baseIndent) {
  const out = [];
  const scoped = baseIndent ? Object.assign({}, ctx, { baseIndent }) : ctx;
  (blocks || []).forEach((block) => {
    const fn = renderers[block.type];
    if (!fn) throw new Error(`Unknown workbook block type: "${block.type}"`);
    out.push(...fn(block, scoped));
  });
  return out;
}

module.exports = {
  LAYOUT, ALL_BORDERS, THIN,
  makeRunner, makeTab, resolveWidths, geometry,
  blankCell, textCell, tableRow, wrapTable,
  renderers, renderBlocks,
};
