# Troop Tools - Project Context

This document provides context for AI coding assistants (Claude Code, etc.) working on this project. Read this before making any changes.

---

## What This Is

A Node.js application for BSA Scoutmasters that automates report generation from TroopWebHost (TWH) CSV exports and my.scouting.org data.

Two ways it runs:
- **From source** (developers): `npm install && npm start`, opens at `http://localhost:3001` (auto-increments if busy).
- **As a standalone installer** (end users): a Windows `.exe` (Inno Setup) or macOS `.app`/`.dmg`, built by `scripts/build.js` and distributed via GitHub Releases. No Node.js or npm required on the user's machine.

The user opens it in a browser, either signs into TroopWebHost (the app drives a hidden Playwright browser to fetch CSVs automatically) or uploads CSVs manually, and generates reports with one click. Files are delivered through the browser's normal download mechanism.

The repo is public: `github.com/ErrorF002/twh-troop-tools`. It is **not affiliated with or endorsed by the Boy Scouts of America** - avoid language, branding, or identifiers (app publisher, bundle ID, etc.) that imply otherwise. "BSA" only belongs in places describing actual BSA terminology (rank names, the "BSA ID" field, etc.), never as this project's own branding.

---

## Tech Stack

- **Runtime:** Node.js 18+, Windows primary (Mac supported, less tested)
- **Server:** Express 4
- **File uploads:** Multer
- **Browser automation:** Playwright (Chromium) - TroopWebHost login/download automation and PDF generation
- **PPTX generation:** pptxgenjs
- **PDF slide-deck generation:** pdfkit (used only by `shared/slide-deck.js` - see below)
- **Frontend:** Vanilla HTML/CSS/JS - no framework
- **Packaging:** `@yao-pkg/pkg` (compiles to a single binary) + Inno Setup 6 (Windows installer) / `hdiutil` (macOS dmg)
- **Unique IDs:** uuid

---

## Project Structure

```
troop-tools/
├── server.js                  Express server - routes, auth, file serving, pkg-aware path resolution
├── settings.js                Persisted settings: troop name, subdomain. Project dir in dev,
│                               OS user-data dir (%APPDATA%/TroopTools, ~/Library/Application Support/TroopTools)
│                               when packaged.
├── package.json                Dependencies, pkg config, build scripts
├── LICENSE                    MIT
├── assets/
│   ├── icon.svg                Source icon (OD green/tan, "TT" monogram)
│   ├── icon.ico                Generated multi-res Windows icon
│   └── icon.icns                Generated macOS icon
├── scripts/
│   ├── install-browser.js     Resilient Chromium installer (doesn't fail npm install)
│   ├── build.js                Builds the standalone installer (pkg + Inno Setup / hdiutil) - see below
│   └── dev/
│       └── fetch_badges.js    One-off maintainer tool, scrapes scouting.org for the official badge list
├── public/
│   ├── index.html             Login view, first-run setup wizard, Settings modal, dashboard
│   ├── style.css              Scout-themed: OD green / tan / cub blue
│   └── app.js                 Frontend: login, setup wizard, settings, session state, card rendering
├── reports/                   One file per report - drop a new file here to add a report
│   ├── advancement.js         Patrol advancement slide deck (PPTX or landscape PDF)
│   ├── health.js              Quarterly committee health slide deck (PPTX or landscape PDF)
│   ├── merit-badges.js        Merit badge analytics (HTML + optional PDF/CSV)
│   ├── patrol-balance.js      Patrol composition + rebalancing suggestions (HTML)
│   ├── audit.js                Roster data-quality audit (HTML), manifest id "roster-audit"
│   ├── contacts.js            Leader contacts export (Google CSV or VCF)
│   └── reconciliation.js      my.scouting vs TroopWebHost comparison (HTML + optional PDF/CSV)
├── shared/
│   ├── csv-parser.js          Handles quoted fields, BOM, CRLF
│   ├── name-normalize.js      normalizeName(), formatDisplayName()
│   ├── dates.js               parseDate() handles both 2-digit and 4-digit years
│   ├── slide-deck.js          Shared slide-deck abstraction (see below) - write a slide once,
│   │                           render as PPTX (pptxgenjs) or landscape PDF (pdfkit)
│   └── pdf-fonts.js           Resolves Arial/Calibri TTFs from the OS's own installed fonts for
│                               slide-deck.js's PDF backend (never bundled - proprietary fonts)
└── twh/
    ├── session.js             Singleton Playwright browser, 30-min inactivity timeout
    ├── login.js               TWH login - handles frameset redirect + popup modal
    └── downloads.js           Direct URL navigation to download CSVs; Menu_Item_IDs are hardcoded in RECIPES
```

---

## TroopWebHost Architecture (Hard-Won Knowledge)

TWH is an ASP.NET site with unusual structure. Key facts:

- **Frameset:** The root URL loads a `<frameset>` containing `Redirect.htm`, which runs JavaScript to detect screen width, then loads the real page. Playwright must wait for this redirect chain to complete.
- **Login:** A "Log On" link in the top-right opens a popup modal with fields `name="User_Login"` and `name="User_Password"`. The submit button is `type="button"` (not `type="submit"`) with `name="login"`.
- **Menu:** Behind a hamburger button (`href="javascript:togglemenu();"`). Categories use `toggleLower('mNN')` to expand - they don't navigate.
- **Downloads:** Reports are downloaded by navigating directly to URLs of the form `https://www.troopwebhost.org/FormReport.aspx?Menu_Item_ID=XXXXX&Stack=1&ReportFormat=XLS`.

Menu_Item_IDs for TroopWebHost's built-in reports turned out to be **the same across every org**, not troop-specific as originally assumed (confirmed 2026-08-12) - so they're hardcoded directly in `twh/downloads.js`'s `RECIPES` object (`roster: 53747`, `requirements: 46047`, `meritBadges: 52388`), not read from settings. `settings.js` only holds `troopName` and `subdomain` now. If you add a new TroopWebHost recipe, find its ID the same way (run the report manually, read `Menu_Item_ID=` from the URL) and hardcode it in `RECIPES` too.

`RECIPES.porHistory` = `46041` ("Leadership Rank Requirement Status", Advancement → Advancement Status Reports; confirmed 2026-08-29 from a live site). Feeds the Eagle Preparedness Report's position-of-responsibility section (Eagle req. 4). That report has one row per scout working toward a rank, with columns `Next Rank, Scout, Patrol, Last Rank Earned On, Current Position, Leadership Days Earned, Leadership Days Needed`. `processLeadership()` in `reports/eagle-prep.js` keeps the `Next Rank == "Eagle"` rows (= current Life Scouts) and treats requirement 4 as met when `Leadership Days Needed` is 0 — TWH does the position-approval and since-Life-BOR accounting itself. If the uploaded file lacks those headers it renders a "not the expected export" notice listing the headers it saw.

**Download trigger:** `page.goto(url)` throws "Download is starting" - this is expected and must be caught silently. The download event listener must be set up before the navigation.

---

## Report Architecture

Each report module exports:

```js
module.exports = {
  manifest: {
    id: "string",
    name: "string",
    description: "string",
    icon: "emoji",
    outputType: "html" | undefined,   // undefined = file download, "html" = open in new tab
    inputs: [
      {
        key: "string",
        label: "string",
        hint: "string",
        required: true|false,
        twhReport: "roster"|"requirements"|"meritBadges"|null,  // null = manual upload only
      }
    ],
    options: [   // optional - non-file inputs rendered above generate button
      {
        key: "string",
        label: "string",
        type: "text"|"radio"|"checkbox",
        placeholder: "string",     // for text
        choices: [{value, label}], // for radio
        default: value,
        required: true|false,
      }
    ]
  },
  generate: async (inputs, outputDir, options) => ({
    // For file output:
    filePath: "/absolute/path/to/file",
    fileName: "filename.ext",
    stats: { key: value },   // shown in UI after generation
    // For outputType: "html":
    htmlPath, htmlFileName,
    pdfPath, pdfFileName,    // optional
    csvPath, csvFileName,    // optional
  })
};
```

`options.troopName` is auto-injected by `server.js` from settings before `generate()` is called, unless already provided. Reports should fall back to a generic label (e.g. "BSA Troop") if it's empty, never a specific real troop name.

The server auto-discovers all `.js` files in `reports/`. Adding a new report = drop a file there and restart.

---

## Slide-Deck Reports (PPTX or PDF)

`advancement.js` and `health.js` are built as slide decks via `shared/slide-deck.js`, which lets each report describe its slides **once** and render either format from the identical layout:

```js
const { SlideDeck } = require("../shared/slide-deck");
const deck = new SlideDeck();          // mirrors pptxgenjs's own API - addSlide/addShape/addText,
deck.title = "...";                    // shapes via deck.shapes.RECTANGLE / ROUNDED_RECTANGLE,
const slide = deck.addSlide();         // all coordinates in inches, same as pptxgenjs
slide.background = { color: "2A3A1F" };
slide.addShape(deck.shapes.RECTANGLE, { x, y, w, h, fill: { color }, line: { type: "none" } });
slide.addText("...", { x, y, w, h, fontSize, bold, color, fontFace, align, valign, margin: 0 });

await deck.writePptx(filePath);        // -> pptxgenjs
await deck.writePdf(filePath);         // -> pdfkit, landscape, same 10in x 5.625in page as the slide
```

This is why existing slide-builder functions barely changed when this was introduced: they already called `pres.addSlide()` / `pres.shapes.X` / `slide.addShape()` / `slide.addText()`, and `SlideDeck` mirrors that surface exactly, so only the construction site (`new SlideDeck()` instead of `new pptxgen()`) and the final write step needed to change.

Both reports expose an `outputFormat` manifest option (`radio`, choices `"pptx"`/`"pdf"`, default `"pptx"`) and branch in `generate()`:
```js
const outputFormat = options.outputFormat === "pdf" ? "pdf" : "pptx";
if (outputFormat === "pdf") await deck.writePdf(filePath); else await deck.writePptx(filePath);
```

**Why the PDF looks exactly like the PPTX:** the PDF page is created at the *same physical size* as the pptxgenjs `LAYOUT_16x9` slide (10in x 5.625in), so every x/y/w/h/fontSize position carries over as a direct inches-to-points multiplication with no scaling factor - both formats are driven by the literal same layout calls, not two independently-maintained renderers.

**Known gotcha already hit and fixed:** pdfkit treats `.text()` as flowing document content by default - if no explicit `height` option is given, it silently calls its own `addPage()` once its internal y-cursor crosses the page's bottom margin, corrupting a fixed-canvas slide layout (this showed up as extra near-blank pages breaking the patrol-progress grids in `advancement.js`, one per slide whose content ran close to the bottom). `slide-deck.js`'s `drawText()` always passes a large explicit `height` to sidestep this - if you touch that function, don't drop it.

**Fonts:** "Arial Black"/"Calibri" (used throughout both reports) aren't PDF-standard fonts. `shared/pdf-fonts.js` resolves real TTFs directly from the OS's own installed fonts (`C:\Windows\Fonts` on Windows) at render time and embeds them - these are never bundled/committed, since Arial and Calibri are proprietary and the repo is public. "Arial Black" specifically maps to bold Arial (`arialbd.ttf`), since Arial Black itself isn't reliably present outside a full Office install. Falls back to pdfkit's built-in core Helvetica family (always present, never fails) if a font file isn't found - relevant mainly on Mac, where Calibri usually isn't installed by default (Mac PDF output will look close but not exact).

**Packaging gotchas found and fixed when this shipped in a real build (v0.9.4):**
- pkg's bundled Node 18 ships "small-icu" (no legacy 8-bit codecs). fontkit (a pdfkit dependency) does `new TextDecoder('ascii')` at module load time - and per the WHATWG Encoding Standard, the `"ascii"` label decodes via the **windows-1252** codec, which throws `ERR_ENCODING_NOT_SUPPORTED` under small-icu. Since `reports/health.js`/`reports/advancement.js` (and therefore pdfkit) are loaded eagerly by `server.js`'s report auto-discovery, this crashed the *entire packaged app* at startup, not just PDF generation. Fixed the same way as the `crypto` shim below: `shared/pkg-polyfills.js`'s `installTextDecoderPolyfill()`, wired in from `server.js`'s `process.pkg` block, patches in a hand-written windows-1252 decoder for exactly the legacy label set that aliases to it, before fontkit ever loads.
- pdfkit's own bundled standard-font metrics (`node_modules/pdfkit/js/data/*.afm`, used whenever `PDFDocument` inits its default Helvetica font) aren't picked up by pkg's static analysis - same category of gotcha as `playwright-core/browsers.json` below. Fixed by adding `"node_modules/pdfkit/js/data/**/*"` to `pkg.assets` in `package.json` (the semantically-correct field for non-JS data files, vs. `pkg.scripts` for JS).

Both were caught and fixed via the documented Phase-0-style verification process below (silent-installed the real `.exe` and generated both a PPTX and a PDF through the actual packaged dashboard) - don't skip that step after touching anything font- or pdfkit-related.

---

## Key Data Notes

### TroopWebHost Roster CSV

- Field `FIrst Name` has a typo (capital I) - this is how TWH exports it
- Dates are in `MM/DD/YY` format (2-digit year) - `parseDate()` handles this
- Adults: `Adult === "Y"`, Youth: `Adult === "N"`
- Inactive scouts are in patrols starting with `zinactive` - filter these out
- Alumni have empty `Patrol` field - filter these out
- `BSA ID` field matches `..memberid` in my.scouting exports

### my.scouting Roster CSV

- Has a 10-line header block before the actual data (district, council, org name, etc.)
- Troop name can be extracted from line matching `Organization Name: Troop 0123...`
- Field `..memberid` has leading dots due to the comment marker format
- `firstname` field contains legal first name + middle name combined (e.g. "Jiann Molly") - strip after first word for name comparison
- Youth are `positionname === "Youth Member"`, adults have various role names
- Rank names differ from TWH: "Eagle Scout" vs "Eagle", "Star Scout" vs "Star", etc.
- Palm ranks (Gold/Silver/Bronze Palm) should be treated as equivalent to Eagle

### Name Normalization

`normalizeName()` in `shared/name-normalize.js` strips middle initials and suffixes because the roster CSV has them but the requirements CSV doesn't. This was critical - without it, 17% of scouts were silently dropped from the advancement report.

---

## Color Palette (All Reports and UI Use These)

```
--od-green:       #3A4F2A   (primary green)
--od-green-dark:  #2A3A1F   (dark headers)
--od-green-light: #5C7A47   (hover states)
--tan:            #C7A975   (accent / stripe)
--tan-light:      #E8DCC0   (subtitle text)
--cub-blue:       #003F87   (secondary action)
--bg-page:        #FAF7F0   (warm cream background)
--text-dark:      #1C2340
--text-mid:       #4A5568
--text-light:     #FFFFFF
--border:         #D7CDB5
--row-alt:        #F0EBDC   (alternating table rows)
```

Rank colors (used in both PPTX and HTML):
- Scout: `#2E7D32`
- Tenderfoot: `#E65100`
- Second Class: `#1565C0`
- First Class: `#6A1B9A`
- Star: `#C0392B`
- Life: `#B8860B`
- Eagle: `#0B3D6B`

The app icon (`assets/icon.svg`) uses the same OD green/tan palette.

---

## UI Behavior

- **First-run setup wizard** (`setupComplete: false` in settings) walks new users through troop name and TWH subdomain before showing the dashboard. Menu_Item_IDs are no longer collected - they're hardcoded (see TroopWebHost Architecture above).
- **Settings modal** lets users revisit all of the above anytime.
- **Cards are collapsed by default** - click header to expand; accordion behavior (one open at a time)
- **Login persists the subdomain** in `localStorage` - shown read-only with a "Change" link
- **Remember Me** stores username + password in `localStorage` (user-opted-in, with warning)
- **Fetch & Generate** auto-downloads CSVs from TWH and streams the result to the browser's download dialog
- **Partial fetch** (reconciliation): fetches what it can from TWH, prompts for manual upload of the rest
- **HTML output type** (merit-badges, patrol-balance, audit, reconciliation): server returns JSON with a `/view/` URL; frontend opens it in a new tab
- **Session timeout**: 30 minutes of inactivity closes the Playwright browser; user must log in again

---

## Things to Never Do

- **No em dashes** anywhere in user-facing text (UI, report output, README, release notes). Use plain hyphens instead.
- **No tar.gz** for packaging - always use `.zip` (npm distribution) or the Inno Setup `.exe` / `.dmg` (installer distribution)
- **No generated files** (PPTX, PDF, CSV, VCF, HTML) in the project directory or committed to git. `dist/` is gitignored; installer binaries are distributed via GitHub Releases only, never committed to the repo tree.
- **Credentials never written to disk** - TWH login credentials live in memory only
- **Don't break the manual upload fallback** - every report must work without TWH auto-fetch
- **No real troop-identifying data in source or docs** - no real troop numbers/names or subdomains as "defaults" or example values. The repo is public; use generic placeholders like "Troop 123 Anytown". (Menu_Item_IDs are the exception - they're stock TroopWebHost identifiers shared across every org, not troop-identifying, so they're fine to hardcode - see TroopWebHost Architecture above.)
- **No implied BSA affiliation** - this is an independent tool, not published or endorsed by BSA. Keep BSA references limited to actual domain terminology.

---

## Reports Summary

| Report | Manifest id | Output | TWH Auto-Fetch | Manual Input |
|---|---|---|---|---|
| Advancement Report | `advancement` | PPTX or landscape PDF (choice) | Roster + Requirements | Both CSVs |
| Troop Health Report | `health` | PPTX or landscape PDF (choice) | Roster | Roster CSV |
| Merit Badge Analysis | `merit-badges` | HTML (+ optional PDF/CSV) | Merit Badge History | CSV |
| Merit Badge Search | `merit-badge-search` | HTML (+ optional PDF/CSV) | Roster + Merit Badge History | Both CSVs |
| Eagle Preparedness Report | `eagle-prep` | HTML (+ optional PDF/CSV) | Merit Badge History (+ Leadership Rank Requirement Status, optional) | Merit Badge History CSV; optional Leadership Rank Requirement Status CSV. Sections: badge matrix, missing-required, Eagle Palms projection, Eagle req. 4 (position of responsibility) |
| Patrol Visualizer | `patrol-balance` | HTML (+ optional PDF/CSV) | Roster | Roster CSV |
| Roster Audit | `roster-audit` | HTML | Roster | Roster CSV |
| Roster Reconciliation | `reconciliation` | HTML (+ optional PDF/CSV) | Roster | my.scouting CSV |
| Troop Contacts Export | `contacts` | CSV or VCF | Roster | Roster CSV |

---

## Packaging & Distribution (Hard-Won Knowledge)

`npm run build:win` / `build:mac` run `scripts/build.js`, which compiles with `@yao-pkg/pkg`, copies `public/` next to the binary, downloads a Playwright Chromium into a `browsers/` folder next to the binary, then wraps it with Inno Setup (Windows) or `hdiutil` (Mac). All of this was built, broken, and fixed for real - these gotchas will bite again if touched carelessly:

- **`pkg` needs `.` + a `"bin"` field, not a direct file path.** `pkg server.js` compiles fine but **silently ignores the entire `"pkg"` config block** in package.json (no `scripts`/`assets` bundling at all, no warning). Only `pkg .` (which requires `"bin"` in package.json) reads that config. package.json has `"bin": "server.js"` for exactly this reason - don't remove it.
- **`playwright-core`'s `browsers.json` doesn't get auto-bundled.** It's required via a path pkg's static analysis can't follow. It's explicitly listed in `pkg.scripts` in package.json. If Playwright ever throws `Cannot find module '...browsers.json'` from a packaged build, this is why.
- **pkg's V8 snapshot breaks Node's lazy `globalThis.crypto` getter** on Node 18, throwing `TypeError: Invalid host defined options` the moment `playwright-core` loads. `server.js` shims it with `Object.defineProperty(globalThis, "crypto", ...)` before any playwright-touching code runs, gated on `process.pkg`. Don't remove this without re-testing a packaged build.
- **pkg's Node 18 has no full ICU, so `new TextDecoder('ascii')` throws** the moment fontkit (a pdfkit dependency) loads - crashing the whole app at startup, since reports are loaded eagerly. Fixed via `shared/pkg-polyfills.js`'s `installTextDecoderPolyfill()`, wired in next to the crypto shim above. See "Slide-Deck Reports" above for the full story.
- **pdfkit's own bundled font-metrics data (`node_modules/pdfkit/js/data/*.afm`) isn't auto-bundled either** - same shape of bug as the `browsers.json` one above. Listed in `pkg.assets` in package.json.
- **Inno Setup's `PrivilegesRequired`** is `lowest` (not `admin`) - this app installs per-user to avoid a UAC prompt, matching where `settings.js` writes (`%APPDATA%`/`~/Library/Application Support`, not a machine-wide location). The desktop shortcut uses `{autodesktop}` (not `{commondesktop}`) so it adapts correctly.
- **App icon**: `assets/icon.ico`/`icon.icns` are generated from `assets/icon.svg` (ImageMagick: `magick -background none icon.svg -resize 1024x1024 icon-1024.png`, then `-define icon:auto-resize=...` for the `.ico` and a direct `magick icon-1024.png icon.icns` for the `.icns`). Wired in via `SetupIconFile=` in the generated `.iss` and `CFBundleIconFile` in `Info.plist`.
- **On Windows, run silent installers via PowerShell `Start-Process`, not Git Bash.** Git Bash's MSYS path conversion mangles leading-slash flags like `/VERYSILENT` into `C:/Program Files/Git/VERYSILENT`, which makes Inno Setup launch in full interactive mode instead of silently.
- **Distribution is via GitHub Releases, not the git tree.** The installer binary (~230 MB) is uploaded as a release asset (`gh release create`/`gh release upload --clobber`), tagged to match the version in `package.json`. `dist/` stays gitignored. When re-releasing under the same version tag after a fix, move the tag (`git tag -f vX.Y.Z <commit> && git push origin vX.Y.Z --force`) and re-upload with `--clobber` so the release stays consistent with what it's tagged at.
- **Verifying a build actually works** means: build it, install it silently on this machine (`Start-Process installer.exe -ArgumentList "/VERYSILENT","/SUPPRESSMSGBOXES" -Wait`), launch the *installed* binary (not the `dist/` output directly), and confirm it serves the dashboard, reads settings from the real OS user-data path (not the dev project dir), and that Playwright's bundled Chromium actually launches. All of these have broken independently before.

---

## Known Issues / Future Work

- **TWH automation fragility** - if TWH changes their HTML structure, `twh/login.js` selectors may need updating. Diagnostic capture (screenshot + form-elements.json) is built in and triggers automatically on failure.
- **macOS build is unverified** - the pipeline exists (`build:mac`) but has never actually been run/tested on a Mac. Treat it as best-effort until someone does.
- **No code signing** - both the Windows installer and macOS app are unsigned (cost isn't justified for a small hobby project yet). Windows shows a SmartScreen warning; Mac requires right-click → Open. Documented in the README.
- **No CI, no automated tests** - deliberate for now, given the small scope and single maintainer. Revisit if regressions start recurring.
