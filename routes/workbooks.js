"use strict";

/**
 * Troop Tools - Merit Badge Workbook routes.
 *
 * Mount in your app entry point:
 *     app.use("/workbooks", require("./routes/workbooks"));
 *
 *     GET  /workbooks             paste-in form
 *     POST /workbooks/generate    requirement text in, .docx out
 *
 * Every workbook simply downloads - nothing is saved to disk from this
 * route. (The badges/requirements library still exists for the CLI
 * authoring workflow - see bin/new-badge.js and bin/generate-workbook.js -
 * it just isn't exposed through this page.)
 *
 * Workbooks are blank forms. Nothing in this route reads TroopWebHost data,
 * so no Scout PII passes through it. Keep it that way.
 */

const express = require("express");
const { workbookFromText } = require("../lib/workbook");

const router = express.Router();

router.use(express.urlencoded({ extended: false, limit: "2mb" }));
router.use(express.json({ limit: "2mb" }));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Merit Badge Workbook Generator - Troop Tools</title>
<link rel="stylesheet" href="/style.css" />
<style>
  .workbook-row { display: flex; gap: 1rem; }
  .workbook-row > .field { flex: 1; }
  .workbook-textarea {
    width: 100%; min-height: 20rem; padding: 0.6rem 0.75rem;
    font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.82rem;
    border: 1px solid var(--border); border-radius: 5px; resize: vertical;
    background: #FFFFFF; color: var(--text-dark);
  }
  .workbook-textarea:focus {
    outline: none; border-color: var(--od-green);
    box-shadow: 0 0 0 3px rgba(58, 79, 42, 0.15);
  }
  .workbook-card { max-width: 640px; }
</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="brand">
      <span class="brand-mark">⚜</span>
      <h1>Troop Tools</h1>
    </div>
    <p class="tagline">Merit Badge Workbook Generator</p>
    <div class="header-right">
      <a href="/" class="link-btn" style="color:var(--tan-light)">← Back to dashboard</a>
    </div>
  </div>
</header>
<main>
  <div class="login-view">
    <div class="login-card workbook-card">${body}</div>
  </div>
</main>
</body>
</html>`;
}

router.get("/", (req, res) => {
  res.send(page(`
  <h2>Workbook Generator</h2>
  <p class="login-help">Paste the current requirements for any merit badge. Lines starting with
  "Resource:" are ignored, so you can paste straight from the requirements page. You'll get a
  Word file to download - upload it to Drive and open with Google Docs to convert.</p>

  <form method="post" action="/workbooks/generate">
    <div class="workbook-row">
      <label class="field">
        <span class="field-label">Badge name</span>
        <input type="text" name="badge" placeholder="Personal Fitness" required />
      </label>
      <label class="field">
        <span class="field-label">Requirements revised (year)</span>
        <input type="text" name="revised" placeholder="2026" />
      </label>
    </div>
    <label class="field">
      <span class="field-label">Requirements</span>
      <textarea name="text" class="workbook-textarea" required placeholder="1. Do the following:&#10;&#10;    (a) ...&#10;    (b) ..."></textarea>
    </label>
    <label class="checkbox-field">
      <input type="checkbox" name="pagebreaks" value="1" />
      <span class="checkbox-text"><span class="checkbox-label">Start each requirement on a new page</span></span>
    </label>
    <button type="submit" class="primary-btn">Generate Workbook</button>
  </form>`));
});

router.post("/generate", async (req, res) => {
  const { badge, text, revised, pagebreaks } = req.body || {};

  if (!badge || !text || !String(text).trim()) {
    return res.status(400).send(page(
      `<h2>Workbook Generator</h2><div class="result error">A badge name and requirement text are both required.</div><p><a href="/workbooks">Back</a></p>`));
  }

  try {
    const result = await workbookFromText(String(text), {
      badge: String(badge).trim(),
      requirementsRevised: revised ? String(revised).trim() : undefined,
      workbookUpdated: new Date().toLocaleString("en-US", { month: "long", year: "numeric" }),
      pageBreakPerRequirement: Boolean(pagebreaks),
    });

    if (result.warnings.length) {
      console.warn(`[workbooks] ${badge}: ${result.warnings.join(" | ")}`);
    }

    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.send(result.buffer);
  } catch (err) {
    console.error(`[workbooks] ${badge}: ${err.message}`);
    res.status(400).send(page(
      `<h2>Workbook Generator</h2><div class="result error">${escapeHtml(err.message)}</div><p><a href="/workbooks">Back</a></p>`));
  }
});

module.exports = router;
