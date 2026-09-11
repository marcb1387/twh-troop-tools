#!/usr/bin/env node
"use strict";

/**
 * Troop Tools - seed badge definitions from the official requirements catalog.
 *
 *   node bin/import-badges.js --list
 *   node bin/import-badges.js --only cooking,first-aid --dry-run
 *   node bin/import-badges.js                      # every badge not already saved
 *   node bin/import-badges.js --force --with-text  # re-import over existing files
 *
 * Writes badges/<slug>.json for each catalog entry, then tells you which ones a
 * human needs to look at. Nothing is overwritten without --force, so reviewed
 * definitions stay reviewed.
 *
 * The catalog is mbworkbook/data/requirements.json from the sibling
 * MeritBadgeWorkbook project - published requirement text, no TroopWebHost data
 * and no Scout attached to it. It is read at import time only; the badge JSON
 * this writes is self-contained.
 */

const fs = require("fs");
const path = require("path");
const { slugify } = require("../lib/workbook/parse");
const { defFromCatalogEntry, textFromCatalogEntry } = require("../lib/workbook/catalog");
const { buildWorkbook, workbookFilename } = require("../lib/workbook");

const ROOT = path.join(__dirname, "..");
const BADGE_DIR = path.join(ROOT, "badges");
const REQ_DIR = path.join(ROOT, "requirements");
const OUT_DIR = path.join(ROOT, "output");

// Where the catalog usually lives, in order of preference.
const CATALOG_CANDIDATES = [
  process.env.MB_CATALOG,
  path.join(ROOT, "data", "requirements.json"),
  path.join(ROOT, "..", "merit-badges", "mbworkbook", "data", "requirements.json"),
  path.join(ROOT, "..", "..", "merit-badges", "mbworkbook", "data", "requirements.json"),
].filter(Boolean);

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) return true;
  return value;
}

function monthYear() {
  return new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
}

function findCatalog(explicit) {
  const tried = [];
  const candidates = explicit && explicit !== true ? [path.resolve(explicit)] : CATALOG_CANDIDATES;
  for (const c of candidates) {
    tried.push(c);
    if (fs.existsSync(c)) return { file: c };
  }
  return { file: null, tried };
}

function loadCatalog(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw.badges !== "object") {
    throw new Error(`${file} is not a requirements catalog (no "badges" object).`);
  }
  return raw;
}

/** Accepts slugs or badge names, comma or space separated. */
function selectEntries(catalog, only) {
  const all = Object.entries(catalog.badges);
  if (!only || only === true) return all;
  const wanted = new Set(
    String(only).split(/[,\s]+/).filter(Boolean).map((s) => slugify(s))
  );
  const picked = all.filter(([slug, entry]) => wanted.has(slug) || wanted.has(slugify(entry.name)));
  const found = new Set(picked.flatMap(([slug, entry]) => [slug, slugify(entry.name)]));
  [...wanted].filter((w) => !found.has(w)).forEach((w) => {
    console.warn(`  ! No catalog entry for "${w}"`);
  });
  return picked;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "Usage: node bin/import-badges.js [options]",
      "",
      "  --catalog <file>    Requirements catalog JSON. Defaults to the sibling",
      "                      MeritBadgeWorkbook project, or $MB_CATALOG.",
      "  --only <list>       Only these badges (slugs or names, comma separated).",
      "  --list              Show catalog contents and what is already saved.",
      "  --dry-run           Report what would be written, write nothing.",
      "  --with-text         Also write requirements/<slug>.txt for re-parsing.",
      "  --page-breaks       Start each requirement on a new page.",
      "  --build             Also generate the .docx into output/.",
      "  --force             Overwrite existing badge definitions.",
      "  --quiet             Only print the summary and the review list.",
    ].join("\n"));
    return;
  }

  const { file: catalogFile, tried } = findCatalog(flag(args, "catalog"));
  if (!catalogFile) {
    console.error("Could not find a requirements catalog. Looked in:");
    tried.forEach((t) => console.error(`  ${t}`));
    console.error("\nPass one with --catalog <file>, or set MB_CATALOG.");
    process.exitCode = 1;
    return;
  }

  const catalog = loadCatalog(catalogFile);
  const entries = selectEntries(catalog, flag(args, "only"));
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const quiet = args.includes("--quiet");
  const withText = args.includes("--with-text");
  const build = args.includes("--build");
  const pageBreaks = args.includes("--page-breaks");

  console.log(`Catalog: ${catalogFile}`);
  console.log(`Built:   ${catalog.built || "unknown"}  (${Object.keys(catalog.badges).length} badges)\n`);

  if (args.includes("--list")) {
    entries.forEach(([slug, entry]) => {
      const saved = fs.existsSync(path.join(BADGE_DIR, `${slug}.json`));
      console.log(`  ${saved ? "saved  " : "       "} ${slug.padEnd(34)} ${entry.requirements.length} requirements`);
    });
    console.log(`\n${entries.filter(([s]) => fs.existsSync(path.join(BADGE_DIR, `${s}.json`))).length} of ${entries.length} already saved in badges/.`);
    return;
  }

  if (!dryRun) fs.mkdirSync(BADGE_DIR, { recursive: true });
  if (!dryRun && withText) fs.mkdirSync(REQ_DIR, { recursive: true });
  if (!dryRun && build) fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  const skipped = [];
  const failed = [];
  const review = [];

  for (const [slug, entry] of entries) {
    const dest = path.join(BADGE_DIR, `${slug}.json`);
    if (fs.existsSync(dest) && !force) {
      skipped.push(slug);
      continue;
    }

    let def;
    let warnings;
    let needsReview;
    try {
      ({ def, warnings, needsReview } = defFromCatalogEntry(entry, {
        workbookUpdated: monthYear(),
        pageBreakPerRequirement: pageBreaks,
      }));
    } catch (e) {
      failed.push(`${slug}: ${e.message}`);
      continue;
    }

    if (!dryRun) {
      fs.writeFileSync(dest, `${JSON.stringify(def, null, 2)}\n`, "utf8");
      if (withText) {
        fs.writeFileSync(path.join(REQ_DIR, `${slug}.txt`), textFromCatalogEntry(entry), "utf8");
      }
      if (build) {
        const buffer = await buildWorkbook(def);
        fs.writeFileSync(path.join(OUT_DIR, workbookFilename(def)), buffer);
      }
    }

    written.push(slug);
    if (needsReview) review.push({ slug, warnings });

    if (!quiet) {
      const flagText = needsReview ? "  ** needs review **" : "";
      console.log(`  ${dryRun ? "would write" : "wrote"} ${slug}.json  (${def.requirements.length} requirements, ${warnings.length} warning${warnings.length === 1 ? "" : "s"})${flagText}`);
    }
  }

  console.log("");
  console.log(`${dryRun ? "Would write" : "Wrote"}: ${written.length}   Skipped (already saved): ${skipped.length}   Failed: ${failed.length}`);
  if (skipped.length && !force) {
    console.log(`Re-run with --force to overwrite the ${skipped.length} existing definition${skipped.length === 1 ? "" : "s"}.`);
  }
  failed.forEach((f) => console.error(`  FAILED ${f}`));

  if (review.length) {
    console.log(`\n${review.length} badge${review.length === 1 ? "" : "s"} need${review.length === 1 ? "s" : ""} a human before a Scout sees the workbook:`);
    review.forEach(({ slug, warnings }) => {
      console.log(`\n  ${slug}`);
      warnings.slice(0, 4).forEach((w) => console.log(`    - ${w}`));
      if (warnings.length > 4) console.log(`    ... and ${warnings.length - 4} more`);
    });
    console.log("\nThese are almost all Option A/B/C badges, where the source restarts");
    console.log("numbering per option. The text is right; the grouping needs judgment.");
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
