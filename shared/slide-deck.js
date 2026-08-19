/**
 * Shared slide-deck abstraction for reports that need to ship as both a
 * PowerPoint and a PDF that looks exactly like it.
 *
 * Each report describes its slides ONCE using this module's addSlide/
 * addShape/addText calls (a thin mirror of pptxgenjs's own API, all
 * coordinates in inches). Two backends then render that same op list:
 *   - writePptx() -> pptxgenjs, producing the .pptx
 *   - writePdf()  -> pdfkit, producing a landscape PDF at the exact same
 *                    physical page size as the slide (10in x 5.625in, same
 *                    as pptxgenjs's LAYOUT_16x9), so positions/sizes/font
 *                    sizes carry over as plain inches-to-points conversion
 *                    with no scaling - guaranteeing the two outputs match.
 */
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const PDFDocument = require("pdfkit");
const { registerFonts } = require("./pdf-fonts");

const SHAPES = { RECTANGLE: "rect", ROUNDED_RECTANGLE: "roundRect" };
const IN_TO_PT = 72;
const SLIDE_W_IN = 10;
const SLIDE_H_IN = 5.625;

class SlideOps {
  constructor() {
    this.bg = "FFFFFF";
    this.ops = [];
  }
  set background(val) { this.bg = (val && val.color) || "FFFFFF"; }
  get background() { return { color: this.bg }; }
  addShape(type, opts) { this.ops.push({ kind: "shape", type, opts }); }
  addText(text, opts) { this.ops.push({ kind: "text", text: String(text), opts }); }
}

class SlideDeck {
  constructor() {
    this.title = "";
    this.layout = "LAYOUT_16x9"; // fixed; kept as a writable no-op for call-site compatibility
    this.slides = [];
    this.shapes = SHAPES;
  }

  addSlide() {
    const slide = new SlideOps();
    this.slides.push(slide);
    return slide;
  }

  async writePptx(filePath) {
    const pres = new pptxgen();
    pres.layout = "LAYOUT_16x9";
    pres.title = this.title || "";
    for (const s of this.slides) {
      const slide = pres.addSlide();
      slide.background = { color: s.bg };
      for (const op of s.ops) {
        if (op.kind === "shape") {
          const shapeType = op.type === SHAPES.ROUNDED_RECTANGLE
            ? pres.shapes.ROUNDED_RECTANGLE : pres.shapes.RECTANGLE;
          slide.addShape(shapeType, op.opts);
        } else {
          slide.addText(op.text, op.opts);
        }
      }
    }
    await pres.writeFile({ fileName: filePath });
  }

  async writePdf(filePath) {
    const pageSize = [SLIDE_W_IN * IN_TO_PT, SLIDE_H_IN * IN_TO_PT];
    const doc = new PDFDocument({ size: pageSize, margin: 0, autoFirstPage: false });
    const fonts = registerFonts(doc);
    const stream = fs.createWriteStream(filePath);
    const done = new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
    });
    doc.pipe(stream);

    this.slides.forEach((s, idx) => {
      doc.addPage({ size: pageSize, margin: 0 });
      doc.rect(0, 0, pageSize[0], pageSize[1]).fill(hexColor(s.bg));
      for (const op of s.ops) {
        if (op.kind === "shape") drawShape(doc, op);
        else drawText(doc, op, fonts);
      }
    });

    doc.end();
    await done;
  }
}

function hexColor(c) {
  const s = String(c || "000000");
  return s.startsWith("#") ? s : `#${s}`;
}

function drawShape(doc, op) {
  const { x = 0, y = 0, w = 0, h = 0, fill, rectRadius } = op.opts;
  const X = x * IN_TO_PT, Y = y * IN_TO_PT, W = w * IN_TO_PT, H = h * IN_TO_PT;
  if (!fill || !fill.color) return; // every shape in this codebase is fill-only, no borders
  doc.save();
  if (fill.transparency) doc.fillOpacity(Math.max(0, 1 - fill.transparency / 100));
  if (op.type === SHAPES.ROUNDED_RECTANGLE) {
    doc.roundedRect(X, Y, W, H, (rectRadius || 0) * IN_TO_PT);
  } else {
    doc.rect(X, Y, W, H);
  }
  doc.fill(hexColor(fill.color));
  doc.restore();
}

function drawText(doc, op, fonts) {
  const o = op.opts;
  const margin = typeof o.margin === "number" ? o.margin : 0;
  const X = (o.x || 0) * IN_TO_PT + margin, Y = (o.y || 0) * IN_TO_PT + margin;
  const W = Math.max(0, (o.w || 0) * IN_TO_PT - margin * 2);
  const H = Math.max(0, (o.h || 0) * IN_TO_PT - margin * 2);

  doc.font(fonts.pick(o.fontFace, o.bold, o.italic));
  doc.fontSize(o.fontSize || 12);
  doc.fillColor(hexColor(o.color));
  doc.fillOpacity(1);

  const textOpts = {
    width: W,
    // Without an explicit height, pdfkit treats text as flowing document
    // content and silently calls addPage() once the y position it's
    // internally tracking crosses the page's bottom margin - wrong for a
    // slide deck where every element is absolutely positioned on a fixed
    // canvas. A generous height (never actually reached by any real slide
    // text) keeps pdfkit in "bounded box" mode instead, with no truncation
    // since `ellipsis` is never set.
    height: 10000,
    align: o.align || "left",
    characterSpacing: o.charSpacing || 0,
    lineBreak: true,
  };

  if (o.rotate) {
    // pptxgenjs rotates the whole text box in place around its own center,
    // clockwise-positive - match that by rotating the coordinate system
    // around the box center and drawing in the box's local frame.
    const cx = X + W / 2, cy = Y + H / 2;
    doc.save();
    doc.translate(cx, cy).rotate(o.rotate, { origin: [0, 0] });
    const textH = doc.heightOfString(op.text, textOpts);
    const ty = o.valign === "middle" ? -textH / 2 : -H / 2;
    doc.text(op.text, -W / 2, ty, textOpts);
    doc.restore();
    return;
  }

  let ty = Y;
  if (o.valign === "middle" || o.valign === "bottom") {
    const textH = doc.heightOfString(op.text, textOpts);
    ty = o.valign === "middle" ? Y + (H - textH) / 2 : Y + H - textH;
  }
  doc.text(op.text, X, ty, textOpts);
}

module.exports = { SlideDeck, SHAPES };
