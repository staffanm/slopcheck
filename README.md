# slopcheck

A static JavaScript app for Phases 1 and 2 of
[`PRD-juridisk-hanvisningskontroll.md`](../ferenda/PRD-juridisk-hanvisningskontroll.md).
The service name is **slopcheck**.

## Run

Use Node.js 22.13 or later.

```sh
cd slopcheck
npm ci
npm run model:prepare
npm run dev
```

Open the URL printed by Vite. The app calls `https://lagen.nu/api/v1` directly.
It needs no local Ferenda process, credentials, or application backend.

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

Original files remain in the browser. In default mode, the extraction request sends text to lagen.nu.
In local privacy mode, the browser extracts citations with the JavaScript `LagrumParser`.
The running text does not leave the browser in local mode.
Only identified citations are sent to `GET /api/v1/resolve?q=${uri}` to verify their validity.
The app states this transfer before the check button.
It stores only the local mode preference in `localStorage`.
No documents are stored in `localStorage`, `IndexedDB`, caches, or a service worker.
Model assets use a versioned Cache Storage cache. Documents and inference results never enter that cache.
Model and runtime downloads come from the SPA host. No remote inference service is used.
No analytics, remote fonts, or runtime CDN dependencies are used.
Reloading or clearing the document removes the session's report.

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
- Experimental local semantic comparison with separate source and claim statuses.
- Claim rules, tokenizer limits, conservative thresholds, and abstention.
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
| `src/analysis.js` | Text normalization and offset mapping, inline spans, claim context, source selection, quote matching, and PDF line assembly |
| `src/lagrum-extract.js` | Browser-side citation extraction coordinator, span filtering, and block location mapping |
| `src/lagrum/` | JavaScript port of `LagrumParser`, Lark-compatible Earley parser, compiled EBNF grammars, and datasets |
| `src/document.worker.js` | PDF/DOCX reading and evidence selection |
| `src/semantic.js` | Claim rules, label thresholds, aggregation, and filters |
| `src/semantic-input.js` | Tokenizer pair inputs and bounded source passages |
| `src/semantic-client.js`, `src/semantic.worker.js` | Cancellation, model asset cache, and local inference |
| `src/model-manifest.json` | Pinned model revision and evaluated asset hashes |
| `scripts/export-model.py`, `scripts/check-model.js` | Reproducible export and build validation |

Document parsing uses [PDF.js](https://mozilla.github.io/pdf.js/examples/)
and [Mammoth](https://github.com/mwilliamson/mammoth.js).
[Vite](https://vite.dev/guide/) builds the static assets.

## Local semantic comparison

The model compares each source passage (premise) with a nearby claim (hypothesis).
It uses [ScandiNLI small](https://huggingface.co/alexandrainst/scandi-nli-small),
with 8-bit matrix weights and float32 activations. The model and tokenizer total 24.6 MB.
The ONNX browser runtime adds about 28.3 MB before HTTP compression.
Serve `.wasm` as `application/wasm`; enable gzip or Brotli for static assets.
A CSP must allow local workers, WASM execution (`wasm-unsafe-eval`), and lagen.nu connections.

The model starts only when a confirmed source has a readable passage and an assessable claim.
Passages have at most 350 model tokens; claims have at most 150. Neither input is truncated.
Conflicting evidence, long inputs, ambiguous attribution, and model failures cause abstention.
Exact quote matches remain separate from semantic support.

Claim extraction recognizes clauses such as “som stadgar att …” and explicit court attribution.
For judgments, source selection retains court and section headings. It excludes other courts, identified reported statements, and trailer lines such as Lagrum and Rättsfall.
The headnote of a referat counts as the reporting court's summary. A report without court headings, such as an HFD referat, is read as the reporting court's own text.
Claims about what a court holds require supporting evidence in its summary or decision before receiving “Stöd hittat”.
This rule does not resolve every instance of quoted or reported speech.
A statute provision is compared one stycke or sentence at a time. A whole multi-paragraph provision as one premise scores at chance with the small model.
The two reported legal examples now reach the model. Both still produce abstention; neither receives a confident error label.

Model files stay cached when the document is cleared. Clear site data to remove those files.
Changing the model requires an export version change, new hashes, and a fresh evaluation.
See [the evaluation and release limits](docs/semantic-evaluation.md).

## Plan: a more capable model server-side

The local model is too small for the job. On the 70-claim corpus fixture it labels 9 claims and
abstains on 55. It cannot tell “fem år” from “tio år” with confidence, and it reads an
exception stycke as a contradiction of the main rule. See
[the evaluation](docs/semantic-evaluation.md). A larger NLI model fixes part of this.
A larger model does not fit the browser: mDeBERTa-v3-base XNLI is about 280 MB quantized,
ten times the current download.

The plan is a slopcheck-specific inference service, not a lagen.nu API:

1. **Model.** [mDeBERTa-v3-base-xnli-multilingual-nli-2mil7](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7),
   exported to ONNX with int8 weights the same way `scripts/export-model.py` exports the small model.
   About 86M encoder parameters and a 190M-parameter embedding table; about 600 MB resident in int8.
   Evaluate it on `test/fixtures/legal-claims.json` before anything else. If it does not beat the
   small model on that fixture, stop here.
2. **Service.** One container on ludo.tomtebo.org beside the static site, `slopcheck-nli`, running
   ONNX Runtime on CPU. One endpoint, `POST /nli`, that takes a list of premise/hypothesis pairs and
   returns the three scores per pair. No document text, no citation, no session: the browser still
   extracts the claim and selects the passages, and sends only those pairs. The service keeps no log
   of request bodies. The host nginx proxies `slopcheck.tomtebo.org/nli` to it, same certificate.
3. **Cost.** Ludo has 3 virtual Broadwell cores with AVX2 and FMA, 7 GB of RAM, and 124 GB free disk,
   shared with the paragraf and paratext containers. A 512-token pair costs roughly 0.4 to 0.8 seconds
   quantized on one core; the passages the browser now selects are mostly under 128 tokens, which is
   four to eight times cheaper. A ten-citation document with five passages each is 50 pairs, so
   expect 5 to 30 seconds per check. Run one worker with a request queue and a 60-second timeout.
   Measure before deciding whether that is acceptable; the numbers above are estimates, not benchmarks.
4. **Client.** A third mode beside default and local privacy mode: “server comparison”. The mode
   selector states what leaves the browser. In local privacy mode the small model stays the only option.
   The label policy, thresholds and the label rule in the tests apply unchanged to the server scores;
   thresholds are recalibrated on the fixture for the new model, and the recorded results in `docs/`
   are regenerated per model.
5. **Deterministic checks first.** A number check does not need a model: extract quantities with a
   unit (år, veckor, månader, dagar, procentenheter, kr) from the claim and the provision, and report a
   differing number as its own finding. Eight of the 25 incorrect fixture claims are wrong numbers.
   This ships before the service, in the browser, and applies to both models.

Not in the plan: exposing the service under lagen.nu, GPU hosting, or a generative model as judge.

## Dataset Viewer & Review UI

To inspect, filter, and review the Swedish legal claim-evidence dataset (7,492 partitioned rows) on your desktop or mobile phone:

```sh
python3 scripts/serve_dataset_viewer.py --host 0.0.0.0 --port 8088
```

See [the Dataset Viewer documentation](docs/dataset-viewer.md) for details on multi-source evidence cards, side-by-side claim comparison, lagen.nu navigation, and stratified sample reviews.
