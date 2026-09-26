# Review of the 4-way classifier training, 21 September 2026

The trigger was one production claim. "Detta följer av svensk rätt, särskilt 4 § avtalslagen
(1915:218), som stadgar att när en person åtar sig ett borgensåtagande 'som för egen skuld', dvs.
proprieborgen, har borgenären rätt att kräva betalning direkt från borgensmannen" cites a provision
about late acceptance of an offer. The right label is `unsupported`. The deployed KB-BERT model
gave the browser's citation-stripped hypothesis 0.701 for `unsupported`, under the 0.85 threshold,
so the report said "Kunde inte bedömas". The exact claim text, with the citation inside it, scored
0.476 `supported`.

## What the data and the pipeline did wrong

Two subagents audited `data/*.jsonl` and every script from extraction to serving. Numbers are
over all 7,492 rows before repair.

| Finding | Measured | Effect on the failing claim |
|---|---|---|
| The counterfactual generator wrote " (intilliggande)" into the citation of every adjacent-unit negative. The citation goes verbatim into the premise header `[Källa 1: …]`. | 678 of 1,233 `unsupported` rows carried the marker; P(unsupported \| marker) = 0.84, P(unsupported \| no marker) = 0.08 | The strongest learnable `unsupported` feature never occurs in production input. |
| The same citations named the original unit while the text was the neighbour. | 798 of 853 adjacent sources | Header and text disagreed in a way production never shows. |
| CJEU sources resolved to a preamble or the bare heading "Prövning av tolkningsfrågorna". | 871 rows (11.6 %) had no real source text; 387 of them were labelled `supported` | In the low-overlap region the data voted `supported` (0.44) over `unsupported` (0.26). The failing claim sits in that region. |
| No row paired a claim about act X with a provision of unrelated act Y. | 69 `unsupported` rows had a statute source; 68 were the neighbouring §, 1 was another document | The production shape was unseen. |
| No claim was written in memo register with the citation inside it. | 8 claims of 7,492 used "stadgar att"; the header's citation appeared in the claim in 5 rows | The model had only lexical overlap between claim and header to go on, which points toward `supported`. |
| Older referats store the hovrätt decision as a `dom` node inside HD's `instans`; dissents sit inside `domslut`; betänkande paragraphs carry ordinals. The resolver took all of them. | 1,011 of 3,919 judgment sources changed on re-resolution | Lower-court reasoning and dissents entered training sources and production input. |
| Calibration was fitted on fp32 torch logits and applied to INT8 ONNX logits. The 0.85 `unsupported` threshold was the top of a search grid, not a value that met the precision target. | temperature 1.74 on torch; on the ONNX path the same data gives 2.36 | The served threshold did not describe the served model. |
| Unsupported rows that reused a source of their `supported` sibling. | 22 rows | Contradictory labels. |
| Class weights `[1, 2, 2, 2]` described as inverse frequency; true values about `[1, 3.2, 3.3, 3.3]`. The scheduler's step count omitted the last partial accumulation step. | | Minor. |
| `test/fixtures/source-grounding.json` (29 cases, including the failing claim and its correct source, 10 kap. 9 § handelsbalken) was read by no script. The evaluation script fed fixture premises with the file name as citation and, for the hardcoded source-grounding cases, without any header. | | The independent numbers described neither training nor production. |

Label noise in the LLM-edited classes is separate from these leaks. A manual read of 10 rows each
put `misleading/overstatement` at 40–50 % noise and `incorrect/contradiction` at 20–40 %; the
same read found no meaning flips among `supported/paraphrase`. That noise is not repaired here.

Windowing is the same in training and serving: `scripts/train_kb_bert.py` and `backend/model.py`
call `window_premise` with 380 premise tokens, and the data files hold the whole cited unit.
The window ranks paragraphs by BM25 against the claim, so for an unrelated claim it returns the
least unrelated paragraphs. That is a shared design choice, not a skew.

## Repairs

- `scripts/repair_dataset.py` rewrites the partitions in place; git history holds the originals.
  It removes the marker and names the supplied unit in the citation,
  removes rows whose every source is a stub, removes the 22 contradictory negatives, and
  re-resolves every judgment source through the fixed resolver. Result: 6,700 rows.
- `backend/resolver.py` keeps only the deciding court's own `dom` node, ignores betänkande
  paragraphs for pinpoints, and cuts a dissent and everything after it.
- `scripts/generate_counterfactuals.py` and `scripts/validate_and_split.py` no longer write the
  marker or feed adjacent sources into the distractor pool.
- `scripts/generate_provision_pairs.py` builds provision-based training pairs. The provisions are
  read verbatim from the local SFS artifacts; the local LLM (gemma4:26b through ollama) writes only
  the claims: a memo-register claim that a provision supports, the
  same claim against a provision of an unrelated act, against a BM25-near provision of another act
  or the neighbouring §, plus a contradicted and an overstated claim. Half of the claims carry a
  citation frame such as "Enligt 4 § … gäller att …"; for negatives the frame names the supplied
  wrong provision, as a miscitation does. The LLM judges every pair against its intended label
  and disagreeing pairs are dropped. Families stay in one partition, keyed by act. The fixture
  acts (avtalslagen, handelsbalken, preskriptionslagen, räntelagen, köplagen, rättegångsbalken,
  brottsbalken, skadeståndslagen, tryckfrihetsförordningen) are excluded.
- `scripts/train_kb_bert.py` uses true inverse-frequency class weights, the correct step count,
  and header augmentation: each row is seen with the citation as written, with the unit type only
  ("lagrum", "rättsfall", …), and with the generic "Källa n" the client sends when it has no
  citation. The header string can then carry no label.
- `scripts/calibrate_onnx.py` replaces the calibration and fixture parts of
  `scripts/evaluate_and_calibrate.py`. It scores the calibration and test partitions and both
  fixtures through `backend.model.ClaimClassifier`, that is through the quantized ONNX model,
  the server's windowing and the server's headers. It fits the temperature, selects fail-closed
  thresholds (`backend/calibration.py`, with a 0.05 slack on the Wilson bound) and writes
  `calibration.json` and `evaluation_report.json`.
- `backend/model.py` exposes the raw-logit path that calibration uses and reports
  `class_disabled` when a class's threshold is above one.
- `backend/semantic.py` accepts more finite verbs; "Köparen förlorar … om reklamation inte sker"
  was rejected as verbless.

## Results

Model v2 is `models/classifier-kb-bert-4way-v2`: KB-BERT, five epochs on 7,428 rows
(4,189 repaired judgment-derived rows and 2,239 provision-based pairs), best validation macro F1
0.699 at epoch 5. All numbers below come from `scripts/calibrate_onnx.py`, that is from the
quantized ONNX model through the server's code path. The deployed model was re-scored the same way
on the repaired data for comparison; its old report is not comparable because its test set held the
marker and the stub rows.

The failing claim, against the text of 4 § avtalslagen:

| Input | Deployed model | Model v2 |
|---|---:|---:|
| exact claim, citation inside the text | 0.476 supported | 0.940 unsupported |
| the browser's citation-stripped hypothesis | 0.701 unsupported | 0.917 unsupported |
| exact claim, header "[Källa 1: lagrum]" | 0.429 supported | 0.936 unsupported |

The calibrated `unsupported` threshold is 0.899, so all three are accepted as "Stöd saknas".

Test partition, 860 assessable rows (548 judgment-derived, 312 provision-based):

| | Deployed model, repaired data | Model v2 |
|---|---:|---:|
| argmax accuracy | 0.591 | 0.731 |
| macro F1 | 0.508 | 0.722 |
| accuracy, statute provisions (332 rows) | 0.500 (20 rows) | 0.889 |
| accuracy, judgment-derived rows | 0.591 | 0.631 |
| accepted under the fail-closed policy | 0 of 860 | 123 of 860, all `unsupported` |
| precision on accepted | none | 0.992 |

The fail-closed selection enabled only `unsupported`. On the 672 calibration rows the best
`supported` threshold reaches 0.939 precision against the 0.95 target, `incorrect` reaches 0.903
against 0.95, and `misleading` reaches 0.911 but its Wilson bound stays under 0.85. Those classes
therefore abstain until they have more and cleaner training rows; the LLM-edited `incorrect` and
`misleading` rows still carry the label noise measured above.

Fixtures, run once with the frozen thresholds:

| Set | Deployed model, argmax correct | v2 argmax correct | v2 accepted | v2 wrong accepted |
|---|---:|---:|---:|---:|
| source-grounding, 28 assessable of 29 | 11 | 16 | 5 | 1 |
| legal-claims, 62 assessable of 70 | 21 | 30 | 2 | 1 |

The deployed model with its old thresholds accepted 7 legal-claims labels of which 4 were wrong,
all "Vilseledande". Both wrong v2 labels are `unsupported` for a claim the fixture calls
`incorrect`. "Enligt 2 § preskriptionslagen ska den part som tappar målet ersätta motpartens
rättegångskostnad" attributes a true rule to a provision that says nothing about it; under the
PRD's section 2 that is `unsupported`, and the fixture's `incorrect` disagrees with the PRD. The
other, "vid borgen såsom för egen skuld måste borgenären först kräva gäldenären", is contradicted
by 10 kap. 9 § handelsbalken ("söke då borgenär vilkendera han helst vill"), and the model does
not read the 1736 wording as a contradiction. Both supported claims against that provision also
fail. Archaic statute text is a gap the provision-based pairs do not cover, because the generator
takes provisions of 150 to 1,200 characters from acts in force without regard to age.

## Relaxed targets, 22 September 2026

The fail-closed policy left the served model able to say only "Stöd saknas", which on a real
memo of 19 citations meant no verdict at all. `scripts/calibrate_onnx.py` now takes
`--target-precision CLASS=VALUE`, and the served calibration was rerun with 0.85 for every
class and a 0.10 Wilson slack, the strictest setting at which all four classes come on:

```sh
uv run --python 3.12 --with onnxruntime --with transformers --with numpy --with scipy --with brotli --with fastapi --with pydantic \
  python scripts/calibrate_onnx.py --model-dir models/classifier-kb-bert-4way-v2 --wilson-slack 0.10 \
  --target-precision supported=0.85 --target-precision incorrect=0.85 --target-precision unsupported=0.85 --target-precision misleading=0.85
```

Thresholds: supported 0.504, unsupported 0.812, incorrect 0.764, misleading 0.648; margin 0.2;
temperature unchanged at 1.7824.

| Set | Accepted | Precision on accepted |
|---|---:|---:|
| calibration, 672 rows | 323 (48%) | 0.861 |
| test, 860 rows | 513 (60%) | 0.856 |
| test, `supported` | 161 | 0.820 |
| test, `unsupported` | 175 | 0.960 |
| test, `incorrect` | 57 | 0.912 |
| test, `misleading` | 120 | 0.725 |
| test, provision pairs | 248 of 312 | 0.968 |
| test, judgment-derived | 265 of 548 | 0.751 |
| source-grounding fixture | 13 of 28 | 9 right, 4 wrong |
| legal-claims fixture | 23 of 62 | 9 right, 14 wrong |

The price is visible in `misleading`: about one "Vilseledande" label in four is wrong on the
test partition, prop pages accept at 0.745, and on the legal-claims fixture more accepted labels
are wrong than right. The `models/` directory is not in git, so the new
`calibration.json` has to be copied to the server's `models/classifier-kb-bert-4way-v2/` and
the backend container restarted before it takes effect.

Still open:

- `supported`, `incorrect` and `misleading` only pass 0.85 targets, not the PRD's 0.95 and 0.90.
  The next step for them is an LLM-judge pass over the existing `incorrect` and `misleading` rows, as the
  provision-based generator already does, and more `supported` rows in memo register.
- `statute_stycke` has 10 test rows and 0.2 accuracy; the provision-based generator does not
  produce stycke pinpoints.
- The client (`src/main.js`) joins all passages into one source with a "court · section" header
  or none. Header augmentation makes the model indifferent to that, but the multi-source premise
  shape in training never occurs in production.
- `docker-compose.yml` still mounts `models/classifier-kb-bert-4way`. Switching it to v2 is a
  deployment decision.

## Browser model (privacy mode), fine-tuned and switched on

`scripts/train_scandi_nli.py` now maps `misleading` to neutral, as the source-grounding fixture
expects of a three-way model, uses inverse-frequency class weights and the same header
augmentation as the KB-BERT script. It trained `alexandrainst/scandi-nli-small` for five epochs on
the same 7,428 rows (best validation macro F1 0.670 at epoch 4). `scripts/export-model.py` takes
`--version` and `--premise window` and wrote `public/models/scandi-nli-small-legal-v2-q8/`.
`scripts/evaluate_browser_model.py` scores an exported browser model on one 350-token window,
which is the shape the worker builds for weights whose manifest says `"premise": "window"`, and
with `--calibrate` writes fail-closed thresholds into the manifest.

| | Shipped weights, window input | Fine-tuned v2 |
|---|---:|---:|
| test partition, 868 rows, argmax accuracy | 0.508 | 0.665 |
| accepted under the calibrated policy | | 106, all "Stöd saknas" |
| precision on accepted | | 0.962 |
| source-grounding, argmax in allowed set | 14 of 29 | 19 of 29 |
| legal-claims, argmax in allowed set | 27 of 62 | 46 of 62 |
| the borgen claim, exact text | entailment 0.63 | neutral 0.65, abstains |

The calibrated thresholds are neutral 0.876, with entailment and contradiction disabled (1.01):
on the 672 calibration rows the best entailment threshold reaches 0.82 precision against the
0.95 target and contradiction 0.90. Privacy mode therefore says "Stöd saknas" reliably and
abstains otherwise. It no longer gives the seven "Stöd hittat" labels the original weights gave
on the legal-claims fixture. `src/semantic.js` reads `THRESHOLDS` from the manifest, and its
`MODEL_VERSION` from the manifest too; a separate constant is what made the first run fail with
"Modellfilen stämmer inte". The label policy takes thresholds as an option so the unit tests pin
the provisional values. The browser tests accept one merged comparison with a `roles` list and
abstention where a label is disabled, and accept "Stöd saknas" for the missing-qualification
cases of the 24-case fixture, which a three-way model trained with misleading as neutral answers
that way.

Neutral confidence of v2 on the unsupported test rows, by how the negative was built:

| Negative type | Rows | Median neutral | At or above 0.876 |
|---|---:|---:|---:|
| unrelated act | 76 | 0.96 | 78 % |
| BM25-near provision of another act | 33 | 0.88 | 52 % |
| neighbouring § | 37 | 0.86 | 43 % |
| topic_match (judgment-derived) | 27 | 0.62 | 0 % |
| adjacent (judgment-derived) | 62 | 0.35 | 0 % |

The borgen claim is an unrelated-act case, where the small model is confident four times in
five. Its 0.65 there points at what the generated pairs do not cover: 1915 wording ("äge",
"i ty fall") and the markdown-bold "**4 §**" of the fixture text. Both HB 10:9 claims fail for
the same reason. Provisions from older acts still in force exist in the corpus and can be
sampled on purpose.

## Teacher audit, source repair and model v3, 25 September 2026

The label noise suspected above was measured with a local teacher, `gemma4:26b` through ollama,
one letter per pair read from the logprobs (`scripts/audit_labels_teacher.py`). The teacher agreed
with 68% of the training labels. Judged on its own against a long source it misses single-word flips
("avsevärt förbättrat" against a source that says "försämrat" was called supported), so rewritten rows
are instead judged next to their original claim (`scripts/audit_transformations_teacher.py`), which
agrees with 81% of them.

A quarter of the authentic rows were rejected. The claims are sound; the stored source text was not:
CJEU pinpoints written "p. 49" fell back to the document header, "HD fattade beslut i enlighet med
betänkandet" cut the reasoning away with the dissent, numbered points inside a provision were dropped,
and "s. 83 f." lost page 84. `backend/resolver.py` fixes all four. `scripts/repair_rejected_sources.py`
re-resolves the sources of rejected rows and asks the teacher again: 83 of 254 rejected parents came
back accepted, and 339 siblings received the repaired text.

`scripts/apply_teacher_audit.py` then wrote `data/train.audited.jsonl` (6130 of 7428 rows) and
`data/validation.audited.jsonl` (789 of 996) with three rules: children of a rejected parent go,
a rewrite the teacher judged as not having its labelled effect goes, and any other row goes on a
confident label disagreement. Model v3 (`models/classifier-kb-bert-4way-v3`) is KB-BERT trained on
those files with the v2 recipe; best validation macro F1 0.824 at epoch 3.

On the unchanged test partition, calibrated with the same 0.85 targets and 0.10 slack as v2:

| | v2 | v3 |
|---|---:|---:|
| argmax accuracy, 860 rows | 0.735 | 0.731 |
| accuracy, 646 rows whose label the teacher confirms | 0.800 | 0.827 |
| accuracy, 199 rows whose label the teacher rejects | 0.533 | 0.437 |
| accepted under the fail-closed policy | 513 (0.856 precision) | 270 (0.815 precision), `unsupported` disabled |
| `incorrect` recall | 0.636 | 0.487 |
| judgment-derived contradiction rows, teacher-confirmed | 0.56 (39 rows) | 0.28 |
| legal-claims fixture, argmax | 23 of 62 accepted, 9 right | 33 of 62 right, 9 accepted, 3 wrong |

v3 gains on supported-type rows (authentic 0.67 to 0.79, paraphrase 0.74 to 0.86, distractor 0.71 to
0.81) and loses on judgment-derived contradictions and overstatements. Coverage fell because the
calibration partition keeps its noisy labels: a model trained to disagree with them is scored as less
confident. The calibration and test partitions have teacher verdicts in `data/teacher/` but were not
filtered or repaired, so v2 and v3 stay comparable on the same rows.

Still open after v3:

- Filter and repair the calibration partition the same way before fitting thresholds, and report
  test numbers on the teacher-confirmed rows.
- The contradiction loss: 130 judgment-derived contradiction rows went with their rejected parents
  and 70 overstatements were judged "same meaning". Check whether the remaining contradiction rows
  are dominated by provision pairs.
- Extraction fixes only reach rows that are re-resolved. Regenerating the partitions from the fixed
  resolver would also repair rows the teacher accepted despite a broken source.

## Sentence-level alignment and model v4, 25 September 2026

Chunk mode scores every paragraph chunk of every source against the claim and pools the chunk
distributions: support, contradiction and overstatement are each as strong as the strongest chunk,
"stöd saknas" as strong as the weakest chunk's unsupported probability (`ClaimClassifier.pool_chunks`).
The chunker (`backend/windowing.py: source_chunks`) is the BM25 window's paragraph splitter with bare
labels merged into the next paragraph, and the same header form. `calibration.json` carries
`"mode": "chunks"`, so a window-mode model serves as before.

Model v4 is KB-BERT trained on chunk pairs (`scripts/build_chunk_pairs.py`): for each audited row the
chunk the teacher named (`scripts/select_chunks_teacher.py`) carries the row label and two other chunks
are unsupported; 13,510 pairs, two thirds unsupported. Best validation macro F1 0.748 on chunk pairs.

The calibration partition was filtered and repaired the same way as train (543 of 672 rows kept,
`data/calibration.audited.jsonl`). All four configurations below are calibrated on it with 0.85
targets and 0.10 slack, and scored on the unchanged test partition. "Confirmed" rows are the 646 test
rows whose label the teacher agrees with.

| | v2 window | v3 window | v3 chunks | v4 chunks |
|---|---:|---:|---:|---:|
| test argmax accuracy | 0.735 | 0.731 | 0.713 | 0.724 |
| accepted of 860, precision | 499, 0.834 | 613, 0.799 | 651, 0.774 | 680, 0.794 |
| classes enabled | 3 | 4 | 4 | 4 |
| confirmed rows: accuracy | 0.800 | 0.827 | 0.807 | 0.814 |
| confirmed rows: accepted, precision | 382, 0.919 | 470, 0.909 | 494, 0.868 | 525, 0.891 |
| judgment-derived contradictions, 85 rows | 0.41 | 0.19 | 0.21 | 0.22 |
| overstatements, 86 rows | 0.71 | 0.57 | 0.56 | 0.58 |
| authentic rows, 90 | 0.63 | 0.74 | 0.72 | 0.74 |
| legal-claims fixture: argmax right, accepted, wrong | 30, 12, 5 | 33, 17, 7 | 35, 24, 11 | 32, 32, 12 |

Calibrating on audited rows raises coverage for every model (v2: 499 against 513 before, with one
class fewer enabled; v3 window: 613 against 270). Chunk mode adds coverage again and turns every
class on. The teacher-filtered models stay behind v2 on judgment-derived contradictions.

Why the contradictions dropped: the filter removed supported rows whose words are not in the source
(median claim-word overlap 0.35 against 0.61 for kept rows) and unsupported rows whose words are
(0.27 against 0.15). Those rows were what forced the model past word overlap. A contradiction is a
high-overlap pair with one flipped word, and v3 answers supported on 51 of the 85, v2 on 35. Chunk
training did not repair it: the shortcut is in the label distribution, not the window.

Still open after v4:

- High-overlap negatives. The audited data needs more pairs where the wording matches and the label
  is not supported: contradictions with the flip inside a chunk, and unsupported rows built from
  neighbouring paragraphs of the supporting source.
- Precision on the unchanged test partition is below the 0.85 target for every model; on the
  confirmed rows it is above. Filtering the test partition the same way would make the target
  measurable, at the cost of comparability with earlier numbers.
- 171 training rows and 6 rows with sources over 300,000 characters have no chunk pick and are absent
  from the chunk pairs.

## Audited test partition, 25 September 2026

The test partition was given the same treatment as train and calibration, with one difference: no row
was dropped on the teacher's word alone. Sources were re-resolved on every row (57 parents and 143
siblings changed text). The 110 rows the rules would have dropped were reviewed one by one by three
Claude reviewer agents with the label definitions and the parent claim in front of them: 68 kept,
42 relabelled, none dropped (`data/teacher/test.decisions.jsonl`, applied through
`scripts/apply_teacher_audit.py --decisions`). Relabels: 12 "adjacent" negatives whose neighbouring
page states the claim, 12 overstatement rewrites with no change of meaning and 2 that reverse it,
15 rows whose only source text is a header or fragment, 1 statute memo. `data/test.audited.jsonl`
keeps all 868 rows, so it is comparable row by row with the old file.

All four configurations, calibrated on `data/calibration.audited.jsonl`, scored on it:

| | v2 window | v3 window | v3 chunks | v4 chunks |
|---|---:|---:|---:|---:|
| argmax accuracy | 0.729 | 0.761 | 0.740 | 0.743 |
| macro F1 | 0.715 | 0.731 | 0.713 | 0.716 |
| accepted of 868, precision | 519, 0.834 | 613, 0.830 | 648, 0.807 | 673, 0.826 |
| classes enabled | 3 | 4 | 4 | 4 |
| incorrect recall | 0.63 | 0.50 | 0.49 | 0.51 |
| judgment-derived contradictions, 85 rows | 0.44 | 0.25 | 0.24 | 0.27 |
| authentic rows, 90 | 0.61 | 0.79 | 0.78 | 0.78 |
| legal-claims fixture: argmax right, accepted, wrong | 30, 12, 5 | 33, 17, 7 | 35, 24, 11 | 32, 32, 12 |

On honest labels v3 in window mode leads on accuracy by three points over v2, and the chunk models
lead on coverage. The contradiction gap is unchanged by the relabelling, so it is a property of the
models, not of the test labels. The 868 rows come from about 150 independent claim families; the
overall accuracy interval is about ±3 points and the 85-row contradiction cell about ±10.

## More rewrites, neighbour chunks and model v5, 26 September 2026

Two data additions, both judged by the teacher before use:

- `scripts/generate_rewrites.py`: one new contradiction and one new overstatement per accepted parent
  claim (1,091 in train), judged pairwise against the parent. 1,471 contradictions and 372
  overstatements survived; 206 overstatements were judged to have the same meaning and 32 to be
  contradictions (kept as incorrect).
- `scripts/neighbour_chunks.py`: the chunk before and after the deciding chunk, judged against the
  parent claim as the only source. 944 came out unsupported and were copied to 3,357 rewrites of the
  same claim; 203 came out supported (a neighbouring paragraph that restates the point).

`scripts/build_chunk_pairs.py` now falls back to the parent's chunk pick for rewrites (1,436 rows in
train, 99 still without a pick). Train has 22,563 chunk pairs: 16,053 unsupported, 2,746 supported,
2,580 incorrect, 1,184 misleading. v5 is KB-BERT on those pairs, best validation macro F1 0.722.
Scored like the others on the audited partitions:

| | v2 window | v3 window | v4 chunks | v5 chunks |
|---|---:|---:|---:|---:|
| argmax accuracy | 0.729 | 0.761 | 0.743 | 0.734 |
| accepted, precision | 519, 0.834 | 613, 0.830 | 673, 0.826 | 653, 0.835 |
| incorrect recall / precision | 0.63 / 0.59 | 0.50 / 0.71 | 0.51 / 0.61 | 0.61 / 0.52 |
| supported recall / precision | 0.66 / 0.77 | 0.78 / 0.75 | 0.74 / 0.74 | 0.67 / 0.80 |
| judgment-derived contradictions, 85 rows | 0.44 | 0.25 | 0.27 | 0.51 |
| paraphrases, 89 rows | 0.75 | 0.84 | 0.79 | 0.67 |
| legal-claims fixture: argmax right, accepted, wrong | 30, 12, 5 | 33, 17, 7 | 32, 32, 12 | 32, 25, 11 |

The high-overlap negatives did what they were meant to: contradictions went from 0.27 to 0.51 and
incorrect recall from 0.51 to 0.61. The cost is on the other side of the same boundary: supported
rows called incorrect rose from 38 to 63 and paraphrase accuracy fell from 0.79 to 0.67. Overall
accuracy is unchanged within the interval. In every model the contradiction rows that pass the
threshold are mostly wrong (precision 0.03 to 0.24 on 34 to 45 accepted rows): the model is
confident on exactly the flipped pairs it misreads.

Still open after v5:

- The supported/incorrect boundary is now balanced by data volume in both directions; the model
  itself does not see the flipped word reliably. A pair-aware feature (which content words differ
  between claim and deciding chunk) or a larger encoder is the next lever, not more pairs.
- Contradiction rows pass the threshold when wrong. Per-transformation calibration is not available
  at serving time, but the margin threshold could be raised for the incorrect class.
- v3 window stays the best single number on accuracy; v5 chunks the best on coverage with the
  contradiction recall of v2.

## All versions in both modes, and v5 window in production, 26 September 2026

Every KB-BERT version and mmBERT-small were scored through `scripts/calibrate_onnx.py` in window
and chunks mode (calibrated on `data/calibration.audited.jsonl`, scored on the 860 assessable rows of
`data/test.audited.jsonl`). The rows not in the tables above:

| | v1 window | v4 window | v5 window | mmBERT window |
|---|---:|---:|---:|---:|
| argmax accuracy | 0.528 | 0.756 | 0.722 | 0.607 |
| macro F1 | 0.489 | 0.735 | 0.704 | 0.461 |
| accepted, precision | 73, 1.000 | 550, 0.829 | 587, 0.842 | 195, 0.687 |
| classes enabled | 1 | 4 | 4 | 1 |
| incorrect recall / precision | 0.29 / 0.40 | 0.55 / 0.58 | 0.63 / 0.49 | 0.46 / 0.54 |
| judgment-derived contradictions | 0.22 | 0.33 | 0.51 | 0.32 |
| paraphrases | 0.80 | 0.78 | 0.60 | 0.88 |

v1 chunks, v2 chunks and mmBERT chunks are no better than their window rows. mmBERT never predicts
misleading and was scored at the 512-token limit of `ClaimClassifier`. If a misleading row counts as
right when the model says supported or incorrect, every KB-BERT accuracy rises by 3 to 4 points and
the order does not change.

The server now runs v5 in window mode (`models/classifier-kb-bert-4way-v5/calibration.json` is the
window calibration: temperature 1.80, margin 0.20, all four classes enabled). Each comparison in the
API response carries the calibrated `threshold` of the predicted class and the `minimum_margin`. The
"Självsäkerhet" slider in the report scales both from 100 % (the calibrated level) down to 0 % (the
top label always), so the browser decides again without a new request. Abstentions for partial
sources or text that is too long stay.

## Browser model v3 on the v5 data, not shipped, 26 September 2026

`scripts/train_scandi_nli.py` trained ScandiNLI-small on the v5 chunk pairs (`data/train.chunks.jsonl`,
misleading as neutral), best validation macro F1 0.668 at epoch 3. It was exported to
`public/models/scandi-nli-small-legal-v3-q8/` and calibrated on `data/calibration.audited.jsonl` with
the browser policy (targets 0.95/0.90/0.95, Wilson slack 0.05): neutral 0.858, entailment and
contradiction disabled, as for v2.

`scripts/benchmark-browser-model.mjs` runs the model the way privacy mode does: the Vite app in
Chromium, the semantic worker, onnxruntime-web (WASM here) and the JS tokenizer and windowing.

| | v2 (shipped) | v3 |
|---|---:|---:|
| audited test partition, 863 scored rows, argmax accuracy | 0.687 | 0.634 |
| recall entailment / neutral / contradiction | 0.75 / 0.71 / 0.48 | 0.68 / 0.59 / 0.62 |
| accepted, precision (all "Stöd saknas") | 114, 0.947 | 136, 0.934 |
| legal-claims fixture: labels given, wrong | 11, 2 | 12, 2 |
| median time per test row, WASM | 205 ms | 209 ms |

v3 repeats the v5 trade on a model one sixth the size: contradiction recall up 14 points, entailment
and neutral down, overall accuracy down 5 points. v2 stays in `src/model-manifest.json`. The two
wrong fixture labels are the same in both: correct claims called "Stöd saknas" by the rule in
`semanticResult` for exact provisions (neutral at least 0.60, both other labels under 0.40).

The "Självsäkerhet" slider and the score popup now work the same in both modes. Each result keeps
its calibrated judgment and, when that judgment abstained only because the top label was under its
threshold, the top label with its score and threshold (`serverCandidate`, `localCandidate`,
`judgmentAt` in `src/semantic.js`). Conflicting passages, a missing conclusion and text that is too
long still abstain at every level.

`backend/model-integrity.json` holds the size and SHA-256 of each file the server loads, per model
directory. `get_model()` refuses a model that differs or has no entry.
