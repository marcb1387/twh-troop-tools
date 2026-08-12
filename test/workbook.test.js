"use strict";

/**
 * Smoke tests for the workbook generator.
 *   node test/workbook.test.js
 *
 * Uses node:test, which ships with Node 18+. No new dev dependency.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { parseRequirements, slugify } = require("../lib/workbook/parse");
const { buildWorkbook, workbookFromText, workbookFilename } = require("../lib/workbook");

const SAMPLE = `
1. Do the following:

    (a) Explain why this matters.
    Resource: Some Video (video)
    (b) Identify three ways to do the thing.
    Resources: A PDF (PDF)
    Another Thing (video)

2 Second requirement without a period. Do the following:

    (a) Keep a log of what you eat and drink for a period of three days.
    (b) Discuss your results with your counselor.
`;

test("parses requirements and strips resource lines", () => {
  const { def, warnings } = parseRequirements(SAMPLE, { badge: "Test Badge" });
  assert.strictEqual(def.requirements.length, 2);
  assert.strictEqual(def.requirements[0].subs.length, 2);
  assert.strictEqual(def.requirements[1].subs.length, 2);
  assert.strictEqual(warnings.length, 0);
  const all = JSON.stringify(def);
  assert.ok(!all.includes("Some Video"), "resource lines should be dropped");
  assert.ok(!all.includes("Another Thing"), "resource continuations should be dropped");
});

test("handles a requirement number with no trailing period", () => {
  const { def } = parseRequirements(SAMPLE, { badge: "Test Badge" });
  assert.strictEqual(def.requirements[1].num, 2);
  assert.ok(def.requirements[1].text.startsWith("Second requirement"));
});

test("infers a numbered block from a counted list", () => {
  const { def } = parseRequirements(SAMPLE, { badge: "Test Badge" });
  const sub = def.requirements[0].subs[1];
  assert.strictEqual(sub.blocks[0].type, "numbered");
  assert.strictEqual(sub.blocks[0].count, 3);
});

test("infers a day grid from a food log", () => {
  const { def } = parseRequirements(SAMPLE, { badge: "Test Badge" });
  const sub = def.requirements[1].subs[0];
  assert.strictEqual(sub.blocks[0].type, "grid");
  assert.deepStrictEqual(sub.blocks[0].headers, ["Day 1", "Day 2", "Day 3"]);
});

test("wraps continuation lines into the item above", () => {
  const { def } = parseRequirements([
    "1. First line of the requirement",
    "   which continues on the next line.",
  ].join("\n"), { badge: "Wrap Test" });
  assert.ok(def.requirements[0].text.includes("which continues"));
});

test("rejects empty and unstructured input", () => {
  assert.throws(() => parseRequirements("", { badge: "X" }), /No requirement text/);
  assert.throws(() => parseRequirements("just some prose", { badge: "X" }), /No numbered requirements/);
});

test("warns on a numbering gap instead of failing", () => {
  const { def, warnings } = parseRequirements("1. One\n\n3. Three", { badge: "Gap" });
  assert.strictEqual(def.requirements.length, 2);
  assert.ok(warnings.some((w) => /numbering jumps/.test(w)));
});

test("slugify produces filesystem-safe names", () => {
  assert.strictEqual(slugify("Personal Fitness"), "personal-fitness");
  assert.strictEqual(slugify("Citizenship in the World"), "citizenship-in-the-world");
});

test("builds a non-trivial docx from parsed text", async () => {
  const { buffer, filename } = await workbookFromText(SAMPLE, { badge: "Test Badge" });
  assert.ok(buffer.length > 5000, "docx should not be empty");
  assert.strictEqual(buffer.slice(0, 2).toString("latin1"), "PK", "docx should be a zip");
  assert.strictEqual(filename, "Test-Badge-Workbook.docx");
});

test("every saved badge definition still builds", async () => {
  const dir = path.join(__dirname, "..", "badges");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const def = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const buffer = await buildWorkbook(def);
    assert.ok(buffer.length > 5000, `${f} produced an empty workbook`);
    assert.ok(workbookFilename(def).endsWith(".docx"));
  }
});
