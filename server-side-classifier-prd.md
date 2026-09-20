# PRD: Source-Grounded Legal Claim Classifier

## 1. Goal and scope

Build a compact classifier that receives one legal claim and the exact text of one cited unit and returns one of four model classes:

```text
supported
unsupported
incorrect
misleading
```

The inference harness adds two labels that the model never produces:

```text
nonsensical   deterministic claim rules (existing check_assessable)
abstain       structural rules, or low calibrated confidence / margin
```

The classifier assesses only whether the supplied source text supports the supplied claim. It must not perform legal research, retrieve nearby sources, repair citations, or use remembered legal knowledge as a substitute for evidence in the supplied source. A proposition that is true in real law but unsupported by the supplied source is `unsupported`. A fictitious source that clearly states the proposition is `supported`.

The model scores one claim against all of its cited units in one input. Real claims, in judgments and in the documents slopcheck checks, often cite several authorities that together support one proposition. The premise is the concatenation of every resolved cited unit, in citation order, each behind a plain-text header (section 7). The label describes what the set of sources establishes. Training rows therefore carry one to several sources, and the harness makes one model call per claim, not one per source (section 9).

The initial model is:

```text
BalaRajesh1/mmbert-small-nli
```

Replace its three-way NLI head with a four-way head and fine-tune the whole model at the model's full context length of 8192 tokens. The production target is CPU inference with ONNX Runtime on a Linux VPS with 3 cores and about 8 GB RAM, shared with other containers.

Training data comes from the ferenda artifact directory (`../ferenda/site/data/artifact/`): `dom/` for HD and HFD, `eurlex/` for CJEU, `forarbete/prop/` for propositions, and statute artifacts for provisions.

---

## 2. Label semantics

The labels must have stable meanings throughout data generation, training and evaluation.

`supported`: the cited unit establishes all material propositions in the claim. Paraphrase and reasonable textual inference are permitted. A claim that is narrower than the source (adds a condition the source does not state but does not contradict) is still `supported`.

`unsupported`: the cited unit does not establish a material part of the claim and does not affirmatively establish its opposite. Typical cases: wrong paragraph, wrong provision, irrelevant authority, or a source on the same subject that does not state the proposition.

`incorrect`: the cited unit affirmatively denies the claim in the claim's core case. The label follows from contradiction, not from the kind of edit. A reversed proposition, changed threshold, added or removed negation or wrong outcome is `incorrect` when the source states the contrary. A wrong party or court is `incorrect` only when the source itself establishes the contrary attribution; if the source says HD held X and the claim says HFD held X, and the source says nothing about HFD, the label is `unsupported`.

`misleading`: the cited unit supports the claim in its core case, but the claim also covers cases the source conditions, excludes or leaves open. Dropped exception, dropped `som huvudregel`, `får`/`kan` written as `ska`, `A och B` written as `A` or `A eller B`, a category of persons or situations widened, one option among several presented as the rule.

Operational test for the `misleading` / `incorrect` boundary. Take the most typical case the source addresses. If the source says the claim holds in that case, and the claim's extra reach is what the source qualifies, the label is `misleading`. If the source says the claim does not hold in that case, the label is `incorrect`. Under this test `får → ska` is `misleading` when the source grants a discretion the claim states as a duty, and `incorrect` when the source forbids what the claim requires.

```text
source says nothing relevant            → unsupported
source denies the core case             → incorrect
source supports a qualified version     → misleading
source supports it, claim is narrower   → supported
```

`nonsensical` is not a model class. The existing deterministic rules in `backend/semantic.py` (`check_assessable`) keep producing it for empty claims, claims without a verb, unreadable text and category errors. Do not generate `nonsensical` training rows.

The 70 claims in `test/fixtures/legal-claims.json` carry a `defect` field for every non-correct claim. Those descriptions are the reference for how the labels are meant to split. Check every generation rule against them before generating at scale.

---

## 3. The cited unit

The cited unit is the exact text the citation names, no more. The classifier never sees uncited neighbouring text. The rules below define the unit per source type. They apply identically to training-data extraction and to the production resolver, and the resolver is the only component that produces source text for the model.

**Statute provision.** The cited paragraph (`§`) with all its stycken. A stycke pinpoint (`första stycket`, `#K21P10S4`) gives that stycke only. A chapter or whole-act citation gives no unit; the harness abstains with `unit_unbounded`.

**Proposition.** The cited page (`#sid25`): every node whose `page` equals the cited page. A page range gives those pages.

**HD and HFD judgment, with pinpoint (`p. 7`, `punkt 7`).** The `stycke` node with that `ordinal` under the deciding court's `dom > domskal`. A range (`p. 4 och 5`, `p. 4–6`) gives those nodes.

**HD and HFD judgment, without pinpoint.** The deciding court's own text only: the deciding court's `dom` node, that is `domskal` and `domslut`. Exclude every lower-instance `instans` node, the `betankande` node, and the headnote (the top-level `stycke` nodes before the first `instans`). The headnote is the reporter's summary, not the court's reasons. If a later version wants the headnote to count as evidence for a blanket citation, that is a separate policy decision to be written here explicitly. The lower-instance summaries in a rättsfallsreferat are not the court's holding and must appear neither in training rows nor in requests to the API. In `dom/*.json.br` the deciding court is the `instans` node whose `court` is `Högsta domstolen` or `Högsta förvaltningsdomstolen`.

**CJEU judgment, with pinpoint (`punkt 45`, `p. 45`).** The numbered paragraph with that `num` in the `eurlex/` artifact. Ranges as above.

**CJEU judgment, without pinpoint.** The court's assessment: the numbered paragraphs under the heading that begins the court's answer (`Prövning av tolkningsfrågan`, `Prövning av tolkningsfrågorna`, `Prövning av talan` and variants), up to and excluding `Rättegångskostnader`. Exclude the keyword list, preamble, legal framework and the account of the national proceedings. This is still often longer than the token budget, see below.

**Token budget.** If the tokenized unit plus claim exceeds 8192 tokens, the harness abstains with `unit_too_long`. No chunking in v1. Record how often this fires per source type in the evaluation run. Chunked inference with an aggregation rule is a v2 item and needs its own training data.

**No repair.** If a citation points to paragraph 7 and only paragraph 8 supports the claim, the result is `unsupported`. Citation correction and nearby-source retrieval belong to another layer.

---

## 4. Training-data extraction from judgments

### 4.1 What the artifacts give

An HD paragraph in `dom/*.json.br` looks like this (NJA 2019 s. 271 p. 7, shortened):

```json
{"ordinal": "7", "type": "stycke", "text": [
  "Syftet med ett förhandsbesked är att ... Ett positivt förhandsbesked är därför bindande vid den efterföljande prövningen av försvararens anspråk på ersättning. Ett förhandsbesked kan dock överklagas ... (Se ",
  {"predicate": "dcterms:references", "text": "prop. 2008/09:232 s. 25", "uri": "https://lagen.nu/prop/2008/09:232#sid25"},
  " och ",
  {"predicate": "dcterms:references", "text": "NJA 2012 s. 262", "uri": "https://lagen.nu/dom/nja/2012s262"},
  " p. 4 och 5.)"
]}
```

Three facts drive the extractor design:

1. Citations attach to a paragraph, usually in a trailing `(Se ...)` or `(Jfr ...)` parenthetical. Nothing in the data says which sentence each citation supports.
2. Proposition URIs carry the page (`#sid25`). Case-law URIs carry no paragraph; the pinpoint (`p. 4 och 5`) is plain text after the reference run. The extractor parses pinpoints from the text following each run, including `p.`, `punkt`, `punkterna`, ranges and `och`-lists.
3. Judgments and propositions also carry document-level metadata (`metadata.lagrum`, `metadata.related`, `metadata.nyckelord`). Those are not claim-level citations and are not used as sources. `nyckelord` is used for hard negatives (section 5).

### 4.2 Claim unit and v1 selection rule

The claim is the paragraph text with the citation parenthetical removed. Only paragraphs from the deciding court's `dom > domskal` are used. Lower-instance text and `betankande` are never claims.

A paragraph becomes an automatic `supported` row with all of its references as sources when all of these hold:

- exactly one citation parenthetical, introduced by `Se` (not `Jfr`, `Se även`, `Se dock`, `jfr dock`), containing one or more references;
- at most three sentences before the parenthetical;
- every reference resolves to a cited unit under section 3, and the concatenated units plus the claim fit the token budget;
- no reference points to the originating judgment (no self-citation);
- the paragraph is not a quotation of another text (no leading quotation mark, no `anförde` or `uttalade` immediately before a colon).

The label is `supported` because the court offers the references together as support for the paragraph. Nothing in the data says which reference supports which sentence, and the row does not claim to know. The paragraph above becomes one row: four sentences as the claim, `prop. 2008/09:232 s. 25` and `NJA 2012 s. 262 p. 4 och 5` as its two sources. It passes only if the reviewer relaxes the three-sentence rule; otherwise it goes to the review queue.

Paragraphs with more than three sentences, weak introducers, or a mix of `Se` and `Jfr` references go to a review queue. A reviewer confirms the label, may shorten the claim to the sentences the references address, and may drop `Jfr` references from the source set. Reviewed rows carry `origin: "reviewed"`.

Report the distribution of source counts per row. Production claims cite one to four authorities in most cases; the training set should cover the same range, with single-source rows still the largest group. Prefer high-confidence rows over dataset size, and count how many paragraphs pass the automatic rule per court before deciding whether the review queue is needed to reach the target size.

### 4.3 CJEU

HD and HFD cite CJEU judgments both with pinpoints (`punkt 45`) and as whole units. Pinpointed citations produce automatic rows. Whole-unit CJEU citations do not produce automatic `supported` rows: the assessment section is long and the automatic label would be weak. Instead, a reviewer confirms that the full assessment section, resolved exactly as section 3 defines it, supports the claim, and the row enters with `origin: "reviewed"` and the full section as its source. The reviewer never shrinks the source to the supporting paragraphs. Training must see the same long unit production will send, or the model learns to find a proposition in a hand-picked passage rather than to judge a long assessment. The reviewer may record the supporting paragraph numbers in a separate `evidence_paragraphs` field for analysis. Budget 100–200 such rows and put most of them in the test partition.

### 4.4 Row format

```json
{
  "id": "...",
  "claim": "...",
  "sources": [
    {
      "citation": "prop. 2008/09:232 s. 25",
      "source_id": "prop/2008/09:232#sid25",
      "document_id": "prop/2008/09:232",
      "unit_type": "prop_page",
      "text": "..."
    },
    {
      "citation": "NJA 2012 s. 262 p. 4 och 5",
      "source_id": "dom/nja/2012s262#p4-5",
      "document_id": "dom/nja/2012s262",
      "unit_type": "case_pinpoint",
      "text": "..."
    }
  ],
  "label": "supported",
  "origin_document_id": "dom/nja/2019s271",
  "origin_paragraph": "7",
  "origin_claim_id": "...",
  "origin": "authentic | reviewed | counterfactual",
  "transformation": null,
  "token_length": 0
}
```

Sources are stored in citation order. Every `source_id` identifies one exact unit and every one of them takes part in split grouping (section 6). `token_length` is the length of the full model input, claim and all sources.

---

## 5. Counterfactual training pairs

Generate synthetic rows from authentic `supported` rows. The purpose is to force the model to rely on the supplied source rather than remembered law, and to stop it from learning surface artifacts of the generation process.

**`unsupported`.** Keep the claim, replace every source with a non-supporting unit. For a multi-source row all sources are replaced; replacing only one leaves the label unknown, because the remaining sources may carry the support alone. Partial replacements may enter only through the review queue. Prefer hard negatives:

- the adjacent paragraph, stycke or page (`p. 6` for `p. 7`);
- another paragraph of the same judgment;
- for whole-unit case citations, the deciding-court text of another judgment sharing at least one `metadata.nyckelord` with the original;
- for provisions, the neighbouring `§` in the same chapter.

Adjacent paragraphs often continue the same argument and partly state the same proposition, so some automatic `unsupported` labels will be wrong. Do not filter candidates by word overlap with the claim. A paragraph that uses the claim's terminology without establishing the claim is the most valuable `unsupported` row there is, and an overlap filter removes exactly those. Keep all candidates, sample them for manual validation stratified by overlap, and report the measured label-noise rate per stratum in the dataset statistics. If the noise rate in the high-overlap stratum is unacceptable, review that stratum rather than drop it.

**`incorrect`.** Keep the source, change one material element of the claim so the source denies it: number, deadline, negation, comparator, outcome, party, court. The sentence must stay natural and the change must contradict the source under the section 2 test.

**`misleading`.** Keep the source, overstate the claim: remove a condition or exception, `kan → ska`, drop `som huvudregel`, widen a category, `A och B → A` or `A eller B` where that widens the rule. Inspect generated samples per transformation type and disable types that produce noisy labels.

**Edited but still `supported`.** Every edit type above has a counterpart that keeps the label: paraphrase, clause reordering, synonym substitution, adding a condition the source does not exclude, `ska → kan` where the source grants a discretion. Generate these in similar volume to `incorrect` and `misleading` rows. Without them, "the claim text was edited" separates {supported, unsupported} from {incorrect, misleading} and the model learns that instead of reading the source. If an LLM produces edits, use it for the `supported` edits too, so style is not a label signal.

Generate families sharing one `origin_claim_id`:

```text
same claim + correct sources                       → supported
paraphrased claim + correct sources                → supported
same claim + correct sources in another order      → supported
same claim + correct sources + one irrelevant unit → supported
same claim + every source replaced by a nearby one → unsupported
contradictory claim + correct sources              → incorrect
overstated claim + correct sources                 → misleading
```

The reordered and distractor variants teach that source order carries no meaning and that an extra irrelevant citation does not remove support. Both happen in real documents. Keep the distractor within the token budget and pick it with the same hard-negative rules as `unsupported`.

A model relying on memorized law cannot solve all members of a family.

---

## 6. Dataset construction and leakage control

Start with 5,000–10,000 rows. Expand toward 20,000 only after the generation rules have been sampled and shown to give reliable labels. Quality and hard negatives matter more than exact balance. Report the length distribution; long whole-unit rows should be a meaningful share, not a tail.

Partitions:

```text
train
validation
calibration
test
```

About 75/10/7.5/7.5 percent. Never split generated rows independently. Group by both:

- `origin_document_id`: every row derived from one judgment stays in one partition;
- `source_id` of every exact cited unit in the row: every row that uses `NJA 2012 s. 262 p. 4–5` as one of its sources stays in one partition. A different paragraph of the same judgment, or a different `§` of the same act, may sit in another partition.

Use a union-find over the two keys and assign whole components to partitions. Do not group by whole source document: a commonly cited RB provision would link a large share of the corpus into one component. Check the component size distribution before assigning; if one component exceeds about 5 percent of the rows, inspect what links it.

Generalization to authorities never seen in training is a separate question. Build a small "unseen source document" evaluation set by holding out a handful of whole judgments and acts as sources, and report it alongside the main test partition. It does not dictate the primary split.

The 70 human-authored claims in `test/fixtures/legal-claims.json` with the frozen sources in `test/fixtures/legal-sources/` are the independent test set. They are never used for training, threshold selection or model selection. Their sources are resolved under section 3 (deciding court's `domskal` and `domslut` only for judgments, no headnote) before scoring. Their labels map as `correct → supported`, `missing → unsupported`; `nonsensical` rows test the harness rules, not the model.

Before training, produce dataset statistics and check automatically for empty claims or sources, invalid labels, duplicates across partitions, orphaned counterfactual rows, self-citations, lower-instance text inside a source, and token lengths above 8192. Manually review random samples per (label, transformation) pair, especially `unsupported/adjacent`, `unsupported/same-nyckelord`, `incorrect/number`, `incorrect/negation`, `misleading/exception-removed`, `misleading/modality` and `supported/paraphrase`.

---

## 7. Fine-tuning

Load `BalaRajesh1/mmbert-small-nli` with `num_labels=4` and `ignore_mismatched_sizes=True`. Confirm in the load log that only the final `classifier` weight is newly initialized and the encoder and pre-classifier `head` load from the checkpoint.

Orientation as in NLI:

```text
premise    = all cited units, in citation order, each behind a header
hypothesis = claim
```

Each unit is preceded by a one-line header and followed by a blank line:

```text
[Källa 1: prop. 2008/09:232 s. 25]
<unit text>

[Källa 2: NJA 2012 s. 262 p. 4–5]
<unit text>
```

The header carries the citation as written, so the model can tell a court's statement from a proposition's. Run one ablation with the citation replaced by the unit type only (`[Källa 2: rättsfall]`). If the ablation scores the same on the test partition, ship the masked form; it removes any chance that the model keys on a well-known citation string. The same formatting code is used at training time and in the production resolver.

ModernBERT has no `token_type_ids`; the separator token alone marks the boundary between premise and hypothesis. Use the tokenizer's pair encoding with truncation disabled. A pair over 8192 tokens is excluded from training and abstains in production with `unit_too_long`; neither side is ever silently truncated.

Initial configuration:

```text
max_length: 8192
epochs: 3
learning_rate: 2e-5 (try 3e-5 and 5e-5; the model is small)
weight_decay: 0.01
warmup: 6%
effective_batch_size: 32 via gradient accumulation
precision: bf16 (not fp16; ModernBERT activations can overflow fp16)
gradient_checkpointing: on
attention: sdpa for training, eager for export
```

Group rows by length into buckets so that short rows do not pad to 8192. Training runs on a GPU machine, not the VPS. Memory at 8192 tokens is dominated by the global-attention layers (every third layer). Expect a 24 GB card to handle micro-batch 1 or 2 with checkpointing; the real figure depends on the attention backend and the length distribution, and micro-batch 1 with gradient accumulation is acceptable.

Train a 512-token baseline with the same data as a control. This control experiment alone truncates the premise to fit; it is the only place truncation is allowed. If the 8192 model does not beat it on the 2049–4096 and 4097–8192 buckets, the long rows are not teaching anything and the extraction needs another look.

Save the checkpoint with the tokenizer, the label order, the dataset version and the git commit of the training code.

---

## 8. Evaluation, calibration and abstention

Report accuracy, macro F1, per-class precision, recall and F1, and the confusion matrix, on:

- the generated test partition, split by unit length (≤512, 513–2048, 2049–4096, 4097–8192 tokens) and by source type. The top bucket is the reason for choosing an 8192-token model; report it on its own, never merged into a `>2048` bucket;
- the 70-claim fixture;
- the source-grounding set below.

Pay particular attention to false `supported` and to the pairs `supported ↔ misleading`, `unsupported ↔ incorrect`, `unsupported ↔ misleading`.

**Source-grounding set.** Hand-build cases where world knowledge conflicts with the supplied text:

```text
true legal proposition + unrelated source               → unsupported
true legal proposition + source stating the opposite    → incorrect
fictitious proposition + source stating it              → supported
true proposition + the correct judgment, wrong paragraph → unsupported
```

**Calibration.** Freeze the selected checkpoint. Fit temperature scaling on the calibration partition. Compute:

```text
p1 = highest class probability
p2 = second-highest class probability
margin = p1 - p2
```

Abstain when `p1 < threshold[predicted_class]` or `margin < minimum_margin`. Derive temperature, thresholds and margin from the calibration partition only, by maximizing coverage subject to a target precision per accepted class (start at 0.95 for `supported` and `incorrect`, 0.90 for the others). The generated calibration partition is about 375–750 rows.

```text
calibration partition:
    select temperature, per-class thresholds and margin
70-claim fixture:
    run once with the frozen model and frozen thresholds
    report the result; never tune against it
```

Changing a threshold because of a fixture result turns the fixture into a second calibration set. If the fixture is needed during development, split it once into a dev half and an untouched final half, record the split, and report only the final half as the independent result.

Report as production metrics:

```text
coverage
accuracy among accepted predictions
per-class precision among accepted predictions
abstain reasons by count
```

**Structural abstention** stays in the harness before the model runs: empty or unreadable claim, no verb, category error (`nonsensical`), missing source text, `unit_unbounded`, `unit_too_long`. Each carries a machine-readable `abstain_reason`.

---

## 9. CPU export and serving

Export with `attn_implementation="eager"` as `scripts/export-model.py` already does for the small model. Export with dynamic sequence length and verify the ONNX model against the PyTorch reference at 128, 512, 2048 and 8192 tokens; sliding-window masks must match at every length.

Test INT8 dynamic quantization. The 256k-vocabulary embedding table is about 98M of the roughly 140M parameters, so INT8 mostly shrinks embeddings. Accept quantization only if precision, calibration and abstention on the full test set and the fixture change negligibly. If the quantized model shifts calibration, refit temperature on the quantized logits.

Production path:

```text
claim + all cited units (resolved under section 3, formatted as in section 7)
        ↓
structural checks → nonsensical / abstain(reason)
        ↓
tokenizer (one pair, max 8192; over budget → abstain unit_too_long)
        ↓
ONNX Runtime CPU
        ↓
4 logits → temperature → softmax → confidence and margin checks
        ↓
supported / unsupported / incorrect / misleading / abstain
```

**One call per claim.** All of a claim's cited units go into one input, so the model, not the harness, decides how they combine. No pairwise aggregation rule exists in v1.

**Partly resolved citations.** If some of a claim's citations resolve and some do not (`unit_unbounded`, missing text), score the resolved ones and list the rest in the response as `unresolved_sources`. A result of `supported`, `incorrect` or `misleading` stands. A result of `unsupported` becomes `abstain` with reason `partial_sources`, because the missing unit may be the one that carries the support. If nothing resolves, abstain with the resolver's reason.

**Over budget.** If the concatenated units exceed the token budget, abstain with `unit_too_long`. Do not fall back to scoring the sources one at a time; the model is not trained for that reading. Record how often this fires and with how many sources.

Benchmark on hardware matching the VPS (3 Broadwell cores, AVX2): resident RAM after load, load time, median and p95 latency at 128, 512, 2048 and 8192 tokens, with 1 and 3 threads. One claim is one call regardless of source count, so latency depends on total length only. If p95 at 8192 is unacceptable for the UI, lower the `unit_too_long` budget to the largest length that fits and report how many fixture and test units that excludes. Run one uvicorn worker with a request queue; do not load a model copy per worker. Remove torch from `backend/requirements.txt` and the image once the ONNX path is in.

---

## 10. API changes

Adapt `POST /api/match` in `backend/main.py`; do not redesign it. Request shape stays `claim` plus `sources`, but each source becomes an object so the resolver's unit is explicit, and the list holds every citation the claim makes, in document order:

```json
{"claim": "...", "sources": [
  {"citation": "prop. 2008/09:232 s. 25", "text": "...", "unit_type": "prop_page"},
  {"citation": "NJA 2012 s. 262 p. 4", "text": "...", "unit_type": "case_pinpoint"}
]}
```

The resolver that produces `text` under section 3 is part of this work and runs server-side. The browser no longer slices provisions per stycke or sentence for this endpoint.

Label mapping, so the UI in `src/semantic.js` and the filters in `src/main.js` keep working:

| Model class | API `label` | API `status` | Swedish label |
|---|---|---|---|
| supported | correct | correct | Stöd hittat |
| unsupported | unsupported | missing | Stöd saknas |
| incorrect | incorrect | incorrect | Möjlig motsägelse |
| misleading | misleading | misleading | Vilseledande |
| (harness) | nonsensical | nonsensical | Meningslöst |
| (harness) | abstain | abstain | Kunde inte bedömas |

Response: keep `label`, `status`, `swedish_label`, `reason`, `evidence`, `comparisons`, `model`. `comparisons` holds one entry, the claim against the whole source set, with the four calibrated probabilities, `confidence`, `margin`, `abstain_reason`, `token_length` and `unresolved_sources`. `evidence` lists every source that entered the model input, in order; the UI shows them together as the passages the verdict rests on, since the model does not attribute the verdict to one of them. Add `model_version` (dataset version, checkpoint id, calibration id, threshold id). Remove the `entailment/neutral/contradiction` scores and the `thresholds` request override.

Per-source attribution is a v2 item. The cheapest route is leave-one-out rescoring for claims with two to four short sources; it multiplies the model calls and is not part of v1.

Diagnostics contain numbers and identifiers only:

```json
{
  "status": "abstain",
  "predicted_class": "supported",
  "probabilities": {"supported": 0.54, "unsupported": 0.02, "incorrect": 0.01, "misleading": 0.43},
  "confidence": 0.54,
  "margin": 0.11,
  "abstain_reason": "low_margin",
  "unit_type": "case_pinpoint",
  "token_length": 812,
  "model_version": "..."
}
```

The service logs no claim text and no source text. This keeps the README's statement that the service keeps no request bodies.

**Deliverables.** Reproducible scripts and configuration for: extraction from the artifact directory, counterfactual generation, validation and splitting; training and evaluation; calibration and threshold selection; ONNX export and INT8 quantization; CPU benchmarking; the server-side resolver; the updated inference code. The trained model, tokenizer, calibration values and thresholds are published as one versioned artifact (a Hugging Face repo or a GitHub release asset); `docker-compose.yml` pins its version, and the image downloads it at build time.

---

## 11. Acceptance criteria

The first implementation is complete when:

1. authentic and counterfactual rows, with one or several sources each, are generated reproducibly from the artifact directory, and no row contains lower-instance text, betänkande text or a self-citation;
2. the resolver produces cited units under section 3 for provisions, proposition pages, HD/HFD paragraphs and whole judgments, and CJEU paragraphs, formats a multi-source input identically to training, and abstains with a reason on unbounded, over-budget or partly resolved inputs;
3. partitions are grouped by originating judgment and by every exact cited unit a row uses, and the checker finds no cited unit in two partitions;
4. on the 70-claim fixture, run once with frozen thresholds, accepted-prediction precision is at least 0.95 with coverage above the current three-way pipeline's 9 substantive labels out of 70, and no accepted label points the reader the wrong way;
5. the source-grounding set shows supplied evidence overrides memorized law: fictitious-but-stated propositions are `supported`, true-but-contradicted propositions are `incorrect`;
6. `nonsensical` and `abstain` are produced by the harness only, with machine-readable reasons;
7. the INT8 ONNX model matches the PyTorch reference on the full test set within the recorded tolerance at every benchmarked length;
8. the service runs inside the VPS memory budget with one worker, and recorded p95 latency at the chosen token budget is documented;
9. every production result carries a `model_version` that traces to a dataset, checkpoint, calibration and threshold release, and the service logs no request text.
