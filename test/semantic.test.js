import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tokenizer } from '@huggingface/tokenizers';
import { readFileSync } from 'node:fs';
import { claimContext, mergeOccurrences } from '../src/analysis.js';
import { extractLocal } from '../src/lagrum-extract.js';
import { MODEL_VERSION, semanticClaim, semanticResult, scoresFromLogits, rowSemantic, matchesFilter, judgmentAt, localCandidate, serverCandidate } from '../src/semantic.js';
import { modelPassages, pairInput, premiseWindow } from '../src/semantic-input.js';

// The policy tests pin the provisional thresholds; the shipped manifest may disable labels.
const PROVISIONAL = { supported: 0.97, contradiction: 0.97, neutral: 0.90, conflict: 0.50 };

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
  assert.equal(claim('Ett sent svar ska inte räknas som ett nytt anbud (se 4 § avtalslagen).').hypothesis, 'Ett sent svar ska inte räknas som ett nytt anbud.');
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
  assert.equal(semanticResult([yes], { thresholds: PROVISIONAL }).status, 'correct');
  assert.equal(semanticResult([no], { thresholds: PROVISIONAL }).status, 'incorrect');
  assert.equal(semanticResult([yes, no], { thresholds: PROVISIONAL }).status, 'abstain');
  assert.equal(semanticResult([yes], { thresholds: PROVISIONAL, incomplete: true }).status, 'abstain');
  assert.equal(semanticResult([], { thresholds: PROVISIONAL }).status, 'abstain');
  assert.equal(semanticResult([comparison('Text', scores(.3, .5, .2))], { thresholds: PROVISIONAL }).status, 'abstain');
  const missing = semanticResult([comparison('Orelaterad text', scores(.01, .98, .01))], { thresholds: PROVISIONAL });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.evidence.text, 'Orelaterad text');
  const missingExact = semanticResult([comparison('4 § 1 st', scores(.07, .63, .30)), comparison('4 § 2 st', scores(.36, .33, .31))], { thresholds: PROVISIONAL, exact: true });
  assert.equal(missingExact.status, 'missing');
  assert.equal(missingExact.evidence.text, '4 § 1 st');
  const missingNonExact = semanticResult([comparison('4 § 1 st', scores(.07, .63, .30)), comparison('4 § 2 st', scores(.36, .33, .31))], { thresholds: PROVISIONAL, exact: false });
  assert.equal(missingNonExact.status, 'abstain');
  const archaicExact = semanticResult([comparison('10 kap. 9 § handelsbalken', scores(.13, .52, .35))], { thresholds: PROVISIONAL, exact: true });
  assert.equal(archaicExact.status, 'abstain');
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
  // When >10 passages exist, BM25 ranks by relevance to hypothesis
  const dummyPassages = Array.from({ length: 15 }, (_, i) => ({
    text: i === 12 ? 'Särskild klausul om force majeure och skadeståndsansvar.' : `Allmän utfyllande text om avtalsvillkor stycke ${i}.`
  }));
  const ranked = modelPassages(dummyPassages, tokenizer, 'Krävs skadeståndsansvar vid force majeure?');
  assert.equal(ranked.passages.length, 10);
  assert.ok(ranked.passages.some(p => p.text.includes('force majeure')));
});

test('a merged premise window keeps shared metadata and every included role', () => {
  const passages = [
    { text: 'Åtal väcktes för försök till grov misshandel.', court: 'högsta domstolen', section: 'Skäl', role: 'reasoning' },
    { text: 'HD dömer för framkallande av fara för annan.', court: 'högsta domstolen', section: 'Domslut', role: 'decision' },
  ];
  const window = premiseWindow(passages, tokenizer, 'Mannen dömdes för framkallande av fara för annan.');
  assert.equal(window.text, passages.map(passage => passage.text).join('\n\n'));
  assert.equal(window.court, 'högsta domstolen');
  assert.equal(window.section, undefined); // Two sections cannot label one window.
  assert.deepEqual(window.roles, ['reasoning', 'decision']);
  assert.equal(premiseWindow([], tokenizer, 'Ett påstående.'), null);
  // A window satisfies the attributed court's conclusion rule through its roles.
  const yes = { scores: scores(.99, .005, .005) };
  assert.equal(semanticResult([{ ...yes, roles: ['reasoning'] }], { thresholds: PROVISIONAL, requireConclusion: true }).status, 'abstain');
  assert.equal(semanticResult([{ ...yes, roles: window.roles }], { thresholds: PROVISIONAL, requireConclusion: true }).status, 'correct');
});

test('multiple targets and semantic filters do not change source validity', () => {
  const row = { semantic: new Map([['a', { status: 'correct' }], ['b', { status: 'abstain' }]]) };
  assert.equal(rowSemantic(row), 'abstain');
  assert.equal(matchesFilter('found', 'found', 'incorrect'), true);
  assert.equal(matchesFilter('review', 'found', 'incorrect'), true);
  assert.equal(matchesFilter('invalid', 'found', 'incorrect'), false);
  assert.equal(matchesFilter('unassessed', 'invalid', 'abstain'), true);
});

test('a lower certainty level forces judgments under the calibrated threshold, for both models', () => {
  const abstain = { status: 'abstain', reason: 'Under tröskeln.' };
  const server = serverCandidate({ predicted: 'incorrect', abstainReason: 'low_confidence', confidence: 0.6, margin: 0.3, threshold: 0.8, minimumMargin: 0.2 });
  assert.equal(judgmentAt(abstain, server, 1).status, 'abstain');
  assert.equal(judgmentAt(abstain, server, 0.7).status, 'incorrect');
  assert.equal(judgmentAt(abstain, server, 0.7).forced, true);
  assert.equal(serverCandidate({ predicted: 'unsupported', abstainReason: 'partial_sources' }), null);
  assert.equal(serverCandidate({ predicted: 'supported', abstainReason: null }), null);

  const thresholds = { supported: 1.01, neutral: 0.88, contradiction: 1.01, conflict: 0.5 };
  const local = semanticResult([comparison('Ett anbud är bindande.', scores(0.8, 0.15, 0.05))], { thresholds });
  assert.equal(local.status, 'abstain');
  const candidate = localCandidate(local, thresholds);
  assert.equal(judgmentAt(local, candidate, 1).status, 'abstain');
  assert.equal(judgmentAt(local, candidate, 0.75).status, 'correct');
  assert.equal(judgmentAt(local, candidate, 0.75).evidence.text, 'Ett anbud är bindande.');
  const conflicting = semanticResult([comparison('a', scores(0.98, 0.01, 0.01)), comparison('b', scores(0.01, 0.01, 0.98))], { thresholds: PROVISIONAL });
  assert.equal(localCandidate(conflicting, PROVISIONAL), null);
});

// Rows as main.js builds them from extractor output: merge, then context and claim.
function rows(text, citations) {
  const blocks = [{ id: 'text', text }];
  const occurrences = mergeOccurrences(citations.map(([sub, ...uris]) => {
    const start = text.indexOf(sub);
    return { text: sub, locations: [{ block_id: 'text', start, end: start + sub.length }], targets: uris.map(uri => ({ uri })) };
  }), blocks);
  return occurrences.map(occurrence => {
    const context = claimContext(occurrence, blocks);
    return { occurrence, context, claim: semanticClaim(occurrence, context, blocks, occurrences) };
  });
}

test('a "(Se …)" after a full stop supports the sentence before it; a law named as the subject of förarbetena is no source', () => {
  // NIS2 memo; the footnote is inlined where its marker sits.
  const text = 'Tvärtom förtydligas det i förarbetena till cybersäkerhetslagen att en verksamhetsutövare kan bedriva flera verksamheter som faller under olika tillsynsmyndigheters ansvarsområden. (Se prop. 2025/26:28, s. 149) Det finns ingenting som talar för att det ska göras skillnad mellan ”kärnverksamhet” och ”sidoverksamhet” i regelverket.';
  const [law, prop] = rows(text, [['cybersäkerhetslagen', 'https://lagen.nu/2025:1506'], ['prop. 2025/26:28, s. 149', 'https://lagen.nu/prop/2025/26:28#sid149']]);
  assert.equal(prop.claim.assessable, true);
  assert.equal(prop.claim.hypothesis, 'en verksamhetsutövare kan bedriva flera verksamheter som faller under olika tillsynsmyndigheters ansvarsområden.');
  assert.equal(law.claim.assessable, false);
  assert.match(law.claim.reason, /förarbetenas ämne/);
  // The sentence after the reference states what the source does not say; it is no claim.
  for (const row of [law, prop]) assert.doesNotMatch(row.context.text, /kärnverksamhet/);
});

test('"4 och 6 §§ räntelagen (1975:635)" is one claim over 4 § and 6 §, not the whole act', () => {
  const text = 'Detta regleras i 4 och 6 §§ räntelagen (1975:635), där det stadgas att dröjsmålsränta ska utgå från den dag då betalning skulle ha skett och tills betalning erläggs.';
  const expected = 'dröjsmålsränta ska utgå från den dag då betalning skulle ha skett och tills betalning erläggs.';
  // The lagen.nu extractor returns three occurrences.
  const api = rows(text, [['4', 'https://lagen.nu/1975:635#P4'], ['6 §§', 'https://lagen.nu/1975:635#P6'], ['räntelagen (1975:635)', 'https://lagen.nu/1975:635']]);
  assert.equal(api.length, 1);
  assert.equal(api[0].occurrence.text, '4 och 6 §§ räntelagen (1975:635)');
  assert.deepEqual(api[0].occurrence.targets.map(target => target.uri), ['https://lagen.nu/1975:635#P4', 'https://lagen.nu/1975:635#P6']);
  assert.equal(api[0].claim.hypothesis, expected);
  // The local extractor returns two, the second with the act as an extra target.
  const blocks = [{ id: 'text', text }];
  const local = mergeOccurrences(extractLocal(blocks), blocks);
  assert.equal(local.length, 1);
  assert.deepEqual(local[0].targets.map(target => target.uri), ['https://lagen.nu/1975:635#P4', 'https://lagen.nu/1975:635#P6']);
});

test('"Detta följer även av X" makes the sentence before it the claim, and a citation inside a word stays text', () => {
  const text = 'Enligt artikel 6(39), NIS2-direktivet, avses med ”leverantör av utlokaliserade driftstjänster” en entitet som tillhandahåller tjänster som rör installation, förvaltning, drift eller underhåll av IKT-produkter på distans. Detta följer även av 1 kap. 2 § 22 p. cybersäkerhetslagen.';
  const [, provision] = rows(text, [['NIS2', 'https://lagen.nu/celex/32022L2555'], ['1 kap. 2 § 22 p. cybersäkerhetslagen', 'https://lagen.nu/2025:1506#K1P2S1N22p']]);
  assert.equal(provision.claim.assessable, true);
  assert.equal(provision.claim.hypothesis, 'Enligt artikel 6(39), NIS2-direktivet, avses med ”leverantör av utlokaliserade driftstjänster” en entitet som tillhandahåller tjänster som rör installation, förvaltning, drift eller underhåll av IKT-produkter på distans.');
});
