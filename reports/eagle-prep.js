/**
 * Eagle Preparedness Report
 *
 * Per-scout view of Eagle-required merit badge progress: which of the 13
 * required categories each scout has earned, which are still missing, and
 * how their elective count stacks up toward the 21-badge total. Complements
 * Merit Badge Analysis (which is troop-wide/badge-centric) with a
 * scout-centric view built for planning who's close to Eagle and what
 * merit badge counselors or events the troop should prioritize.
 *
 * Also includes an Eagle Palms projection (Palm insignia earned so far and
 * how many merit badges to the next one, for every scout with all 13 required
 * categories and 21+ total badges) and, when the "Leadership Rank Requirement
 * Status" CSV is supplied, an Eagle requirement 4 (position of responsibility)
 * tracker driven by TroopWebHost's own Leadership Days tally.
 */

const fs   = require("fs");
const path = require("path");
const { parseCSV } = require("../shared/csv-parser");
const { parseDate, todayLong } = require("../shared/dates");
const { formatDisplayName, normalizeName } = require("../shared/name-normalize");

// ═══════════════════════════════ MANIFEST ════════════════════════════════
const manifest = {
  id:          "eagle-prep",
  name:        "Eagle Preparedness Report",
  description: "Per-scout breakdown of Eagle-required merit badges: what's earned, what's missing, and how close each scout is to the 21-badge total. Plus an Eagle Palms projection and a Life Scout position-of-responsibility tracker (Eagle requirement 4).",
  icon:        "🦅",
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
      key:      "porHistory",
      label:    "Leadership Rank Requirement Status CSV (optional)",
      hint:     "Export: Menu → Advancement → Advancement Status Reports → Leadership Rank Requirement Status → Open in Excel. Enables the Eagle requirement 4 (position-of-responsibility) section: which Life Scouts have served six months in an approved position.",
      required: false,
      twhReport: "porHistory",
    },
  ],
  options: [
    { key: "onlyStarted", label: "Only show scouts with at least one Eagle-required badge", type: "checkbox", default: true },
    { key: "downloadPdf", label: "Also download PDF", type: "checkbox", default: false },
    { key: "downloadCsv", label: "Also download CSV", type: "checkbox", default: false },
  ],
};

// ═══════════════════════════════ CONSTANTS ═══════════════════════════════
// The 13 Eagle-required categories, current as of the Feb. 27, 2026 removal
// of Citizenship in Society (Eagle: 13 required + 8 elective = 21 total).
// Three categories are "pick one of these" - if a scout earns more than one
// alternative in a category, the earliest satisfies the requirement and any
// extra alternative counts as one of their electives, same as BSA counts it.
const EAGLE_CATEGORIES = [
  { label: "Camping",                                badges: ["Camping"] },
  { label: "Citizenship in the Community",           badges: ["Citizenship in the Community"] },
  { label: "Citizenship in the Nation",               badges: ["Citizenship in the Nation"] },
  { label: "Citizenship in the World",                badges: ["Citizenship in the World"] },
  { label: "Communication",                           badges: ["Communication"] },
  { label: "Cooking",                                 badges: ["Cooking"] },
  { label: "Family Life",                             badges: ["Family Life"] },
  { label: "First Aid",                               badges: ["First Aid"] },
  { label: "Personal Fitness",                        badges: ["Personal Fitness"] },
  { label: "Personal Management",                     badges: ["Personal Management"] },
  { label: "Emergency Preparedness / Lifesaving",     badges: ["Emergency Preparedness", "Lifesaving"] },
  { label: "Environmental Science / Sustainability",  badges: ["Environmental Science", "Sustainability"] },
  { label: "Swimming / Hiking / Cycling",             badges: ["Swimming", "Hiking", "Cycling"] },
];
const REQUIRED_TOTAL = EAGLE_CATEGORIES.length; // 13
const EAGLE_TOTAL    = 21;

// Short column headers for the matrix table (full label lives in the <th title="">)
const SHORT_LABEL = {
  "Camping": "Camping",
  "Citizenship in the Community": "Cit. Community",
  "Citizenship in the Nation": "Cit. Nation",
  "Citizenship in the World": "Cit. World",
  "Communication": "Comm.",
  "Cooking": "Cooking",
  "Family Life": "Family Life",
  "First Aid": "First Aid",
  "Personal Fitness": "Pers. Fitness",
  "Personal Management": "Pers. Mgmt.",
  "Emergency Preparedness / Lifesaving": "Emerg. Prep / Lifesaving",
  "Environmental Science / Sustainability": "Envir. Sci / Sustain.",
  "Swimming / Hiking / Cycling": "Swim / Hike / Cycle",
};

// Eagle requirement 4 (renumbered from 5): "While a Life Scout, serve actively
// in your troop for a period of six months in one or more of ... [approved]
// positions of responsibility." TroopWebHost's Leadership Rank Requirement
// Status report does the accounting itself (Leadership Days Earned / Needed),
// so this report just reads those figures rather than re-deriving them.
const DAYS_PER_MONTH = 30.4375; // avg. calendar month, for days↔months display

// ═══════════════════════════════ UTILITIES ═══════════════════════════════
function cleanName(n) {
  return n.replace(/^\*/, "")
    .replace(/\s*\([^)]*\)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normBadge(n) {
  return n.toLowerCase()
    .replace(/&/g, "and")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d) {
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

// Nicknames in quotes and parentheticals: "Martz, Abigail \"Abby\"" -> "Martz, Abigail".
function stripNickname(n) {
  return String(n || "")
    .replace(/\s*["“”'‘’][^"“”'‘’]*["“”'‘’]\s*/g, " ")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Canonical key for matching a scout across two TWH exports (merit-badge
// history vs. leadership report). Drop the TWH "*" prefix (no-email flag),
// nicknames, middle initial and suffix; normalise the "Last, First" comma
// and case. "*Nelson, Helgi III" and "Nelson,Helgi" both -> "nelson, first".
function matchKey(name) {
  let n = String(name || "")
    .replace(/^[\s*]+/, "")                 // TWH inactive/no-email "*" prefix
    .replace(/ /g, " ");               // non-breaking spaces
  n = normalizeName(stripNickname(n));
  return n
    .toLowerCase()
    .replace(/\s*,\s*/, ", ")               // "last,first" / "last ,  first" -> "last, first"
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Every key a name could reasonably match on. Besides the canonical (legal)
// key, TWH stores a quoted nickname inline — "Martz, Abigail \"Abby\"" — so
// also offer "Last, Nickname". That lets a nickname used as the first name in
// one export ("Martz, Abby") line up with the legal name in the other.
function nameKeys(name) {
  const raw  = String(name || "");
  const keys = new Set([matchKey(raw)]);
  const nick  = raw.match(/["“”'‘’]\s*([^"“”'‘’]+?)\s*["“”'‘’]/);
  const comma = raw.indexOf(",");
  if (nick && comma > 0) keys.add(matchKey(`${raw.slice(0, comma)}, ${nick[1]}`));
  return [...keys].filter(Boolean);
}

// Read a value from a row by trying several header spellings (case-insensitive,
// trimmed). TWH headers vary between sites; keep the accepted set generous.
function pickCol(row, names) {
  for (const want of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === want.toLowerCase()) return row[key];
    }
  }
  return "";
}

// ─── Eagle Palms ───────────────────────────────────────────────────────
// One Palm per 5 merit badges earned beyond the 21 required for Eagle. The
// insignia actually worn cycles every 3 Palms: Bronze = 1, Gold = 2,
// Silver = 3; beyond that, stack Silvers and add a Bronze/Gold remainder
// (e.g. 7 Palms = 2 Silver + 1 Bronze). Matches BSA's Palm award table.
// Palms for surplus badges finished before the Eagle board of review are
// granted at that board of review with no wait; each later Palm needs 3
// months as an Eagle Scout plus active participation. This report does the
// badge-count math only (no Eagle BOR date, so no before/after split).
const PALM_STEP = 5;

function palmInsignia(palms) {
  if (palms <= 0) return "—";
  const silver = Math.floor(palms / 3);
  const rem    = palms % 3;
  const parts  = [];
  if (silver) parts.push(`${silver} Silver`);
  if (rem === 1) parts.push("1 Bronze");
  if (rem === 2) parts.push("1 Gold");
  return parts.join(" + ");
}

// Badge-count math for a scout who has (or is about to have) Eagle.
function palmStatus(totalBadges) {
  const beyond      = Math.max(0, totalBadges - EAGLE_TOTAL);
  const earned      = Math.floor(beyond / PALM_STEP);
  const nextNumber  = earned + 1;
  const badgesToNext = EAGLE_TOTAL + nextNumber * PALM_STEP - totalBadges; // 1..5
  return {
    beyond,
    earned,
    wornNow:    palmInsignia(earned),
    nextNumber,
    nextWorn:   palmInsignia(nextNumber),
    badgesToNext,
  };
}

// ═══════════════════════════════ DATA PROCESSING ════════════════════════
function processData(csvPath, onlyStarted) {
  const raw  = fs.readFileSync(csvPath, "utf8");
  const rows = parseCSV(raw);

  // scout (TWH "Last, First" key) -> Map(normalizedBadge -> {badge, date})
  const scoutBadges = new Map();

  rows.forEach(r => {
    // Drop TWH's leading "*" (no-email / inactive flag) so it doesn't leak
    // into the displayed name or throw off the Life-Scout name match.
    const scout    = (r["Scout"] || "").trim().replace(/^\*\s*/, "");
    const rawBadge = (r["Merit Badge"] || "").trim();
    const badge    = cleanName(rawBadge);
    const earned   = parseDate(r["Earned"]);
    if (!scout || !badge) return;

    if (!scoutBadges.has(scout)) scoutBadges.set(scout, new Map());
    const map = scoutBadges.get(scout);
    const key = normBadge(badge);
    const existing = map.get(key);
    // Keep the earliest earned date if a badge somehow appears twice
    if (!existing || (earned && (!existing.date || earned < existing.date))) {
      map.set(key, { badge, date: earned });
    }
  });

  const scouts = [...scoutBadges.entries()].map(([scoutKey, earnedMap]) => {
    let extraFromChoices = 0;

    const categories = EAGLE_CATEGORIES.map(cat => {
      const matches = cat.badges
        .map(b => earnedMap.get(normBadge(b)))
        .filter(Boolean)
        .sort((a, b) => {
          if (!a.date && !b.date) return 0;
          if (!a.date) return 1;
          if (!b.date) return -1;
          return a.date - b.date;
        });

      if (matches.length === 0) {
        return { label: cat.label, earned: false, options: cat.badges };
      }
      extraFromChoices += matches.length - 1;
      return {
        label: cat.label,
        earned: true,
        badge:  matches[0].badge,
        date:   matches[0].date,
      };
    });

    const requiredCount = categories.filter(c => c.earned).length;
    const totalBadges   = earnedMap.size;
    // Every earned badge either "fills" exactly one satisfied category, or
    // it's an elective (including a 2nd/3rd alternative within a category
    // that already has a badge satisfying it).
    const electiveCount = totalBadges - requiredCount;
    const missing        = categories.filter(c => !c.earned).map(c => c.label);

    return {
      name: formatDisplayName(scoutKey),
      sortKey: scoutKey,
      categories,
      requiredCount,
      electiveCount,
      totalBadges,
      missing,
    };
  });

  const filtered = onlyStarted ? scouts.filter(s => s.requiredCount > 0) : scouts;

  filtered.sort((a, b) => {
    if (b.requiredCount !== a.requiredCount) return b.requiredCount - a.requiredCount;
    if (b.totalBadges !== a.totalBadges) return b.totalBadges - a.totalBadges;
    return a.name.localeCompare(b.name);
  });

  return {
    scouts: filtered,
    totalScouts: scouts.length,
    shownScouts: filtered.length,
    fullyRequired: filtered.filter(s => s.requiredCount === REQUIRED_TOTAL).length,
    fullyEagle: filtered.filter(s => s.totalBadges >= EAGLE_TOTAL && s.requiredCount === REQUIRED_TOTAL).length,
    avgRequired: filtered.length
      ? (filtered.reduce((sum, s) => sum + s.requiredCount, 0) / filtered.length)
      : 0,
  };
}

// ─── Eagle requirement 4: position of responsibility for Life Scouts ─────
// Reads TroopWebHost's "Leadership Rank Requirement Status" export. That report
// has one row per scout working toward a rank; the rows whose "Next Rank" is
// Eagle are the current Life Scouts. TWH pre-computes "Leadership Days Earned"
// and "Leadership Days Needed" (counted from the Life board of review across
// approved positions), so a Scout has met requirement 4 when Needed is 0.
function processLeadership(porPath) {
  const empty = {
    hasData: false, parseLooksWrong: false, rawRowCount: 0, headers: [],
    scouts: [], lifeCount: 0, metCount: 0, lifeKeys: new Set(),
  };
  if (!porPath || !fs.existsSync(porPath)) return empty;

  const rows = parseCSV(fs.readFileSync(porPath, "utf8"));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const hasHeader = want => headers.some(k => k.trim().toLowerCase() === want);
  const looksRight = rows.length > 0 &&
    hasHeader("next rank") && hasHeader("scout") &&
    headers.some(k => /leadership days (earned|needed)/i.test(k.trim()));

  if (!looksRight) {
    return { ...empty, hasData: true, parseLooksWrong: true, rawRowCount: rows.length, headers };
  }

  const num = v => {
    const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };

  const scouts = rows
    .filter(r => pickCol(r, ["Next Rank", "Rank"]).trim().toLowerCase() === "eagle")
    .map(r => {
      const rawName = pickCol(r, ["Scout", "Name", "Scout Name"]).trim().replace(/^\*\s*/, "");
      const earned  = num(pickCol(r, ["Leadership Days Earned", "Days Earned"]));
      const needed  = num(pickCol(r, ["Leadership Days Needed", "Days Needed"]));
      const position = pickCol(r, ["Current Position", "Current Leadership Position", "Position"]).trim();
      return {
        name: formatDisplayName(stripNickname(rawName)) || rawName,
        sortKey: rawName,
        patrol: pickCol(r, ["Patrol"]).trim(),
        lifeDate: parseDate(pickCol(r, ["Last Rank Earned On", "Last Rank Earned", "Rank Date", "Date Earned"])),
        position,
        daysEarned: earned,
        daysNeeded: needed,
        monthsEarned: earned != null ? earned / DAYS_PER_MONTH : null,
        currentlyServing: !!position,
        met: needed != null ? needed <= 0 : null,
      };
    });

  scouts.sort((a, b) => {
    const am = a.met ? 1 : 0, bm = b.met ? 1 : 0;
    if (am !== bm) return am - bm;                       // not-yet-met first
    return (b.daysEarned ?? -1) - (a.daysEarned ?? -1);  // then by time served
  });

  return {
    hasData: true,
    parseLooksWrong: false,
    rawRowCount: rows.length,
    headers,
    scouts,
    lifeCount: scouts.length,
    metCount: scouts.filter(s => s.met).length,
    lifeKeys: new Set(scouts.flatMap(s => nameKeys(s.sortKey))),
  };
}

// ═══════════════════════════════ HTML GENERATION ════════════════════════
function buildHTML(data, por, dateStr, troopName) {
  const label = troopName ? `${troopName} - ` : "";
  const GREEN = "#3A4F2A";
  const RED   = "#C0392B";
  const GOLD  = "#9A7E4E";
  const DKBL  = "#0B3D6B";

  const lifeKeys = (por && por.lifeKeys) || new Set();
  const isLifeScout = s => nameKeys(s.sortKey).some(k => lifeKeys.has(k));
  const anyLifeInMatrix = data.scouts.some(isLifeScout);
  // Life Scouts named in the leadership report that didn't line up with any
  // matrix row — a name-format mismatch between the two exports, or the scout
  // simply has no merit badges recorded.
  const matrixKeys = new Set(data.scouts.flatMap(s => nameKeys(s.sortKey)));
  const unmatchedLife = ((por && por.scouts) || [])
    .filter(ls => !nameKeys(ls.sortKey).some(k => matrixKeys.has(k)));

  const matrixRows = data.scouts.map(s => {
    const cells = s.categories.map(c => {
      if (c.earned) {
        const title = `${esc(c.badge)}${c.date ? " — " + esc(fmtDate(c.date)) : ""}`;
        return `<td class="cell-yes" title="${title}">✓</td>`;
      }
      const title = `Not yet earned (needs: ${esc(c.options.join(" or "))})`;
      return `<td class="cell-no" title="${title}">✗</td>`;
    }).join("");

    const reqColor = s.requiredCount === REQUIRED_TOTAL ? GREEN : s.requiredCount >= REQUIRED_TOTAL - 2 ? GOLD : RED;
    const totColor = s.totalBadges >= EAGLE_TOTAL ? DKBL : s.totalBadges >= EAGLE_TOTAL - 4 ? GOLD : "#4A5568";
    const isLife = isLifeScout(s);

    return `<tr${isLife ? ' class="life"' : ""}>
      <td class="scout-name">${esc(s.name)}${isLife ? ' <span class="life-tag">LIFE</span>' : ""}</td>
      ${cells}
      <td class="num-col" style="color:${reqColor};font-weight:700">${s.requiredCount}/${REQUIRED_TOTAL}</td>
      <td class="num-col">${s.electiveCount}</td>
      <td class="num-col" style="color:${totColor};font-weight:700">${s.totalBadges}/${EAGLE_TOTAL}</td>
    </tr>`;
  }).join("");

  const headerCells = EAGLE_CATEGORIES.map(c =>
    `<th title="${esc(c.label)}">${esc(SHORT_LABEL[c.label] || c.label)}</th>`
  ).join("");

  const needsWork = data.scouts.filter(s => s.missing.length > 0);
  const missingRows = needsWork.map(s => `<tr>
      <td class="scout-name">${esc(s.name)}</td>
      <td>${esc(s.missing.join(", "))}</td>
      <td class="num-col">${s.totalBadges}/${EAGLE_TOTAL}</td>
    </tr>`).join("");

  const missingCopy = needsWork
    .map(s => `${s.name}: ${s.missing.join(", ")}`)
    .join("\n");

  const closeToEagle = data.scouts.filter(s => s.requiredCount === REQUIRED_TOTAL && s.totalBadges < EAGLE_TOTAL);
  const closeRows = closeToEagle.map(s => `<tr>
      <td class="scout-name">${esc(s.name)}</td>
      <td class="num-col">${s.totalBadges}/${EAGLE_TOTAL}</td>
      <td>${EAGLE_TOTAL - s.totalBadges} more elective${EAGLE_TOTAL - s.totalBadges === 1 ? "" : "s"} needed</td>
    </tr>`).join("");

  // ─── Eagle Palms ─────────────────────────────────────────────────────
  const palmScouts = data.scouts
    .filter(s => s.requiredCount === REQUIRED_TOTAL && s.totalBadges >= EAGLE_TOTAL)
    .map(s => ({ name: s.name, totalBadges: s.totalBadges, palm: palmStatus(s.totalBadges) }))
    .sort((a, b) => b.totalBadges - a.totalBadges || a.name.localeCompare(b.name));

  const palmRows = palmScouts.map(s => `<tr>
      <td class="scout-name">${esc(s.name)}</td>
      <td class="num-col">${s.totalBadges}</td>
      <td class="num-col">${s.palm.beyond}</td>
      <td class="num-col" style="font-weight:700">${s.palm.earned}</td>
      <td>${s.palm.earned ? esc(s.palm.wornNow) : `<span class="muted">none yet</span>`}</td>
      <td>Palm ${s.palm.nextNumber} — ${esc(s.palm.nextWorn)}</td>
      <td class="num-col" style="font-weight:700">${s.palm.badgesToNext}</td>
    </tr>`).join("");

  const palmCopy = palmScouts
    .map(s => `${s.name}: ${s.palm.earned ? s.palm.wornNow : "no Palms yet"} — next is Palm ${s.palm.nextNumber} (${s.palm.nextWorn}), ${s.palm.badgesToNext} more MB${s.palm.badgesToNext === 1 ? "" : "s"}`)
    .join("\n");

  const palmSection = `
<h2>Eagle Palms${palmScouts.length ? ` (${palmScouts.length} Eagle Scout${palmScouts.length === 1 ? "" : "s"})` : ""}</h2>
<p class="note">One Palm per 5 merit badges beyond the 21 required. Insignia worn: Bronze = 1 Palm, Gold = 2, Silver = 3; above 3 the Silvers stack with a Bronze/Gold remainder (e.g. 7 Palms = 2 Silver + 1 Bronze). Palms for surplus badges completed <em>before</em> the Eagle board of review are awarded at that board of review with no wait; each Palm after that needs 3 months as an Eagle Scout plus active participation and Scout spirit. This table is the merit-badge count only, and lists every scout with all 13 required categories and 21+ total badges.</p>
<div class="section">
  ${palmScouts.length ? `<div class="copy-area">
    <table>
      <thead><tr><th>Scout</th><th>Total MBs</th><th>Beyond 21</th><th>Palms Earned</th><th>Insignia Worn Now</th><th>Next Palm</th><th>MBs to Next</th></tr></thead>
      <tbody>${palmRows}</tbody>
    </table>
    <div class="copy-aside">
      <label>Palm status — copy list</label>
      <textarea readonly id="palm-ta">${esc(palmCopy)}</textarea>
      <button class="copy-btn" onclick="const t=document.getElementById('palm-ta');t.select();document.execCommand('copy');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy All',1500)">Copy All</button>
    </div>
  </div>` : `<p class="note" style="margin:0">No scouts have all 13 Eagle-required categories plus 21 total badges yet.</p>`}
</div>`;

  // ─── Eagle requirement 4: position of responsibility ──────────────────
  const DAY_MS = 1000 * 60 * 60 * 24;
  const daysToMonths = d => d == null ? "—" : `${(d / DAYS_PER_MONTH).toFixed(1)} mo`;

  let porSection;
  if (!por.hasData) {
    porSection = `
<h2>Eagle Requirement 4 — Position of Responsibility</h2>
<div class="section"><p class="note" style="margin:0">Add the <strong>Leadership Rank Requirement Status</strong> CSV (auto-fetched from TroopWebHost, or uploaded) to track which Life Scouts have served six months in an approved position of responsibility.</p></div>`;
  } else if (por.parseLooksWrong) {
    porSection = `
<h2>Eagle Requirement 4 — Position of Responsibility</h2>
<div class="section"><p class="note" style="margin:0;color:#C0392B">A leadership file was supplied (${por.rawRowCount} row${por.rawRowCount === 1 ? "" : "s"}) but it isn't the expected "Leadership Rank Requirement Status" export — it needs <em>Next Rank</em>, <em>Scout</em>, and <em>Leadership Days Earned / Needed</em> columns. Columns found: ${esc(por.headers.join(", ") || "none")}.</p></div>`;
  } else if (por.lifeCount === 0) {
    porSection = `
<h2>Eagle Requirement 4 — Position of Responsibility</h2>
<div class="section"><p class="note" style="margin:0">No Life Scouts working toward Eagle in the leadership report (no rows with Next Rank = "Eagle").</p></div>`;
  } else {
    const rows = por.scouts.map(s => {
      const servedColor = s.met ? GREEN : RED;
      const servedCell = s.daysEarned == null
        ? "—"
        : `${s.daysEarned} days <span class="muted">(${daysToMonths(s.daysEarned)})</span>`;

      let reqCell;
      if (s.met === null) {
        reqCell = `<span class="muted">not reported</span>`;
      } else if (s.met) {
        reqCell = `<span class="por-pill por-yes">✓ Met</span>`;
      } else {
        const done = s.currentlyServing && s.daysNeeded != null
          ? ` <span class="muted">on track ≈ ${esc(fmtDate(new Date(Date.now() + s.daysNeeded * DAY_MS)))}</span>`
          : "";
        reqCell = `<span class="por-pill por-no">✗ ${s.daysNeeded} day${s.daysNeeded === 1 ? "" : "s"} to go</span>${done}`;
      }

      return `<tr>
      <td class="scout-name">${esc(s.name)}</td>
      <td class="num-col">${s.lifeDate ? esc(fmtDate(s.lifeDate)) : "—"}</td>
      <td>${s.position ? esc(s.position) : `<span class="muted">none currently</span>`}</td>
      <td class="num-col" style="color:${servedColor};font-weight:700">${servedCell}</td>
      <td>${reqCell}</td>
    </tr>`;
    }).join("");

    const porCopy = por.scouts.filter(s => s.met === false)
      .map(s => `${s.name}: ${s.daysEarned ?? "?"} leadership days earned, ${s.daysNeeded} to go`)
      .join("\n");

    porSection = `
<h2>Eagle Requirement 4 — Position of Responsibility (${por.metCount}/${por.lifeCount} Life Scouts met)</h2>
<p class="note">Life Scouts working toward Eagle (Next Rank = "Eagle" in TroopWebHost's Leadership Rank Requirement Status report). "Leadership Days" are TWH's own tally, counted from the Life board of review across positions it treats as approved; requirement 4 is met when 0 days remain.</p>
<div class="section">
  <div class="copy-area">
    <table>
      <thead><tr><th>Life Scout</th><th>Life BOR</th><th>Current Position</th><th>Leadership Time Earned</th><th>6-Month Requirement</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="copy-aside">
      <label>Not yet met — copy list</label>
      <textarea readonly id="por-ta">${esc(porCopy || "All Life Scouts working toward Eagle have met requirement 4.")}</textarea>
      <button class="copy-btn" onclick="const t=document.getElementById('por-ta');t.select();document.execCommand('copy');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy All',1500)">Copy All</button>
    </div>
  </div>
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(label)}Eagle Preparedness Report - ${esc(dateStr)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #FAF7F0; color: #1C2340; padding: 2rem; max-width: 1300px; margin: 0 auto; }
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
    padding: 1.25rem; margin-bottom: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.06);
    overflow-x: auto; }
  .legend { display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: 0.8rem; color: #4A5568;
    margin-bottom: 0.75rem; }
  .legend span.k { font-weight: 700; }
  .copy-area { display: flex; gap: 1.5rem; align-items: flex-start; flex-wrap: wrap; }
  .copy-area table { flex: 1; border-collapse: collapse; }
  .copy-aside { flex: 0 0 220px; }
  .copy-aside label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: #4A5568; display: block; margin-bottom: 0.35rem; }
  .copy-aside textarea { width: 100%; height: 260px; font-size: 0.76rem; font-family: monospace;
    border: 1px solid #D7CDB5; border-radius: 6px; padding: 0.5rem;
    background: #FAF7F0; color: #1C2340; resize: vertical; line-height: 1.6; }
  .copy-btn { margin-top: 0.4rem; width: 100%; padding: 0.4rem; background: #3A4F2A;
    color: #fff; border: none; border-radius: 5px; font-size: 0.8rem; cursor: pointer; }
  .copy-btn:hover { background: #5C7A47; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  thead th { background: #F0EBDC; padding: 0.4rem 0.5rem; text-align: center;
    font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
    color: #4A5568; border-bottom: 1px solid #D7CDB5; white-space: nowrap; }
  thead th:first-child { text-align: left; }
  tbody tr:nth-child(even) { background: #FAF7F0; }
  tbody tr:hover { background: #F0EBDC; }
  tbody td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #EDE8DC; vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  .scout-name { font-weight: 600; white-space: nowrap; }
  .num-col { text-align: center; white-space: nowrap; }
  .cell-yes, .cell-no { text-align: center; font-weight: 700; cursor: default; }
  .cell-yes { color: #3A4F2A; }
  .cell-no { color: #C0392B; }
  /* Life Scouts stand out in the matrix */
  tbody tr.life, tbody tr.life:nth-child(even) { background: #FBF1D9; }
  tbody tr.life:hover { background: #F6E7BE; }
  tbody tr.life .scout-name { box-shadow: inset 3px 0 0 #B8860B; }
  .life-tag { display: inline-block; margin-left: 0.35rem; padding: 0 0.3rem;
    border-radius: 3px; background: #B8860B; color: #fff; font-size: 0.6rem;
    font-weight: 800; letter-spacing: 0.5px; vertical-align: 1px; }
  .muted { color: #7A8494; font-size: 0.92em; font-style: italic; }
  .por-pill { display: inline-block; padding: 0.12rem 0.5rem; border-radius: 999px;
    font-size: 0.72rem; font-weight: 700; white-space: nowrap; }
  .por-yes { background: #E4EEDA; color: #3A4F2A; }
  .por-no  { background: #F7E1DE; color: #C0392B; }
  .report-footer { text-align: center; font-size: 0.8rem; color: #9A7E4E;
    margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #D7CDB5; }
  @media print {
    /* Portrait for the report as a whole; the 17-column Eagle Merit Badge
       Matrix gets its own landscape page(s). Needs preferCSSPageSize in the
       PDF renderer (see buildPDF). */
    @page          { size: Letter portrait;  margin: 0.55in 0.5in; }
    @page matrix   { size: Letter landscape; margin: 0.45in; }
    .matrix-page   { page: matrix; break-before: page; break-after: page; }

    body { background: #fff; padding: 0.5rem; }
    .report-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .section { break-inside: avoid; overflow: visible; }
    .copy-aside { display: none; }
    h2 { break-after: avoid; }
    .note { break-after: avoid; }

    /* Eagle Merit Badge Matrix has 17 columns — the PDF renderer clips rather
       than scales, so fix the layout to a width that fits Letter landscape.
       Let a long roster flow across pages (thead repeats) instead of clipping. */
    .matrix-section { overflow: visible; padding: 0.5rem; break-inside: auto; }
    .matrix-table { table-layout: fixed; font-size: 0.55rem; }
    .matrix-table tr { break-inside: avoid; }
    .matrix-table col.c-scout { width: 74px; }
    .matrix-table col.c-cat   { width: 50px; }
    .matrix-table col.c-num   { width: 40px; }
    .matrix-table thead th { font-size: 0.5rem; white-space: normal;
      padding: 2px 1px; letter-spacing: 0; line-height: 1.12; }
    .matrix-table tbody td { padding: 2px 1px; }
    .matrix-table .scout-name { white-space: normal; word-break: break-word; }
    .matrix-table .cell-yes, .matrix-table .cell-no { font-size: 0.62rem; }
  }
</style>
</head>
<body>
<div class="report-header">
  <h1>🦅 ${esc(label)}Eagle Preparedness Report</h1>
  <div class="report-meta">Generated ${esc(dateStr)}  •  ${data.shownScouts} scouts shown${data.shownScouts !== data.totalScouts ? ` (of ${data.totalScouts} in file)` : ""}</div>
</div>

<div class="summary">
  <div class="stat"><div class="stat-n">${data.shownScouts}</div><div class="stat-l">Scouts on Eagle trail</div></div>
  <div class="stat"><div class="stat-n">${data.fullyRequired}</div><div class="stat-l">All 13 required earned</div></div>
  <div class="stat"><div class="stat-n">${data.fullyEagle}</div><div class="stat-l">Full 21 badges (required + elective)</div></div>
  <div class="stat"><div class="stat-n">${data.avgRequired.toFixed(1)}</div><div class="stat-l">Avg. required badges earned</div></div>
  ${por.hasData && !por.parseLooksWrong ? `
  <div class="stat"><div class="stat-n">${por.lifeCount}</div><div class="stat-l">Life Scouts toward Eagle</div></div>
  <div class="stat"><div class="stat-n">${por.metCount}/${por.lifeCount}</div><div class="stat-l">Met 6-mo position of responsibility</div></div>` : ""}
</div>

<div class="matrix-page">
<h2>Eagle Merit Badge Matrix</h2>
<p class="note">✓ = earned (hover for badge name and date) &nbsp;•&nbsp; ✗ = not yet earned. Sorted by required badges earned, then total badges.${anyLifeInMatrix ? ` &nbsp;•&nbsp; <span class="life-tag">LIFE</span> row = current Life Scout (from the Leadership Rank Requirement Status report).` : ""}</p>
<div class="legend">
  <span><span class="k">Required:</span> 13 categories, current since Feb. 27, 2026 (Citizenship in Society discontinued)</span>
  <span><span class="k">Electives:</span> 8 needed of the Scout's choosing</span>
  <span><span class="k">Total for Eagle:</span> 21 merit badges</span>
</div>
<div class="section matrix-section">
  <table class="matrix-table">
    <colgroup>
      <col class="c-scout" />
      ${EAGLE_CATEGORIES.map(() => `<col class="c-cat" />`).join("")}
      <col class="c-num" /><col class="c-num" /><col class="c-num" />
    </colgroup>
    <thead><tr>
      <th>Scout</th>
      ${headerCells}
      <th>Required</th>
      <th>Electives</th>
      <th>Total</th>
    </tr></thead>
    <tbody>${matrixRows}</tbody>
  </table>
</div>
${unmatchedLife.length ? `<p class="note" style="color:#C0392B">${unmatchedLife.length} Life Scout${unmatchedLife.length === 1 ? "" : "s"} from the leadership report ${unmatchedLife.length === 1 ? "was" : "were"} not matched to a row above — the name differs between the two TroopWebHost exports, or the scout has no merit badges on file: ${esc(unmatchedLife.map(s => s.name + (s.patrol ? ` (${s.patrol})` : "")).join(", "))}.</p>` : ""}
</div>

<h2>Missing Required Badges by Scout (${needsWork.length})</h2>
<p class="note">Categories still needed for each scout who hasn't completed all 13. Good input for scheduling counselors or a merit badge event.</p>
<div class="section">
  <div class="copy-area">
    <table>
      <thead><tr><th>Scout</th><th>Missing Categories</th><th>Total</th></tr></thead>
      <tbody>${missingRows || `<tr><td colspan="3" style="text-align:center;color:#4A5568;font-style:italic;padding:1rem">No scouts shown are missing a required category.</td></tr>`}</tbody>
    </table>
    <div class="copy-aside">
      <label>Copy-paste list</label>
      <textarea readonly id="missing-ta">${esc(missingCopy)}</textarea>
      <button class="copy-btn" onclick="const t=document.getElementById('missing-ta');t.select();document.execCommand('copy');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy All',1500)">Copy All</button>
    </div>
  </div>
</div>

${closeToEagle.length > 0 ? `
<h2>All 13 Required Earned — Just Need Electives (${closeToEagle.length})</h2>
<p class="note">These scouts have every required category covered; only elective badges stand between them and 21 total.</p>
<div class="section">
  <table>
    <thead><tr><th>Scout</th><th>Total</th><th>Remaining</th></tr></thead>
    <tbody>${closeRows}</tbody>
  </table>
</div>` : ""}
${palmSection}
${porSection}

<div class="report-footer">
  ${esc(label)}Eagle Preparedness Report  •  ${esc(dateStr)}
</div>
</body>
</html>`;
}

// ═══════════════════════════════ CSV GENERATION ════════════════════════
function buildCSV(data) {
  const esc2 = v => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];

  const header = ["Scout", ...EAGLE_CATEGORIES.map(c => c.label), "Required", "Electives", "Total"];
  lines.push(header.map(esc2).join(","));

  data.scouts.forEach(s => {
    const row = [
      s.name,
      ...s.categories.map(c => c.earned ? `Yes (${c.badge}${c.date ? " " + c.date.toISOString().slice(0, 10) : ""})` : "No"),
      `${s.requiredCount}/${REQUIRED_TOTAL}`,
      s.electiveCount,
      `${s.totalBadges}/${EAGLE_TOTAL}`,
    ];
    lines.push(row.map(esc2).join(","));
  });

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
    // Page size/orientation and margins come from the stylesheet's @page rules
    // (portrait overall, a named landscape page for the merit-badge matrix).
    await page.pdf({
      path: pdfPath,
      preferCSSPageSize: true,
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
  const { meritBadges: csvPath, porHistory: porPath } = inputs;
  if (!csvPath || !fs.existsSync(csvPath)) throw new Error("Merit Badge History CSV not provided");

  const onlyStarted = options.onlyStarted !== false && options.onlyStarted !== "false";
  const data    = processData(csvPath, onlyStarted);
  const por     = processLeadership(porPath);
  const dateStr = todayLong();
  const ts      = fileTimestamp();
  const troopName = options.troopName || "";

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const htmlFileName = `Eagle_Preparedness_${ts}.html`;
  const htmlPath     = path.join(outputDir, htmlFileName);
  fs.writeFileSync(htmlPath, buildHTML(data, por, dateStr, troopName), "utf8");

  const output = {
    htmlFileName,
    htmlPath,
    pdfPath:  null,
    csvPath2: null,
    stats: {
      scouts: data.shownScouts,
      fullyRequired: data.fullyRequired,
      fullyEagle: data.fullyEagle,
      lifeScouts: por.hasData && !por.parseLooksWrong ? por.lifeCount : null,
      porRequirementMet: por.hasData && !por.parseLooksWrong ? por.metCount : null,
    },
  };

  if (options.downloadPdf === true || options.downloadPdf === "true") {
    output.pdfPath     = await buildPDF(htmlPath);
    output.pdfFileName = path.basename(output.pdfPath);
  }

  if (options.downloadCsv === true || options.downloadCsv === "true") {
    const csvFileName  = `Eagle_Preparedness_${ts}.csv`;
    const csvOut       = path.join(outputDir, csvFileName);
    fs.writeFileSync(csvOut, buildCSV(data), "utf8");
    output.csvPath     = csvOut;
    output.csvFileName = csvFileName;
  }

  return output;
}

// matchKey / nameKeys are exported for scripts/dev/check_name_match.js so the
// diagnostic stays byte-for-byte consistent with the report's own matching.
module.exports = { manifest, generate, matchKey, nameKeys };
