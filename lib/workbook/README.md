# Merit Badge Workbook Generator

Paste requirement text in, get a blank merit badge workbook out as `.docx`.

The pipeline is three stages, and the middle one is deliberate:

```
pasted text  ->  badges/<slug>.json  ->  <Badge>-Workbook.docx
  (parse)          (review + tune)          (render)
```

The parser gets the structure and the official wording right. It guesses at
what capture area belongs under each item, and it guesses conservatively: a
lined box unless the wording clearly asks for something else. The JSON exists
so you can correct those guesses before a Scout ever sees the workbook. Going
straight from text to `.docx` is supported, but the result is a first draft.

This module never reads TroopWebHost data. Workbooks are blank forms, so no
Scout PII is in this path. Worth keeping that way.

## Files

```
lib/workbook/index.js        buildWorkbook(def), workbookFromText(text, meta)
lib/workbook/parse.js        parseRequirements(text, meta) -> { def, warnings }
lib/workbook/blocks.js       page geometry and the capture-area primitives
badges/<slug>.json           one reviewed definition per badge
requirements/<slug>.txt      the raw pasted source, kept so you can re-parse
bin/new-badge.js             text -> badges/<slug>.json
bin/generate-workbook.js     badges/<slug>.json -> output/<Badge>-Workbook.docx
routes/workbooks.js          Express router with a paste-in form
test/workbook.test.js        node:test smoke tests
output/                      generated .docx (gitignored)
```

## Install

```
npm install docx
```

Merge the scripts block from `package.json.snippet`, add the line from
`gitignore.snippet`, and wire the route into your app entry point:

```js
app.use("/workbooks", require("./routes/workbooks"));
```

Then `node --test test/workbook.test.js` to confirm everything resolves.

## Everyday use

**From the browser.** Go to `/workbooks`, paste requirements into the box, name
the badge, submit. You get the `.docx` immediately and the parsed definition is
saved to `badges/` for later tuning.

**From the terminal.**

```
node bin/new-badge.js --name "Cooking" --in requirements/cooking.txt --build
node bin/generate-workbook.js cooking
node bin/generate-workbook.js --all
node bin/generate-workbook.js --list
```

`new-badge.js` also reads stdin, so `pbpaste | node bin/new-badge.js --name "Cooking"`
works on macOS and `Get-Clipboard | node bin/new-badge.js --name "Cooking"` on Windows.

**From code.**

```js
const { workbookFromText, buildWorkbook } = require("./lib/workbook");

const { buffer, def, warnings } = await workbookFromText(pastedText, {
  badge: "Cooking",
  requirementsRevised: "2026",
});
```

## Getting a Google Doc

The generator produces Word format. Upload to Drive and open with Google Docs
to convert. Everything emitted is paragraphs and tables, which convert cleanly.
Word form fields and content controls do not survive that conversion, which is
why answer areas are drawn as bordered tables.

Default font is Arial, not Arial Narrow. Arial Narrow is not in the Google Docs
font menu, so it gets substituted on conversion anyway; using Arial up front
means the line breaks you preview are the line breaks Scouts see. Set
`"font": "Arial Narrow"` per badge if you are only ever printing.

## What the parser accepts

Mix and match; most sources are consistent within themselves.

```
1. Requirement text          1) Requirement text        1 Requirement text
   (a) Sub text              a. Sub text                a) Sub text
       (1) Nested text           1. Nested text
```

- Lines starting with `Resource:` or `Resources:` are dropped, along with the
  continuation lines that follow them (lines ending in `(video)`, `(PDF)`,
  `(website)`, `(playlist)`, `(fillable)`, and similar). Paste straight from
  the requirements page without cleaning it up first.
- A line that does not start a new item is appended to the item above it, so
  hard-wrapped source text reassembles correctly.
- A missing period after the number is fine. `6 Plan the Program` parses.
- Numbering gaps produce a warning, not a failure, so you can see that
  something was mis-detected rather than silently losing a requirement.

### What it infers, and where it will be wrong

| Signal in the text | Block produced |
|---|---|
| Item has sub-items | no capture area on the parent |
| "identify at least two", "explore three careers" | `numbered` with that count |
| "log of what you eat and drink for three days" | 3-column day `grid` |
| anything else | `lines`, 4 to 6 rows by length |

It cannot infer things like a multi-checkpoint measurement table, a program
outline with named elements, or a sign-off block. Those are judgment calls
about how the badge is actually taught. `badges/personal-fitness.json` is the
worked example of a reviewed definition; diff it against a fresh parse of
`requirements/personal-fitness.txt` to see the kind of tuning that pays off.

## Badge definition schema

```jsonc
{
  "badge": "Personal Fitness",          // required. Title, header, filename
  "requirementsRevised": "2025",        // optional. Printed on the cover
  "workbookUpdated": "August 2026",     // optional. Printed on the cover
  "font": "Arial",                      // optional
  "creditLine": "...",                  // optional. Cover footer line 1
  "rightsLine": "...",                  // optional. Cover footer line 2
  "religiousNote": "...",               // optional. Overrides the standard note

  "requirements": [
    {
      "num": 1,                         // required
      "text": "Defining Personal ...",  // required. Official wording, verbatim
      "pageBreakBefore": true,          // optional
      "before": [ /* blocks */ ],       // optional. Above the sub-list
      "subs": [
        {
          "letter": "a",
          "text": "Describe a ...",
          "blocks": [ /* blocks */ ],   // omit for discussion-only items
          "subs": [ /* one more level of nesting */ ]
        }
      ],
      "after": [ /* blocks */ ]         // optional. Summary tables, sign-offs
    }
  ],

  "appendices": [                       // optional. Each starts on a new page
    { "title": "...", "subtitle": "...", "blocks": [ /* blocks */ ] }
  ]
}
```

### Block types

Any block accepts `"wide": true` to use the full text column instead of hanging
under the sub-requirement letter.

| Type | Purpose | Keys |
|---|---|---|
| `lines` | Plain lined answer area | `rows` |
| `fields` | Label / value rows | `labels[]`, `labelWidth` (dxa), `blanksAfter` |
| `numbered` | Numbered slots, 1..n | `count` |
| `grid` | Header row plus blank rows | `headers[]`, `widths[]`, `rows`, `rowLabels[]`, `headerSize`, `cellSize` |
| `repeatgrid` | The same grid repeated n times | all `grid` keys plus `count`, `caption`, `perPage` |
| `note` | Italic guidance, not official text | `text` |
| `label` | Caption above a capture area | `text`, `bold` |
| `heading` | Centered section heading | `text`, `size` |
| `pagebreak` | Force a page break | none |

`widths` are proportional weights, not twips. `[3, 1, 1]` means the first column
is three times the others; exact dxa values are resolved to sum to the printable
width. This matters because Google Docs mangles percentage-width tables.

`rowLabels` fills column 1 of each body row with fixed text. If present, `rows`
defaults to its length.

`caption` in `repeatgrid` uses `{n}` for the iteration number, e.g. `"Week {n}"`.
`perPage` inserts a page break every n repetitions.

### Conventions worth keeping

- Official requirement text goes in `text` verbatim. Anything you add as
  guidance goes in a `note` block so it is visibly not part of the requirement.
- Discussion-only sub-requirements get no `blocks`. Personal Fitness
  requirement 4 is the example: three discussion items, then one summary table
  in `after` capturing what was agreed.
- When a requirement asks the Scout to repeat an earlier measurement, use one
  table with a column per checkpoint and point back to it with a `note`, rather
  than duplicating the table.

## Staleness

Requirements are revised on an annual cycle and a JSON file has no idea it went
out of date. `requirementsRevised` prints on the cover so a counselor can spot
an old workbook, but that is a convention, not a check. If this grows into a
real library, add a `verifiedOn` date and have the picker flag anything older
than a year. Better to decide that deliberately than to find out when a
counselor rejects a Scout's workbook.
