# Experimental semantic comparison

## What ships

The browser runs ScandiNLI small through ONNX Runtime Web.
It uses [Alexandra Institute's model](https://huggingface.co/alexandrainst/scandi-nli-small)
at revision `5c7d1eec144f2342823d829693d19cf5230b32a9`.
The export quantizes matrix weights and embeddings to int8. Activations remain float32.
The checked-in manifest records the evaluated files and their SHA-256 hashes.
The model file is 22,323,359 bytes. Model and tokenizer assets total 24.6 MB.
The browser runtime adds about 28.3 MB before HTTP compression.

The model receives source text first and the claim second.
Its output labels are entailment, neutral, and contradiction, in that order.
No text goes to a model API. Only immutable model assets enter Cache Storage.
[ONNX Runtime](https://onnxruntime.ai/docs/tutorials/web/) supplies local WASM and WebGPU execution.

## Small Swedish evaluation

The [fixture](../test/fixtures/semantic-cases.json) has 24 authored examples.
They are synthetic test statements, not legal advice or assertions about current law.
They cover paraphrases, negation, unrelated references, changed outcomes, missing conditions,
party attribution, neutral mentions, quotation overreach, and unassessable text.
There are 12 calibration examples and 12 separate test examples.
Four unassessable examples exercise claim rules; the other 20 run through the real browser worker.
Claim extraction, source selection, conflicting passages, and token limits also have unit tests.

Initial model outputs expose a serious attribution error.
For `party-attribution`, the model assigns about 0.961 entailment probability
when the claim incorrectly attributes a party's statement to the court.
This error rules out an entailment threshold of 0.95.
The calibration examples support provisional thresholds of 0.97 for support and contradiction,
and 0.90 for neutral evidence. These values favor abstention over coverage.
The same values apply to the separate test examples; they were not lowered to improve test recall.

A support or contradiction signal of at least 0.20 conflicts with the opposite signal.
Conflicting passages produce abstention. Incomplete input also produces abstention.
All compared passages must exceed the neutral threshold to show “Support not found.”
A quote match never sets a semantic support label by itself.

### Browser results, 16 September 2026

[Recorded outputs](semantic-evaluation-results.json) come from the shipped tokenizer,
quantized model, worker, and label policy. Chromium runs the WASM backend on this host.

| Split | Examples | Substantive labels | Incorrect substantive labels | Abstentions |
|---|---:|---:|---:|---:|
| Calibration | 12 | 4 | 0 | 8 |
| Separate test | 12 | 1 | 0 | 11 |

The test split produces only one substantive label, “Support not found.”
It gives no evidence that supported or contradiction labels generalize reliably.
These results are too small and too selective to establish legal precision.
**The release remains experimental.** An independent, expert-reviewed legal corpus is still required
before removing that label. Do not describe these results as validated legal accuracy.

The recorded first ten comparisons take about 7.9 seconds including startup.
The next ten take about 1.1 seconds with the model already loaded.
These short examples use one passage each. This is not the PRD's full ten-citation benchmark.
Physical WebGPU performance and memory behavior on mobile devices remain unmeasured.
The browser tries WebGPU and recovers locally through WASM if GPU initialization or inference fails.

## Reported legal claims

The [legal fixtures](../test/fixtures/legal-claims.json) preserve both reported examples.
They use the complete 4 § avtalslagen and the NJA 2013 s. 502 report.
[Source provenance](../test/fixtures/legal-sources/README.md) records their origin.

The guarantee example now extracts the complete claim after “som stadgar att”.
It no longer stops at the introductory “Detta”. Both paragraphs of the provision stay together.
The model still fails to identify the unrelated subject confidently. It abstains with scores of
0.599 support, 0.226 neutral, and 0.175 contradiction.

The HD example now records the attributed court separately from the claim.
Selection retains court and section labels and excludes lower-court passages from inference.
It reserves space for HD's summary and decision, even when earlier passages share more words.
Explicit claims about a court's holding need supporting summary or decision evidence to receive “Stöd hittat”.
The reported example abstains because the selected passages give conflicting signals.
Its maximum support score is 0.691; its maximum contradiction score is 0.407.

[Recorded legal outputs](legal-claim-results.json) contain the actual hypotheses, passages, and model scores.
These results come from Chromium with WASM on 16 September 2026. Thresholds remain unchanged.
Neither example receives a confident error label. The claim-extraction and attribution fixes do not establish reliable legal reasoning.
Tests also check that matching lower-court text stays excluded and that supporting conclusions can still pass the label policy.

## Reproduce

```sh
cd slopcheck
npm ci
npm run model:prepare
npm test
npm run test:browser
npm run build
```

Set `CHROMIUM_PATH` to use an installed Chromium binary.
The browser evaluation writes `semantic-evaluation.json` under `test-results/`.
The tests check model cache reuse with model HTTP requests blocked.
They also check no model download for invalid references or citation-only lists,
model download failure, cancellation, retry, original evidence, printing, and request privacy.

The export uses a pinned CPU environment. It does not change Ferenda's Python dependencies.
Production builds reject missing or changed model files.
Update the model version, manifest, fixtures, and recorded evaluation together when changing the export.
