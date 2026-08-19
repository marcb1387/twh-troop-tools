const fs   = require("fs");
const path = require("path");
const csvParser = require("../shared/csv-parser");
const { parseDate, todayLong } = require("../shared/dates");

// ═══════════════════════════════ MANIFEST ════════════════════════════════
const manifest = {
  id: "patrol-balance",
  name: "Patrol Visualizer",
  description: "Snapshot of patrol composition with age and rank variance, plus rebalancing suggestions that prioritize clearing out unassigned scouts first.",
  icon: "⚖️",
  outputType: "html",
  inputs: [
    {
      key: "roster",
      label: "TroopWebHost Active Roster CSV",
      hint: "Export: Menu → Membership → Export Membership Data → Export Active Roster to Excel",
      required: true,
      twhReport: "roster",
    },
  ],
  options: [
    {
      key: "patrolMin", label: "Min Patrol Size", type: "text",
      placeholder: "8", default: "8",
    },
    {
      key: "patrolMax", label: "Max Patrol Size", type: "text",
      placeholder: "10", default: "10",
    },
    {
      key: "ageWeight", label: "Age vs. Rank Weighting (Age / Rank)", type: "radio",
      choices: [
        { value: "0.5", label: "50 / 50" },
        { value: "0.6", label: "60 / 40" },
        { value: "0.7", label: "70 / 30" },
        { value: "0.8", label: "80 / 20" },
      ],
      default: "0.7",
    },
    { key: "downloadPdf", label: "Also download PDF", type: "checkbox", default: false },
    { key: "downloadCsv", label: "Also download CSV", type: "checkbox", default: false },
  ],
};

// ═══════════════════════════════ CONSTANTS ════════════════════════════════
const RANK_VALUES = {
  "no rank": 0, "": 0,
  "scout": 1, "tenderfoot": 2, "second class": 3,
  "first class": 4, "star": 5, "life": 6, "eagle": 7,
};
const AGE_WEIGHT        = 0.7;
const RANK_WEIGHT       = 0.3;
const TARGET_MIN        = 8;
const TARGET_MAX        = 10;
const HIGH_VAR_THRESHOLD = 1.0;

// ═══════════════════════════════ MATH UTILITIES ══════════════════════════
function rankNum(rank) {
  const r = (rank || "").toLowerCase().trim();
  if (/palm/.test(r)) return 7;
  return RANK_VALUES[r] ?? 0;
}

// Same abbreviation scheme as the Advancement report's roster rank badges,
// used here to keep the Rank column narrow enough for the 3-column print
// layout without clipping mid-word.
function rankAbbrev(rank) {
  const r = (rank || "").trim();
  if (!r) return "NR";
  if (/^no rank/i.test(r)) return "NR";
  if (r.startsWith("Scout")) return "S";
  if (r.startsWith("Tenderfoot")) return "TF";
  if (r.startsWith("Second Class")) return "2C";
  if (r.startsWith("First Class")) return "1C";
  if (r.startsWith("Star")) return "St";
  if (r.startsWith("Life")) return "L";
  if (r.startsWith("Eagle")) return "E";
  if (/palm/i.test(r)) return "E";
  return r;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function score(scouts, aw, rw) {
  return aw * stdDev(scouts.map(s => s.age))
       + rw * stdDev(scouts.map(s => s.rankNum));
}

function metrics(scouts, aw, rw) {
  return {
    size:    scouts.length,
    avgAge:  mean(scouts.map(s => s.age)),
    sdAge:   stdDev(scouts.map(s => s.age)),
    sdRank:  stdDev(scouts.map(s => s.rankNum)),
    score:   score(scouts, aw, rw),
  };
}

// ═══════════════════════════════ DATA LOADING ════════════════════════════
const UNASSIGNED_MALE   = "Unassigned (Male)";
const UNASSIGNED_FEMALE = "Unassigned (Female)";

function loadRoster(rosterPath) {
  const rows = csvParser.parseCSV(fs.readFileSync(rosterPath, "utf8"));
  return rows
    .filter(r => r.Adult === "N")
    .filter(r => !(r.Patrol || "").trim().toLowerCase().startsWith("zinactive"))
    .map(r => {
      const firstName = (r["FIrst Name"] || r["First Name"] || "").trim();
      const lastName  = (r["Last Name"] || "").trim();
      const rank      = (r["Rank"] || "").trim();
      const gender    = (r["Registered Gender"] || "M").trim().toUpperCase();
      let age = parseInt(r["Age"] || "", 10);
      if (isNaN(age)) {
        const dob = parseDate(r["Born"] || "");
        if (dob) {
          const now = new Date();
          age = now.getFullYear() - dob.getFullYear() -
            (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
        } else {
          age = 0;
        }
      }
      // No patrol on file - bucket by gender rather than drop the scout
      // entirely, so unassigned scouts are visible and suggestions can
      // work on getting them placed.
      const patrol = (r["Patrol"] || "").trim()
        || (gender === "F" ? UNASSIGNED_FEMALE : UNASSIGNED_MALE);
      return {
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`.trim(),
        rank,
        rankNum:  rankNum(rank),
        age,
        patrol,
        gender,
      };
    });
}

function isUnassigned(patrolName) {
  return patrolName === UNASSIGNED_MALE || patrolName === UNASSIGNED_FEMALE;
}

// ═══════════════════════════════ PATROL GROUPING ═════════════════════════
function buildPatrols(scouts, aw, rw) {
  const map = new Map();
  for (const s of scouts) {
    if (!map.has(s.patrol)) map.set(s.patrol, []);
    map.get(s.patrol).push(s);
  }

  const patrols = [];
  for (const [name, members] of map) {
    const femaleCount = members.filter(s => s.gender === "F").length;
    const gender      = femaleCount > members.length / 2 ? "F" : "M";
    // New scout patrol: every member has No Rank
    const isNewScout  = members.every(s => s.rankNum === 0);
    const sorted      = members.slice().sort((a, b) => a.lastName.localeCompare(b.lastName));
    patrols.push({ name, scouts: sorted, gender, isNewScout, metrics: metrics(sorted, aw, rw) });
  }

  patrols.sort((a, b) => {
    if (a.isNewScout !== b.isNewScout) return a.isNewScout ? 1 : -1;
    if (a.gender    !== b.gender)     return a.gender === "M" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return patrols;
}

// ═══════════════════════════════ SUGGESTIONS ════════════════════════════
function findSuggestions(patrols, cfg) {
  const { aw, rw, patrolMin, patrolMax, highVarThreshold } = cfg;

  const sc = scouts => score(scouts, aw, rw);
  const mt = scouts => metrics(scouts, aw, rw);

  const suggestions = [];

  // --- Source-driven: too-large or high-variance patrols ---
  for (const src of patrols) {
    const issues = [];
    if (src.metrics.size > patrolMax)         issues.push("too-large");
    if (src.metrics.score > highVarThreshold) issues.push("high-variance");
    if (!issues.length) continue;

    let best = null;
    let bestNet = 0;

    for (const scout of src.scouts) {
      const without = src.scouts.filter(s => s !== scout);
      if (!issues.includes("too-large") && without.length < patrolMin) continue;

      const srcImprovement = src.metrics.score - sc(without);

      for (const dest of patrols) {
        if (dest.name === src.name)            continue;
        if (dest.gender    !== src.gender)     continue;
        if (dest.isNewScout !== src.isNewScout) continue;
        if (dest.scouts.length >= patrolMax)   continue;

        const destWith = [...dest.scouts, scout];
        const destHarm = sc(destWith) - dest.metrics.score;
        const net      = srcImprovement - destHarm;

        if (net > bestNet) {
          bestNet = net;
          best = {
            issue:       issues[0],
            scout,
            from:        src.name,
            to:          dest.name,
            fromBefore:  src.metrics,
            fromAfter:   mt(without),
            toBefore:    dest.metrics,
            toAfter:     mt(destWith),
          };
        }
      }
    }

    if (best) suggestions.push(best);
  }

  // --- Destination-driven: too-small patrols not already addressed ---
  const addressedDests = new Set(suggestions.map(s => s.to));

  for (const dest of patrols) {
    if (dest.metrics.size >= patrolMin)   continue;
    if (addressedDests.has(dest.name))    continue;

    let best = null;
    let bestDestScore = Infinity;

    for (const src of patrols) {
      if (src.name === dest.name)              continue;
      if (src.gender    !== dest.gender)       continue;
      if (src.isNewScout !== dest.isNewScout)  continue;
      if (src.scouts.length <= patrolMin)      continue;

      for (const scout of src.scouts) {
        const destWith  = [...dest.scouts, scout];
        const destAfter = sc(destWith);
        if (destAfter < bestDestScore) {
          bestDestScore = destAfter;
          const without = src.scouts.filter(s => s !== scout);
          best = {
            issue:      "too-small",
            scout,
            from:       src.name,
            to:         dest.name,
            fromBefore: src.metrics,
            fromAfter:  mt(without),
            toBefore:   dest.metrics,
            toAfter:    mt(destWith),
          };
        }
      }
    }

    suggestions.push(best || {
      issue:   "too-small",
      noMove:  true,
      patrol:  dest.name,
      size:    dest.metrics.size,
    });
  }

  return suggestions;
}

// ═══════════════════════════════ COMBINE UNDERSIZED PATROLS ══════════════
// Top-tier check, evaluated before anything else: two undersized patrols
// are often better fixed by merging them outright than by shuffling scouts
// one at a time. Only suggested when the combined patrol (a) fits within
// patrolMax and (b) keeps variance low - i.e. the merge doesn't trade a
// size problem for a variance problem. Greedy: pairs are evaluated by
// resulting score (best fit first), and a patrol already claimed by one
// merge can't be reused in another.
function findMergeSuggestions(patrols, cfg) {
  const { aw, rw, patrolMin, patrolMax, highVarThreshold } = cfg;
  const sc = arr => score(arr, aw, rw);
  const mt = arr => metrics(arr, aw, rw);

  const undersized = patrols.filter(p => p.metrics.size < patrolMin);
  const candidates = [];

  for (let i = 0; i < undersized.length; i++) {
    for (let j = i + 1; j < undersized.length; j++) {
      const a = undersized[i], b = undersized[j];
      if (a.gender     !== b.gender)     continue;
      if (a.isNewScout !== b.isNewScout) continue;

      const combined = [...a.scouts, ...b.scouts];
      if (combined.length > patrolMax) continue;

      const combinedScore = sc(combined);
      if (combinedScore > highVarThreshold) continue; // variance impacted too much

      candidates.push({ a, b, combined, combinedScore });
    }
  }

  candidates.sort((x, y) => x.combinedScore - y.combinedScore); // best fit first

  const used  = new Set();
  const merges = [];
  for (const c of candidates) {
    if (used.has(c.a.name) || used.has(c.b.name)) continue;
    used.add(c.a.name);
    used.add(c.b.name);
    merges.push({
      issue:   "merge",
      patrolA: c.a.name, patrolB: c.b.name,
      beforeA: c.a.metrics, beforeB: c.b.metrics,
      after:   mt(c.combined),
    });
  }

  return { merges, usedNames: used };
}

// ═══════════════════════════════ UNASSIGNED RESOLUTION ═══════════════════
// Two-tier: (1) would the unassigned group make a good patrol on its own
// (low variance)? If so, stop - they can be formalized as a new patrol.
// (2) If not, peel off the single biggest age outlier to whichever
// existing (non-unassigned, same-gender) patrol absorbs them with the
// least harm, then re-check tier 1 against what's left. Repeats until
// the remainder is low-variance, exhausted, or there's nowhere left to
// send an outlier.
function resolveUnassigned(patrols, cfg) {
  const { aw, rw, patrolMax, highVarThreshold } = cfg;
  const sc = arr => score(arr, aw, rw);
  const mt = arr => metrics(arr, aw, rw);

  // Working copy of every patrol's roster, mutated as moves are chosen so
  // a second outlier sent to the same destination sees the first one
  // already there instead of stale "before" numbers.
  const working = new Map(patrols.map(p => [p.name, p.scouts.slice()]));
  const genderOf = new Map(patrols.map(p => [p.name, p.gender]));

  const results = [];

  for (const u of patrols.filter(p => isUnassigned(p.name))) {
    let remaining = working.get(u.name);
    const moves = [];

    // A lone leftover scout is never "a good patrol" regardless of score
    // (stdDev of one value is trivially 0) - keep trying to place them
    // rather than declaring a one-scout patrol resolved.
    while (remaining.length > 0 && (remaining.length === 1 || sc(remaining) > highVarThreshold)) {
      const avgAge = mean(remaining.map(s => s.age));
      const outlier = remaining.reduce((worst, s) =>
        Math.abs(s.age - avgAge) > Math.abs(worst.age - avgAge) ? s : worst
      );

      let bestName = null, bestAfter = null, bestHarm = Infinity;
      for (const [name, arr] of working) {
        if (name === u.name || isUnassigned(name))    continue;
        if (genderOf.get(name) !== genderOf.get(u.name)) continue;
        if (arr.length >= patrolMax)                  continue;
        const harm = sc([...arr, outlier]) - sc(arr);
        if (harm < bestHarm) { bestHarm = harm; bestName = name; bestAfter = [...arr, outlier]; }
      }

      if (!bestName) break; // nowhere left to send an outlier

      const fromBefore = mt(remaining);
      const toBefore    = mt(working.get(bestName));

      remaining = remaining.filter(s => s !== outlier);
      working.set(u.name, remaining);
      working.set(bestName, bestAfter);

      moves.push({
        issue: "unassigned", scout: outlier, from: u.name, to: bestName,
        fromBefore, fromAfter: mt(remaining),
        toBefore,   toAfter:   mt(bestAfter),
      });
    }

    results.push({
      patrolName: u.name,
      gender:     u.gender,
      moves,
      remaining,
      remainingScore: remaining.length > 0 ? sc(remaining) : 0,
      resolvedLowVariance: remaining.length >= 2 && sc(remaining) <= highVarThreshold,
    });
  }

  return results;
}

// ═══════════════════════════════ HTML ════════════════════════════════════
function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(n) { return isNaN(n) ? "-" : Number(n).toFixed(2); }


function suggestionCard(s) {
  if (s.noMove) return `
  <div class="suggestion-card warn">
    <strong>${esc(s.patrol)}</strong> has only ${s.size} scouts and no valid source patrol could spare one. Consider a new scout transfer or cross-patrol merge.
  </div>`;

  const LABELS = { "too-large": "Too Large", "high-variance": "High Variance", "too-small": "Too Small", "unassigned": "Clear Unassigned" };
  const COLORS = { "too-large": "#E65100", "high-variance": "#C0392B", "too-small": "#1565C0", "unassigned": "#9A7E4E" };
  const color  = COLORS[s.issue] || "#3A4F2A";

  function deltaSpan(before, after, lowerIsBetter = true) {
    const improved = lowerIsBetter ? after <= before : after >= before;
    const cls = improved ? "better" : "worse";
    return `<span class="${cls}">${fmt(before)} → ${fmt(after)}</span>`;
  }

  return `
  <div class="suggestion-card" style="border-left-color:${color}">
    <div class="suggestion-header">
      <span class="badge" style="background:${color}">${esc(LABELS[s.issue] || s.issue)}</span>
      <span>Move <strong>${esc(s.scout.fullName)}</strong> (${esc(s.scout.rank || "No Rank")}, age ${s.scout.age}) from <strong>${esc(s.from)}</strong> to <strong>${esc(s.to)}</strong></span>
    </div>
    <div class="delta-grid">
      <div class="delta-block">
        <div class="delta-patrol">${esc(s.from)} (source)</div>
        <div class="delta-rows">
          <span>Size: ${s.fromBefore.size} → ${s.fromAfter.size}</span>
          <span>Avg Age: ${deltaSpan(s.fromBefore.avgAge, s.fromAfter.avgAge, false)}</span>
          <span>Age SD: ${deltaSpan(s.fromBefore.sdAge, s.fromAfter.sdAge)}</span>
          <span>Rank SD: ${deltaSpan(s.fromBefore.sdRank, s.fromAfter.sdRank)}</span>
          <span>Score: ${deltaSpan(s.fromBefore.score, s.fromAfter.score)}</span>
        </div>
      </div>
      <div class="delta-block">
        <div class="delta-patrol">${esc(s.to)} (destination)</div>
        <div class="delta-rows">
          <span>Size: ${s.toBefore.size} → ${s.toAfter.size}</span>
          <span>Avg Age: ${deltaSpan(s.toBefore.avgAge, s.toAfter.avgAge, false)}</span>
          <span>Age SD: ${deltaSpan(s.toBefore.sdAge, s.toAfter.sdAge)}</span>
          <span>Rank SD: ${deltaSpan(s.toBefore.sdRank, s.toAfter.sdRank)}</span>
          <span>Score: ${deltaSpan(s.toBefore.score, s.toAfter.score)}</span>
        </div>
      </div>
    </div>
  </div>`;
}

function unassignedResultCard(r) {
  const movesHtml = r.moves.map(m => suggestionCard(m)).join("");

  let summary;
  if (r.remaining.length === 0) {
    summary = `
  <div class="suggestion-card" style="border-left-color:#2E7D32">
    <strong>${esc(r.patrolName)}</strong> is fully cleared - every scout was reassigned to an existing patrol above.
  </div>`;
  } else if (r.resolvedLowVariance) {
    const n = r.remaining.length;
    summary = `
  <div class="suggestion-card" style="border-left-color:#2E7D32">
    The remaining ${n} scout${n === 1 ? "" : "s"} in <strong>${esc(r.patrolName)}</strong> have low variance (score ${fmt(r.remainingScore)}) and could be formalized as a new patrol instead of splitting them up further.
  </div>`;
  } else {
    const n = r.remaining.length;
    const reason = n === 1
      ? `no suitable destination patrol was found for the last scout`
      : `variance is still too high (score ${fmt(r.remainingScore)}) and no suitable destination patrol was found for the rest`;
    summary = `
  <div class="suggestion-card warn">
    <strong>${esc(r.patrolName)}</strong> still has ${n} scout${n === 1 ? "" : "s"} - ${reason}. Manual review needed.
  </div>`;
  }

  return movesHtml + summary;
}

function mergeCard(m) {
  return `
  <div class="suggestion-card" style="border-left-color:#2E7D32">
    <div class="suggestion-header">
      <span class="badge" style="background:#2E7D32">Combine</span>
      <span>Combine <strong>${esc(m.patrolA)}</strong> (${m.beforeA.size}) and <strong>${esc(m.patrolB)}</strong> (${m.beforeB.size}) into one patrol of ${m.after.size}</span>
    </div>
    <div class="delta-grid">
      <div class="delta-block">
        <div class="delta-patrol">${esc(m.patrolA)}</div>
        <div class="delta-rows">
          <span>Size: ${m.beforeA.size}</span>
          <span>Avg Age: ${fmt(m.beforeA.avgAge)}</span>
          <span>Score: ${fmt(m.beforeA.score)}</span>
        </div>
      </div>
      <div class="delta-block">
        <div class="delta-patrol">${esc(m.patrolB)}</div>
        <div class="delta-rows">
          <span>Size: ${m.beforeB.size}</span>
          <span>Avg Age: ${fmt(m.beforeB.avgAge)}</span>
          <span>Score: ${fmt(m.beforeB.score)}</span>
        </div>
      </div>
      <div class="delta-block">
        <div class="delta-patrol">Combined</div>
        <div class="delta-rows">
          <span>Size: ${m.after.size}</span>
          <span>Avg Age: ${fmt(m.after.avgAge)}</span>
          <span>Age SD: ${fmt(m.after.sdAge)}</span>
          <span>Rank SD: ${fmt(m.after.sdRank)}</span>
          <span>Score: ${fmt(m.after.score)}</span>
        </div>
      </div>
    </div>
  </div>`;
}

function buildHTML(patrols, suggestions, unassignedResults, mergeResults, dateStr, troopName, cfg) {
  const label = troopName ? `${troopName} - ` : "";
  const { aw, rw, patrolMin, patrolMax, highVarThreshold } = cfg;

  function patrolStatusColor(p) {
    if (p.metrics.size < patrolMin || p.metrics.size > patrolMax) return "#E65100";
    if (p.metrics.score > highVarThreshold) return "#E65100";
    if (p.metrics.score > 0.75) return "#B8860B";
    return "#2E7D32";
  }

  function patrolCard(p) {
    const color     = patrolStatusColor(p);
    const scoreFlag = p.metrics.score > highVarThreshold ? " !" : "";
    const rows      = p.scouts.map(s => `
      <tr>
        <td class="check-cell"><span class="cb"></span></td>
        <td>${esc(s.fullName)}</td>
        <td>${s.age || "-"}</td>
        <td title="${esc(s.rank || "No Rank")}">${esc(rankAbbrev(s.rank))}</td>
      </tr>`).join("");
    return `
  <div class="patrol-card" style="border-left-color:${color}">
    <div class="patrol-header">
      <span class="patrol-name">${esc(p.name)}</span>
      <span class="patrol-size" style="color:${color}">${p.metrics.size} scouts</span>
    </div>
    <table>
      <thead><tr>
        <th class="check-cell"></th>
        <th>Scout</th><th>Age</th><th>Rank</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="patrol-metrics">
      <div class="metric">
        <span class="metric-label">Avg Age</span>
        <span class="metric-value">${fmt(p.metrics.avgAge)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Age SD</span>
        <span class="metric-value">${fmt(p.metrics.sdAge)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Rank SD</span>
        <span class="metric-value">${fmt(p.metrics.sdRank)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Score${esc(scoreFlag)}</span>
        <span class="metric-value" style="color:${color}">${fmt(p.metrics.score)}</span>
      </div>
    </div>
  </div>`;
  }

  const totalScouts      = patrols.reduce((s, p) => s + p.metrics.size, 0);
  const unassignedPatrols = patrols.filter(p => isUnassigned(p.name));
  const realPatrols      = patrols.filter(p => !isUnassigned(p.name));
  const established      = realPatrols.filter(p => !p.isNewScout);
  const newScoutGroups   = realPatrols.filter(p => p.isNewScout);
  const hasUndersized    = realPatrols.some(p => p.metrics.size < patrolMin);

  const step2Body = suggestions.length === 0
    ? `<p class="empty-msg">All patrols are within target range - no moves suggested.</p>`
    : suggestions.map(s => suggestionCard(s)).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(label)}Patrol Visualizer - ${esc(dateStr)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #FAF7F0; color: #1C2340;
    padding: 2rem; max-width: 1200px; margin: 0 auto;
  }
  .report-header {
    background: #2A3A1F; color: #fff;
    padding: 1.75rem 2rem; border-radius: 10px;
    margin-bottom: 1.5rem; border-bottom: 4px solid #C7A975;
  }
  .report-header h1 { font-size: 1.6rem; font-weight: 800; }
  .report-meta { font-size: 0.9rem; color: #E8DCC0; margin-top: 0.3rem; font-style: italic; }
  h2 {
    font-size: 1.05rem; font-weight: 700; color: #2A3A1F;
    border-bottom: 2px solid #C7A975; padding-bottom: 0.35rem;
    margin: 1.75rem 0 1rem;
  }
  .section-note {
    font-size: 0.8rem; color: #4A5568; margin-bottom: 1rem; font-style: italic;
  }
  .patrol-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem; margin-bottom: 0.5rem;
  }
  .patrol-card {
    background: #fff; border: 1px solid #D7CDB5;
    border-left: 5px solid #ccc; border-radius: 8px;
    overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .patrol-header {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.65rem 1rem; background: #F7F4EC;
    border-bottom: 1px solid #D7CDB5;
  }
  .patrol-name { font-weight: 700; font-size: 0.9rem; flex: 1; }
  .patrol-size { font-size: 0.82rem; font-weight: 700; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  thead th {
    background: #F0EBDC; padding: 0.4rem 0.7rem;
    text-align: left; font-weight: 600; font-size: 0.72rem;
    color: #4A5568; text-transform: uppercase; letter-spacing: 0.5px;
    border-bottom: 1px solid #D7CDB5;
  }
  tbody tr:nth-child(even) { background: #FAF7F0; }
  tbody tr:hover { background: #F0EBDC; }
  tbody td { padding: 0.4rem 0.7rem; border-bottom: 1px solid #EDE8DC; }
  tbody tr:last-child td { border-bottom: none; }
  .check-cell { width: 1.75rem; text-align: center; }
  .cb {
    display: inline-block; width: 12px; height: 12px;
    border: 2px solid #C7A975; border-radius: 3px; background: #fff;
  }
  .patrol-metrics {
    display: flex; background: #F7F4EC; border-top: 1px solid #D7CDB5;
  }
  .metric {
    flex: 1; padding: 0.45rem 0.5rem; text-align: center;
    border-right: 1px solid #D7CDB5;
  }
  .metric:last-child { border-right: none; }
  .metric-label { display: block; font-size: 0.62rem; color: #4A5568; text-transform: uppercase; letter-spacing: 0.4px; }
  .metric-value { display: block; font-size: 0.88rem; font-weight: 700; margin-top: 0.1rem; }
  /* Suggestions */
  .suggestion-card {
    background: #fff; border: 1px solid #D7CDB5;
    border-left: 5px solid #ccc; border-radius: 8px;
    padding: 0.9rem 1.1rem; margin-bottom: 0.9rem;
    box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  }
  .suggestion-card.warn { border-left-color: #B8860B; font-size: 0.88rem; color: #4A5568; }
  .suggestion-header {
    display: flex; align-items: center; gap: 0.65rem;
    margin-bottom: 0.65rem; font-size: 0.88rem;
  }
  .badge {
    color: #fff; font-size: 0.72rem; font-weight: 700;
    padding: 0.18rem 0.55rem; border-radius: 10px; white-space: nowrap;
  }
  .delta-grid { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .delta-block {
    flex: 1; min-width: 220px; background: #FAF7F0;
    border: 1px solid #D7CDB5; border-radius: 6px; padding: 0.55rem 0.8rem;
  }
  .delta-patrol { font-size: 0.78rem; font-weight: 700; color: #2A3A1F; margin-bottom: 0.35rem; }
  .delta-rows { display: flex; flex-wrap: wrap; gap: 0.35rem 0.75rem; font-size: 0.8rem; color: #4A5568; }
  .better { color: #2E7D32; font-weight: 600; }
  .worse  { color: #E65100; font-weight: 600; }
  .empty-msg { font-size: 0.88rem; color: #4A5568; font-style: italic; padding: 0.5rem 0; }
  .report-footer {
    text-align: center; font-size: 0.8rem; color: #9A7E4E;
    margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #D7CDB5;
  }
  @media print {
    body { background: #fff; padding: 1rem; }
    .report-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .patrol-card, .suggestion-card { break-inside: avoid; }
    .patrol-metrics, .badge { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    thead th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    /* The responsive auto-fill/minmax grid used on screen collapses to a
       single column at PDF print time (Chromium's print layout pass uses
       the paper's content width, not the browser viewport) - force the
       same 3-column layout the web report shows instead of leaving it to
       auto-fill. */
    .patrol-grid { grid-template-columns: repeat(3, 1fr); }
  }
</style>
</head>
<body>

<div class="report-header">
  <h1>⚜ ${esc(label)}Patrol Visualizer</h1>
  <div class="report-meta">Generated ${esc(dateStr)}  •  ${totalScouts} active youth  •  ${realPatrols.length} patrols${unassignedPatrols.length ? `  •  ${unassignedPatrols.reduce((s, p) => s + p.metrics.size, 0)} unassigned` : ""}</div>
</div>

<h2>Step 1 - Established Patrols</h2>
<div class="patrol-grid">
  ${established.map(p => patrolCard(p)).join("")}
</div>

${unassignedPatrols.length ? `
<h2>Unassigned Scouts</h2>
<p class="section-note">No patrol on file - grouped by gender. Clearing these out is a top priority; see below.</p>
<div class="patrol-grid">
  ${unassignedPatrols.map(p => patrolCard(p)).join("")}
</div>` : ""}

${newScoutGroups.length ? `
<h2>New Scout Patrols</h2>
<p class="section-note">All No Rank - kept separate from rebalancing suggestions.</p>
<div class="patrol-grid">
  ${newScoutGroups.map(p => patrolCard(p)).join("")}
</div>` : ""}

${hasUndersized ? `
<h2>Combine Undersized Patrols</h2>
<p class="section-note">
  Top priority - checked first: two undersized patrols are often better fixed by
  merging them outright than by moving one scout at a time. Only suggested when the
  combined patrol fits within the max size and keeps variance low (score ≤ ${highVarThreshold}).
</p>
${mergeResults.merges.length === 0
  ? `<p class="empty-msg">No pair of undersized patrols could be combined without exceeding the max size or pushing variance too high.</p>`
  : mergeResults.merges.map(m => mergeCard(m)).join("")}` : ""}

${unassignedResults.length ? `
<h2>Clear Unassigned Scouts</h2>
<p class="section-note">
  Second priority (after combining undersized patrols above): first checks whether
  the unassigned group is already low-variance enough to formalize as its own patrol;
  if not, peels off the single biggest age outlier to the best-fit existing patrol
  and re-checks, repeating until what's left is low-variance, empty, or has nowhere
  left to go.
</p>
${unassignedResults.map(r => unassignedResultCard(r)).join("")}` : ""}

<h2>Step 2 - Rebalancing Suggestions</h2>
<p class="section-note">
  Each suggestion is a single-move analysis from current state.
  Weighted score = ${Math.round(aw * 100)}% age SD + ${Math.round(rw * 100)}% rank SD.
  Target size: ${patrolMin}-${patrolMax}.
  High-variance threshold: ${highVarThreshold}.
  Rank scale: No Rank=0, Scout=1, Tenderfoot=2, Second Class=3, First Class=4, Star=5, Life=6, Eagle=7.
</p>
${step2Body}

<div class="report-footer">
  Patrol Visualizer  •  ${esc(dateStr)}
</div>
</body>
</html>`;
}

// ═══════════════════════════════ CSV ════════════════════════════════════
function buildCSV(patrols) {
  const esc2 = v => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["Patrol", "Type", "Gender", "Size", "Avg Age", "Age SD", "Rank SD", "Score", "Scout", "Age", "Rank"].join(",")];
  for (const p of patrols) {
    p.scouts.forEach((s, i) => {
      lines.push([
        i === 0 ? p.name : "",
        i === 0 ? (isUnassigned(p.name) ? "Unassigned" : p.isNewScout ? "New Scout" : "Established") : "",
        i === 0 ? (p.gender === "F" ? "Female" : "Male") : "",
        i === 0 ? p.metrics.size : "",
        i === 0 ? fmt(p.metrics.avgAge) : "",
        i === 0 ? fmt(p.metrics.sdAge) : "",
        i === 0 ? fmt(p.metrics.sdRank) : "",
        i === 0 ? fmt(p.metrics.score) : "",
        s.fullName, s.age, s.rank || "No Rank",
      ].map(esc2).join(","));
    });
  }
  return lines.join("\r\n");
}

// ═══════════════════════════════ PDF ════════════════════════════════════
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
      // Left/right kept at 0.25in - the minimum most consumer printers can
      // reliably print to - to give the 3-column patrol grid as much
      // width as possible. Top/bottom unaffected since they don't bear on
      // that.
      margin: { top: "0.75in", bottom: "0.75in", left: "0.25in", right: "0.25in" },
      printBackground: true,
    });
    return pdfPath;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ═══════════════════════════════ MAIN ════════════════════════════════════
function fileTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

async function generate(inputs, outputDir, options = {}) {
  const { roster: rosterPath } = inputs;
  if (!rosterPath || !fs.existsSync(rosterPath)) throw new Error("TroopWebHost roster CSV not provided");

  const aw  = Math.min(Math.max(parseFloat(options.ageWeight) || AGE_WEIGHT, 0.1), 0.9);
  const rw  = Math.round((1 - aw) * 10) / 10;
  const cfg = {
    aw,
    rw,
    patrolMin:        Math.max(parseInt(options.patrolMin) || TARGET_MIN, 1),
    patrolMax:        Math.max(parseInt(options.patrolMax) || TARGET_MAX, 1),
    highVarThreshold: HIGH_VAR_THRESHOLD,
  };
  if (cfg.patrolMin > cfg.patrolMax) cfg.patrolMax = cfg.patrolMin;

  const scouts      = loadRoster(rosterPath);
  const patrols     = buildPatrols(scouts, cfg.aw, cfg.rw);
  const realPatrols = patrols.filter(p => !isUnassigned(p.name));

  // Top tier: combining undersized patrols is evaluated first. Any patrol
  // claimed by a suggested merge is pulled out of consideration for the
  // lower-priority tiers below, so the report doesn't also suggest moving
  // a scout into (or out of) a patrol it just proposed dissolving.
  const mergeResults = findMergeSuggestions(realPatrols, cfg);
  const patrolsAfterMerge     = patrols.filter(p => !mergeResults.usedNames.has(p.name));
  const realPatrolsAfterMerge = realPatrols.filter(p => !mergeResults.usedNames.has(p.name));

  const unassignedResults = resolveUnassigned(patrolsAfterMerge, cfg);
  const suggestions = findSuggestions(realPatrolsAfterMerge, cfg);
  const dateStr     = todayLong();
  const ts          = fileTimestamp();
  const troopName   = options.troopName || "";

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const htmlFileName = `Patrol_Visualizer_${ts}.html`;
  const htmlPath     = path.join(outputDir, htmlFileName);
  fs.writeFileSync(htmlPath, buildHTML(patrols, suggestions, unassignedResults, mergeResults, dateStr, troopName, cfg), "utf8");

  const output = {
    htmlFileName,
    htmlPath,
    pdfPath:  null,
    csvPath:  null,
    stats: {
      activeScouts: scouts.length,
      patrols:      realPatrols.length,
      unassigned:   scouts.length - realPatrols.reduce((s, p) => s + p.metrics.size, 0),
      suggestions:  suggestions.length,
      unassignedMoves: unassignedResults.reduce((s, r) => s + r.moves.length, 0),
      merges:       mergeResults.merges.length,
    },
  };

  if (options.downloadPdf === true || options.downloadPdf === "true") {
    output.pdfPath     = await buildPDF(htmlPath);
    output.pdfFileName = path.basename(output.pdfPath);
  }

  if (options.downloadCsv === true || options.downloadCsv === "true") {
    const csvFileName  = `Patrol_Visualizer_${ts}.csv`;
    output.csvPath     = path.join(outputDir, csvFileName);
    output.csvFileName = csvFileName;
    fs.writeFileSync(output.csvPath, buildCSV(patrols), "utf8");
  }

  return output;
}

module.exports = { manifest, generate };
