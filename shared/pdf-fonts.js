/**
 * Resolves TrueType font files for embedding in generated PDFs, sourced
 * directly from the OS's own installed fonts (never bundled/redistributed -
 * Arial and Calibri are proprietary and can't ship in a public repo).
 *
 * "Arial Black" isn't reliably present on Windows outside a full Office
 * install, so headers map to bold Arial instead - visually close enough as
 * a stand-in and avoids depending on a font that may not exist.
 */
const fs = require("fs");
const path = require("path");

const WIN_FONTS_DIR = path.join(process.env.SystemRoot || "C:\\Windows", "Fonts");
const MAC_FONT_DIRS = ["/Library/Fonts", "/System/Library/Fonts/Supplemental", "/System/Library/Fonts"];

const CANDIDATES = {
  "arial":            { win32: "arial.ttf",   darwin: "Arial.ttf" },
  "arial-bold":       { win32: "arialbd.ttf", darwin: "Arial Bold.ttf" },
  "calibri":          { win32: "calibri.ttf",   darwin: "Calibri.ttf" },
  "calibri-bold":     { win32: "calibrib.ttf",  darwin: "Calibri Bold.ttf" },
  "calibri-italic":   { win32: "calibrii.ttf",  darwin: "Calibri Italic.ttf" },
  "calibri-bolditalic": { win32: "calibriz.ttf", darwin: "Calibri Bold Italic.ttf" },
};

function findFile(fileName) {
  const dirs = process.platform === "darwin" ? MAC_FONT_DIRS : [WIN_FONTS_DIR];
  for (const dir of dirs) {
    const full = path.join(dir, fileName);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

const resolved = {};
function resolveFontPath(key) {
  if (key in resolved) return resolved[key];
  const entry = CANDIDATES[key];
  const fileName = entry && entry[process.platform];
  const found = fileName ? findFile(fileName) : null;
  resolved[key] = found;
  return found;
}

// Registers every resolvable Arial/Calibri weight under stable font keys on
// a pdfkit document, falling back to the built-in core fonts (always
// present, never fail) for any weight not found on this machine.
function registerFonts(doc) {
  const map = {
    "arial":              resolveFontPath("arial")              || "Helvetica",
    "arial-bold":         resolveFontPath("arial-bold")          || "Helvetica-Bold",
    "calibri":            resolveFontPath("calibri")             || "Helvetica",
    "calibri-bold":       resolveFontPath("calibri-bold")        || "Helvetica-Bold",
    "calibri-italic":     resolveFontPath("calibri-italic")      || "Helvetica-Oblique",
    "calibri-bolditalic": resolveFontPath("calibri-bolditalic")  || "Helvetica-BoldOblique",
  };
  Object.entries(map).forEach(([key, source]) => {
    try {
      doc.registerFont(key, source);
    } catch {
      doc.registerFont(key, key.includes("bold") ? "Helvetica-Bold" : "Helvetica");
    }
  });

  // Picks the closest registered font key for a pptxgenjs-style
  // (fontFace, bold, italic) combination.
  return {
    pick(fontFace, bold, italic) {
      const isArialBlack = fontFace === "Arial Black";
      if (isArialBlack) return "arial-bold";
      if (bold && italic) return "calibri-bolditalic";
      if (bold) return "calibri-bold";
      if (italic) return "calibri-italic";
      return "calibri";
    },
  };
}

module.exports = { registerFonts };
