#!/usr/bin/env node
"use strict";

/**
 * Troop Tools - Merit Badge Workbook generator (CLI)
 *
 *   node bin/generate-workbook.js personal-fitness
 *   node bin/generate-workbook.js personal-fitness --out ./output
 *   node bin/generate-workbook.js --all
 *   node bin/generate-workbook.js --list
 */

const fs = require("fs");
const path = require("path");
const { buildWorkbook, workbookFilename } = require("../lib/workbook");

const BADGE_DIR = path.join(__dirname, "..", "badges");
const DEFAULT_OUT = path.join(__dirname, "..", "output");

function listBadges() {
  if (!fs.existsSync(BADGE_DIR)) return [];
  return fs.readdirSync(BADGE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

function loadBadge(slug) {
  const file = path.join(BADGE_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No badge definition at badges/${slug}.json. Available: ${listBadges().join(", ") || "(none)"}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`badges/${slug}.json is not valid JSON: ${err.message}`);
  }
}

async function generate(slug, outDir) {
  const def = loadBadge(slug);
  const buffer = await buildWorkbook(def);
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, workbookFilename(def));
  fs.writeFileSync(dest, buffer);
  return dest;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    const badges = listBadges();
    console.log(badges.length ? badges.join("\n") : "No badge definitions found in badges/");
    return;
  }

  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;
  const consumed = new Set(outIdx !== -1 ? [outIdx, outIdx + 1] : []);
  const slugs = args.includes("--all")
    ? listBadges()
    : args.filter((a, i) => !consumed.has(i) && !a.startsWith("--"));

  if (slugs.length === 0) {
    console.error("Usage: node bin/generate-workbook.js <badge-slug> [--out DIR]");
    console.error("       node bin/generate-workbook.js --all");
    console.error("       node bin/generate-workbook.js --list");
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const slug of slugs) {
    try {
      const dest = await generate(slug, outDir);
      console.log(`OK   ${slug} -> ${dest}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${slug}: ${err.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
