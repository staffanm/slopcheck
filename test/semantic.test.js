import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tokenizer } from '@huggingface/tokenizers';
import { readFileSync } from 'node:fs';
import { claimContext } from '../src/analysis.js';
import { MODEL_VERSION, semanticClaim, semanticResult, scoresFromLogits, rowSemantic, matchesFilter } from '../src/semantic.js';
import { modelPassages, pairInput } from '../src/semantic-input.js';

const tokenizer = new Tokenizer(...['tokenizer.json', 'tokenizer_config.json'].map(name => JSON.parse(readFileSync(new URL(`../public/models/${MODEL_VERSION}/${name}`, import.meta.url)))));
const scores = (entailment, neutral, contradiction) => ({ entailment, neutral, contradiction });
const comparison = (text, values) => ({ text, scores: values });

function claim(text, extra = {}) {
  const citation = '4 § avtalslagen';
  const start = text.indexOf(citation);
  const occurrence = { text: citation, locations: [{ block_id: 'text', start, end: start + citation.length }] };
  const blocks = [{ id: 'text', text, ...extra }];
  return semanticClaim(occurrence, claimContext(occurrence, blocks), blocks);
}

test('claims preserve negation, select semicolon clauses, and remove citation signals', () => {
  assert.equal(claim('Ett sent svar ska inte räknas som ett nytt anbud (se 4 § avtalslagen).').hypothesis, 'Ett sent svar ska inte räknas som ett nytt anbud');
  const second = claim('Det första avtalet är giltigt; ett sent svar ska räknas som ett nytt anbud enligt 4 § avtalslagen.');
  assert.equal(second.assessable, true);
  assert.doesNotMatch(second.hypothesis, /första avtalet|avtalslagen/);
  assert.equal(claim('Ett sent svar ska räknas som ett nytt anbud. Se även 4 § avtalslagen.').hypothesis, 'Ett sent svar ska räknas som ett nytt anbud.');
});

test('lists, nested speech, unlinked notes and pronouns abstain', () => {
  for (const text of ['Se 4 § avtalslagen.', 'Källförteckning\n4 § avtalslagen.', 'Han ska därför betala henne beloppet enligt 4 § avtalslagen.', 'Käranden hävdade att avtalet var giltigt enligt 4 § avtalslagen.']) {
    assert.equal(claim(text).assessable, false, text);
  }
  assert.equal(claim('Ett sent svar ska räknas som ett nytt anbud enligt 4 § avtalslagen.', { label: 'Fotnot 1' }).assessable, false);
  assert.equal(claim('Se 4 § avtalslagen.', { label: 'Fotnot 1', claimContext: 'Ett sent svar ska räknas som ett nytt anbud.' }).assessable, true);
});

test('a citation-only paragraph uses the preceding sentence without changing document offsets', () => {
  const occurrence = { text: '4 § avtalslagen', locations: [{ block_id: 'note', start: 3, end: 18 }] };
  const blocks = [{ id: 'body', text: 'Ett sent svar ska räknas som ett nytt anbud.' }, { id: 'note', text: 'Se 4 § avtalslagen.' }];
  const result = semanticClaim(occurrence, claimContext(occurrence, blocks), blocks);
  assert.equal(result.hypothesis, blocks[0].text);
  assert.equal(result.assessable, true);
  assert.deepEqual(occurrence.locations, [{ block_id: 'note', start: 3, end: 18 }]);
});

test('label policy abstains on uncertain, conflicting and incomplete evidence', () => {
  const yes = comparison('Avsnitt A', scores(.99, .005, .005));
  const no = comparison('Avsnitt B', scores(.005, .005, .99));
  assert.equal(semanticResult([yes]).status, 'supported');
  assert.equal(semanticResult([no]).status, 'contradiction');
  assert.equal(semanticResult([yes, no]).status, 'abstain');
  assert.equal(semanticResult([yes], { incomplete: true }).status, 'abstain');
  assert.equal(semanticResult([]).status, 'abstain');
  assert.equal(semanticResult([comparison('Text', scores(.3, .5, .2))]).status, 'abstain');
  const missing = semanticResult([comparison('Orelaterad text', scores(.01, .98, .01))]);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.evidence.text, 'Orelaterad text');
  assert.throws(() => scoresFromLogits([0, NaN, 1]));
  assert.equal(scoresFromLogits([1000, 0, 0]).entailment, 1);
});

test('tokenized pairs use premise first and never truncate either input', () => {
  const premise = 'Avtalet är giltigt.';
  const hypothesis = 'Avtalet är inte giltigt.';
  const pair = pairInput(tokenizer, premise, hypothesis);
  assert.equal(tokenizer.decode(pair.input_ids.filter((_, i) => pair.token_type_ids[i] === 0), { skip_special_tokens: true }), premise);
  assert.equal(tokenizer.decode(pair.input_ids.filter((_, i) => pair.token_type_ids[i] === 1), { skip_special_tokens: true }), hypothesis);
  assert.equal(pairInput(tokenizer, premise, 'avtal '.repeat(200)), null);
  const text = 'Avtalet är giltigt. '.repeat(200);
  const selected = modelPassages([{ text }], tokenizer);
  assert.ok(selected.passages.every(p => tokenizer.encode(p.text, { add_special_tokens: false }).ids.length <= 350));
  assert.ok(selected.passages.every(p => text.includes(p.text)));
  assert.equal(selected.incomplete, false);
  assert.equal(modelPassages([{ text: 'avtal '.repeat(600) }], tokenizer).incomplete, true);
});

test('multiple targets and semantic filters do not change source validity', () => {
  const row = { semantic: new Map([['a', { status: 'supported' }], ['b', { status: 'abstain' }]]) };
  assert.equal(rowSemantic(row), 'abstain');
  assert.equal(matchesFilter('found', 'found', 'contradiction'), true);
  assert.equal(matchesFilter('review', 'found', 'contradiction'), true);
  assert.equal(matchesFilter('invalid', 'found', 'contradiction'), false);
  assert.equal(matchesFilter('unassessed', 'invalid', 'abstain'), true);
});
