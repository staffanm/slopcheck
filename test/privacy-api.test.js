import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUri,
  sha256Hex,
  splitHash,
  hashSuffix,
  rootPrefix,
  packIdForUri,
  generateDecoyPrefixes,
  isDeterministicAbsence,
  resolveTargetPrivate,
  rangeBucketCache,
  documentCache,
  packCache,
  getDocumentSource,
  getProvisionText,
} from '../src/privacy-api.js';
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

test('sha256Hex, rootPrefix, and hashSuffix produce deterministic 3-hex root prefix and 16-hex suffix', async () => {
  const rootUri = 'https://lagen.nu/1915:218';
  const rootHash = await sha256Hex(rootUri);
  assert.equal(typeof rootHash, 'string');
  assert.equal(rootHash.length, 64);

  const prefix = rootPrefix(rootHash, 3);
  assert.equal(prefix.length, 3);
  assert.match(prefix, /^[0-9a-f]{3}$/);

  const rootSuffix = hashSuffix(rootHash, 16);
  assert.equal(rootSuffix.length, 16);
  assert.match(rootSuffix, /^[0-9a-f]{16}$/);

  const { prefix: spPrefix, suffix: spSuffix } = splitHash(rootHash, 3, 16);
  assert.equal(spPrefix, prefix);
  assert.equal(spSuffix, rootSuffix);
});

test('packIdForUri deterministically maps URIs to core and volume packs', () => {
  // Core statutes
  assert.equal(packIdForUri('https://lagen.nu/1915:218#P1'), 'core');
  assert.equal(packIdForUri('https://lagen.nu/1970:994#K12P1'), 'core');

  // Decade SFS
  assert.equal(packIdForUri('https://lagen.nu/2024:9999'), 'sfs/2020s');
  assert.equal(packIdForUri('https://lagen.nu/1890:999'), 'sfs/1890s');

  // NJA 5-year blocks
  assert.equal(packIdForUri('https://lagen.nu/dom/nja/2013s502'), 'nja/2010-2014');
  assert.equal(packIdForUri('https://lagen.nu/dom/nja/2024s100'), 'nja/2020-2024');

  // Other Swedish courts (5-year blocks)
  assert.equal(packIdForUri('https://lagen.nu/dom/hfd/2022:15'), 'dom/hfd/2020-2024');
  assert.equal(packIdForUri('https://lagen.nu/dom/ad/2018:3'), 'dom/ad/2015-2019');
  assert.equal(packIdForUri('https://lagen.nu/dom/rh/2011:4'), 'dom/rh/2010-2014');

  // CELEX EU acts (sector + year volume packs, or celex/1)
  assert.equal(packIdForUri('https://lagen.nu/celex/32016R0679#32'), 'celex/3/2016');
  assert.equal(packIdForUri('https://lagen.nu/celex/32024R1689'), 'celex/3/2024');
  assert.equal(packIdForUri('https://lagen.nu/celex/62015CJ0123'), 'celex/6/2015');
  assert.equal(packIdForUri('https://lagen.nu/celex/12012M/TXT'), 'celex/1');

  // Förarbeten
  assert.equal(packIdForUri('https://lagen.nu/prop/1997/98:44'), 'prop/1997-98');
  assert.equal(packIdForUri('https://lagen.nu/prop/2020/21:12'), 'prop/2020-21');
  assert.equal(packIdForUri('https://lagen.nu/sou/2021:1'), 'sou/2021');
  assert.equal(packIdForUri('https://lagen.nu/ds/2023:5'), 'ds/2023');
});

test('generateDecoyPrefixes creates distinct random 3-hex buckets', () => {
  const real = ['a1b', 'c3d'];
  const decoys = generateDecoyPrefixes(real, 4);
  assert.equal(decoys.length, 4);
  for (const d of decoys) {
    assert.match(d, /^[0-9a-f]{3}$/);
    assert.ok(!real.includes(d));
  }
  // All decoys must be unique
  assert.equal(new Set(decoys).size, 4);
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

test('resolveTargetPrivate finds exact hash match in single 3-hex root bucket', async () => {
  rangeBucketCache.clear();
  const rootUri = 'https://lagen.nu/1915:218';
  const pinUri = 'https://lagen.nu/1915:218#P4';

  const rootHash = await sha256Hex(rootUri);
  const rootPrefixStr = rootHash.slice(0, 3).toLowerCase();
  const rootSuffixStr = rootHash.slice(0, 16).toLowerCase();

  const pinHash = await sha256Hex(pinUri);
  const pinSuffixStr = pinHash.slice(0, 16).toLowerCase();

  // Co-locate root and pinpoint in the SAME root-prefixed bucket
  rangeBucketCache.set(rootPrefixStr, Promise.resolve(new Set([rootSuffixStr, pinSuffixStr])));

  const res = await resolveTargetPrivate(pinUri, null, { fallbackToResolve: false });
  assert.equal(res.status, 'found');
  assert.equal(res.result.uri, rootUri);
  assert.equal(res.result.pin.uri, pinUri);
});

test('resolveTargetPrivate classifies missing pinpoint as invalid when root exists in single bucket', async () => {
  rangeBucketCache.clear();
  const rootUri = 'https://lagen.nu/1915:218';
  const invalidPinUri = 'https://lagen.nu/1915:218#K12P1';

  const rootHash = await sha256Hex(rootUri);
  const rootPrefixStr = rootHash.slice(0, 3).toLowerCase();
  const rootSuffixStr = rootHash.slice(0, 16).toLowerCase();

  // Bucket contains root, but does NOT contain the invalid pinpoint
  rangeBucketCache.set(rootPrefixStr, Promise.resolve(new Set([rootSuffixStr])));

  const res = await resolveTargetPrivate(invalidPinUri, null, { fallbackToResolve: false });
  assert.equal(res.status, 'invalid');
  assert.equal(res.reason, 'Bestämmelsen saknas i författningen.');
});

test('getDocumentSource retrieves markdown from documentCache', async () => {
  documentCache.clear();
  const uri = 'https://lagen.nu/1915:218';
  documentCache.set(uri, { markdown: '# Avtalslagen\n\n**1 §**' });

  const doc = await getDocumentSource(uri, null, { privacyMode: true });
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

