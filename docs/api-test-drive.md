# Deployed API test: Eskilstuna T 667-25

Test date: **2026-09-15**. Server: `https://lagen.nu`.
Input: `Eskilstuna TR T 667-25 Dom 2025-12-12.pdf` from the repository root.
The original PDF is not bundled with the SPA or its tests.

## Page numbering

The file has a cover page. Printed pages 10–13 are PDF pages 11–14.
Both interpretations of the requested range were tested.

| Input | Occurrences | Distinct target URIs |
|---|---:|---:|
| PDF pages 10–13 | 14 | 7 |
| Printed pages 10–13, through the SPA | 19 | 9 |

Repeated references remain separate occurrences.
The SPA resolves each distinct target once per run.

## Results from printed pages 10–13

| Reference | API result | Occurrences |
|---|---|---:|
| NJA 2013 s. 372 | Invalid | 3 |
| NJA 1995 s. 603 | Invalid | 2 |
| NJA 1999 s. 687 | Invalid | 3 |
| NJA 2002 s. 725 | Invalid | 2 |
| 12 kap. 1 § avtalslagen | Invalid provision | 2 |
| 4 § avtalslagen | Found | 2 |
| Avtalslagen, without a provision | Found | 3 |
| 18 kap. 7 § rättegångsbalken | Found | 1 |
| 10 kap. 9 § handelsbalken | Found | 1 |

Total: **12 invalid occurrences and 7 found occurrences**.
These totals count references in the court's discussion as well as quoted submissions.
They do not count separate errors by the author.

The API correctly finds 4 § avtalslagen.
Its source text concerns late acceptance. The quoted submission attributes a rule about guarantees to it.
Phase 1 shows the claim and provision together for manual review.
It does not produce an automatic contradiction label.

## PDF line wraps can change API interpretation

Passing `pdftotext -layout` output directly exposed a problem on printed page 13.
This citation contains a physical line break:

```text
18 kap.
                7 § rättegångsbalken
```

The deployed extractor returned two occurrences:

- `18 kap.` → `https://lagen.nu/1915:218#K18`, inheriting the earlier avtalslagen context.
- `7 § rättegångsbalken` → `https://lagen.nu/1942:740#P7`.

Both incorrect targets then resolve as invalid.
Joining the wrapped line produces `https://lagen.nu/1942:740#K18P7`, which resolves as found.

The SPA joins line wraps for extraction, including pasted text, and keeps paragraph gaps.
It maps API offsets back to the original text, including line breaks and indentation.
The report displays the full document with inline marks and a linked side panel.
Regression tests cover LF, CRLF, indentation, emoji offsets, and complete sentence context.
The backend's handling of raw layout text remains unchanged.

The user's exact two-line quote now returns one found reference to `#K18P7`.
Pasting the full printed-page excerpt also returns 19 occurrences: 12 invalid and 7 found.
The marked document retains the pasted text without changes.

## Endpoint checks

- `POST /api/v1/citations/extract`: HTTP 200, UTF-16 locations, repeated occurrences, and `Cache-Control: no-store`.
- JSON CORS preflight from `http://localhost:5173`: HTTP 200, wildcard origin, GET/POST, and `content-type` allowed.
- `GET /api/v1/resolve`: expected found, invalid, and unconfirmed responses.
- `GET /api/v1/document?uri=…&format=md`: JSON envelope with Markdown source text.
- A fragment URI sent to `/document` returns 404. The SPA fetches the resolved parent URI and selects the provision locally.
- Invalid JSON and invalid fields return 422. Unsupported media types return 415.
- Validation responses inspected in this test do not echo submitted text.

The resolver's tested NJA boundaries are:

| Query | Result |
|---|---|
| 1873 s. 1 | Invalid: before publication starts |
| 1874 s. 99999 | Unconfirmed |
| 1980 s. 99999 | Unconfirmed |
| 1981 s. 99999 | Invalid |
| 2025 s. 99999 | Invalid |
| 2026 s. 99999 | Unconfirmed |
| 2027 s. 1 | Invalid: future year at test date |
| 2013 s. 0 | Invalid |
| 2013 s. 502 | Found |

These checks confirm that high page numbers alone do not cause invalidity outside complete coverage.
They do not independently prove the completeness of the server's corpus.
HTTP checks also cannot prove the server's memory, logging, or buffer configuration.

## Browser and timing checks

The actual PDF runs through PDF.js in Chromium against the deployed API.
The SPA sends one extraction request, nine resolution requests, and three source-document requests.
All thirteen requests return HTTP 200. No browser errors occur.
The production build also passes this check from a static `/slopcheck/` URL.
The run takes about **0.9 seconds** after local PDF reading.
Separate extraction requests take about **0.4–0.6 seconds** in this session.
These are individual measurements, not a latency guarantee.

The browser produces a printable PDF with all occurrences, claims, sources, and page locations.
Automated browser checks also cover synthetic PDF/DOCX files, failures, cancellation,
target deduplication, source selection, text highlighting, printing, and mobile width.

## Phase 2 production check, 16 September 2026

The production build runs under `/slopcheck/`, including the model and WASM assets.
A controlled source/claim pair produces “Stöd hittat” with the exact source passage.
The browser reports no page errors.

The live check again uses PDF positions 11–14 (printed pages 10–13).
It finds 19 references: 12 invalid and 7 found.
The semantic stage abstains on all 19. It adds no claim warnings or support labels.
This confirms integration, not semantic usefulness on this judgment.
See [the model evaluation](semantic-evaluation.md) for the measured limits.
