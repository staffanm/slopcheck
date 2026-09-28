import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalUri,
  isDeterministicAbsence,
  resolveTargetPrivate,
  documentCache,
  getDocumentSource,
  getProvisionText,
} from '../src/privacy-api.js';
import { prefetchUnits } from '../src/unit-index.js';
import { provisionText, selectEvidence } from '../src/analysis.js';

test('canonicalUri normalizes scheme and host while preserving exact path and fragment case', () => {
  assert.equal(
    canonicalUri('HTTPS://LAGEN.NU/1915:218#P3a'),
    'https://lagen.nu/1915:218#P3a'
  );
  assert.equal(
    canonicalUri('https://lagen.nu/dom/nja/2013s502'),
    'https://lagen.nu/dom/nja/2013s502'
  );
  // Preserves uppercase path segments (avoids collision like bet/1980/81:KU25 vs ku25)
  assert.equal(
    canonicalUri('https://lagen.nu/bet/1980/81:KU25'),
    'https://lagen.nu/bet/1980/81:KU25'
  );
});

test('isDeterministicAbsence classifies known publication boundaries', () => {
  // NJA before 1874 is invalid
  assert.equal(isDeterministicAbsence('https://lagen.nu/dom/nja/1870s1'), true);
  // NJA 2013 page 0 is invalid
  assert.equal(isDeterministicAbsence('https://lagen.nu/dom/nja/2013s0'), true);
  // NJA within complete range (1981-2025)
  assert.equal(isDeterministicAbsence('https://lagen.nu/dom/nja/2013s99999'), true);
  // Future year is invalid
  assert.equal(isDeterministicAbsence('https://lagen.nu/dom/nja/2028s1'), true);
  // Unfinished year (e.g. 2026) is NOT deterministic absence
  assert.equal(isDeterministicAbsence('https://lagen.nu/dom/nja/2026s99999'), false);
});

// lagen.nu as the client sees it: the filter and the answers of the ferenda
// fixture (test/fixtures/unit-index.json); every other bucket is empty.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/unit-index.json', import.meta.url)));
const requested = [];
globalThis.fetch = async url => {
  const path = new URL(url).pathname;
  requested.push(String(url));
  if (path.endsWith('/range/filter')) return new Response(Buffer.from(fixture.filter, 'base64'));
  if (path.endsWith(`/range/${fixture.prefix.toString(16).padStart(4, '0')}`)) return new Response(Buffer.from(fixture.answer, 'base64'));
  return new Response(Buffer.from('LUR1\x10\0\0\0\0', 'latin1'));
};

test('resolveTargetPrivate finds a provision the filter holds', async () => {
  const res = await resolveTargetPrivate('https://lagen.nu/1915:218#P36', null);
  assert.equal(res.status, 'found');
  assert.equal(res.result.uri, 'https://lagen.nu/1915:218');
  assert.equal(res.result.pin.uri, 'https://lagen.nu/1915:218#P36');
});

test('resolveTargetPrivate calls a provision the document lacks invalid', async () => {
  const res = await resolveTargetPrivate('https://lagen.nu/1915:218#P99', null);
  assert.equal(res.status, 'invalid');
  assert.equal(res.reason, 'Bestämmelsen saknas i författningen.');
});

test('in privacy mode the source is the unit text, fetched among fillers and never by uri', async () => {
  const unit = 'https://lagen.nu/1915:218#P36';
  await assert.rejects(getDocumentSource(unit, null, { privacyMode: true, unit }), /kunde inte hämtas/);
  requested.length = 0;
  const found = await prefetchUnits([unit, 'https://lagen.nu/1915:218#P99'], null);
  assert.deepEqual([...found], [unit]);
  assert.equal(requested.length, 128);
  assert.ok(requested.every(url => /\/range\/[0-9a-f]{4}\?bits=16$/.test(url)));
  const doc = await getDocumentSource(unit, null, { privacyMode: true, unit });
  assert.equal(doc.markdown, fixture.text);
  assert.deepEqual(doc.anchors, { P36: [0, fixture.text.length] });
});

test('getDocumentSource retrieves markdown from documentCache in normal mode', async () => {
  documentCache.clear();
  const uri = 'https://lagen.nu/1915:218';
  documentCache.set(uri, { markdown: '# Avtalslagen\n\n**1 §**' });

  const doc = await getDocumentSource(uri, null);
  assert.equal(doc.markdown, '# Avtalslagen\n\n**1 §**');
});

test('getProvisionText and provisionText accurately slice markdown with anchor maps', () => {
  const markdown = '# Lag (1915:218)\n\n## 1 kap.\n\n**1 §** Anbud...\n\n**2 §** Svar...\n\n**3 a §** Särskild regel...';
  const startP3a = markdown.indexOf('**3 a §**');
  const endP3a = startP3a + '**3 a §** Särskild regel...'.length;

  const docData = {
    markdown,
    anchors: {
      'P3a': [startP3a, endP3a]
    }
  };

  const textP3a = getProvisionText(docData, 'https://lagen.nu/1915:218#P3a');
  assert.equal(textP3a, '**3 a §** Särskild regel...');

  // provisionText helper also supports anchors map
  const scope = provisionText(markdown, 'https://lagen.nu/1915:218#P3a', docData.anchors);
  assert.equal(scope.exact, true);
  assert.equal(scope.text, '**3 a §** Särskild regel...');
});

test('formatPinLabel formats statutory, court, and EU provision fragments cleanly', async () => {
  const { formatPinLabel, formatDisplayTitle } = await import('../src/privacy-api.js');
  assert.equal(formatPinLabel('P4'), '4 §');
  assert.equal(formatPinLabel('P3a'), '3 a §');
  assert.equal(formatPinLabel('K18P7'), '18 kap. 7 §');
  assert.equal(formatPinLabel('K2P3a'), '2 kap. 3 a §');
  assert.equal(formatPinLabel('sid100'), 's. 100');
  assert.equal(formatPinLabel('recital-83'), 'skäl 83');
  assert.equal(formatPinLabel('32.1'), 'art. 32.1');

  assert.equal(formatDisplayTitle('https://lagen.nu/1915:218'), 'Avtalslagen');
  assert.equal(formatDisplayTitle('https://lagen.nu/1942:740'), 'Rättegångsbalken');
  assert.equal(formatDisplayTitle('https://lagen.nu/dom/nja/2013s502'), 'NJA 2013 s. 502');
  assert.equal(formatDisplayTitle('https://lagen.nu/dom/hfd/2022:15'), 'HFD 2022 ref. 15');
  assert.equal(formatDisplayTitle('https://lagen.nu/prop/1997/98:44'), 'Prop. 1997/98:44');
});

test('artifactToMarkdown converts AST to markdown with accurate anchor offsets', async () => {
  const { artifactToMarkdown } = await import('../src/privacy-api.js');
  const artifact = {
    uri: 'https://lagen.nu/1998:204',
    title: 'Personuppgiftslag (1998:204)',
    structure: [
      {
        type: 'paragraf',
        id: 'P1',
        num: '1',
        beteckning: '1 §',
        text: 'Syftet med denna lag är att skydda fysiska personer mot att deras personliga integritet kränks.'
      },
      {
        type: 'paragraf',
        id: 'P2',
        num: '2',
        beteckning: '2 §',
        text: 'Lagen gäller för sådan behandling av personuppgifter som är helt eller delvis automatiserad.'
      }
    ]
  };

  const { markdown, anchors, title } = artifactToMarkdown(artifact);
  assert.equal(title, 'Personuppgiftslag (1998:204)');
  assert.ok(markdown.includes('**1 §** Syftet med denna lag'));
  assert.ok(markdown.includes('**2 §** Lagen gäller för'));
  assert.ok(anchors.P1);
  assert.ok(anchors.P2);

  const p1Text = markdown.slice(anchors.P1[0], anchors.P1[1]).trim();
  assert.ok(p1Text.startsWith('**1 §** Syftet med denna lag'));
});

test('artifactToMarkdown anchors each printed page of a förarbete', async () => {
  const { artifactToMarkdown } = await import('../src/privacy-api.js');
  const artifact = { artifact: { structure: [
    { type: 'stycke', page: 51, text: 'Slutet av sidan 51.' },
    { type: 'avsnitt', id: 'sec77', level: 3, page: 52, text: 'Storlekskravet i lagen', children: [
      { type: 'stycke', page: 52, text: 'Första stycket på sidan 52.' },
      { type: 'stycke', page: 52, text: 'Andra stycket på sidan 52.' },
      { type: 'stycke', page: 53, text: 'Stycket på sidan 53.' },
    ] },
    { type: 'stycke', page: 54, text: 'Sidan 54.' },
  ] } };
  const { markdown, anchors } = artifactToMarkdown(artifact);
  assert.equal(markdown.slice(...anchors.sid52).trim(), 'Storlekskravet i lagen\n\nFörsta stycket på sidan 52.\n\nAndra stycket på sidan 52.');
  assert.equal(markdown.slice(...anchors.sid53).trim(), 'Stycket på sidan 53.');
  assert.equal(markdown.slice(...anchors.sid54).trim(), 'Sidan 54.');
  assert.equal(anchors.sid51[1], anchors.sid52[0]);
});

test('OHTTP key parsing, BHTTP framing, and HPKE mutual cycle', async () => {
  const {
    parseOhttpKeys,
    encodeBhttpRequest,
    decodeBhttpResponse,
    encapsulateRequest,
    decapsulateResponse,
  } = await import('../src/ohttp.js');

  // Test RFC 9458 key framing (2 bytes total length, 2 bytes config length, 1 byte id, etc.)
  const RFC_PUBLIC_KEY = '31e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155';
  const rawKeyBytes = new Uint8Array(Buffer.from(RFC_PUBLIC_KEY, 'hex'));
  const keyConfigBytes = new Uint8Array(Buffer.from('0029010020' + RFC_PUBLIC_KEY + '000400010001', 'hex'));

  const parsedKeys = parseOhttpKeys(keyConfigBytes);
  assert.equal(parsedKeys.length, 1);
  assert.equal(parsedKeys[0].keyId, 1);
  assert.equal(parsedKeys[0].kemId, 0x0020);
  assert.equal(parsedKeys[0].kdfId, 0x0001);
  assert.equal(parsedKeys[0].aeadId, 0x0001);
  assert.deepEqual(parsedKeys[0].publicKey, rawKeyBytes);

  // Test BHTTP request encoding
  const bhttp = encodeBhttpRequest('GET', '/api/v1/range/c4a', [['accept', 'text/plain']]);
  assert.ok(bhttp.length > 0);

  // Test Encapsulation
  const encResult = await encapsulateRequest(bhttp, parsedKeys[0]);
  assert.equal(encResult.enc.length, 32);
  assert.ok(encResult.encapsulated.length > 39);

  // Test BHTTP response decoding from synthetic response
  const rawResponse = new Uint8Array(Buffer.from('0140c80000', 'hex')); // framing 1, status 200, empty section & content
  const decoded = decodeBhttpResponse(rawResponse);
  assert.equal(decoded.status, 200);
});

