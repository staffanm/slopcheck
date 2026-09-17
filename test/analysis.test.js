import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pasted from './fixtures/pasted-line-wrap.json' with { type: 'json' };
import { citationSegments, claimContext, classifyResolution, extractionText, invalidCitationMessage, normalizeQuote, occurrenceStatus, originalOccurrences, pdfPageText, provisionText, selectEvidence, validateBlocks } from '../src/analysis.js';
import { extract } from '../src/api.js';
import { extractLocal, getLocalParser } from '../src/lagrum-extract.js';

test('pasted chapter and provision stay together, with offsets in the original text', () => {
  for (const newline of ['\n', '\r\n', '\n     ', '\r\n\t']) {
    const text = '📄 Se avtalslagen.\n\n' + pasted.text.replace('\n', newline);
    const normalized = { id: 'text', ...extractionText(text) };
    const start = normalized.text.indexOf(pasted.normalizedCitation);
    assert.ok(start > 0);
    assert.match(normalized.text, /avtalslagen\.\n\nTingsrätten/);
    const [occurrence] = originalOccurrences([{
      text: pasted.normalizedCitation,
      locations: [{ block_id: 'text', start, end: start + pasted.normalizedCitation.length }],
      targets: [{ uri: pasted.target, source: 'sfs' }],
    }], [{ id: 'text', text }], [normalized]);
    assert.equal(occurrence.text, pasted.originalCitation.replace('\n', newline));
    assert.equal(occurrence.locations[0].start, text.indexOf('18 kap.'));
    assert.equal(occurrence.locations[0].end, text.indexOf('rättegångsbalken') + 'rättegångsbalken'.length);
    assert.equal(claimContext(occurrence, [{ id: 'text', text }]).text, pasted.text.replace('\n', newline));
  }
});

test('overlapping and cross-block references keep the complete original text', () => {
  const block = { id: 'one', text: '📄 18 kap. 7 § RB och mer.' };
  const occurrences = [
    { locations: [{ block_id: 'one', start: 3, end: 17 }] },
    { locations: [{ block_id: 'one', start: 11, end: 17 }] },
    { locations: [{ block_id: 'one', start: 21, end: 25 }, { block_id: 'two', start: 0, end: 5 }] },
  ];
  const segments = citationSegments(block, occurrences);
  assert.equal(segments.map(s => block.text.slice(s.start, s.end)).join(''), block.text);
  assert.deepEqual(segments.find(s => s.start === 11).rows, [0, 1]);
  assert.deepEqual(citationSegments({ id: 'two', text: 'text. Slut.' }, occurrences)[0].rows, [2]);
});

test('resolver uncertainty and failures never become authoritative invalidity', () => {
  const uri = 'https://lagen.nu/dom/nja/2026s99999';
  assert.equal(classifyResolution({ results: [], recognized: [{ uri }] }, uri), 'unconfirmed');
  assert.equal(classifyResolution({ results: [], recognized: [{ uri, invalid: true }] }, uri), 'invalid');
  assert.equal(classifyResolution({ results: [{ uri }], recognized: [] }, uri), 'found');
  assert.equal(occurrenceStatus([]), 'unconfirmed');
  assert.equal(occurrenceStatus([{ status: 'found' }, { status: 'invalid' }]), 'invalid');
  assert.equal(occurrenceStatus([{ status: 'found' }, { status: 'error' }]), 'error');
});

test('UTF-16 positions retain emoji, repeated occurrences, and citation abbreviations', () => {
  const text = '📄 Läs detta först. I NJA 2013 s. 372 anges att borgenären får kräva betalning direkt. Ett annat påstående.';
  const start = text.indexOf('NJA');
  const claim = claimContext({ text: 'NJA 2013 s. 372', locations: [{ block_id: 'page-12', start, end: start + 15 }] }, [{ id: 'page-12', text }]);
  assert.equal(claim.text, 'I NJA 2013 s. 372 anges att borgenären får kräva betalning direkt.');
  assert.equal(claim.assessable, true);
});

test('citation-only sentences use the preceding proposition', () => {
  const text = 'Ett sent svar ska räknas som ett nytt anbud. Se 4 § avtalslagen.';
  const start = text.indexOf('4 §');
  const claim = claimContext({ text: '4 § avtalslagen', locations: [{ block_id: 'text', start, end: start + '4 § avtalslagen'.length }] }, [{ id: 'text', text }]);
  assert.equal(claim.text, text);
});

test('claim context includes the complete wrapped sentence after a citation', () => {
  const text = 'I NJA 2013 s. 372 slog Högsta domstolen fast att\n  borgensmannen ansvarar för betalningen.\n\nNästa stycke.';
  const start = text.indexOf('NJA');
  const claim = claimContext({ text: 'NJA 2013 s. 372', locations: [{ block_id: 'text', start, end: start + 15 }] }, [{ id: 'text', text }]);
  assert.equal(claim.text, text.split('\n\n')[0]);
});

test('wrapped PDF lines keep chapter and paragraph in one citation; paragraphs remain separated', () => {
  const item = (str, y) => ({ str, transform: [1, 0, 0, 1, 60, y], height: 12 });
  assert.equal(pdfPageText([item('reglerna i 18 kap.', 700), item('7 § rättegångsbalken.', 684), item('Nästa stycke.', 650)]), 'reglerna i 18 kap. 7 § rättegångsbalken.\n\nNästa stycke.');
});

const markdown = '# Avtalslagen\n\n## [1 kap.](https://lagen.nu/1915:218#K1) Avtal\n\n**3 §** Ett annat lagrum.\n\n**4 §** Antagande svar, som för sent kommer anbudsgivaren till handa, skall gälla såsom nytt anbud.\n\nAndra stycket i samma paragraf.\n\n**5 §** En annan regel.';

test('provision evidence excludes adjacent provisions, including multi-paragraph text', () => {
  const scope = provisionText(markdown, 'https://lagen.nu/1915:218#P4');
  assert.equal(scope.exact, true);
  assert.match(scope.text, /Andra stycket/);
  assert.doesNotMatch(scope.text, /En annan regel|Ett annat lagrum/);
  assert.equal(provisionText(markdown, 'https://lagen.nu/1915:218#K12P1').exact, false);
});

test('quote matching and ranking remain separate from semantic support', () => {
  const evidence = selectEvidence(markdown, 'https://lagen.nu/1915:218#P4', { text: 'Här står ”Antagande svar, som för sent kommer anbudsgivaren till handa, skall gälla såsom nytt anbud.”', assessable: true });
  assert.equal(evidence.quote, true);
  assert.equal(evidence.exact, true);
  assert.equal(evidence.passages.length, 2);
  assert.match(evidence.passages[0].text, /^4 § Antagande/);
  assert.equal(evidence.passages[1].quote, false);
  assert.ok(evidence.passages.every(p => p.text.length <= 1400));
  assert.equal(normalizeQuote('”borgens-\nmannen”  får'), 'borgensmannen får');
});

test('empty, oversized, and excessive block input fail before the API request', () => {
  assert.throws(() => validateBlocks([{ text: '   ' }]), /OCR/);
  assert.throws(() => validateBlocks([{ text: 'x'.repeat(250001) }]), /250 000/);
  assert.throws(() => validateBlocks(Array.from({ length: 5001 }, () => ({ text: 'x' }))), /5 000/);
  assert.doesNotThrow(() => validateBlocks([{ text: '📄'.repeat(250000) }]));
});

test('extractLocal extracts citations locally with accurate original locations and targets', () => {
  const text = '📄 Se 18 kap.\n7 § rättegångsbalken och NJA 2013 s. 372.';
  const blocks = [{ id: 'block-1', text }];
  const occurrences = extractLocal(blocks);

  assert.equal(occurrences.length, 2);
  assert.equal(occurrences[0].text, '18 kap.\n7 § rättegångsbalken');
  assert.equal(occurrences[0].locations[0].block_id, 'block-1');
  assert.equal(occurrences[0].locations[0].start, text.indexOf('18 kap.'));
  assert.equal(occurrences[0].locations[0].end, text.indexOf('rättegångsbalken') + 'rättegångsbalken'.length);
  assert.deepEqual(occurrences[0].targets, [
    { uri: 'https://lagen.nu/1942:740#K18P7', source: 'sfs' },
  ]);

  assert.equal(occurrences[1].text, 'NJA 2013 s. 372');
  assert.equal(occurrences[1].locations[0].start, text.indexOf('NJA'));
  assert.equal(occurrences[1].locations[0].end, text.indexOf('372') + 3);
  assert.deepEqual(occurrences[1].targets, [
    { uri: 'https://lagen.nu/dom/nja/2013s372', source: 'dv' },
  ]);
});

test('extract in local privacy mode operates without network request', async () => {
  const blocks = [{ id: 'text', text: 'I 36 § avtalslagen regleras oskäliga avtalsvillkor.' }];
  const occurrences = await extract(blocks, null, { local: true });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].text, '36 § avtalslagen');
  assert.deepEqual(occurrences[0].targets, [
    { uri: 'https://lagen.nu/1915:218#P36', source: 'sfs' },
  ]);
});

test('extractLocal matches all frozen extraction cases in test/files/resolve/extraction.json', (t) => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let ferendaRoot = path.resolve(dir, '../../ferenda');
  if (!fs.existsSync(ferendaRoot)) {
    ferendaRoot = path.resolve(dir, '../..');
  }
  const fixturePath = path.join(ferendaRoot, 'test/files/resolve/extraction.json');
  if (!fs.existsSync(fixturePath)) {
    t.skip('Ferenda extraction.json fixture not found');
    return;
  }
  const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  for (const item of cases) {
    const occurrences = extractLocal([{ id: 'text', text: item.text }]);
    const got = occurrences.map(occurrence => [
      occurrence.text,
      occurrence.targets.map(target => target.uri.replace('https://lagen.nu/', '')),
    ]);
    assert.deepEqual(got, item.matches, `Mismatch in case: ${item.text}`);
    for (const occurrence of occurrences) {
      assert.equal(occurrence.locations.length, 1);
      const loc = occurrence.locations[0];
      assert.equal(loc.block_id, 'text');
      assert.equal(item.text.slice(loc.start, loc.end), occurrence.text);
    }
  }
});

test('extractLocal resets the singleton parser and does not retain document text', () => {
  const longText = 'NJA 2013 s. 372 '.repeat(1000);
  extractLocal([{ id: 'text', text: longText }]);
  const parser = getLocalParser();
  assert.equal(parser._scan_text.length, 0);
  assert.equal(parser.state.namedlaws.size, 0);
});

test('extract in local privacy mode throws when aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const blocks = [{ id: 'text', text: 'Se 36 § avtalslagen.' }];
  await assert.rejects(
    () => extract(blocks, controller.signal, { local: true }),
    { name: 'AbortError' }
  );
});

test('invalidCitationMessage provides adapted Swedish error messages for nonexistent sources', () => {
  assert.equal(
    invalidCitationMessage({ uri: 'https://lagen.nu/dom/nja/2013s372', source: 'dv' }, { text: 'NJA 2013 s. 372' }),
    'Det finns inget rättsfall betecknat NJA 2013 s. 372.'
  );
  assert.equal(
    invalidCitationMessage({ uri: 'https://lagen.nu/1915:218#K12P1', source: 'sfs' }, { text: '12 kap. 1§ avtalslagen' }),
    'Det finns ingen 12 kap. 1 § i avtalslagen.'
  );
  assert.equal(
    invalidCitationMessage({ uri: 'https://lagen.nu/1915:218#K1P12', source: 'sfs' }, { text: '1 kap. 12 § i avtalslagen' }),
    'Det finns ingen 1 kap. 12 § i avtalslagen.'
  );
  assert.equal(
    invalidCitationMessage({ uri: 'https://lagen.nu/2052:1506', source: 'sfs' }, { text: 'cybersäkerhetslagen (2052:1506)' }),
    'Det finns ingen lag som heter cybersäkerhetslagen (2052:1506).'
  );
  assert.equal(
    invalidCitationMessage({ uri: 'https://lagen.nu/2052:1506', source: 'sfs' }, { text: 'SFS 2052:1506' }),
    'Det finns ingen författning med beteckningen SFS 2052:1506.'
  );
});

test('claimContext does not split on abbreviations such as t.ex. and bl.a.', () => {
  const text = '1. Rättslig grund Borgensåtagandet i förevarande mål utgör en proprieborgen, vilket enligt 10 kap. 9 § handelsbalken och rättspraxis (t.ex. NJA 2013 s. 372) innebär att borgenären har rätt att kräva betalning. Nästa mening.';
  const start = text.indexOf('10 kap. 9 § handelsbalken');
  const claim = claimContext({ text: '10 kap. 9 § handelsbalken', locations: [{ block_id: 'text', start, end: start + '10 kap. 9 § handelsbalken'.length }] }, [{ id: 'text', text }]);
  assert.match(claim.text, /innebär att borgenären har rätt att kräva betalning\.$/);
  assert.doesNotMatch(claim.text, /Nästa mening/);
});


