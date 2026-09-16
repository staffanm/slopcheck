# Review of the local JavaScript citation extractor

Reviewed 16 September 2026. This review covers Gemini's uncommitted implementation.
The findings below remain unfixed. Phase 2's semantic implementation is a separate change.

## Findings

### P1: Preserve complete citation candidates before accepting publication links

Location: `src/lagrum-extract.js:24–33`.

`extractLocal` uses only `LagrumParser.parse_text`. The API also runs candidate recognition,
exact lookup, and treaty matching in `ferenda/lib/citationextract.py`.
The missing step changes the identity being checked, rather than only reducing coverage.

Examples from the frozen API extraction fixtures:

| Input | Local result | API fixture expectation |
|---|---|---|
| `NJA 2013 s. 372–374` | `dom/nja/2013s372`, with the range removed | Whole citation, no determined target |
| `NJA 2013 s. 372 II` | `dom/nja/2013s372`, with the suffix removed | Whole citation, no determined target |
| `12 kap. 1 § FFFS 2020:1` | `fffs/2020:1`, with the pinpoint removed | `fffs/2020:1#K12P1` |
| `GDPR artikel 32` | No occurrence | `celex/32016R0679#32` |
| `ECLI:EU:C:2020:559` | No occurrence | Retained occurrence, no determined target |

A real parent document can now produce “Hittad källa” while the written pinpoint remains unchecked.
This repeats the failure mode that prompted the missing-space fix.
Preserve complete candidates and unresolved occurrences before suppressing overlapping publication links.
Use the extraction fixtures, including malformed inputs, as the parity contract.

### P1: Restore the year guard for CJEU references without a court letter

Location: `src/lagrum/lagrum.js:1387–1392`.

Input:

```
i mål 23452/94 den 28 oktober 1998, Osman mot Förenade kungariket
```

The JavaScript parser emits `https://lagen.nu/celex/61994CJ23452` for `mål 23452/94`.
The Python parser explicitly rejects this CJEU interpretation for years outside 1954–1989.
Its ECHR matcher identifies `https://lagen.nu/dom/echr/001-58257` instead.
The port omits that guard and checks the wrong court's target.
Port the guard and its existing `test_ecj_letterless_form_is_year_bounded` regression.

### P2: Run the enabled matchers that sit outside the grammar

Location: `src/lagrum/lagrum.js:707–709` and `ALL_PARSE_TYPES` at lines 57–62.

`ALL_PARSE_TYPES` includes `EMDRATTSFALL`, `MALNUMMER`, and `ENGLAGRUM`.
The JavaScript `parse_text` returns after the grammar scan and never runs these matchers.
The Python implementation runs all three before returning.

These inputs therefore disappear in local mode:

- `avgörandet, ansökan nr 23452/94, i samma mål`
- `Högsta domstolens dom 2009-11-03 T 3-08`
- `SFS 1982:80, Chapter 2, Section 3`

The relevant regression tests exist in `test/test_lagrum.py`, but are absent from the JS suite.
Implement the matchers and their required snapshots, or clearly restrict the advertised local coverage.

### P2: Clear the singleton parser's document state after extraction

Location: `src/lagrum-extract.js:22–24` and return at line 85.

The parser resets before extraction, but not after it.
`parse_text` stores the complete normalized document in `this._scan_text` at `lagrum.js:675`.
The singleton keeps this string, learned names, and abbreviations after the report is cleared.
The clear button empties UI state but never resets this parser.

After extracting 68,000 characters, `getLocalParser()._scan_text.length` still equals 68,000.
Use a `finally` block to reset document state after producing the result.
The API already clears its shared parser in `citationextract.extract`.

### P2: Move local extraction off the main thread

Location: `src/api.js:29–32`.

The `async` function calls `extractLocal` synchronously. The parser scans the whole document
before control returns to the browser. The abort signal is checked only before this scan.
The progress display and cancel button cannot respond during extraction.

A valid 244,800-character input with 3,600 repeated citations takes about 3.7 seconds on this host.
This input is below the advertised 250,000-character limit. Slower devices can take longer.
Run the scan in a worker and terminate it on cancellation, as the other local stages do.

## Checks performed

- The maintained JS tests pass, including the ported legalref fixtures.
- Compared all eight `test/files/resolve/extraction.json` cases with `extractLocal`.
  Six cases differ. The differences include lost targets, lost occurrences, and shortened citations.
- Confirmed the malformed NJA, missing regulatory pinpoint, missing matcher, and wrong-court examples above.
- Confirmed original UTF-16 positions for an emoji before `12 kap. 1§ avtalslagen`.
- Measured synchronous extraction with 20, 200, 1,000, and 3,600 repeated citations.
- Confirmed that the singleton retains the complete normalized input after extraction.

The grammar export sync test checks generated grammar and datasets only.
It cannot catch missing formatter guards or missing post-grammar matchers.
The JS tests also primarily compare URI lists; add complete occurrence and offset parity checks.

## Reproduce the API fixture comparison

Run from the repository root:

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import { extractLocal } from './slopcheck/src/lagrum-extract.js';
const cases = JSON.parse(fs.readFileSync('test/files/resolve/extraction.json'));
for (const item of cases) {
  const got = extractLocal([{ id: 'text', text: item.text }]).map(occurrence => [
    occurrence.text,
    occurrence.targets.map(target => target.uri.replace('https://lagen.nu/', '')),
  ]);
  if (JSON.stringify(got) !== JSON.stringify(item.matches)) {
    console.log(JSON.stringify({ text: item.text, expected: item.matches, got }, null, 2));
  }
}
JS
```
