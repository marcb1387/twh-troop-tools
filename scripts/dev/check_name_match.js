// Diagnostic: why isn't a Life Scout highlighted in the Eagle Merit Badge
// Matrix? The matrix comes from the Merit Badge History CSV; the "LIFE" flag
// comes from the Leadership Rank Requirement Status CSV. They only line up if
// the scout's name resolves to the same key in both. This prints those keys
// and flags every Life Scout that doesn't match, with near-miss candidates.
//
// Usage:
//   node scripts/dev/check_name_match.js <MeritBadgeHistory.csv> <LeadershipRankRequirementStatus.csv>
//
// Not part of the app.

const fs = require("fs");
const path = require("path");
const { parseCSV } = require("../../shared/csv-parser");
const { matchKey, nameKeys } = require("../../reports/eagle-prep");

const [mbPath, porPath] = process.argv.slice(2);
if (!mbPath || !porPath) {
  console.error("Usage: node scripts/dev/check_name_match.js <MeritBadgeHistory.csv> <LeadershipRankRequirementStatus.csv>");
  process.exit(1);
}
for (const p of [mbPath, porPath]) {
  if (!fs.existsSync(p)) { console.error(`No such file: ${p}`); process.exit(1); }
}

const mbRows  = parseCSV(fs.readFileSync(mbPath, "utf8"));
const mbNames = [...new Set(mbRows.map(r => (r.Scout || r.Name || "").trim()).filter(Boolean))];
const mbByKey = new Map();  // every key (legal + nickname) -> the raw name
for (const n of mbNames) for (const k of nameKeys(n)) if (!mbByKey.has(k)) mbByKey.set(k, n);

const porRows = parseCSV(fs.readFileSync(porPath, "utf8"));
const life = porRows
  .filter(r => (r["Next Rank"] || r.Rank || "").trim().toLowerCase() === "eagle")
  .map(r => ({ name: (r.Scout || r.Name || "").trim(), patrol: (r.Patrol || "").trim() }))
  .filter(s => s.name);

console.log(`Merit Badge History : ${path.basename(mbPath)} — ${mbNames.length} distinct scouts`);
console.log(`Leadership report   : ${path.basename(porPath)} — ${life.length} Life Scouts (Next Rank = Eagle)\n`);

let matched = 0;
for (const ls of life) {
  const keys = nameKeys(ls.name);
  const hitKey = keys.find(k => mbByKey.has(k));
  if (hitKey) {
    matched++;
    console.log(`  ✓  "${ls.name}"  ->  [${keys.join(" | ")}]  ->  matrix row "${mbByKey.get(hitKey)}"`);
    continue;
  }
  const surname = matchKey(ls.name).split(",")[0].trim();
  const near = mbNames.filter(n => matchKey(n).split(",")[0].trim() === surname);
  console.log(`  ✗  "${ls.name}"${ls.patrol ? ` (${ls.patrol})` : ""}  ->  [${keys.join(" | ")}]  — NOT FOUND in the merit-badge file`);
  if (near.length) {
    for (const n of near) console.log(`        candidate: "${n}"  ->  [${nameKeys(n).join(" | ")}]`);
  } else {
    console.log(`        no merit-badge scout with surname "${surname}" — this scout likely has no badges recorded`);
  }
}

console.log(`\n${matched}/${life.length} Life Scouts matched a matrix row.`);
if (matched < life.length) {
  console.log("For each ✗ above, compare the two keys: a differing first name = nickname/legal-name");
  console.log("mismatch; a trailing token = middle name; otherwise a typo in one of the exports.");
}
