"use strict";

/**
 * Tests for the Merit Badge Analysis "Almost There" reader.
 *   node test/merit-badges.test.js
 *
 * The first cut of this shipped wrong numbers because it assumed TroopWebHost's
 * Uncompleted Merit Badge Requirements export (report 52217) had one row per
 * outstanding requirement. It does not - it is a summary row per scout+badge
 * with the count already tallied, so every scout came out as "1 requirement
 * left". These tests pin both shapes down.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { processNearlyComplete } = require("../reports/merit-badges");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mb-test-"));
function csv(name, body) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, body.trim() + "\n", "utf8");
  return file;
}

// What report 52217 actually returns.
const COUNTS = csv("counts.csv", `
Scout,Merit Badge,Started,Completed Requirements,Uncompleted Requirements,Merit Badge Counselor
"Bowman, Molly",Astronomy,7/13/2026,30,3,Jen Nelson
"Bowman, Molly",*Camping,7/02/2025,0,38,
"Carmon, Deanna R",Art,7/13/2026,13,1,
"Blazejak, Mason",*First Aid,5/17/2026,18,82,
"Gervais, Abel",Weather (2014 rqmts),4/26/2025,10,3,
"Gervais, Abel",Sewing & Needlework (MERIT BADGE TEST LAB),1/01/2026,2,2,
`);

// The shape the rank report returns, kept as a fallback.
const ITEMIZED = csv("itemized.csv", `
Award,Code,Uncompleted Requirement,Scout
First Class (Current requirements),1.a,"Do something ranky","Blazejak, Mason"
Cooking,4a,"Plan a menu","Blazejak, Mason"
Cooking,4b,"Cook the meals","Blazejak, Mason"
Cooking,4b,"Cook the meals","Blazejak, Mason"
Cooking,6,"Discuss careers","Blazejak, Mason"
Astronomy,1,"Req 1","Bowman, Molly"
`);

const WRONG = csv("wrong.csv", `
Foo,Bar
1,2
`);

const noEarned = new Map();

test("counts shape: reads TWH's own uncompleted count, not the row count", () => {
  const r = processNearlyComplete(COUNTS, 5, noEarned);
  assert.strictEqual(r.shape, "counts");
  assert.strictEqual(r.parseLooksWrong, false);

  // Astronomy 3, Art 1, Weather 3. Camping (38) and First Aid (82) are further
  // out; the test-lab badge is not an official name.
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows.map((d) => d.remaining), [1, 3, 3]);
  assert.strictEqual(r.furtherOut, 2);
  assert.strictEqual(r.unmatched, 1);
  assert.strictEqual(r.scoutCount, 3);

  const art = r.rows.find((d) => d.badge === "Art");
  assert.strictEqual(art.scout, "Deanna Carmon");
  assert.strictEqual(art.completed, 13);
  assert.strictEqual(art.counselor, "");

  const astronomy = r.rows.find((d) => d.badge === "Astronomy");
  assert.strictEqual(astronomy.counselor, "Jen Nelson");
  assert.ok(astronomy.started instanceof Date);
});

test("counts shape: a vintage suffix and the Eagle asterisk are stripped", () => {
  const r = processNearlyComplete(COUNTS, 5, noEarned);
  assert.ok(r.rows.some((d) => d.badge === "Weather"), "\"Weather (2014 rqmts)\" should match Weather");
  const wide = processNearlyComplete(COUNTS, 100, noEarned);
  const firstAid = wide.rows.find((d) => d.badge === "First Aid");
  assert.ok(firstAid, "\"*First Aid\" should match First Aid");
  assert.strictEqual(firstAid.isEagle, true);
  assert.strictEqual(firstAid.remaining, 82);
});

test("counts shape: the threshold is inclusive and excludes finished badges", () => {
  assert.strictEqual(processNearlyComplete(COUNTS, 1, noEarned).rows.length, 1);
  assert.strictEqual(processNearlyComplete(COUNTS, 3, noEarned).rows.length, 3);
  // Every row in this export is work in progress, so nothing has 0 left.
  assert.ok(processNearlyComplete(COUNTS, 100, noEarned).rows.every((d) => d.remaining > 0));
});

test("a badge the scout already earned is not reported as outstanding", () => {
  const earned = new Map([["carmon, deanna", new Set(["art"])]]);
  const r = processNearlyComplete(COUNTS, 5, earned);
  assert.ok(!r.rows.some((d) => d.badge === "Art"), "earned badge should drop out");
  assert.strictEqual(r.rows.length, 2);
});

test("itemized shape: rows are counted and duplicates collapse", () => {
  const r = processNearlyComplete(ITEMIZED, 5, noEarned);
  assert.strictEqual(r.shape, "itemized");
  const cooking = r.rows.find((d) => d.badge === "Cooking");
  assert.strictEqual(cooking.remaining, 3, "the repeated 4b row must not inflate the count");
  assert.deepStrictEqual(cooking.codes, ["4a", "4b", "6"]);
  // The rank row is not an official badge name.
  assert.ok(!r.rows.some((d) => d.badge.includes("First Class")));
});

test("a file of neither shape is reported, not guessed at", () => {
  const r = processNearlyComplete(WRONG, 5, noEarned);
  assert.strictEqual(r.parseLooksWrong, true);
  assert.strictEqual(r.shape, null);
  assert.deepStrictEqual(r.headers, ["Foo", "Bar"]);
});

test("no file at all is a quiet empty result", () => {
  const r = processNearlyComplete(undefined, 5, noEarned);
  assert.strictEqual(r.hasData, false);
  assert.strictEqual(r.parseLooksWrong, false);
  assert.strictEqual(r.rows.length, 0);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
