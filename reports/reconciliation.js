/**
 * Roster Reconciliation Report
 *
 * Compares youth members between my.scouting.org and TroopWebHost
 * using BSA Member ID as the definitive match key.
 *
 * Primary output: a self-contained HTML report that opens in a new browser tab.
 * Optional outputs: PDF (via Playwright) and CSV.
 *
 * Five categories:
 *   1. Missing BSA ID in TWH — can't be matched at all; fix this first
 *   2. In my.scouting only   — needs to be added to TroopWebHost
 *   3. In TroopWebHost only  — investigate / possibly remove
 *   4. Name mismatch         — one row per scout with a name discrepancy
 *   5. Rank mismatch         — one row per scout with a rank discrepancy
 *
 * Matching is by BSA Member ID only. A TroopWebHost row with no BSA ID can't
 * be looked up in my.scouting at all, so it's reported separately instead of
 * silently vanishing from every other category (this used to live in Roster
 * Audit as "Missing BSA ID" - moved here since the real risk is exactly this
 * kind of invisible-to-reconciliation scout, not just a blank field).
 *
 * my.scouting is treated as the source of truth.
 * Palm ranks (Gold/Silver/Bronze) are treated as equivalent to Eagle.
 */

const fs   = require("fs");
const path = require("path");
const csvParser = require("../shared/csv-parser");
const { todayLong } = require("../shared/dates");

function fileTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

// ═══════════════════════════════ MANIFEST ════════════════════════════════
const manifest = {
  id: "reconciliation",
  name: "Roster Reconciliation",
  description: "Compares youth on my.scouting.org against TroopWebHost. Flags who needs to be added, who needs investigation, who's missing a BSA ID, and any name or rank discrepancies.",
  icon: "🔍",
  outputType: "html",   // signals the server to open result in a new tab
  inputs: [
    {
      key: "roster",
      label: "TroopWebHost Active Roster CSV",
      hint: "Export: Menu → Membership → Export Membership Data → Export Active Roster to Excel",
      required: true,
      twhReport: "roster",
    },
    {
      key: "scouting",
      label: "my.scouting Roster CSV",
      hint: "my.scouting.org → Roster Report export",
      required: true,
      twhReport: null,
      cacheKey: "myscouting-roster", // no TWH auto-download exists for this source - manual upload is its only refresh path
    },
  ],
  options: [
    {
      key: "downloadPdf",
      label: "Also download PDF",
      type: "checkbox",
      default: false,
    },
    {
      key: "downloadCsv",
      label: "Also download CSV",
      type: "checkbox",
      default: false,
    },
  ],
};

// ═══════════════════════════════ RANK NORMALIZATION ══════════════════════
function normalizeRank(rank) {
  const r = (rank || "").trim().toLowerCase();
  if (/palm/.test(r)) return "eagle";
  return r.replace(/\s+scout$/, "");
}

// ═══════════════════════════════ DATA LOADING ════════════════════════════
function extractTroopName(lines) {
  for (const line of lines.slice(0, 10)) {
    const m = line.match(/Organization Name:\s*(Troop\s*0*(\d+))/i);
    if (m) return `Troop ${m[2]}`;
  }
  return "BSA Troop";
}

function loadTWH(rosterPath) {
  const rows = csvParser.parseCSV(fs.readFileSync(rosterPath, "utf8"));
  const map = new Map();
  const missingId = [];
  rows.filter(r => r.Adult === "N").forEach(r => {
    const id      = (r["BSA ID"] || "").trim();
    const firstName = (r["FIrst Name"] || r["First Name"] || "").trim();
    const lastName  = (r["Last Name"] || "").trim();
    const fullName  = `${firstName} ${lastName}`.trim();
    const rank      = (r["Rank"] || "").trim();
    const patrol    = (r["Patrol"] || "").trim();

    if (!id) {
      // No BSA ID at all - can't be matched against my.scouting by this
      // report's key, so it never enters `map` and would otherwise vanish
      // from every category below. Skip alumni the same way Roster Audit
      // did, since this replaces that report's "Missing BSA ID" check.
      if (!patrol.toLowerCase().startsWith("zinactive")) {
        missingId.push({
          bsaId: "", myscoutingName: "", twhName: fullName,
          myscoutingRank: "", twhRank: rank, patrol, registrationStatus: "",
        });
      }
      return;
    }

    map.set(id, { id, firstName, lastName, fullName, rank, patrol });
  });
  return { map, missingId };
}

function loadMyScouting(scoutingPath) {
  const raw   = fs.readFileSync(scoutingPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const troopName = extractTroopName(lines);

  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("memberid")) { dataStart = i; break; }
  }

  const rows = csvParser.parseCSV(lines.slice(dataStart).join("\n"));
  const map  = new Map();
  rows
    .filter(r => (r["positionname"] || "").trim() === "Youth Member")
    .forEach(r => {
      const id = (r["..memberid"] || r["memberid"] || "").trim();
      if (!id || map.has(id)) return;
      const firstName = (r["firstname"] || "").trim().split(/\s+/)[0];
      const lastName  = (r["lastname"] || "").trim();
      map.set(id, {
        id,
        firstName,
        lastName,
        fullName:           `${firstName} ${lastName}`.trim(),
        rank:               (r["rankname"] || "").trim(),
        registrationStatus: (r["registrationstatus"] || "").trim(),
      });
    });
  return { map, troopName };
}

// ═══════════════════════════════ RECONCILE ═══════════════════════════════
function reconcile(twhMap, msMap, missingId) {
  const results = { msOnly: [], twhOnly: [], nameIssues: [], rankIssues: [], missingId: missingId || [] };
  const msIds  = new Set(msMap.keys());
  const twhIds = new Set(twhMap.keys());

  for (const id of msIds) {
    if (!twhIds.has(id)) {
      const ms = msMap.get(id);
      results.msOnly.push({
        bsaId: id, myscoutingName: ms.fullName, twhName: "",
        myscoutingRank: ms.rank, twhRank: "", patrol: "",
        registrationStatus: ms.registrationStatus,
      });
    }
  }

  for (const id of twhIds) {
    if (!msIds.has(id)) {
      const twh = twhMap.get(id);
      results.twhOnly.push({
        bsaId: id, myscoutingName: "", twhName: twh.fullName,
        myscoutingRank: "", twhRank: twh.rank,
        patrol: twh.patrol, registrationStatus: "",
      });
    }
  }

  for (const id of msIds) {
    if (!twhIds.has(id)) continue;
    const ms  = msMap.get(id);
    const twh = twhMap.get(id);

    const msNorm  = ms.fullName.toLowerCase().replace(/\s+/g, " ").trim();
    const twhNorm = twh.fullName.toLowerCase().replace(/\s+/g, " ").trim();
    if (msNorm !== twhNorm) {
      results.nameIssues.push({
        bsaId: id, myscoutingName: ms.fullName, twhName: twh.fullName,
        myscoutingRank: ms.rank, twhRank: twh.rank,
        patrol: twh.patrol, registrationStatus: ms.registrationStatus,
        note: `my.scouting: "${ms.fullName}" vs TroopWebHost: "${twh.fullName}"`,
      });
    }

    const msRankNorm  = normalizeRank(ms.rank);
    const twhRankNorm = normalizeRank(twh.rank);
    if (msRankNorm && twhRankNorm && msRankNorm !== twhRankNorm) {
      results.rankIssues.push({
        bsaId: id, myscoutingName: ms.fullName, twhName: twh.fullName,
        myscoutingRank: ms.rank, twhRank: twh.rank,
        patrol: twh.patrol, registrationStatus: ms.registrationStatus,
        note: `my.scouting: "${ms.rank}" vs TroopWebHost: "${twh.rank}"`,
      });
    }
  }

  const byLastName = arr => arr.sort((a, b) => {
    const la = (a.myscoutingName || a.twhName).split(" ").pop() || "";
    const lb = (b.myscoutingName || b.twhName).split(" ").pop() || "";
    return la.localeCompare(lb);
  });

  byLastName(results.msOnly);
  byLastName(results.twhOnly);
  byLastName(results.nameIssues);
  byLastName(results.rankIssues);
  byLastName(results.missingId);

  return results;
}

// ═══════════════════════════════ HTML GENERATION ═════════════════════════
function buildHTML(results, troopName, dateStr) {
  const { msOnly, twhOnly, nameIssues, rankIssues, missingId } = results;
  const total = msOnly.length + twhOnly.length + nameIssues.length + rankIssues.length + missingId.length;

  const badge = (n, bg) =>
    `<span class="badge" style="background:${bg}">${n}</span>`;

  const checkRow = (cells, color) => `
    <tr>
      <td class="check-cell"><span class="cb"></span></td>
      ${cells.map(c => `<td>${esc(c)}</td>`).join("")}
    </tr>`;

  const section = (id, color, icon, title, subtitle, badgeColor, rows, headers, rowFn) => {
    if (rows.length === 0) return `
      <div class="section" id="${id}">
        <div class="section-header" style="border-left-color:${color}">
          <div class="section-header-top">
            <span class="section-icon">${icon}</span>
            <span class="section-title">${title}</span>
            ${badge(0, "#aaa")}
          </div>
          <p class="section-subtitle">${subtitle}</p>
        </div>
        <p class="empty-msg">No items in this category.</p>
      </div>`;
    return `
      <div class="section" id="${id}">
        <div class="section-header" style="border-left-color:${color}">
          <div class="section-header-top">
            <span class="section-icon">${icon}</span>
            <span class="section-title">${title}</span>
            ${badge(rows.length, badgeColor)}
          </div>
          <p class="section-subtitle">${subtitle}</p>
        </div>
        <table>
          <thead><tr>
            <th class="check-cell"></th>
            ${headers.map(h => `<th>${h}</th>`).join("")}
          </tr></thead>
          <tbody>${rows.map(rowFn).join("")}</tbody>
        </table>
      </div>`;
  };

  const missingIdSection = section(
    "missing-id", "#1565C0", "🪪",
    "Missing BSA ID",
    "The following scouts have no BSA ID on file in TroopWebHost, so they could not be checked against the Council Roster at all. Fix these first.",
    "#1565C0", missingId,
    ["TroopWebHost Name", "Patrol", "Rank"],
    r => checkRow([r.twhName, r.patrol, r.twhRank], "#1565C0")
  );

  const msOnlySection = section(
    "ms-only", "#2E7D32", "➕",
    "Add to TroopWebHost",
    "The following scouts are not in TroopWebHost but are listed in the Council Roster.",
    "#2E7D32", msOnly,
    ["BSA ID", "my.scouting Name", "Rank", "Registration Status"],
    r => checkRow([r.bsaId, r.myscoutingName, r.myscoutingRank, r.registrationStatus], "#2E7D32")
  );

  const twhOnlySection = section(
    "twh-only", "#E65100", "🔎",
    "Missing in Council Roster",
    "The following scouts are in TroopWebHost, but are not in the Council Roster.",
    "#E65100", twhOnly,
    ["BSA ID", "TroopWebHost Name", "Rank", "Patrol"],
    r => checkRow([r.bsaId, r.twhName, r.twhRank, r.patrol], "#E65100")
  );

  const nameSection = section(
    "name-issues", "#003F87", "✏️",
    "Name Mismatches",
    "The following scout's names do not match the name in the Council Roster.",
    "#003F87", nameIssues,
    ["BSA ID", "my.scouting Name", "TroopWebHost Name", "Patrol"],
    r => checkRow([r.bsaId, r.myscoutingName, r.twhName, r.patrol], "#003F87")
  );

  const rankSection = section(
    "rank-issues", "#6A1B9A", "🎖️",
    "Rank Mismatches",
    "The following scout's ranks do not match the rank in the Council Roster.",
    "#6A1B9A", rankIssues,
    ["BSA ID", "Name", "my.scouting Rank", "TroopWebHost Rank", "Patrol"],
    r => checkRow([r.bsaId, r.myscoutingName, r.myscoutingRank, r.twhRank, r.patrol], "#6A1B9A")
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(troopName)} Roster Reconciliation — ${dateStr}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #FAF7F0;
    color: #1C2340;
    padding: 2rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  /* Header */
  .report-header {
    background: #2A3A1F;
    color: #fff;
    padding: 1.75rem 2rem;
    border-radius: 10px;
    margin-bottom: 1.5rem;
    border-bottom: 4px solid #C7A975;
  }
  .report-header h1 {
    font-size: 1.6rem;
    font-weight: 800;
    letter-spacing: 0.5px;
  }
  .report-meta {
    font-size: 0.9rem;
    color: #E8DCC0;
    margin-top: 0.3rem;
    font-style: italic;
  }
  /* Summary bar */
  .summary {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1.75rem;
  }
  .summary-item {
    flex: 1;
    min-width: 150px;
    background: #fff;
    border: 1px solid #D7CDB5;
    border-radius: 8px;
    padding: 0.85rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .summary-count {
    font-size: 2rem;
    font-weight: 800;
    line-height: 1;
  }
  .summary-label {
    font-size: 0.82rem;
    color: #4A5568;
    line-height: 1.35;
  }
  /* Sections */
  .section {
    background: #fff;
    border: 1px solid #D7CDB5;
    border-radius: 10px;
    margin-bottom: 1.5rem;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .section-header {
    padding: 1rem 1.25rem;
    background: #F7F4EC;
    border-bottom: 1px solid #D7CDB5;
    border-left: 5px solid #ccc;
  }
  .section-header-top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .section-icon { font-size: 1.2rem; }
  .section-title { font-weight: 700; font-size: 1rem; flex: 1; }
  .section-subtitle {
    margin-top: 0.35rem;
    color: #4A5568;
    font-size: 0.85rem;
    font-style: italic;
  }
  .badge {
    color: #fff;
    font-size: 0.82rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    border-radius: 20px;
    min-width: 2rem;
    text-align: center;
  }
  .empty-msg {
    padding: 1rem 1.25rem;
    color: #4A5568;
    font-style: italic;
    font-size: 0.9rem;
  }
  /* Table */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
  }
  thead th {
    background: #F0EBDC;
    padding: 0.6rem 0.85rem;
    text-align: left;
    font-weight: 600;
    font-size: 0.8rem;
    color: #4A5568;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #D7CDB5;
  }
  tbody tr:nth-child(even) { background: #FAF7F0; }
  tbody tr:hover { background: #F0EBDC; }
  tbody td {
    padding: 0.6rem 0.85rem;
    border-bottom: 1px solid #EDE8DC;
    vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: none; }
  /* Checkbox */
  .check-cell { width: 2rem; text-align: center; }
  .cb {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid #C7A975;
    border-radius: 3px;
    background: #fff;
    vertical-align: middle;
  }
  /* Footer */
  .report-footer {
    text-align: center;
    font-size: 0.8rem;
    color: #9A7E4E;
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid #D7CDB5;
  }
  @media print {
    body { background: #fff; padding: 1rem; }
    .report-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .section { break-inside: avoid; }
    .section-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .badge { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    thead th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="report-header">
  <h1>⚜ ${esc(troopName)} — Roster Reconciliation</h1>
  <div class="report-meta">Generated ${dateStr}  •  ${total} item${total !== 1 ? "s" : ""} requiring attention</div>
</div>

<div class="summary">
  <div class="summary-item">
    <div class="summary-count" style="color:#1565C0">${missingId.length}</div>
    <div class="summary-label">Missing<br>BSA ID</div>
  </div>
  <div class="summary-item">
    <div class="summary-count" style="color:#2E7D32">${msOnly.length}</div>
    <div class="summary-label">Add to<br>TroopWebHost</div>
  </div>
  <div class="summary-item">
    <div class="summary-count" style="color:#E65100">${twhOnly.length}</div>
    <div class="summary-label">Missing in<br>Council Roster</div>
  </div>
  <div class="summary-item">
    <div class="summary-count" style="color:#003F87">${nameIssues.length}</div>
    <div class="summary-label">Name<br>Mismatches</div>
  </div>
  <div class="summary-item">
    <div class="summary-count" style="color:#6A1B9A">${rankIssues.length}</div>
    <div class="summary-label">Rank<br>Mismatches</div>
  </div>
</div>

${missingIdSection}
${msOnlySection}
${twhOnlySection}
${nameSection}
${rankSection}

<div class="report-footer">
  ${esc(troopName)} Roster Reconciliation  •  ${dateStr}  •  my.scouting is the source of truth
</div>
</body>
</html>`;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ═══════════════════════════════ CSV GENERATION ══════════════════════════
const CSV_HEADERS = [
  "Category", "BSA ID", "my.scouting Name", "TroopWebHost Name",
  "my.scouting Rank", "TroopWebHost Rank", "Note", "Registration Status", "TWH Patrol",
];

function buildCSV(results) {
  const escape = v => {
    const s = String(v || "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_HEADERS.join(",")];
  const addRows = (category, rows) => rows.forEach(r => lines.push([
    category, r.bsaId, r.myscoutingName, r.twhName,
    r.myscoutingRank, r.twhRank, r.note || "", r.registrationStatus, r.patrol,
  ].map(escape).join(",")));
  addRows("Missing BSA ID in TroopWebHost - cannot reconcile", results.missingId);
  addRows("In my.scouting only - add to TroopWebHost", results.msOnly);
  addRows("In TroopWebHost only - investigate", results.twhOnly);
  addRows("Name mismatch - review", results.nameIssues);
  addRows("Rank mismatch - review", results.rankIssues);
  return lines.join("\r\n");
}

// ═══════════════════════════════ PDF GENERATION ══════════════════════════
async function buildPDF(htmlPath) {
  const { chromium } = require("playwright");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "domcontentloaded" });
    const pdfPath = htmlPath.replace(/\.html$/, ".pdf");
    await page.pdf({
      path: pdfPath,
      format: "Letter",
      margin: { top: "0.75in", bottom: "0.75in", left: "0.75in", right: "0.75in" },
      printBackground: true,
    });
    return pdfPath;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ═══════════════════════════════ MAIN ENTRY POINT ════════════════════════
async function generate(inputs, outputDir, options = {}) {
  const { roster: rosterPath, scouting: scoutingPath } = inputs;
  if (!rosterPath || !fs.existsSync(rosterPath)) throw new Error("TroopWebHost roster CSV not provided");
  if (!scoutingPath || !fs.existsSync(scoutingPath)) throw new Error("my.scouting roster CSV not provided");

  const { map: twhMap, missingId } = loadTWH(rosterPath);
  const { map: msMap, troopName }  = loadMyScouting(scoutingPath);
  const results             = reconcile(twhMap, msMap, missingId);
  const dateStr             = todayLong();
  const ts = fileTimestamp();

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Always generate HTML
  const htmlFileName = `Roster_Reconciliation_${ts}.html`;
  const htmlPath     = path.join(outputDir, htmlFileName);
  fs.writeFileSync(htmlPath, buildHTML(results, troopName, dateStr), "utf8");

  const output = {
    htmlFileName,
    htmlPath,
    pdfPath: null,
    csvPath: null,
    stats: {
      missingBsaId:    results.missingId.length,
      addToTWH:        results.msOnly.length,
      investigateInTWH: results.twhOnly.length,
      nameMismatches:  results.nameIssues.length,
      rankMismatches:  results.rankIssues.length,
    },
  };

  // Optional PDF
  if (options.downloadPdf === true || options.downloadPdf === "true") {
    output.pdfPath = await buildPDF(htmlPath);
    output.pdfFileName = path.basename(output.pdfPath);
  }

  // Optional CSV
  if (options.downloadCsv === true || options.downloadCsv === "true") {
    const csvFileName = `Roster_Reconciliation_${ts}.csv`;
    output.csvPath = path.join(outputDir, csvFileName);
    output.csvFileName = csvFileName;
    fs.writeFileSync(output.csvPath, buildCSV(results), "utf8");
  }

  return output;
}

module.exports = { manifest, generate };
