# slopcheck

Slopcheck checks the legal citations in a text: that each cited provision, case
or förarbete exists, and whether the cited source supports the claim made
beside it. It is a static JavaScript app with a small backend for the server
model, live at [slopcheck.tomtebo.org](https://slopcheck.tomtebo.org). It
started from Phases 1 and 2 of
[`PRD-juridisk-hanvisningskontroll.md`](../ferenda/PRD-juridisk-hanvisningskontroll.md).

It has two modes:

- **Normal mode.** lagen.nu extracts and resolves the citations
  (`/api/v1/citations/extract`, `/api/v1/resolve`) and serves the source text.
  The backend compares each claim with its source using a fine-tuned KBLab
  Megatron-BERT-large.
- **Integritetsläge (privacy mode).** The text stays in the browser. Citations are
  extracted by the JavaScript port of lagen.nu's `LagrumParser`, and a 25 MB
  student of the server model compares the claims in the browser. See
  [What leaves the browser](#what-leaves-the-browser).

## Run

Use Node.js 22.13 or later.

```sh
cd slopcheck
npm ci
npm run model:prepare
npm run dev
```

Open the URL printed by Vite. The app calls `https://lagen.nu/api/v1` directly.
Normal mode also calls `/api/match`, which the dev server proxies to the deployed
backend; set `SLOPCHECK_BACKEND` to use another one. Privacy mode needs no backend.
No local Ferenda process or credentials are needed.

## Build and host

Run locally with npm:

```sh
npm run build
npm run preview
```

Or run locally with Docker:

```sh
docker compose up -d --build
```

Nginx serves the static files on `http://127.0.0.1:8099`.

## Deploy on ludo.tomtebo.org

The repo is github.com/staffanm/slopcheck, cloned on ludo as
`~/repos/slopcheck`. Deploy is push here, pull and build there:

```sh
git push
ssh ludo.tomtebo.org "cd repos/slopcheck && git pull && docker compose up -d --build"
```

Model files are not in git. Copy a new server model directory to ludo with rsync.
The backend serves the model that `SERVER_MODEL` in `.env` names
(`models/<SERVER_MODEL>/`), and only when its files match
`backend/model-integrity.json`. Record a model there
after you train or calibrate it: `python -m backend.integrity models/<name>`. The
browser model has the same check: `npm run build` compares `public/models/<version>/`
with the hashes in `src/model-manifest.json`.

The multi-stage Docker build compiles the static bundle at container build time
and serves it via nginx on `127.0.0.1:8099`. The host nginx proxies
`slopcheck.tomtebo.org` to it, with a certbot certificate — set up once via
`sudo ~/repos/slopcheck/install-slopcheck.sh` on ludo.

Relative asset paths support hosting at `/slopcheck/` or at a domain root.
Serve JavaScript modules with a JavaScript MIME type, including `.mjs`.
No rewrite rules or server-side proxy are required.
Permit connections to `https://lagen.nu` in the host's Content Security Policy.
The app uses workers served from its own origin.
PDF.js can also require `blob:` worker URLs.

### What leaves the browser

Original files remain in the browser in both modes.

- **Normal mode** sends the document's text to lagen.nu for extraction, the cited
  uris to `/resolve` and `/document`, and each claim with its source passages to
  the slopcheck backend (`/api/match`). The backend logs only the call (path and
  status), not the claim, the source or the result.
- **Privacy mode** sends no text, no claim and no cited uri. The browser
  extracts the citations and runs the comparison.
  - Existence: the browser downloads one filter over every document and
    provision (`GET /api/v1/range/filter`, about 21 MB, cached for a day) and
    checks each citation locally.
  - Text: each cited provision (or a judgment without provisions) is fetched
    with `GET /api/v1/range/{prefix}?bits=16`. The prefix is the first 16 bits
    of the hash of the provision's own uri. An answer holds about 143 units of
    unrelated documents. A check sends 128 such requests (or a multiple of 128)
    in random order, the real ones among fillers. The fillers are the same on
    every check from one browser and are drawn half from the most cited
    provisions.
  - The server learns 128 buckets and not which of them are real. A citation of
    a whole document that has provisions ("brottsbalken") gets no text in
    privacy mode.

The app stores the mode preference and the secret that picks the filler
requests in `localStorage`. No documents are stored in `localStorage`,
`IndexedDB`, caches, or a service worker. Model assets, the filter and the
range answers use versioned Cache Storage caches; documents and inference
results never enter them. No analytics, remote fonts, or runtime CDN dependencies are
used. Reloading or clearing the document removes the session's report.

## Features

- Pasted text, text-bearing PDF files, and DOCX files.
- Full document text with inline citation marks and a linked side panel.
- One text input and file drop target. Select a file, then start the check.
- Whole-file reading, document locations, and next/previous error navigation.
- One report entry per occurrence, including repeated references and multiple targets.
- URI-based resolution, four concurrent target checks, and deduplicated source requests.
- Separate found, invalid, unconfirmed, pending, and request-failure states.
- Exact provision selection for supported Swedish Markdown layouts.
- Local passage ranking and normalized quote matching in a Web Worker.
- Four claim labels: stöd hittat, stöd saknas, motsägelse, vilseledande, and abstention
  ("Kunde inte bedömas") when the model is below its calibrated threshold.
- A certainty slider ("Självsäkerhet"): at 100 % the calibrated result, below it also
  the model's less certain labels, marked "osäkrare än vanligt". The probabilities show on hover.
- Claim context: a claim that starts by referring back ("Det gäller …", "Detta innebär …")
  includes the sentence before; PDF footnotes are inlined beside their sentence.
- Exact source units: a Swedish provision, an EU article, paragraph or recital, a
  judgment paragraph (`#point-N`), or a förarbete page.
- WebGPU when available, with local WASM recovery if GPU execution fails.
- Cancellation, retry of failed sources or local inference, filters, and printing all report entries.
- Swedish interface, keyboard controls, visible focus, and mobile layout.

The document retains its original text and line breaks. Filters affect the side
panel; they never remove document text or citation marks. Selecting a mark opens
its details. Selecting an entry in the side panel moves to that document location.
Printing includes the marked document and all citation details.
Open side-panel entries show a short result or a source link.
Source passages expand on request. Semantic findings show their claim and decisive evidence.
The full document supplies the surrounding context.

For extraction, the client joins wrapped lines and keeps paragraph boundaries.
A UTF-16 boundary map translates API locations back into the original text.
This also applies to pasted text, including CRLF line endings and indented lines.

The API determines invalidity. The client never infers invalidity from missing text,
network failures, or high page numbers. It sends interpreted target URIs to the
resolver, preserving the API's document context.

## Limits

- 25 MiB per file and 250,000 Unicode characters. There is no PDF page selection or page-count cap.
- 5,000 blocks and 2,000,000 bytes per extraction request.
- No OCR. Semantic labels remain experimental; the small evaluation does not establish legal reliability.
- PDF reading follows the file's text-item order. Complex columns can need manual correction.
- DOCX extraction retains headings, paragraphs, table-cell text, and notes. It does not retain layout.
- Printed page numbers can differ from PDF page positions. The report shows PDF positions and available page labels.
- Context extraction uses sentence boundaries. Ambiguous claims still need manual review.
- A quoted phrase match proves matching words only. It does not establish support for the entire claim.
- Source selection can use the whole document when the exact provision is unavailable.
  lagen.nu has no anchors for Swedish court decisions, so a pinpoint into one is read whole.
- Sources use the API's presented version. They do not automatically select historical wording.
- No citations found does not prove that a document contains no citations.

## Tests

```sh
npm test
npx playwright install chromium
npm run test:browser
```

The parser parity tests use fixtures from the sibling `../ferenda` checkout.
The `export:lagrum` command also reads that checkout.

To use an existing Chromium executable, set `CHROMIUM_PATH`.
Browser tests mock API responses. The semantic evaluation uses the actual local model.
The first model load can take several seconds. They check PDF/DOCX extraction, request privacy,
repeated occurrences, deduplication, failures, source evidence, printing, and layout.
The small PDF and DOCX fixtures contain synthetic text.

See [the deployed API test report](docs/api-test-drive.md) for the judgment check.

## Files

| File | Responsibility |
|---|---|
| `index.html`, `src/style.css` | Swedish interface and print layout |
| `src/main.js` | Session state, file selection, progress, and report rendering |
| `src/api.js` | Extraction, resolution, source requests, and request concurrency |
| `src/privacy-api.js`, `src/unit-index.js`, `src/ohttp.js` | Privacy mode: existence from the filter, unit text among filler requests, and the (disabled) OHTTP client |
| `src/polyfills.js` | `ReadableStream` async iteration for older Safari |
| `src/analysis.js` | Text normalization and offset mapping, inline spans, claim context, source selection, quote matching, and PDF line assembly |
| `src/lagrum-extract.js` | Browser-side citation extraction coordinator, span filtering, and block location mapping |
| `src/lagrum/` | JavaScript port of `LagrumParser`, Lark-compatible Earley parser, compiled EBNF grammars, and datasets |
| `src/document.worker.js` | PDF/DOCX reading and evidence selection |
| `src/semantic.js` | Claim rules, label thresholds, aggregation, and filters |
| `src/semantic-input.js` | Tokenizer pair inputs and bounded source passages |
| `src/semantic-client.js`, `src/semantic.worker.js` | Cancellation, model asset cache, and local inference |
| `src/model-manifest.json` | Pinned model revision and evaluated asset hashes |
| `scripts/export-model.py`, `scripts/check-model.js` | Reproducible export and build validation |
| `backend/` | The server model: FastAPI `/api/match`, windowing, calibration, model integrity check |
| `scripts/train_kb_bert.py`, `scripts/distill_kb_bert.py`, `scripts/export_student.py`, `scripts/calibrate_onnx.py` | Training, distillation, 4-bit export, and calibration |

Document parsing uses [PDF.js](https://mozilla.github.io/pdf.js/examples/)
and [Mammoth](https://github.com/mwilliamson/mammoth.js).
[Vite](https://vite.dev/guide/) builds the static assets.

## Local semantic comparison

The model compares the cited source (premise) with a nearby claim (hypothesis) and gives the
same four labels as the server: supported, unsupported, incorrect, misleading. It is a student of
the server model: [KB-BERT](https://huggingface.co/KB/bert-base-swedish-cased) cut to 4 of its 12
layers and to the vocabulary that legal Swedish uses, distilled from the server's classifier
(`scripts/distill_kb_bert.py`) and exported with 4-bit weights (`scripts/export_student.py`). The
model and tokenizer total 24.9 MB. The ONNX browser runtime adds about 28.3 MB before HTTP
compression. The manifest carries the labels and the calibration; the label policy is the
server's (`fourLabelResult` in `src/semantic.js`).
Serve `.wasm` as `application/wasm`; enable gzip or Brotli for static assets.
A CSP must allow local workers, WASM execution (`wasm-unsafe-eval`), and lagen.nu connections.

The model starts only when a confirmed source has a readable passage and an assessable claim.
The premise is one window of at most 380 model tokens, as in training; claims have at most 150.
Neither input is truncated.
Conflicting evidence, long inputs, ambiguous attribution, and model failures cause abstention.
Exact quote matches remain separate from semantic support.

Claim extraction recognizes clauses such as “som stadgar att …” and explicit court attribution.
For judgments, source selection retains court and section headings. It excludes other courts, identified reported statements, and trailer lines such as Lagrum and Rättsfall.
The headnote of a referat counts as the reporting court's summary. A report without court headings, such as an HFD referat, is read as the reporting court's own text.
Claims about what a court holds require supporting evidence in its summary or decision before receiving “Stöd hittat”.
This rule does not resolve every instance of quoted or reported speech.
The passages are ranked with BM25 and merged into one window, the way the server builds its window.
The two reported legal examples now reach the model. Both still produce abstention; neither receives a confident error label.

Model files stay cached when the document is cleared. Clear site data to remove those files.
Changing the model requires an export version change, new hashes, and a fresh evaluation.
See [the evaluation and release limits](docs/semantic-evaluation.md).

## Server comparison

Normal mode compares claims on the server with
[KBLab Megatron-BERT-large](https://huggingface.co/KBLab/megatron-bert-large-swedish-cased-165-zero-shot),
fine-tuned as a four-label claim classifier (supported, unsupported, incorrect,
misleading) and exported to ONNX with int8 weights, 354 MB. The backend windows a
long source into premises of the length the model was trained on, and one
judgment covers every cited source of a row.

Each label has its own threshold, calibrated for a target precision of 0.85; a
label that cannot reach it is never given. Measured with the deployed int8 model:

| Test set | Answered | Right among the answered |
|---|---|---|
| Test partition | 607 of 860 | 0.852 |
| Hand-written claims (`test/fixtures/legal-claims.jsonl`) | 37 of 55 | 33 (0.89) |

"Misleading" does not pass calibration and "incorrect" reaches 0.78, so a wrong
claim is more often left unassessed than labelled. Both models can be downloaded:
the server model at `/downloads/server-model/`, the browser model at `/models/`.
The KB models' license is 26 a § upphovsrättslagen (1960:729).

## Dataset Viewer & Review UI

To inspect, filter, and review the Swedish legal claim-evidence dataset (7,492 partitioned rows) on your desktop or mobile phone:

```sh
python3 scripts/serve_dataset_viewer.py --host 0.0.0.0 --port 8088
```

See [the Dataset Viewer documentation](docs/dataset-viewer.md) for details on multi-source evidence cards, side-by-side claim comparison, lagen.nu navigation, and stratified sample reviews.
