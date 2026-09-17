import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { claimContext, pdfPageText, sentenceSegments, selectEvidence } from '../src/analysis.js';
import { semanticClaim } from '../src/semantic.js';
import { extractLocal } from '../src/lagrum-extract.js';

function claims(blocks) {
  const occurrences = extractLocal(blocks);
  return occurrences.map(occurrence => ({ occurrence, ...semanticClaim(occurrence, claimContext(occurrence, blocks), blocks, occurrences) }));
}
function one(text, citation = '4 § avtalslagen', extra = {}) {
  const start = text.lastIndexOf(citation);
  const occurrence = { text: citation, locations: [{ block_id: 'text', start, end: start + citation.length }] };
  const blocks = [{ id: 'text', text, ...extra }];
  return semanticClaim(occurrence, claimContext(occurrence, blocks), blocks);
}

test('sentence masking preserves original offsets, initials, decimals and wrapped abbreviations', () => {
  const text = '📄 1.\t  Ett sent svar enligt 4 § avtalslagen gäller som ett nytt anbud, t. ex. för A.B.\n\nNästa stycke.';
  const claim = one(text);
  assert.match(claim.text, /^📄 1\./);
  assert.match(claim.text, /för A.B\.$/);
  assert.doesNotMatch(claim.text, /Nästa stycke/);
  const decimals = 'Beloppet är 1.25 kronor. Enligt 4 § avtalslagen gäller ett sent svar som ett nytt anbud.';
  assert.equal(one(decimals).text, decimals.slice(decimals.indexOf('Enligt')));
  assert.ok(sentenceSegments(text).every(s => text.slice(s.index, s.index + s.segment.length) === s.segment));
});

test('list markers do not eat names, verbs, negation or numbered subjects', () => {
  for (const prefix of ['1. ', '12.\t\t', '1.\n  ']) {
    const claim = one(`${prefix}Anna Andersson ska inte betala enligt 4 § avtalslagen.`);
    assert.match(claim.hypothesis, /^Anna Andersson ska inte betala/);
    assert.equal(claim.assessable, true);
  }
});

test('a repeated citation selects its own semicolon clause and retains qualifications', () => {
  const repeated = one('Enligt 4 § avtalslagen är avtalet giltigt; enligt 4 § avtalslagen är avtalet inte giltigt.');
  assert.match(repeated.hypothesis, /är avtalet inte giltigt/);
  assert.doesNotMatch(repeated.hypothesis, /är avtalet giltigt/);
  assert.match(one('Avtalet är giltigt enligt 4 § avtalslagen; dock endast om svaret kom i tid.').hypothesis, /dock endast om svaret kom i tid/);
  assert.match(one('Avtalet är giltigt (4 § avtalslagen, men bara om svaret kom i tid).').hypothesis, /men bara om svaret kom i tid/);
});

test('short propositions are retained instead of borrowing another claim', () => {
  const blocks = [{ id: 'first', text: 'Ett sent svar ska räknas som ett nytt anbud.' }, { id: 'text', text: 'Avtalet är ogiltigt enligt 4 § avtalslagen.' }];
  const claim = claims(blocks)[0];
  assert.match(claim.hypothesis, /^Avtalet är ogiltigt/);
  assert.equal(claim.assessable, true);
});

test('existence comments in the judgment are not substituted with the preceding claim', () => {
  for (const text of ['Rättsfallet NJA 2013 s 372 finns inte.', 'Inte heller rättsfallet NJA 1995 s 603 finns.', 'Även rättsfallet NJA 1999 s 687 är påhittat och finns inte.']) {
    const claim = claims([{ id: 'page', label: 'PDF-sida 1', text: 'En tidigare mening om något annat. ' + text }])[0];
    assert.equal(claim.assessable, false);
    assert.match(claim.reason, /existens/);
    assert.doesNotMatch(claim.text, /tidigare mening/);
  }
});

test('ordinary negative legal assertions are not mistaken for source-existence comments', () => {
  assert.equal(one('Enligt 4 § avtalslagen finns inte något bindande avtal när svaret kommer för sent.').assessable, true);
});

test('nested reported source headings cannot be promoted to the deciding court', () => {
  const text = '# Referat\n\nEn sammanfattning.\n\n## Högsta domstolen\n\n### Skiljaktig mening\n\n#### Domskäl\n\nAvtalet är giltigt.\n\n### Domslut\n\nAvtalet är ogiltigt.';
  const evidence = selectEvidence(text, 'https://lagen.nu/dom/nja/2020s1042', { text: 'Avtalet är giltigt.' });
  assert.ok(evidence.passages.every(p => !p.text.includes('Avtalet är giltigt.')));
  assert.ok(evidence.passages.some(p => p.text.includes('Avtalet är ogiltigt.')));
});

test('PDF claims retain a complete cross-page sentence and its court attribution', () => {
  const blocks = [
    { id: 'page-1', label: 'PDF-sida 1', text: 'Vidare, i NJA 1995 s. 603, konstaterade Högsta domstolen att när borgensmannen ingår ett\n\nESKILSTUNA TINGSRÄTT Rotel 2:05\n\nINKOM: 2025-06-27 MÅLNR: T 667-25 AKTBIL: 26' },
    { id: 'page-2', label: 'PDF-sida 2', text: 'proprieborgensåtagande, gäller detta oberoende av gäldenärens betalningsförmåga och oavsett eventuella interna tvister eller obestyrkta delbetalningar.\n\nNästa stycke.' },
  ];
  const claim = claims(blocks)[0];
  assert.equal(claim.assessable, true);
  assert.equal(claim.authority, 'högsta domstolen');
  assert.equal(claim.requireConclusion, true);
  assert.match(claim.hypothesis, /^när borgensmannen ingår ett proprieborgensåtagande/);
  assert.match(claim.hypothesis, /obestyrkta delbetalningar\.$/);
  assert.doesNotMatch(claim.hypothesis, /INKOM|TINGSRÄTT|Nästa stycke/);
  assert.equal(claim.locations.length, 2);
  assert.equal(claim.occurrence.locations.length, 1);
  assert.equal(claims(blocks.slice(0, 1))[0].assessable, false);
});

test('the real PDFs pass through PDF.js, local extraction and claim preparation', async t => {
  const files = ['Eskilstuna TR T 667-25 Aktbil 26.pdf', 'Eskilstuna TR T 667-25 Aktbil 32.pdf', 'Eskilstuna TR T 667-25 Dom 2025-12-12.pdf'];
  try { await Promise.all(files.map(file => access(new URL(`../${file}`, import.meta.url)))); }
  catch { t.skip('Optional local court PDFs are absent; frozen excerpt regressions still run.'); return; }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const [index, file] of files.entries()) {
    const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(new URL(`../${file}`, import.meta.url))), isEvalSupported: false, useSystemFonts: true });
    try {
      const pdf = await task.promise;
      const blocks = [];
      for (let page = 1; page <= pdf.numPages; page++) blocks.push({ id: `page-${page}`, label: `PDF-sida ${page}`, text: pdfPageText((await (await pdf.getPage(page)).getTextContent()).items) });
      const extracted = claims(blocks);
      assert.ok(extracted.length >= 3, file);
      for (const claim of extracted) {
        assert.ok(claim.text.includes(claim.occurrence.text), `${file}: ${claim.occurrence.text}`);
        assert.doesNotMatch(claim.hypothesis, /CITATION/);
        for (const loc of claim.occurrence.locations) assert.equal(blocks.find(b => b.id === loc.block_id).text.slice(loc.start, loc.end), claim.occurrence.text);
      }
      if (index === 0) {
        const proprieborgen = extracted.find(c => c.occurrence.text.includes('4 § avtalslagen'));
        assert.ok(proprieborgen);
        assert.equal(proprieborgen.assessable, true);
        assert.match(proprieborgen.hypothesis, /^när en person åtar sig ett borgensåtagande 'som för egen skuld'/);
        assert.match(proprieborgen.hypothesis, /direkt från borgensmannen\.$/);
        const continuation = extracted.find(c => c.occurrence.text === 'NJA 1995 s. 603');
        assert.match(continuation.hypothesis, /obestyrkta delbetalningar\.$/);
        assert.equal(continuation.authority, 'högsta domstolen');
      } else if (index === 1) {
        const guarantee = extracted.filter(c => /handelsbalken|2013/.test(c.occurrence.text));
        assert.equal(guarantee.length, 2);
        assert.equal(guarantee[0].hypothesis, guarantee[1].hypothesis);
        assert.match(guarantee[0].hypothesis, /^Borgensåtagandet/);
        assert.doesNotMatch(guarantee[0].hypothesis, /NJA|§/);
        assert.match(guarantee[0].hypothesis, /utan att först behöva vidta åtgärder mot huvudgäldenären\.$/);
      } else {
        const orders = extracted.filter(c => c.occurrence.locations[0].block_id === 'page-3');
        assert.equal(orders.length, 6);
        assert.ok(orders.every(c => c.hypothesis.startsWith('Rana Daoud ska')));
        assert.ok(extracted.filter(c => /Rättsfallet.*finns inte|Inte heller rättsfallet/.test(c.text)).every(c => !c.assessable));
        assert.ok(extracted.filter(c => /påhittade eller helt felaktiga|alltjämt påhittade/.test(c.text)).every(c => !c.assessable));
      }
    } finally { await task.destroy(); }
  }
});
