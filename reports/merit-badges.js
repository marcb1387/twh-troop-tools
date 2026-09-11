const fs   = require("fs");
const path = require("path");
const { parseCSV } = require("../shared/csv-parser");
const { todayLong } = require("../shared/dates");
const { OFFICIAL_BADGES, EAGLE_REQUIRED_BADGES } = require("../shared/official-badges");

// ═══════════════════════════════ MANIFEST ════════════════════════════════
const manifest = {
  id:          "merit-badges",
  name:        "Merit Badge Analysis",
  description: "Troop-wide merit badge analytics: scouts a few requirements from finishing a badge, Eagle coverage, scout progress, popular electives, badges never earned, and stale badges worth repeating.",
  icon:        "🎖️",
  outputType:  "html",
  inputs: [
    {
      key:       "meritBadges",
      label:     "Merit Badge History CSV",
      hint:      "Export: Menu → Advancement → Advancement Status Reports → Merit Badge History By Scout By Badge Name → Open in Excel",
      required:  true,
      twhReport: "meritBadges",
    },
    {
      key:       "mbRequirements",
      label:     "Uncompleted Merit Badge Requirements CSV (optional)",
      hint:      "Export: Menu → Advancement → Requirements Reports → Uncompleted Merit Badge Requirements → Open in Excel. Enables the \"Almost There\" section: scouts a handful of requirements from finishing a badge. Optional — the rest of the report still generates without it.",
      required:  false,
      twhReport: "mbRequirements",
    },
  ],
  options: [
    {
      key:     "nearThreshold",
      label:   "\"Almost There\" cutoff — requirements still outstanding",
      type:    "select",
      default: "5",
      choices: [
        { value: "3",  label: "Within 3 requirements" },
        { value: "5",  label: "Within 5 requirements" },
        { value: "8",  label: "Within 8 requirements" },
        { value: "10", label: "Within 10 requirements" },
      ],
    },
    { key: "downloadPdf", label: "Also download PDF", type: "checkbox", default: false },
    { key: "downloadCsv", label: "Also download CSV", type: "checkbox", default: false },
  ],
};

// ═══════════════════════════════ CONSTANTS ═══════════════════════════════
const STALE_YEARS   = 2;
const MIN_SCOUTS    = 3;
const TOP_ELECTIVES = 25;
const NEAR_DEFAULT  = 5;   // "almost there" cutoff when no option is supplied
const MAX_CODES_SHOWN = 12; // remaining-requirement codes listed inline per row

// Column aliases for the two shapes a TroopWebHost requirements export can
// arrive in.
//
// "counts" is what report 52217 (Uncompleted Merit Badge Requirements) actually
// returns, confirmed against a live export: one summary row per scout+badge
// carrying the outstanding count directly.
//   Scout, Merit Badge, Started, Completed Requirements,
//   Uncompleted Requirements, Merit Badge Counselor
//
// "itemized" is the shape the rank report uses - one row per outstanding
// requirement, where the row count *is* the number left. Kept as a fallback in
// case a per-requirement merit badge export turns up.
//   Award, Code, Uncompleted Requirement, Scout
const SCOUT_COLS = ["Scout", "Name", "Scout Name"];
const AWARD_COLS = ["Merit Badge", "Award", "Advancement", "Achievement"];
const LEFT_COLS  = ["Uncompleted Requirements", "Requirements Uncompleted", "Requirements Remaining", "Uncompleted"];
const DONE_COLS  = ["Completed Requirements", "Requirements Completed", "Completed"];
const START_COLS = ["Started", "Start Date", "Date Started"];
const COUNSELOR_COLS = ["Merit Badge Counselor", "Counselor", "Merit Badge Counselors"];
const REQ_COLS   = ["Uncompleted Requirement", "Requirement", "Requirement Description", "Description"];
const CODE_COLS  = ["Code", "Requirement Code", "Req", "Requirement #", "Requirement Number"];

// ═══════════════════════════════ UTILITIES ═══════════════════════════════
function cleanName(n) {
  return n.replace(/^\*/, "")
    .replace(/\s*\([^)]*\)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(n) {
  return n.toLowerCase()
    .replace(/&/g, "and")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(s) {
  if (!s || !s.trim()) return null;
  const parts = s.trim().split("/").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return new Date(parts[2], parts[0] - 1, parts[1]);
}

function fmtScout(s) {
  const p = s.split(",");
  const last  = (p[0] || "").trim();
  const first = (p[1] || "").trim().split(/\s+/)[0];
  return first ? `${first} ${last}` : last;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt1(n) { return isNaN(n) ? "-" : Number(n).toFixed(1); }

// Case/whitespace-tolerant column lookup - TWH exports vary in header casing
// between reports, and a stray trailing space is common.
function pickCol(row, names) {
  for (const want of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === want.toLowerCase()) return row[key];
    }
  }
  return "";
}

// Scout identity across two TWH exports. Both use "Last, First M" but the
// middle initial and suffix are not consistently present between reports,
// so they are stripped before comparing (same reasoning as
// shared/name-normalize.js, kept local so badge normalizeName stays put).
function scoutKey(name) {
  return String(name || "")
    .trim()
    .replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)\s*$/i, "")
    .replace(/\s+[A-Za-z]\.?\s*$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Sorts "3", "3a", "10b" the way a human reads them, not as raw strings.
function compareCodes(a, b) {
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

const EAGLE_REQUIRED_NORM = new Set(EAGLE_REQUIRED_BADGES.map(normalizeName));
// normalized badge name -> canonical spelling, so the "almost there" table
// prints official names regardless of how TWH spelled them in the export.
const OFFICIAL_BY_NORM = new Map(OFFICIAL_BADGES.map(b => [normalizeName(b), b]));

// ═══════════════════════════════ DATA PROCESSING ════════════════════════
function processData(csvPath) {
  const raw  = fs.readFileSync(csvPath, "utf8");
  const rows = parseCSV(raw);

  const today     = new Date();
  const staleDate = new Date(today.getFullYear() - STALE_YEARS, today.getMonth(), today.getDate());
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;

  const eagleMap       = new Map(); // badge -> Set<scout>
  const electiveMap    = new Map(); // badge -> Set<scout>
  const scoutEagle     = new Map(); // scout -> Set<badge>
  const badgeLastEarned = new Map(); // badge -> Date
  const allScouts      = new Set();
  const scoutEarned    = new Map(); // scoutKey -> Set<normalized badge>

  rows.forEach(r => {
    const scout    = (r["Scout"] || "").trim();
    const rawBadge = (r["Merit Badge"] || "").trim();
    const badge    = cleanName(rawBadge);
    // TWH's asterisk marking turns out to be inconsistent per-row - some
    // genuinely Eagle-required completions (e.g. Citizenship in Society)
    // come through with no asterisk at all. Trust the canonical list first;
    // fall back to the asterisk only for a badge the list doesn't cover.
    const isEagle  = EAGLE_REQUIRED_NORM.has(normalizeName(badge)) || rawBadge.startsWith("*");
    const earned   = parseDate(r["Earned"]);
    if (!scout || !badge) return;

    allScouts.add(scout);

    const sk = scoutKey(scout);
    if (!scoutEarned.has(sk)) scoutEarned.set(sk, new Set());
    scoutEarned.get(sk).add(normalizeName(badge));

    if (earned) {
      const existing = badgeLastEarned.get(badge);
      if (!existing || earned > existing) badgeLastEarned.set(badge, earned);
    }

    if (isEagle) {
      if (!eagleMap.has(badge))  eagleMap.set(badge, new Set());
      eagleMap.get(badge).add(scout);
      if (!scoutEagle.has(scout)) scoutEagle.set(scout, new Set());
      scoutEagle.get(scout).add(badge);
    } else {
      if (!electiveMap.has(badge)) electiveMap.set(badge, new Set());
      electiveMap.get(badge).add(scout);
    }
  });

  // Never earned
  const earnedNorm = new Set(
    [...eagleMap.keys(), ...electiveMap.keys()].map(normalizeName)
  );
  const neverEarned = OFFICIAL_BADGES
    .filter(b => !earnedNorm.has(normalizeName(b)))
    .sort();

  // Worth repeating: 3+ scouts, not earned in 2+ years
  const allBadgeEntries = [
    ...[...eagleMap.entries()].map(([b, s]) => [b, s, true]),
    ...[...electiveMap.entries()].map(([b, s]) => [b, s, false]),
  ];
  const worthRepeating = allBadgeEntries
    .map(([badge, scouts, isEagle]) => {
      const last     = badgeLastEarned.get(badge);
      const yearsAgo = last ? (today - last) / msPerYear : 99;
      return { badge, scouts: scouts.size, isEagle, last, yearsAgo };
    })
    .filter(d => d.scouts >= MIN_SCOUTS && (!d.last || d.last < staleDate))
    .sort((a, b) => b.scouts - a.scouts);

  // Eagle sorted ascending (fewest scouts = most attention needed).
  // Starts from the canonical Eagle-required list, not just what's in the
  // data - a badge zero scouts have ever earned has zero rows in the CSV
  // (asterisk or not), so it would otherwise be invisible here entirely.
  // Anything the data flags as Eagle-required but isn't in the canonical
  // list (a naming mismatch, or the list going stale) is still included,
  // not silently dropped.
  const eagleFromData = [...eagleMap.entries()].map(([b, s]) => ({ badge: b, count: s.size }));
  const eagleFromDataNorm = new Set(eagleFromData.map(d => normalizeName(d.badge)));
  const eagleNeverEarned = EAGLE_REQUIRED_BADGES
    .filter(b => !eagleFromDataNorm.has(normalizeName(b)))
    .map(b => ({ badge: b, count: 0 }));
  const eagleSorted = [...eagleFromData, ...eagleNeverEarned]
    .sort((a, b) => a.count - b.count);

  // Top electives
  const electiveSorted = [...electiveMap.entries()]
    .map(([b, s]) => ({ badge: b, count: s.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_ELECTIVES);

  // Scout Eagle progress — only scouts who have started on Eagle trail
  const scoutProgress = [...scoutEagle.entries()]
    .map(([s, badges]) => ({ name: fmtScout(s), count: badges.size }))
    .sort((a, b) => b.count - a.count);

  return {
    scoutEarned,
    totalScouts:    allScouts.size,
    totalRows:      rows.length,
    eagleCount:     eagleMap.size,
    neverEarned,
    worthRepeating,
    eagleSorted,
    electiveSorted,
    scoutProgress,
    maxEagle: Math.max(...eagleSorted.map(e => e.count), 1),
    maxElective: Math.max(...electiveSorted.map(e => e.count), 1),
    maxScout: Math.max(...scoutProgress.map(s => s.count), 1),
  };
}

// ═══════════════════ NEARLY-COMPLETE BADGES (optional file) ═════════════
// TroopWebHost's Uncompleted Merit Badge Requirements export (report 52217)
// gives one summary row per scout+badge with the outstanding count already
// tallied - "Completed Requirements" / "Uncompleted Requirements" - plus who
// the counselor is and when the Scout started. Badges a Scout has finished
// aren't in the file at all, so every row is work in progress.
//
// A per-requirement export (one row per outstanding requirement, the shape the
// rank report uses) is still accepted: there the row count is the number left.
// Which shape arrived is decided by the columns present, and a file matching
// neither is reported rather than guessed at.
function processNearlyComplete(reqPath, threshold, scoutEarned) {
  const empty = {
    hasData: false, parseLooksWrong: false, shape: null, rawRowCount: 0,
    headers: [], threshold, rows: [], scoutCount: 0, furtherOut: 0, unmatched: 0,
  };
  if (!reqPath || !fs.existsSync(reqPath)) return empty;

  const rows    = parseCSV(fs.readFileSync(reqPath, "utf8"));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const hasCol  = names => names.some(w =>
    headers.some(k => k.trim().toLowerCase() === w.toLowerCase()));

  const shape = hasCol(LEFT_COLS) ? "counts"
              : (hasCol(CODE_COLS) || hasCol(REQ_COLS)) ? "itemized"
              : null;

  if (!rows.length || !hasCol(SCOUT_COLS) || !hasCol(AWARD_COLS) || !shape) {
    return { ...empty, hasData: true, parseLooksWrong: true, rawRowCount: rows.length, headers };
  }

  const num = v => {
    const n = parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  // Badge names arrive with TWH's Eagle asterisk and sometimes a requirements
  // vintage - "*Weather (2014 rqmts)" - both of which cleanName strips.
  const badgeOf = r => cleanName(pickCol(r, AWARD_COLS).trim());
  const scoutOf = r => pickCol(r, SCOUT_COLS).trim().replace(/^\*\s*/, "");

  const pairs = new Map();   // scoutKey||badgeNorm -> record
  let unmatched = 0;

  rows.forEach((r, i) => {
    const scoutRaw = scoutOf(r);
    const badge    = badgeOf(r);
    if (!scoutRaw || !badge) return;

    const badgeNorm = normalizeName(badge);
    // Anything not on the official list (a council's test-lab badge, a typo, or
    // a rank row in an itemized file) is counted out loud rather than dropped
    // on the floor.
    if (!OFFICIAL_BY_NORM.has(badgeNorm)) { unmatched++; return; }

    const key = `${scoutKey(scoutRaw)}||${badgeNorm}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        scout:     fmtScout(scoutRaw),
        sortName:  scoutRaw,
        scoutKey:  scoutKey(scoutRaw),
        badge:     OFFICIAL_BY_NORM.get(badgeNorm),
        isEagle:   EAGLE_REQUIRED_NORM.has(badgeNorm),
        remaining: 0,
        completed: null,
        started:   null,
        counselor: "",
        items:     new Map(),
      });
    }
    const p = pairs.get(key);

    if (shape === "counts") {
      const left = num(pickCol(r, LEFT_COLS));
      if (left === null) return;
      // A scout+badge listed twice (rare, but a re-registration does it) is
      // taken at its most complete.
      p.remaining = p.remaining ? Math.min(p.remaining, left) : left;
      p.completed = num(pickCol(r, DONE_COLS));
      p.started   = parseDate(pickCol(r, START_COLS));
      p.counselor = pickCol(r, COUNSELOR_COLS).trim();
    } else {
      // One row per outstanding requirement. A requirement listed twice (TWH
      // repeats a parent row for each child in some exports) must not inflate
      // the count.
      const code = pickCol(r, CODE_COLS).trim();
      const desc = pickCol(r, REQ_COLS).trim();
      p.items.set(code || desc || `row-${i}`, { code, desc });
    }
  });

  let furtherOut = 0;
  const near = [];

  pairs.forEach(p => {
    // A badge the scout has already completed shouldn't show as outstanding.
    // TWH leaves finished badges out of this export itself, but a stale file or
    // a badge signed off after it was pulled would sneak through.
    const earned = scoutEarned.get(p.scoutKey);
    if (earned && earned.has(normalizeName(p.badge))) return;

    const items     = [...p.items.values()];
    const remaining = shape === "counts" ? p.remaining : items.length;
    if (!remaining || remaining <= 0) return;
    if (remaining > threshold) { furtherOut++; return; }

    near.push({
      scout:     p.scout,
      sortName:  p.sortName,
      badge:     p.badge,
      isEagle:   p.isEagle,
      remaining,
      completed: p.completed,
      started:   p.started,
      counselor: p.counselor,
      codes:     items.map(it => it.code).filter(Boolean).sort(compareCodes),
      details:   items
        .map(it => [it.code, it.desc].filter(Boolean).join(" - "))
        .filter(Boolean)
        .sort(compareCodes),
    });
  });

  near.sort((a, b) =>
    a.remaining - b.remaining ||
    a.sortName.localeCompare(b.sortName) ||
    a.badge.localeCompare(b.badge));

  return {
    hasData: true,
    parseLooksWrong: false,
    shape,
    rawRowCount: rows.length,
    headers,
    threshold,
    rows: near,
    scoutCount: new Set(near.map(d => d.sortName)).size,
    furtherOut,
    unmatched,
  };
}

// ═══════════════════════════════ HTML GENERATION ════════════════════════
function bar(count, max, color) {
  const pct = Math.round((count / max) * 100);
  return `<div style="display:flex;align-items:center;gap:0.5rem">
    <div style="flex:1;background:#F0EBDC;border-radius:3px;height:12px;overflow:hidden">
      <div style="width:${pct}%;background:${color};height:100%;border-radius:3px"></div>
    </div>
    <span style="font-size:0.82rem;font-weight:700;min-width:1.5rem;text-align:right">${count}</span>
  </div>`;
}

function buildHTML(data, nearly, dateStr, troopName) {
  const label = troopName ? `${troopName} - ` : "";

  const OD    = "#3A4F2A";
  const RED   = "#C0392B";
  const AMBER = "#B8860B";
  const BLUE  = "#003F87";
  const DKBL  = "#0B3D6B";

  // ── Never Earned grid (CSS columns) ──
  const neverColHtml = data.neverEarned.map(b =>
    `<div style="font-size:0.85rem;padding:0.2rem 0;border-bottom:1px solid #EDE8DC;break-inside:avoid;">${esc(b)}</div>`
  ).join("");

  // ── Almost There (optional requirements file) ──
  const nearHeading = `<h2>Almost There \u2014 Scouts Within ${nearly.threshold} Requirement${nearly.threshold === 1 ? "" : "s"} of a Badge</h2>`;
  let nearlyHtml;

  if (!nearly.hasData) {
    nearlyHtml = `${nearHeading}
<div class="section"><p class="note" style="margin:0">Add the <strong>Uncompleted Merit Badge Requirements</strong> CSV (Advancement \u2192 Requirements Reports) to list scouts who are a handful of sign-offs from finishing a badge. The Merit Badge History export on its own only records finished badges, so partial progress can't be seen without it.</p></div>`;
  } else if (nearly.parseLooksWrong) {
    nearlyHtml = `${nearHeading}
<div class="section"><p class="note" style="margin:0;color:${RED}">A requirements file was supplied (${nearly.rawRowCount} row${nearly.rawRowCount === 1 ? "" : "s"}) but it isn't a merit badge requirements export. It needs a <em>Scout</em> column, a <em>Merit Badge</em> column, and either an <em>Uncompleted Requirements</em> count or one row per outstanding requirement. Columns found: ${esc(nearly.headers.join(", ") || "none")}.</p></div>`;
  } else if (nearly.rows.length === 0) {
    const why = nearly.furtherOut > 0
      ? `${nearly.furtherOut} scout-badge combination${nearly.furtherOut === 1 ? " has" : "s have"} outstanding requirements, but none within ${nearly.threshold}.`
      : `No badges in progress were found in that file \u2014 check that it's the merit badge version of the report, not the rank version.`;
    nearlyHtml = `${nearHeading}
<div class="section"><p class="note" style="margin:0">${esc(why)}</p></div>`;
  } else {
    const counts = nearly.shape === "counts";
    const staleYears = d => d.started ? (new Date() - d.started) / (365.25 * 24 * 60 * 60 * 1000) : null;

    const nearRows = nearly.rows.map(d => {
      const cls = d.remaining <= 2 ? `color:${OD};font-weight:700`
                : d.remaining <= 5 ? `color:${AMBER};font-weight:700`
                : `font-weight:600`;

      let tail;
      if (counts) {
        const yrs = staleYears(d);
        // A badge opened a long time ago with only a few items left is the
        // one most worth a nudge, so the age carries the emphasis.
        const startCls = yrs === null ? "" : yrs >= 2 ? `color:${RED};font-weight:600`
                        : yrs >= 1 ? `color:${AMBER};font-weight:600` : "";
        const startTxt = d.started
          ? d.started.toLocaleDateString("en-US", { month: "short", year: "numeric" })
          : "\u2014";
        const done = d.completed === null ? "\u2014" : d.completed;
        tail = `<td>${done}</td>
        <td style="${startCls}" title="${yrs === null ? "" : `${fmt1(yrs)} years ago`}">${esc(startTxt)}</td>
        <td style="font-size:0.82rem">${d.counselor ? esc(d.counselor) : `<span style="color:#4A5568">none assigned</span>`}</td>`;
      } else {
        const shown = d.codes.slice(0, MAX_CODES_SHOWN).join(", ");
        const more  = d.codes.length > MAX_CODES_SHOWN ? ` +${d.codes.length - MAX_CODES_SHOWN} more` : "";
        tail = `<td title="${esc(d.details.join(" | "))}" style="font-size:0.8rem">${esc(shown)}${more}</td>`;
      }

      return `<tr>
        <td>${esc(d.scout)}</td>
        <td>${esc(d.badge)}${d.isEagle ? `<span class="tag-eagle">Eagle</span>` : ""}</td>
        <td style="${cls}">${d.remaining}</td>
        ${tail}
      </tr>`;
    }).join("");

    const copyList = nearly.rows
      .map(d => {
        const extra = counts
          ? (d.counselor ? ` - counselor ${d.counselor}` : " - no counselor")
          : (d.codes.length ? `: ${d.codes.join(", ")}` : "");
        return `${d.scout} - ${d.badge} (${d.remaining} left)${extra}`;
      })
      .join("\n");

    const headCells = counts
      ? `<th>Scout</th><th>Merit Badge</th><th>Left</th><th>Done</th><th>Started</th><th>Counselor</th>`
      : `<th>Scout</th><th>Merit Badge</th><th>Left</th><th>Requirements Remaining</th>`;

    const notes = [
      `${nearly.rows.length} badge${nearly.rows.length === 1 ? "" : "s"} across ${nearly.scoutCount} scout${nearly.scoutCount === 1 ? "" : "s"} with ${nearly.threshold} or fewer requirements still outstanding \u2014 the shortest list of nudges that would turn into finished badges. Closest first.`,
      counts ? `<strong>Left</strong> and <strong>Done</strong> are TroopWebHost's own counts of that Scout's outstanding and completed requirements. A start date in amber or red means the badge has been open a year or more.` : `Hover a row's remaining requirements for the full wording.`,
      nearly.furtherOut > 0 ? `${nearly.furtherOut} badge${nearly.furtherOut === 1 ? " is" : "s are"} in progress but further out than ${nearly.threshold}, and not shown.` : "",
      nearly.unmatched > 0 ? `${nearly.unmatched} row${nearly.unmatched === 1 ? "" : "s"} skipped: not an official BSA merit badge name.` : "",
    ].filter(Boolean).join(" ");

    nearlyHtml = `${nearHeading}
<p class="note">${notes}</p>
<div class="section">
  <div class="copy-area">
    <table>
      <thead><tr>${headCells}</tr></thead>
      <tbody>${nearRows}</tbody>
    </table>
    <div class="copy-aside">
      <label>Copy-paste list</label>
      <textarea readonly id="near-ta">${esc(copyList)}</textarea>
      <button class="copy-btn" onclick="const t=document.getElementById('near-ta');t.select();document.execCommand('copy');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy All',1500)">Copy All</button>
    </div>
  </div>
</div>`;
  }

  // ── Worth repeating table ──
  const worthHtml = data.worthRepeating.length === 0
    ? `<p style="color:#4A5568;font-style:italic;padding:0.5rem 0">No badges match this criteria.</p>`
    : `<table>
        <thead><tr>
          <th>Merit Badge</th><th>Scouts Ever Earned</th><th>Last Earned</th><th>Years Since</th>
        </tr></thead>
        <tbody>
          ${data.worthRepeating.map(d => {
            const cls   = d.yearsAgo >= 3 ? `color:${RED};font-weight:700` : `color:${AMBER};font-weight:600`;
            const lastFmt = d.last
              ? d.last.toLocaleDateString("en-US", { month: "short", year: "numeric" })
              : "No record";
            return `<tr>
              <td>${esc(d.badge)}${d.isEagle ? `<span class="tag-eagle">Eagle</span>` : ""}</td>
              <td>${d.scouts}</td>
              <td style="${cls}">${esc(lastFmt)}</td>
              <td style="${cls}">${d.yearsAgo < 99 ? fmt1(d.yearsAgo) + " yrs" : "-"}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;

  // ── Eagle coverage table ──
  const eagleHtml = data.eagleSorted.map(d => {
    const color = d.count <= 5 ? RED : d.count <= 10 ? AMBER : OD;
    return `<tr>
      <td>${esc(d.badge)}</td>
      <td style="width:60%">${bar(d.count, data.maxEagle, color)}</td>
    </tr>`;
  }).join("");

  // ── Elective table ──
  const electiveHtml = data.electiveSorted.map(d => `<tr>
    <td>${esc(d.badge)}</td>
    <td style="width:60%">${bar(d.count, data.maxElective, BLUE)}</td>
  </tr>`).join("");

  // ── Scout progress table ──
  const progressHtml = data.scoutProgress.map(d => {
    const color = d.count >= 14 ? DKBL : d.count >= 8 ? BLUE : d.count >= 4 ? OD : AMBER;
    return `<tr>
      <td>${esc(d.name)}</td>
      <td style="width:55%">${bar(d.count, data.maxScout, color)}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(label)}Merit Badge Analysis - ${esc(dateStr)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #FAF7F0; color: #1C2340; padding: 2rem; max-width: 1100px; margin: 0 auto; }
  .report-header { background: #2A3A1F; color: #fff; padding: 1.75rem 2rem;
    border-radius: 10px; margin-bottom: 1.5rem; border-bottom: 4px solid #C7A975; }
  .report-header h1 { font-size: 1.6rem; font-weight: 800; }
  .report-meta { font-size: 0.9rem; color: #E8DCC0; margin-top: 0.3rem; font-style: italic; }
  h2 { font-size: 1rem; font-weight: 700; color: #2A3A1F; border-bottom: 2px solid #C7A975;
    padding-bottom: 0.35rem; margin: 1.75rem 0 0.75rem; }
  .note { font-size: 0.82rem; color: #4A5568; font-style: italic; margin-bottom: 0.75rem; }
  .summary { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .stat { background: #fff; border: 1px solid #D7CDB5; border-radius: 8px;
    padding: 0.85rem 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,.06); min-width: 130px; }
  .stat-n { font-size: 2rem; font-weight: 800; color: #3A4F2A; line-height: 1; }
  .stat-l { font-size: 0.78rem; color: #4A5568; margin-top: 0.2rem; }
  .section { background: #fff; border: 1px solid #D7CDB5; border-radius: 10px;
    padding: 1.25rem; margin-bottom: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  .copy-area { display: flex; gap: 1.5rem; align-items: flex-start; flex-wrap: wrap; }
  .copy-area table { flex: 1; border-collapse: collapse; }
  .copy-aside { flex: 0 0 200px; }
  .copy-aside label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: #4A5568; display: block; margin-bottom: 0.35rem; }
  .copy-aside textarea { width: 100%; height: 260px; font-size: 0.78rem; font-family: monospace;
    border: 1px solid #D7CDB5; border-radius: 6px; padding: 0.5rem;
    background: #FAF7F0; color: #1C2340; resize: vertical; line-height: 1.7; }
  .copy-btn { margin-top: 0.4rem; width: 100%; padding: 0.4rem; background: #3A4F2A;
    color: #fff; border: none; border-radius: 5px; font-size: 0.8rem; cursor: pointer; }
  .copy-btn:hover { background: #5C7A47; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
  thead th { background: #F0EBDC; padding: 0.45rem 0.75rem; text-align: left;
    font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    color: #4A5568; border-bottom: 1px solid #D7CDB5; }
  tbody tr:nth-child(even) { background: #FAF7F0; }
  tbody tr:hover { background: #F0EBDC; }
  tbody td { padding: 0.45rem 0.75rem; border-bottom: 1px solid #EDE8DC; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  .tag-eagle { background: #0B3D6B; color: #fff; font-size: 0.68rem;
    padding: 0.1rem 0.35rem; border-radius: 3px; margin-left: 0.4rem; vertical-align: middle; }
  .report-footer { text-align: center; font-size: 0.8rem; color: #9A7E4E;
    margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #D7CDB5; }
  @media print {
    body { background: #fff; padding: 1rem; }
    .report-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .section { break-inside: avoid; }
    .copy-aside { display: none; }
    h2 { break-after: avoid; }
    .note { break-after: avoid; }
  }
</style>
</head>
<body>
<div class="report-header">
  <h1>⚜ ${esc(label)}Merit Badge Analysis</h1>
  <div class="report-meta">Generated ${esc(dateStr)}  •  ${data.totalScouts} scouts  •  ${data.totalRows} total completions</div>
</div>

<div class="summary">
  <div class="stat"><div class="stat-n">${data.totalScouts}</div><div class="stat-l">Scouts in file</div></div>
  <div class="stat"><div class="stat-n">${data.totalRows}</div><div class="stat-l">Total completions</div></div>
  <div class="stat"><div class="stat-n">${data.eagleCount}</div><div class="stat-l">Eagle badges earned</div></div>
  <div class="stat"><div class="stat-n">${data.neverEarned.length}</div><div class="stat-l">Badges never earned</div></div>
  <div class="stat"><div class="stat-n">${data.worthRepeating.length}</div><div class="stat-l">Badges worth repeating</div></div>
  ${nearly.hasData && !nearly.parseLooksWrong ? `
  <div class="stat"><div class="stat-n">${nearly.rows.length}</div><div class="stat-l">Badges within ${nearly.threshold} requirements</div></div>` : ""}
</div>

<!-- Almost There -->
${nearlyHtml}

<!-- Never Earned -->
<h2>Badges Never Earned (${data.neverEarned.length} of ${OFFICIAL_BADGES.length} official BSA badges)</h2>
<p class="note">No scout in this file has a completion record for any badge below. Good starting list for planning merit badge events or summer camp.</p>
<div class="section">
  <div class="copy-area">
    <div style="flex:1;columns:3 160px;column-gap:0.75rem;">${neverColHtml}</div>
    <div class="copy-aside">
      <label>Copy-paste list</label>
      <textarea readonly id="never-ta">${data.neverEarned.map(b => esc(b)).join("\n")}</textarea>
      <button class="copy-btn" onclick="const t=document.getElementById('never-ta');t.select();document.execCommand('copy');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy All',1500)">Copy All</button>
    </div>
  </div>
</div>

<!-- Worth Repeating -->
<h2>Badges Worth Repeating — ${MIN_SCOUTS}+ Scouts, Not Earned in ${STALE_YEARS}+ Years</h2>
<p class="note">Popular with this troop historically but no completion recorded recently. Good candidates for organizing a merit badge event.</p>
<div class="section">${worthHtml}</div>

<!-- Eagle Coverage -->
<h2>Eagle-Required Badge Coverage — sorted by fewest completions</h2>
<p class="note">Red = 5 or fewer scouts. Amber = 6-10 scouts.</p>
<div class="section"><table><tbody>${eagleHtml}</tbody></table></div>

<!-- Scout Eagle Progress -->
<h2>Scout Eagle-Required Badge Progress</h2>
<p class="note">Dark blue = 14+ badges — likely close to Eagle.</p>
<div class="section"><table><tbody>${progressHtml}</tbody></table></div>

<!-- Top Electives -->
<h2>Top ${TOP_ELECTIVES} Elective Badges</h2>
<div class="section"><table><tbody>${electiveHtml}</tbody></table></div>

<div class="report-footer">
  ${esc(label)}Merit Badge Analysis  •  ${esc(dateStr)}
</div>
</body>
</html>`;
}

// ═══════════════════════════════ CSV GENERATION ════════════════════════
function buildCSV(data, nearly) {
  const esc2 = v => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];

  if (nearly.hasData && !nearly.parseLooksWrong) {
    lines.push(`== ALMOST THERE (WITHIN ${nearly.threshold} REQUIREMENTS) ==`);
    if (nearly.shape === "counts") {
      lines.push(["Scout","Merit Badge","Eagle Required","Requirements Left","Requirements Completed","Started","Counselor"].join(","));
      nearly.rows.forEach(d => lines.push(
        [d.scout, d.badge, d.isEagle ? "Yes" : "No", d.remaining,
         d.completed === null ? "" : d.completed,
         d.started ? d.started.toLocaleDateString("en-US") : "",
         d.counselor].map(esc2).join(",")));
    } else {
      lines.push(["Scout","Merit Badge","Eagle Required","Requirements Left","Remaining Codes"].join(","));
      nearly.rows.forEach(d => lines.push(
        [d.scout, d.badge, d.isEagle ? "Yes" : "No", d.remaining, d.codes.join(" ")]
          .map(esc2).join(",")));
    }
    lines.push("");
  }

  lines.push("== BADGES NEVER EARNED ==");
  lines.push(["Merit Badge"].join(","));
  data.neverEarned.forEach(b => lines.push(esc2(b)));
  lines.push("");

  lines.push("== BADGES WORTH REPEATING ==");
  lines.push(["Merit Badge","Eagle Required","Scouts Ever Earned","Last Earned","Years Since"].join(","));
  data.worthRepeating.forEach(d => {
    const lastFmt = d.last
      ? d.last.toLocaleDateString("en-US", { month:"short", year:"numeric" })
      : "No record";
    lines.push([d.badge, d.isEagle ? "Yes" : "No", d.scouts, lastFmt,
      d.yearsAgo < 99 ? fmt1(d.yearsAgo) : ""].map(esc2).join(","));
  });
  lines.push("");

  lines.push("== EAGLE-REQUIRED COVERAGE ==");
  lines.push(["Merit Badge","Scouts Earned"].join(","));
  data.eagleSorted.forEach(d => lines.push([d.badge, d.count].map(esc2).join(",")));
  lines.push("");

  lines.push("== SCOUT EAGLE PROGRESS ==");
  lines.push(["Scout","Eagle Badges Earned"].join(","));
  data.scoutProgress.forEach(d => lines.push([d.name, d.count].map(esc2).join(",")));

  return lines.join("\r\n");
}

// ═══════════════════════════════ PDF GENERATION ═════════════════════════
async function buildPDF(htmlPath) {
  const { chromium } = require("playwright");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "domcontentloaded" });
    const pdfPath = htmlPath.replace(/\.html$/, ".pdf");
    await page.pdf({
      path: pdfPath, format: "Letter",
      margin: { top: "0.75in", bottom: "0.75in", left: "0.75in", right: "0.75in" },
      printBackground: true,
    });
    return pdfPath;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ═══════════════════════════════ TIMESTAMP ══════════════════════════════
function fileTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

// ═══════════════════════════════ MAIN ═══════════════════════════════════
async function generate(inputs, outputDir, options = {}) {
  const { meritBadges: csvPath, mbRequirements: reqPath } = inputs;
  if (!csvPath || !fs.existsSync(csvPath)) throw new Error("Merit Badge History CSV not provided");

  const parsedThreshold = parseInt(options.nearThreshold, 10);
  const nearThreshold   = Number.isFinite(parsedThreshold) && parsedThreshold > 0
    ? parsedThreshold : NEAR_DEFAULT;

  const data    = processData(csvPath);
  const nearly  = processNearlyComplete(reqPath, nearThreshold, data.scoutEarned);
  const dateStr = todayLong();
  const ts      = fileTimestamp();
  const troopName = options.troopName || "";

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const htmlFileName = `Merit_Badge_Analysis_${ts}.html`;
  const htmlPath     = path.join(outputDir, htmlFileName);
  fs.writeFileSync(htmlPath, buildHTML(data, nearly, dateStr, troopName), "utf8");

  const output = {
    htmlFileName,
    htmlPath,
    pdfPath:  null,
    csvPath2: null,
    stats: {
      scouts:      data.totalScouts,
      completions: data.totalRows,
      neverEarned: data.neverEarned.length,
      worthRepeating: data.worthRepeating.length,
      almostThere: nearly.hasData && !nearly.parseLooksWrong ? nearly.rows.length : null,
    },
  };

  if (options.downloadPdf === true || options.downloadPdf === "true") {
    output.pdfPath     = await buildPDF(htmlPath);
    output.pdfFileName = path.basename(output.pdfPath);
  }

  if (options.downloadCsv === true || options.downloadCsv === "true") {
    const csvFileName  = `Merit_Badge_Analysis_${ts}.csv`;
    const csvOut       = path.join(outputDir, csvFileName);
    fs.writeFileSync(csvOut, buildCSV(data, nearly), "utf8");
    output.csvPath     = csvOut;
    output.csvFileName = csvFileName;
  }

  return output;
}

// processNearlyComplete is exported for test/merit-badges.test.js; the
// server only ever uses manifest + generate.
module.exports = { manifest, generate, processNearlyComplete };
