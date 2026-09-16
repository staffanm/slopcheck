import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import cases from './fixtures/legal-claims.json' with { type: 'json' };
import { claimContext, selectEvidence, plainText } from '../src/analysis.js';
import { semanticClaim, semanticResult } from '../src/semantic.js';

function input(item) {
  const start = item.text.indexOf(item.citation);
  const occurrence = { text: item.citation, locations: [{ block_id: 'text', start, end: start + item.citation.length }] };
  const blocks = [{ id: 'text', text: item.text }];
  const claim = semanticClaim(occurrence, claimContext(occurrence, blocks), blocks);
  const markdown = readFileSync(new URL(`./fixtures/legal-sources/${item.file}`, import.meta.url), 'utf8');
  return { claim, markdown, evidence: selectEvidence(markdown, item.uri, claim) };
}

test('a provision-relative claim keeps the complete guarantee assertion and both source paragraphs', () => {
  const { claim, markdown, evidence } = input(cases[0]);
  assert.equal(claim.assessable, true);
  assert.match(claim.hypothesis, /^när en person åtar sig/);
  assert.match(claim.hypothesis, /'som för egen skuld'.*direkt från borgensmannen\.$/);
  assert.equal(claim.text, cases[0].text);
  assert.doesNotMatch(claim.hypothesis, /Detta följer|avtalslagen/);
  assert.equal(evidence.passages.length, 1);
  assert.equal(evidence.passages[0].text, plainText(markdown));
  assert.equal(evidence.exact, true);
});

test('HD attribution selects its own summary and decision, excluding lower courts', () => {
  const { claim, evidence } = input(cases[1]);
  assert.equal(claim.assessable, true);
  assert.equal(claim.authority, 'högsta domstolen');
  assert.equal(claim.requireConclusion, true);
  assert.match(claim.hypothesis, /^det förhållandet.*inte hindrar/);
  assert.equal(evidence.passages.length, 5);
  assert.ok(evidence.passages.every(p => p.court === 'högsta domstolen'));
  assert.ok(evidence.passages.some(p => p.role === 'summary' && p.text.includes('ska avvisas')));
  assert.ok(evidence.passages.some(p => p.role === 'decision' && p.text.includes('HD undanröjer')));
  assert.ok(evidence.excluded.some(p => p.court.includes('hovrätt')));
});

test('identical lower-court text cannot support a claim attributed to HD', () => {
  const claim = { text: 'Avtalet är giltigt och parterna ska fullgöra det.', authority: 'högsta domstolen', requireConclusion: true };
  const markdown = `## Tingsrätten\n\n## Domslut\n\n${claim.text}\n\n## Högsta domstolen\n\n## Bakgrund\n\n${claim.text}\n\n## Skäl\n\nKäranden anförde att ${claim.text}\n\n## Beslut\n\nAvtalet är ogiltigt och ingen part ska fullgöra det.`;
  const evidence = selectEvidence(markdown, cases[1].uri, claim);
  assert.equal(evidence.passages.length, 1);
  assert.equal(evidence.passages[0].role, 'decision');
  assert.doesNotMatch(evidence.passages[0].text, /Avtalet är giltigt/);
  assert.equal(selectEvidence(claim.text, cases[1].uri, claim).passages.length, 0);
  const yes = { scores: { entailment: .99, neutral: .005, contradiction: .005 } };
  assert.equal(semanticResult([{ ...yes, role: 'reasoning' }], evidence).status, 'abstain');
  assert.equal(semanticResult([{ ...yes, role: 'decision' }], evidence).status, 'supported');
  assert.equal(semanticResult([{ ...yes, role: 'summary' }], evidence).status, 'supported');
});

test('source passages preserve long sentences instead of cutting off their conditions', () => {
  const text = 'En part ska betala ' + 'ett belopp '.repeat(160) + 'bara om avtalet är giltigt.';
  const evidence = selectEvidence(text, 'https://lagen.nu/1915:218', { text: 'En part ska betala ett belopp.' });
  assert.equal(evidence.passages[0].text, text);
});
