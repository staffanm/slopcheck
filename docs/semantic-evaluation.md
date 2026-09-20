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

A strong support or contradiction signal stands only when no other compared passage gives
the opposite label at 0.50 or more. Such conflicting passages produce abstention.
Incomplete input also produces abstention.
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

## Corpus claims about statutes and judgments

The [legal fixtures](../test/fixtures/legal-claims.json) hold 70 claims against 14 real source texts
from the lagen.nu corpus: nine statute provisions and five judgments.
[Source provenance](../test/fixtures/legal-sources/README.md) records their origin.
Each claim carries a `kind`:

| Kind | Claims | Meaning | Example |
|---|---:|---|---|
| correct | 24 | the source says this | 18 kap. 1 § RB: the losing party pays the other side's costs, om inte annat är stadgat |
| misleading | 13 | true in part; a condition, exception or scope is dropped or widened | 2 § preskriptionslagen: “alla fordringar tio år”, denying the three-year consumer rule |
| incorrect | 25 | a wrong number, a reversed outcome, the opposite rule, a true rule attributed to the wrong source, or a holding attributed to a court that did not make it | NJA 2005 s. 805: “pastorn ska dömas … till fängelse” (HD acquitted) |
| nonsensical | 8 | a category error, word salad, a citation list, or keywords without a verb | “3 kap. 1 § brottsbalken slog fast att hovrätten är ett mord” |

Eight claims exist in two wordings, the second with the `-verb` suffix. The first run of the
fixture found the natural wording unassessable because the claim verb list lacked `preskriberas`,
`beräknas`, `omfattar`, `dömde` and `skulle`. Both wordings are assessable now, and the pair
doubles as a paraphrase check. One claim keeps a `known_gap`: “preskriberas en fordran fem år
efter tillkomsten” has five content words, and the claim rule needs six.

### Label rule the tests enforce

A label is wrong when it points the reader the wrong way. The browser test therefore forbids
“Möjlig motsägelse” and “Stöd inte hittat” for a correct claim, “Stöd hittat” for a misleading or
incorrect claim, and both “Stöd hittat” and “Möjlig motsägelse” for a nonsensical claim.
Abstention and unassessable are always allowed. Unit tests check the deterministic layer:
the hypothesis never contains the citation, provision claims select exactly the cited provision,
and judgment claims compare only the attributed court's own text and always include its decision.

### What the first run showed, and what changed

The first run on 16 September 2026 gave 4 substantive labels on 62 assessable claims,
all correct. The abstentions had four causes. Each got a fix the same day:

- **Long premises.** A provision longer than about 600 characters as one premise scored near
  one third for every label, whatever the claim said. `selectEvidence` now splits an exact provision
  into units: each stycke, a list joined to its lead-in, and the sentences of any stycke over 400
  characters. The claim is compared against the best-ranked units.
- **Cross-passage conflict.** Every judgment claim abstained because some irrelevant passage
  scored 0.2 contradiction while another scored 0.2 entailment. The rule now blocks a strong signal
  only when another passage gives the opposite label at 0.50 or more.
- **Unused headnote, HFD reports, trailers.** The headnote of a referat sits under no court
  heading and was never compared. It now counts as the reporting court's summary, and the reporting
  court is read from the uri (`/dom/nja/` is HD, `/dom/hfd/` is HFD). HFD reports, which have no
  court headings at all, therefore get their Skälen för avgörandet and Högsta förvaltningsdomstolens
  avgörande as reasoning and decision. Trailer lines (HD:s dom meddelad, Mål nr, Lagrum, Rättsfall)
  are metadata and never compared. Chapter selection stops at the next heading of the chapter's own
  level, so 2 kap. 1 § tryckfrihetsförordningen is found under its sub-headings.
- **Claim verb list.** Forty more finite verbs, plus any word ending in -as, -ade or -ades.

### Browser results, 16 September 2026, after the changes

[Recorded outputs](legal-claim-results.json) come from Chromium with WASM on this host.
The 66 assessable claims took 15.5 seconds after the model had loaded.

| Kind | Claims | Supported | Contradiction | Missing | Abstain | Unassessable |
|---|---:|---:|---:|---:|---:|---:|
| correct | 24 | 7 | 0 | 0 | 17 | 0 |
| misleading | 13 | 0 | 1 | 0 | 12 | 0 |
| incorrect | 25 | 0 | 1 | 0 | 23 | 1 |
| nonsensical | 8 | 0 | 0 | 0 | 4 | 4 |

No claim receives a wrong label. Seven correct statute claims receive “Stöd hittat”
(4 § avtalslagen, 2 kap. 1 § skadeståndslagen, 50 kap. 1 § and 18 kap. 1 § rättegångsbalken,
3 kap. 1 § brottsbalken, 32 § köplagen, 2 kap. 1 § tryckfrihetsförordningen).
Two claims receive “Möjlig motsägelse”: the incorrect claim that the three-year limitation period
covers löpande skuldebrev, against the sentence that excludes them (0.98), and the misleading claim
that a sermon can never be hets mot folkgrupp, against the headnote of NJA 2005 s. 805 (0.98).
Judgment claims still abstain, but no longer on conflicting signals. The headnote is now the
best-scoring passage for the NJA 2013 s. 502 claims and for the correct NJA 2020 s. 1042 claim
(0.96). The correct HFD 2013 ref. 71 claim reaches 0.95 on HFD's own reasoning.

The threshold still does the work. Scores just under it:

| Claim | Kind | Entailment | Blocked by |
|---|---|---:|---|
| oskäliga avtalsvillkor får jämkas eller lämnas utan avseende (36 § AvtL) | correct | 0.98 | a later stycke contradicts at 0.53 |
| tre år för en näringsidkares fordran mot en konsument (2 § PreskL) | correct | 0.97 | rounding: 0.9699 |
| en part som vinner mot en av två motparter har rätt till full ersättning (NJA 2020 s. 1042) | correct | 0.96 | threshold |
| huvudregeln är tio år (2 § PreskL) | correct | 0.95 | the three-year stycke contradicts at 0.80 |
| det svenska systemet … är förenligt med Europakonventionen (NJA 2013 s. 502) | incorrect | 0.88 | threshold |
| överklagandet kan göras muntligen vid tingsrätten (50 kap. 1 § RB) | incorrect | 0.87 | threshold |

The model reads an exception stycke as contradicting the main rule it qualifies, so a correct
claim about the main rule abstains. That is the price of the 0.50 conflict rule, and it is the
right side to err on. The two originally reported claims still abstain: the guarantee claim at
0.36 support, the lower-court claim at 0.69.
These results do not establish reliable legal reasoning. They show that the label policy
holds on 64 realistic claims, and that the deterministic layer no longer hides the model.

## One merged premise window, measured and rejected for these weights

The server sends one premise to the model. `backend/model.py` calls `window_premise`,
which ranks the source paragraphs by BM25 against the claim and joins the best ones
into a single text of at most 380 tokens. The browser instead scored each selected
passage on its own. `src/windowing.js` now mirrors the server's ranking, so the browser
can build the same window. The browser worker was changed to do so and measured against
the 70-claim fixture, on the same host, with the same shipped weights.

| Premise shape | Inferences | Total time | Per claim | Supported | Contradiction | Missing | Wrong labels |
|---|---:|---:|---:|---:|---:|---:|---:|
| one passage per inference | 232 | 11.6 s | 176 ms | 7 | 1 | 3 | 0 |
| one merged window | 66 | 7.8 s | 118 ms | 4 | 0 | 0 | 0 |

The window is faster and gives no wrong label. It also removes seven of the eleven
substantive labels and adds none. The cause is dilution. A longer premise moves every
probability toward neutral:

| Claim | Kind | Per passage | Merged window |
|---|---|---|---|
| ett sent svar gäller som nytt anbud (4 § AvtL) | correct | 0.97 entailment | 0.93 |
| straffskalan för mord (3 kap. 1 § BrB) | correct | 0.98 entailment | 0.96 |
| reklamation inom två år (32 § KöpL) | correct | 0.97 entailment | 0.96 |
| treårsregeln omfattar löpande skuldebrev (2 § PreskL) | incorrect | 0.98 contradiction | 0.26 |

The 0.97 thresholds were calibrated on single passages, so a lower threshold could suit
the window better. It does not. The recorded scores of both runs were relabelled at every
threshold from 0.99 to 0.80. The figures below are substantive labels over wrong labels:

| Premise shape | 0.99 | 0.97 | 0.95 | 0.93 | 0.90 | 0.85 | 0.80 |
|---|---|---|---|---|---|---|---|
| one passage per inference | 3/0 | 11/0 | 14/0 | 15/0 | 18/0 | 25/3 | 28/5 |
| one merged window | 0/0 | 4/0 | 6/0 | 6/0 | 7/0 | 8/1 | 12/3 |

The passage shape gives more substantive labels at every threshold and reaches a wrong
label later. The window is worse at every operating point, so the browser keeps one
inference per passage.

The window still does what it was proposed for. For `hiv-endangerment`, a correct claim
about NJA 2004 s. 176, an isolated procedural line reads as a contradiction. The passage
shape scores 0.92 contradiction on that line. The merged window, which also holds HD's
reasoning and decision, scores 0.11. The shipped weights stay under the 0.97 threshold
either way, so the claim abstains and no reader is misled. Weights fine-tuned on windowed
premises score higher and would cross it. Such weights must read the window.

The premise shape belongs to the weights, not to the client. `scripts/train_kb_bert.py`
and `scripts/train_scandi_nli.py` both train on `window_premise` output. The shipped
ScandiNLI weights were trained on single sentence pairs. `src/model-manifest.json`
therefore records `"premise": "passage"`, and the worker reads it. A model exported from
the windowed training scripts records `"premise": "window"` and gets one merged premise.
Do not change the premise shape without re-running this fixture on the new weights.

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
