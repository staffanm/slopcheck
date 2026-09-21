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

Still open:

- `supported`, `incorrect` and `misleading` are disabled by the fail-closed policy. The next step
  for them is an LLM-judge pass over the existing `incorrect` and `misleading` rows, as the
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
