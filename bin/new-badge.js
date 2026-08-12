#!/usr/bin/env node
"use strict";

/**
 * Troop Tools - create a badge definition from pasted requirement text.
 *
 *   node bin/new-badge.js --name "Personal Fitness" --in requirements/personal-fitness.txt
 *   pbpaste | node bin/new-badge.js --name "Citizenship in the Community"
 *   node bin/new-badge.js --name "Cooking" --in reqs.txt --revised 2026 --build
 *
 * Writes badges/<slug>.json, then tells you what to review. Nothing is
 * overwritten without --force.
 */

const fs = require("fs");
const path = require("path");
const { parseRequirements, slugify } = require("../lib/workbook/parse");
const { buildWorkbook, workbookFilename } = require("../lib/workbook");

const ROOT = path.join(__dirname, "..");
const BADGE_DIR = path.join(ROOT, "badges");
const REQ_DIR = path.join(ROOT, "requirements");
const OUT_DIR = path.join(ROOT, "output");

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) return true;
  return value;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

function monthYear() {
  return new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
}

async function main() {
  const args = process.argv.slice(2);
  const name = flag(args, "name");
  const inFile = flag(args, "in");
  const force = args.includes("--force");
  const build = args.includes("--build");
  const breaks = args.includes("--page-breaks");

  if (!name || name === true) {
    console.error([
      "Usage: node bin/new-badge.js --name \"Badge Name\" [--in FILE] [options]",
      "",
      "  --name <string>     Badge name. Required.",
      "  --in <file>         Requirement text file. Defaults to stdin.",
      "  --revised <year>    Year the requirements were last revised.",
      "  --page-breaks       Start each requirement on a new page.",
      "  --build             Also generate the .docx into output/.",
      "  --force             Overwrite an existing badge definition.",
    ].join("\n"));
    process.exitCode = 1;
    return;
  }

  let text;
  if (inFile && inFile !== true) {
    const resolved = path.isAbsolute(inFile) ? inFile : path.resolve(inFile);
    if (!fs.existsSync(resolved)) {
      console.error(`No such file: ${resolved}`);
      process.exitCode = 1;
      return;
    }
    text = fs.readFileSync(resolved, "utf8");
  } else {
    text = await readStdin();
    if (!text.trim()) {
      console.error("No requirement text on stdin. Use --in FILE, or pipe text in.");
      process.exitCode = 1;
      return;
    }
  }

  const slug = slugify(name);
  const dest = path.join(BADGE_DIR, `${slug}.json`);
  if (fs.existsSync(dest) && !force) {
    console.error(`badges/${slug}.json already exists. Re-run with --force to replace it.`);
    process.exitCode = 1;
    return;
  }

  let def;
  let warnings;
  try {
    ({ def, warnings } = parseRequirements(text, {
      badge: name,
      requirementsRevised: flag(args, "revised") === true ? undefined : flag(args, "revised"),
      workbookUpdated: monthYear(),
      pageBreakPerRequirement: breaks,
    }));
  } catch (err) {
    console.error(`Parse failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Keep the raw source next to the definition so the parse can be redone
  // when requirements are revised.
  fs.mkdirSync(REQ_DIR, { recursive: true });
  fs.writeFileSync(path.join(REQ_DIR, `${slug}.txt`), text);

  fs.mkdirSync(BADGE_DIR, { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(def, null, 2)}\n`);

  const subCount = def.requirements.reduce((n, r) => n + ((r.subs || []).length), 0);
  console.log(`Wrote badges/${slug}.json`);
  console.log(`  ${def.requirements.length} requirements, ${subCount} sub-requirements`);
  console.log(`  Raw text saved to requirements/${slug}.txt`);

  if (warnings.length) {
    console.log("\nParser warnings:");
    warnings.forEach((w) => console.log(`  - ${w}`));
  }

  console.log([
    "",
    "Next: open the JSON and review the capture areas.",
    "The parser puts a lined box under most items. Replace with a grid, fields,",
    "or numbered block where the requirement is really asking for structured data,",
    "and delete blocks from items that are discussion only.",
    "",
    `Then: node bin/generate-workbook.js ${slug}`,
  ].join("\n"));

  if (build) {
    const buffer = await buildWorkbook(def);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, workbookFilename(def));
    fs.writeFileSync(file, buffer);
    console.log(`\nBuilt ${path.relative(ROOT, file)}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
