import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLegalClaims } from './legal-fixture.js';
import { claimContext, selectEvidence, plainText } from '../src/analysis.js';
import { semanticClaim, semanticResult } from '../src/semantic.js';

// The policy tests pin the provisional thresholds; the shipped manifest may disable labels.
const PROVISIONAL = { supported: 0.97, contradiction: 0.97, neutral: 0.90, conflict: 0.50 };

const cases = readLegalClaims();
const LABELS = ['supported', 'misleading', 'incorrect', 'nonsensical', 'unsupported'];
const uri = item => item.sources[0].uri;

function input(item) {
  const claim = semanticClaim(item.occurrence, claimContext(item.occurrence, item.blocks), item.blocks);
  return { claim, markdown: item.markdown, evidence: selectEvidence(item.markdown, uri(item), claim) };
}

test('a provision-relative claim keeps the complete guarantee assertion and both source paragraphs', () => {
  const { claim, markdown, evidence } = input(cases[0]);
  assert.equal(claim.assessable, true);
  assert.match(claim.hypothesis, /^när en person åtar sig/);
  assert.match(claim.hypothesis, /'som för egen skuld'.*direkt från borgensmannen\.$/);
  assert.equal(claim.text, cases[0].claim);
  assert.doesNotMatch(claim.hypothesis, /Detta följer|avtalslagen/);
  assert.equal(evidence.passages.length, 2);
  assert.equal(evidence.passages.toSorted((a, b) => a.index - b.index).map(p => p.text).join('\n\n'), plainText(markdown));
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
  const evidence = selectEvidence(markdown, uri(cases[1]), claim);
  assert.equal(evidence.passages.length, 1);
  assert.equal(evidence.passages[0].role, 'decision');
  assert.doesNotMatch(evidence.passages[0].text, /Avtalet är giltigt/);
  assert.equal(selectEvidence(claim.text, uri(cases[1]), claim).passages.length, 0);
  const yes = { scores: { entailment: .99, neutral: .005, contradiction: .005 } };
  assert.equal(semanticResult([{ ...yes, role: 'reasoning' }], { ...evidence, thresholds: PROVISIONAL }).status, 'abstain');
  assert.equal(semanticResult([{ ...yes, role: 'decision' }], { ...evidence, thresholds: PROVISIONAL }).status, 'correct');
  assert.equal(semanticResult([{ ...yes, role: 'summary' }], { ...evidence, thresholds: PROVISIONAL }).status, 'correct');
});

test('source passages preserve long sentences instead of cutting off their conditions', () => {
  const text = 'En part ska betala ' + 'ett belopp '.repeat(160) + 'bara om avtalet är giltigt.';
  const evidence = selectEvidence(text, 'https://lagen.nu/1915:218', { text: 'En part ska betala ett belopp.' });
  assert.equal(evidence.passages[0].text, text);
});

test('every corpus claim has a label, a frozen source, and a hypothesis without the citation', () => {
  assert.ok(cases.length >= 60);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  // Every label occurs. Misleading has few claims since contradictions
  // were relabelled incorrect; see docs/semantic-evaluation.md.
  for (const label of LABELS) assert.ok(cases.some(item => item.label === label), label);
  for (const item of cases) {
    assert.ok(LABELS.includes(item.label), item.id);
    assert.ok(item.claim.includes(item.sources[0].citation), item.id);
    const { claim } = input(item);
    assert.doesNotMatch(claim.hypothesis, /CITATION/, item.id);
    assert.equal(claim.hypothesis.includes(item.sources[0].citation), false, item.id);
    if (item.known_gap) continue;
    assert.equal(claim.assessable, item.assessable !== false, `${item.id}: ${claim.reason}`);
  }
});

test('provision claims select the exact provision; judgment claims select the attributed court', () => {
  for (const item of cases.filter(item => !item.known_gap)) {
    const { claim, markdown, evidence } = input(item);
    if (!new URL(uri(item)).pathname.startsWith('/dom/')) {
      assert.equal(evidence.exact, true, item.id);
      assert.ok(evidence.passages.length >= 1 && evidence.passages.length <= 5, item.id);
      assert.ok(evidence.passages.every(p => plainText(markdown).includes(p.text)), item.id);
      assert.ok(evidence.passages.some(p => new RegExp(`^${new URL(uri(item)).hash.replace(/^#(?:K\d+[a-z]?)?P/, '')} §`).test(p.text)), item.id);
      continue;
    }
    assert.ok(evidence.passages.length > 0, item.id);
    assert.equal(evidence.authority, claim.authority ?? (uri(item).includes('/dom/hfd/') ? 'högsta förvaltningsdomstolen' : 'högsta domstolen'), item.id);
    assert.ok(evidence.passages.every(p => p.court === evidence.authority), item.id);
    assert.ok(evidence.passages.some(p => p.role === 'decision'), item.id);
    assert.equal(claim.requireConclusion, Boolean(claim.authority), item.id);
  }
});

test('the headnote, HFD reports and sub-headed chapters supply evidence', () => {
  const [tf, hfd, hd] = ['public-access-everyone', 'tax-surcharge-after-charge', 'sermon-acquitted'].map(id => input(cases.find(item => item.id === id)));
  assert.equal(tf.evidence.exact, true);
  assert.equal(tf.evidence.passages.length, 1);
  assert.equal(hfd.evidence.authority, 'högsta förvaltningsdomstolen');
  assert.ok(hfd.evidence.passages.every(p => p.court === 'högsta förvaltningsdomstolen'));
  assert.ok(hfd.evidence.passages.some(p => p.role === 'summary' && p.text.startsWith('När en skattskyldig har åtalats')));
  assert.ok(hfd.evidence.passages.some(p => p.role === 'decision' && p.text.includes('undanröjer skattetilläggen')));
  assert.ok(hfd.evidence.excluded.every(p => p.role === 'reported'));
  assert.ok(hd.evidence.passages.some(p => p.role === 'summary' && p.text.includes('har ogillats med hänvisning till Europakonventionen')));
  assert.ok(hd.evidence.passages.some(p => p.role === 'decision' && p.text.includes('fastställer hovrättens domslut')));
});

// Second wordings of fixture claims. They test the claim verb list ("är",
// "gäller", "ska" for "skulle") and are not separate gold rows.
const REWORDED = {
  'limitation-five-years': 'Enligt 2 § preskriptionslagen (1981:130) är preskriptionstiden för en fordran fem år från tillkomsten.',
  'interest-eight-points': 'Dröjsmålsräntan är enligt 6 § räntelagen (1975:635) referensräntan med ett tillägg av åtta procentenheter.',
  'interest-twelve-points': 'Dröjsmålsräntan är enligt 6 § räntelagen (1975:635) referensräntan med ett tillägg av tolv procentenheter.',
  'ne-bis-in-idem-scope': 'Högsta domstolen har i NJA 2013 s. 502 slagit fast att rätten att inte bli lagförd två gånger för samma gärning gäller även systemet med skattetillägg och påföljd för skattebrott.',
  'sermon-acquitted': 'Högsta domstolen har i NJA 2005 s. 805 funnit att åtalet mot en pastor för hets mot folkgrupp ska ogillas, eftersom en fällande dom sannolikt strider mot Europakonventionen.',
  'sermon-convicted': 'HD har i NJA 2005 s. 805 slagit fast att pastorn ska dömas för hets mot folkgrupp till fängelse.',
  'hiv-endangerment': 'HD har i NJA 2004 s. 176 funnit att en HIV-smittad man som haft oskyddade samlag utan att upplysa om smittan ska dömas för framkallande av fara för annan och inte för försök till grov misshandel.',
  'hiv-attempted-assault': 'Högsta domstolen har i NJA 2004 s. 176 slagit fast att mannen ska dömas för försök till grov misshandel eftersom han varit likgiltig inför risken för smitta.',
};

test('both wordings of a claim are assessable', () => {
  for (const [id, wording] of Object.entries(REWORDED)) {
    const original = cases.find(item => item.id === id);
    const { citation } = original.sources[0];
    const start = wording.indexOf(citation);
    const occurrence = { text: citation, locations: [{ block_id: 'text', start, end: start + citation.length }] };
    const blocks = [{ id: 'text', text: wording }];
    assert.equal(semanticClaim(occurrence, claimContext(occurrence, blocks), blocks).assessable, true, id);
    assert.equal(input(original).claim.assessable, !original.known_gap, id);
  }
});
