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
const { defFromCatalogEntry, textFromCatalogEntry, classifyNote } = require("../lib/workbook/catalog");
const { buildWorkbook, workbookFromText, workbookFilename, validate } = require("../lib/workbook");

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

// ── Catalog import ─────────────────────────────────────────────────────
// A trimmed catalog entry in the shape mbworkbook/data/requirements.json uses.
const CATALOG_ENTRY = {
  name: "Test Catalog Badge",
  url: "https://www.scouting.org/merit-badges/test/",
  source_retrieved: "2026-09-03T02:33:15+00:00",
  requirements: [
    {
      marker: "1", level: 1, text: "Do the following:", notes: ["Note: this qualifies requirement 1."],
      children: [
        { marker: "(a)", level: 2, text: "Explain why this matters.", notes: ["Resource: Some Video (video)"], children: [] },
        { marker: "(b)", level: 2, text: "Identify three ways to do the thing.", notes: ["A Handout (website w/ video)"], children: [] },
      ],
    },
    {
      marker: "2", level: 1, text: "Complete ONE of the following options: Option A. Do ALL of the following:",
      notes: [], children: [
        { marker: "(1)", level: 2, text: "First option item.", notes: ["Option B. Do ALL of the following:"], children: [] },
        { marker: "(1)", level: 2, text: "Second option, first item.", notes: [], children: [] },
      ],
    },
    {
      marker: "3", level: 1, text: "A standalone requirement.",
      notes: ["4 Rescue Me. This requirement was lost into a note by the scrape."], children: [],
    },
  ],
};

test("classifies catalog notes by kind", () => {
  assert.strictEqual(classifyNote("Resource: A Thing (video)").kind, "resource");
  assert.strictEqual(classifyNote("A Thing (website w/ video)").kind, "resource");
  assert.strictEqual(classifyNote("Muscular Strength ( video)").kind, "resource");
  assert.strictEqual(classifyNote("Note: this is official.").kind, "official");
  assert.strictEqual(classifyNote("Option B. Do ALL of the following:").kind, "heading");
  assert.strictEqual(classifyNote("6 Plan the Program. Outline with your counselor.").kind, "orphan");
});

test("converts a catalog entry into a buildable definition", async () => {
  const { def, warnings, needsReview } = defFromCatalogEntry(CATALOG_ENTRY, {});
  assert.strictEqual(def.badge, "Test Catalog Badge");
  assert.strictEqual(def.requirements.length, 3);

  // Official "Note:" text joins the requirement it qualifies; resources go.
  assert.ok(def.requirements[0].text.includes("Note: this qualifies requirement 1."));
  const all = JSON.stringify(def);
  assert.ok(!all.includes("Some Video"), "resource notes should be dropped");
  assert.ok(!all.includes("A Handout"), "media-marker notes should be dropped");

  // Provenance lands on the definition.
  assert.strictEqual(def.sourceUrl, "https://www.scouting.org/merit-badges/test/");
  assert.strictEqual(def.verifiedOn, "2026-09-03");

  // Restarted option numbering and rescued text both flag for review.
  assert.ok(needsReview, "option numbering and orphaned text should flag review");
  assert.ok(warnings.some((w) => w.includes("appears more than once")));
  assert.ok(warnings.some((w) => w.includes("lost requirement text")));

  // Nothing is dropped: the rescued requirement survives as a caption.
  assert.ok(all.includes("Rescue Me"), "orphaned requirement text must be kept");

  const buffer = await buildWorkbook(def);
  assert.ok(buffer.length > 5000, "converted definition should build a docx");
});

test("catalog definitions satisfy the same validation as hand-written ones", () => {
  const { def } = defFromCatalogEntry(CATALOG_ENTRY, {});
  assert.doesNotThrow(() => validate(def));
});

test("catalog text round-trips through the paste parser", () => {
  const text = textFromCatalogEntry(CATALOG_ENTRY);
  const { def } = parseRequirements(text, { badge: "Test Catalog Badge" });
  assert.strictEqual(def.requirements.length, 3);
  assert.strictEqual(def.requirements[0].subs.length, 2);
  assert.ok(!text.includes("Some Video"), "resources should not reach the text form");
});
