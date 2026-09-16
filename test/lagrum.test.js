import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EMDRATTSFALL,
  ENGLAGRUM,
  EULAGSTIFTNING,
  EURATTSFALL,
  FORARBETEN,
  LAGRUM,
  LagrumParser,
  MALNUMMER,
  RATTSFALL,
} from '../src/lagrum/lagrum.js';
import {
  ABBREVIATIONS_DATA,
  NAMEDACTS_DATA,
  NAMEDLAWS_DATA,
} from '../src/lagrum/datasets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let TESTROOT = path.resolve(__dirname, '../../ferenda/test/files/legalref');
if (!fs.existsSync(TESTROOT)) {
  TESTROOT = path.resolve(__dirname, '../../test/files/legalref');
}
const decoder = new TextDecoder('windows-1252');

const OLD_BROKEN = new Set([
  'sfs-tricky-bokstavslista',
  'sfs-tricky-eller',
  'sfs-tricky-eller-paragrafer-stycke',
  'sfs-tricky-overgangsbestammelse',
  'sfs-tricky-uppdelat-lagnamn',
  'sfs-tricky-vvfs',
]);

function expectedUris(want) {
  const matches = [];
  const re = /<Link uri="([^"]+)"/g;
  let m;
  while ((m = re.exec(want)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

function normalizeSpace(s) {
  return (s || '').trim().split(/\s+/).join(' ');
}

function runTestfile(filePath, abbreviations = null, parseTypes = null) {
  const raw = decoder.decode(fs.readFileSync(filePath));
  const parts = raw.split(/\r?\n\r?\n/);
  const testdata = parts[0];
  const want = parts.length > 1 ? parts[1].trim() : '';

  const parser = new LagrumParser(NAMEDLAWS_DATA, {
    basefile: '9999:999',
    abbreviations,
    parse_types: parseTypes,
  });

  const got = [];
  const paras = testdata.split(/\r?\n---\r?\n/);
  for (let para of paras) {
    let context = { law: '9999:999' };
    if (para.startsWith('RESET:')) {
      parser.state.namedlaws.clear();
    } else if (para.startsWith('NOBASE:')) {
      context = {};
    } else if (para.startsWith('BASE:')) {
      const splitIdx = para.indexOf('\n');
      const head = para.slice(0, splitIdx);
      para = para.slice(splitIdx + 1);
      const dictStr = head.slice(head.indexOf(':') + 1).trim();
      context = (0, eval)('(' + dictStr + ')');
    }
    const refs = parser.parse_text(normalizeSpace(para), context);
    for (const ref of refs) {
      got.push(ref.uri);
    }
  }
  return { got, want: expectedUris(want) };
}

describe('Legalref Fixtures', { skip: !fs.existsSync(TESTROOT) ? 'legalref fixtures not found' : false }, () => {
  describe('SFS fixtures', () => {
    const dir = path.join(TESTROOT, 'SFS');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();
    for (const file of files) {
      const stem = path.basename(file, '.txt');
      const isXfail = OLD_BROKEN.has(stem);
      it(stem, { skip: isXfail ? 'unresolved reference expectation' : false }, () => {
        const { got, want } = runTestfile(path.join(dir, file));
        assert.deepEqual(got, want);
      });
    }
  });

  describe('EGLag fixtures', () => {
    const dir = path.join(TESTROOT, 'EGLag');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();
    for (const file of files) {
      const stem = path.basename(file, '.txt');
      it(stem, () => {
        const { got, want } = runTestfile(path.join(dir, file));
        assert.deepEqual(got, want);
      });
    }
  });

  describe('Short fixtures', () => {
    const dir = path.join(TESTROOT, 'Short');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();
    for (const file of files) {
      const stem = path.basename(file, '.txt');
      it(stem, () => {
        const { got, want } = runTestfile(path.join(dir, file), ABBREVIATIONS_DATA);
        assert.deepEqual(got, want);
      });
    }
  });

  describe('DV fixtures', () => {
    const dir = path.join(TESTROOT, 'DV');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();
    for (const file of files) {
      const stem = path.basename(file, '.txt');
      it(stem, () => {
        const { got, want } = runTestfile(path.join(dir, file), null, [RATTSFALL]);
        assert.deepEqual(got, want);
      });
    }
  });

  describe('Regpubl fixtures', () => {
    const dir = path.join(TESTROOT, 'Regpubl');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();
    for (const file of files) {
      const stem = path.basename(file, '.txt');
      it(stem, () => {
        const { got, want } = runTestfile(path.join(dir, file), null, [FORARBETEN]);
        assert.deepEqual(got, want);
      });
    }
  });
});

describe('Lagrum Unit Tests', () => {
  it('optional space before section mark', () => {
    const cases = [
      ['1§ avtalslagen', ['1915:218#P1']],
      ['12 kap. 1§ avtalslagen', ['1915:218#K12P1']],
      ['1 a§ avtalslagen', ['1915:218#P1a']],
      ['1–3§§ avtalslagen', ['1915:218#P1', '1915:218#P3', '1915:218']],
      ['1 och 3§§ avtalslagen', ['1915:218#P1', '1915:218#P3', '1915:218']],
      ['1 a–3 b§§ avtalslagen', ['1915:218#P1a', '1915:218#P3b', '1915:218']],
      ['3§ BrB', ['1962:700#P3']],
      ['BrB 3§', ['1962:700#P3']],
      ['BrB 3 a§', ['1962:700#P3a']],
      ['1–3§§ BrB', ['1962:700#P1', '1962:700#P3']],
      ['1§ första stycket avtalslagen', ['1915:218#P1S1']],
    ];
    for (const space of ['', ' ', '\u00a0', '\u202f']) {
      for (const [tpl, expected] of cases) {
        const text = tpl.replace(/(?<!§)§/g, space + '§');
        const parser = new LagrumParser(NAMEDLAWS_DATA, {
          basefile: '9999:999',
          abbreviations: ABBREVIATIONS_DATA,
        });
        const refs = parser.parse_text(text, {});
        assert.deepEqual(refs.map(r => r.uri), expected.map(u => 'https://lagen.nu/' + u));
        assert.ok(refs.every(r => r.text === text.slice(r.start, r.end)));
      }
    }
  });

  it('rättsfall narrow nbsp', () => {
    const parser = new LagrumParser({}, { basefile: 'dom', parse_types: [RATTSFALL] });
    const refs = parser.parse_text('HD har i rättsfallet NJA 1991 s.\u202f567 uttalat, jfr NJA\u00a02012 s.\u202f725.');
    assert.deepEqual(refs.map(r => r.uri), [
      'https://lagen.nu/dom/nja/1991s567',
      'https://lagen.nu/dom/nja/2012s725',
    ]);
    assert.equal(refs[0].text, 'NJA 1991 s.\u202f567');
  });

  it('SÖ reference links Sveriges överenskommelser', () => {
    const parser = new LagrumParser({}, { basefile: 'x', parse_types: [FORARBETEN] });
    const refs = parser.parse_text('den europeiska utlämningskonventionen (se SÖ 1982:50 och SÖ 1959:65).');
    assert.deepEqual(refs.map(r => [r.text, r.uri]), [
      ['SÖ 1982:50', 'https://lagen.nu/so/1982:50'],
      ['SÖ 1959:65', 'https://lagen.nu/so/1959:65'],
    ]);
  });

  it('anonymous law ref is one pinpointed link', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, { basefile: '9999:999', parse_types: [LAGRUM] });
    const refs = parser.parse_text(
      'organ som avses i 1 kap. 18 § lagen (2016:1145) om offentlig upphandling,',
      {}
    );
    assert.deepEqual(refs.map(r => [r.uri, r.text]), [
      ['https://lagen.nu/2016:1145#K1P18', '1 kap. 18 § lagen (2016:1145)'],
    ]);
  });

  it('eurattsfall cases', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, { basefile: 'x', parse_types: [EURATTSFALL] });
    const cases = [
      ['In Case C-176/09 the court', 'https://lagen.nu/celex/62009CJ0176'],
      ['mål C-197/09 RX-II,', 'https://lagen.nu/celex/62009CJ0197'],
      ['By order in Case F-23/07', 'https://lagen.nu/celex/62007FJ0023'],
      ['i mål T-201/04', 'https://lagen.nu/celex/62004TJ0201'],
      ['C-176/09', 'https://lagen.nu/celex/62009CJ0176'],
      ['Case C\u2011197/09', 'https://lagen.nu/celex/62009CJ0197'],
    ];
    for (const [text, uri] of cases) {
      assert.deepEqual(parser.parse_text(text, {}).map(r => r.uri), [uri]);
    }
  });

  it('eurattsfall old numbering', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, { basefile: 'x', parse_types: [EURATTSFALL] });
    assert.deepEqual(
      parser.parse_text('in Case 31/87, REFERENCE to the Court', {}).map(r => r.uri),
      ['https://lagen.nu/celex/61987CJ0031']
    );
    assert.deepEqual(
      parser.parse_text('se mål 45/87, Dundalk', {}).map(r => r.uri),
      ['https://lagen.nu/celex/61987CJ0045']
    );
    assert.deepEqual(parser.parse_text('delivered on 31/87 items', {}), []);
  });

  it('eulagstiftning english surface', () => {
    const parser = new LagrumParser({}, {
      basefile: 'celex',
      parse_types: [EULAGSTIFTNING],
      lang: 'eng',
    });
    const cases = [
      ['Council Directive 71/305/EEC of 26 July 1971 is intended to secure', ['https://lagen.nu/celex/31971L0305']],
      ['Article 29 (5) of Directive 71/305/EEC provides', ['https://lagen.nu/celex/31971L0305#29.5']],
      ['As stated in Article 1(2) of Directive 92/50/EEC.', ['https://lagen.nu/celex/31992L0050#1.2']],
      ['Regulation (EEC) No 2092/91 applies.', ['https://lagen.nu/celex/31991R2092']],
      ['Commission Recommendation 2003/361/EC', ['https://lagen.nu/celex/32003H0361']],
      ['Article 177 of the EEC Treaty by the Raad van State', []],
      ['Recital 19 of Directive 71/305/EEC states', [
        'https://lagen.nu/celex/31971L0305#recital-19',
        'https://lagen.nu/celex/31971L0305',
      ]],
      ['Recital 19 and Article 29 (5) of Directive 71/305/EEC provide', [
        'https://lagen.nu/celex/31971L0305#recital-19',
        'https://lagen.nu/celex/31971L0305#29.5',
      ]],
      ['Regulation (EEC) No 2092/91 applies. See recital 4 of the regulation.', [
        'https://lagen.nu/celex/31991R2092',
        'https://lagen.nu/celex/31991R2092#recital-4',
        'https://lagen.nu/celex/31991R2092',
      ]],
      ['The court gave recital 5 no weight.', []],
    ];
    for (const [text, uris] of cases) {
      assert.deepEqual(parser.parse_text(text, {}).map(r => r.uri), uris);
    }
  });

  it('english anaphora links directive and bare articles', () => {
    const parser = new LagrumParser({}, {
      basefile: 'celex',
      parse_types: [EULAGSTIFTNING],
      lang: 'eng',
    });
    parser.parse_text('Council Directive 71/305/EEC of 26 July 1971 concerns public works contracts.', {});
    const got = parser.parse_text('Under Articles 20 and 26 of the directive, criteria are laid down.', {});
    assert.deepEqual(got.map(r => r.uri), [
      'https://lagen.nu/celex/31971L0305#20',
      'https://lagen.nu/celex/31971L0305#26',
    ]);
    const bare = parser.parse_text('Article 29 provides for that examination.', {});
    assert.deepEqual(bare.map(r => r.uri), ['https://lagen.nu/celex/31971L0305#29']);
  });

  it('eulagstiftning celex minting', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, { basefile: 'x', parse_types: [EULAGSTIFTNING] });
    const cases = [
      ['Europaparlamentets och rådets direktiv (EU) 2016/1148', 'https://lagen.nu/celex/32016L1148'],
      ['Europaparlamentets och rådets förordning (EU) 2016/679', 'https://lagen.nu/celex/32016R0679'],
      ['Europaparlamentets och rådets direktiv (EU) 2022/2555', 'https://lagen.nu/celex/32022L2555'],
      ['rådets direktiv 85/337/EEG', 'https://lagen.nu/celex/31985L0337'],
      ['Europaparlamentets och rådets direktiv 95/46/EG', 'https://lagen.nu/celex/31995L0046'],
      ['rådets förordning (EEG) nr 1234/85', 'https://lagen.nu/celex/31985R1234'],
      ['ändras genom direktiv (EU) 2022/2555 och', 'https://lagen.nu/celex/32022L2555'],
      ['som avses i direktiv (EU) 2018/1808', 'https://lagen.nu/celex/32018L1808'],
      ['enligt förordning (EU) 2022/2554 ska', 'https://lagen.nu/celex/32022R2554'],
      ['i (EU) 2019/1020 anges', 'https://lagen.nu/celex/32019R1020'],
      ['kommissionens rekommendation 2003/361/EG', 'https://lagen.nu/celex/32003H0361'],
      ['rådets beslut 2010/48/EG', 'https://lagen.nu/celex/32010D0048'],
    ];
    for (const [text, uri] of cases) {
      assert.deepEqual(parser.parse_text(text, {}).map(r => r.uri), [uri]);
    }
  });

  it('treaty and charter articles', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, { basefile: 'x', parse_types: [EULAGSTIFTNING] });
    const cases = [
      ['artikel 16.2 i EUF-fördraget', 'https://lagen.nu/celex/12016E/TXT#16.2'],
      ['artikel 263 i EUF-fördraget', 'https://lagen.nu/celex/12016E/TXT#263'],
      ['artikel 267 FEUF', 'https://lagen.nu/celex/12016E/TXT#267'],
      ['artikel 47 i stadgan', 'https://lagen.nu/celex/12012P/TXT#47'],
      ['Artikel 8.1 i Europeiska unionens stadga om de grundläggande rättigheterna', 'https://lagen.nu/celex/12012P/TXT#8.1'],
      ['artikel 6 i europakonventionen', 'https://lagen.nu/coe/005#A6'],
      ['artikel 6.1 i EKMR', 'https://lagen.nu/coe/005#A6P1'],
    ];
    for (const [text, uri] of cases) {
      assert.deepEqual(parser.parse_text(text, {}).map(r => r.uri), [uri]);
    }
  });

  it('eu article lists and ranges', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, { basefile: 'x', parse_types: [EULAGSTIFTNING] });
    assert.deepEqual(
      parser.parse_text('artiklarna 101 och 102 i EUF-fördraget', {}).map(r => r.uri),
      ['https://lagen.nu/celex/12016E/TXT#101', 'https://lagen.nu/celex/12016E/TXT#102']
    );
    assert.deepEqual(
      parser.parse_text('artiklarna 12, 13 och 14 i stadgan', {}).map(r => r.uri),
      ['https://lagen.nu/celex/12012P/TXT#12', 'https://lagen.nu/celex/12012P/TXT#13', 'https://lagen.nu/celex/12012P/TXT#14']
    );
    assert.deepEqual(
      parser.parse_text('artiklarna 12–15 i EUF-fördraget', {}).map(r => r.uri),
      ['https://lagen.nu/celex/12016E/TXT#12', 'https://lagen.nu/celex/12016E/TXT#15']
    );
  });

  it('eu särskilt names instrument first', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, { basefile: 'x', parse_types: [EULAGSTIFTNING] });
    const refs = parser.parse_text(
      'med beaktande av fördraget om Europeiska unionens funktionssätt, särskilt artikel 16,',
      {}
    );
    assert.deepEqual(refs.map(r => [r.uri, r.text]), [
      ['https://lagen.nu/celex/12016E/TXT#16', 'artikel 16'],
    ]);
  });

  it('gdpr preamble reference patterns', () => {
    const p = new LagrumParser({}, { basefile: 'celex', parse_types: [EULAGSTIFTNING] });
    p.reset();
    p.state.self_eu_act = '32016R0679';
    const T = 'https://lagen.nu/celex/12016E/TXT';
    const C = 'https://lagen.nu/celex/12012P/TXT';
    const uris = text => p.parse_text(text, {}).map(r => r.uri);

    assert.deepEqual(
      uris('med beaktande av fördraget om Europeiska unionens funktionssätt, särskilt artikel 16,'),
      [`${T}#16`]
    );
    assert.deepEqual(uris('påverkar inte tillämpningen av artikel 98'), ['https://lagen.nu/celex/32016R0679#98']);
    assert.deepEqual(
      uris('Artikel 8.1 i Europeiska unionens stadga om de grundläggande rättigheterna'),
      [`${C}#8.1`]
    );
    assert.deepEqual(uris('I artikel 16.2 i EUF-fördraget bemyndigas'), [`${T}#16.2`]);
    p.parse_text('Europaparlamentets och rådets direktiv 2000/31/EG', {});
    assert.deepEqual(uris('ansvar i artiklarna 12–15 i det direktivet'), [
      'https://lagen.nu/celex/32000L0031#12',
      'https://lagen.nu/celex/32000L0031#15',
    ]);
    assert.deepEqual(
      uris('artikel 2 i bilagan till kommissionens rekommendation 2003/361/EG'),
      ['https://lagen.nu/celex/32003H0361']
    );
  });

  it('eu namedact articles and anaphora', () => {
    const GDPR = 'https://lagen.nu/celex/32016R0679';
    const parser = new LagrumParser(NAMEDLAWS_DATA, {
      basefile: 'dom',
      parse_types: [EULAGSTIFTNING],
      named_acts: NAMEDACTS_DATA,
    });
    parser.reset();

    const sequence = [
      ['Enligt artikel 6 i dataskyddsförordningen ska', [`${GDPR}#6`]],
      ['artikel 6.3 och 6.4 i den allmänna dataskyddsförordningen är', [`${GDPR}#6.3`, `${GDPR}#6.4`]],
      ['artikel 23.1 i dataskyddsförordningen medger', [`${GDPR}#23.1`]],
      ['behandlingen är nödvändig enligt artikel 6.1. e). Den', [`${GDPR}#6.1`]],
      ['artikel 5.1 c i förordningen, som', [`${GDPR}#5.1.c`]],
      ['artikel 6.1 europakonventionen och', ['https://lagen.nu/coe/005#A6P1']],
      ['artikel 267 EUF-fördraget för', ['https://lagen.nu/celex/12016E/TXT#267']],
      ['rätten till privatliv enligt artikel 7 och 8.1 i EU:s rättighetsstadga', [
        'https://lagen.nu/celex/12012P/TXT#7',
        'https://lagen.nu/celex/12012P/TXT#8.1',
      ]],
    ];
    for (const [text, want] of sequence) {
      assert.deepEqual(parser.parse_text(text, {}).map(r => r.uri), want);
    }
  });

  it('local abbreviation definitions shadow and track uses', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, {
      basefile: '9999:999',
      abbreviations: ABBREVIATIONS_DATA,
    });
    const refs = parser.parse_text(
      'bestämmelserna är genomförda genom lagen (1994:1564) om alkoholskatt, förkortad LAS, och av 8 a § LAS framgår vidare',
      {}
    );
    assert.deepEqual(refs.map(r => r.uri), [
      'https://lagen.nu/1994:1564',
      'https://lagen.nu/1994:1564#P8a',
    ]);
    assert.deepEqual(parser.local_abbreviations(), {
      LAS: { sfs: '1994:1564', uses: 1, shadows: '1982:80' },
    });

    // nedan form
    parser.reset();
    const refs2 = parser.parse_text(
      'genom lagen (1994:1564) om alkoholskatt, nedan LAS. I 19 § LAS anges vidare',
      {}
    );
    assert.equal(refs2[refs2.length - 1].uri, 'https://lagen.nu/1994:1564#P19');
  });

  it('ecj letterless form is year bounded', () => {
    const parser = new LagrumParser({}, {
      basefile: 'x',
      parse_types: [EURATTSFALL, EMDRATTSFALL],
    });
    let refs = parser.parse_text(
      'i mål 23452/94 den 28 oktober 1998, Osman mot Förenade kungariket'
    );
    assert.deepEqual(refs.map(r => r.uri), ['https://lagen.nu/dom/echr/001-58257']);
    refs = parser.parse_text('se mål 31/87 om offentlig upphandling');
    assert.deepEqual(refs.map(r => r.uri), ['https://lagen.nu/celex/61987CJ0031']);
  });

  it('emdrattsfall swedish surface', () => {
    const parser = new LagrumParser({}, {
      basefile: 'x',
      parse_types: [EMDRATTSFALL, RATTSFALL],
    });
    let refs = parser.parse_text(
      'i sin dom den 28 oktober 1998, Osman mot Förenade kungariket, p. 115'
    );
    assert.deepEqual(refs.map(r => [r.text, r.uri]), [
      ['Osman mot Förenade kungariket', 'https://lagen.nu/dom/echr/001-58257'],
    ]);
    refs = parser.parse_text('avgörandet, ansökan nr 23452/94, i samma mål');
    assert.deepEqual(refs.map(r => r.uri), ['https://lagen.nu/dom/echr/001-58257']);
    assert.deepEqual(parser.parse_text('kampen mot Sverige har hårdnat'), []);
    assert.deepEqual(parser.parse_text('enligt skrivelse med ansökan nr 1994/95'), []);
    assert.deepEqual(parser.parse_text('se Von Hannover mot Tyskland, p. 57'), []);
  });

  it('malnummer resolves a decision cited before its referat', () => {
    const parser = new LagrumParser({}, {
      basefile: 'x',
      parse_types: [MALNUMMER, RATTSFALL],
    });
    let refs = parser.parse_text('Högsta domstolens dom 2009-11-03 T 3-08');
    assert.deepEqual(refs.map(r => [r.text, r.uri]), [
      ['T 3-08', 'https://lagen.nu/dom/nja/2009s672'],
    ]);
    assert.deepEqual(parser.parse_text('HD:s dom i mål T 3-08').map(r => r.uri), [
      'https://lagen.nu/dom/nja/2009s672',
    ]);
    refs = parser.parse_text('NJA 2009 s. 672 (HD:s dom i mål T 3-08)');
    assert.deepEqual(refs.map(r => r.text), ['NJA 2009 s. 672', 'T 3-08']);
    assert.deepEqual(parser.parse_text('Södertörns tingsrätt mål nr B 4318-18'), []);
    const plain = new LagrumParser({}, { basefile: 'x', parse_types: [RATTSFALL] });
    assert.deepEqual(plain.parse_text('Högsta domstolens dom 2009-11-03 T 3-08'), []);
  });

  it('english sfs prefixed number', () => {
    const parser = new LagrumParser({}, {
      basefile: 'x',
      parse_types: [ENGLAGRUM, RATTSFALL],
    });
    for (const [text, want] of [
      ['Swedish Forestry Act, SFS 1979:429, requires', ['SFS 1979:429', 'https://lagen.nu/1979:429']],
      ['The Swedish Patent Act (SFS 1967:837) provides', ['SFS 1967:837', 'https://lagen.nu/1967:837']],
    ]) {
      assert.deepEqual(parser.parse_text(text).map(r => [r.text, r.uri]), [want]);
    }
    assert.deepEqual(parser.parse_text('Nordisk miljörättslig tidskrift 2021:1'), []);
    assert.deepEqual(parser.parse_text('(SAC 2015:116), under heading'), []);
    assert.deepEqual(parser.parse_text('ISO/IEC 42001:2023 - Information'), []);
    const plain = new LagrumParser({}, { basefile: 'x', parse_types: [RATTSFALL] });
    assert.deepEqual(plain.parse_text('under SFS 1979:429 and later'), []);
  });

  it('english pinpoint binds to the preceding act', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, {
      basefile: 'x',
      parse_types: [LAGRUM, ENGLAGRUM],
    });
    for (const [text, want] of [
      ['Miljöbalken, Chapter 5, Section 2, lays down obligations.', 'https://lagen.nu/1998:808#K5P2'],
      ['Environmental Code (SFS 1998:808), chapter 15 section 27', 'https://lagen.nu/1998:808#K15P27'],
      ['Miljötillsynsförordningen (2011:13), chapter 2, section 31', 'https://lagen.nu/2011:13#K2P31'],
      ['minerallagen (1991:45) ch. 4 s. 2 para. 5', 'https://lagen.nu/1991:45#K4P2S5'],
      ['vattenlagen (1983:291), ch. 16 s. 4 a', 'https://lagen.nu/1983:291#K16P4a'],
    ]) {
      const refs = parser.parse_text(text);
      assert.equal(refs[refs.length - 1].uri, want, text);
      assert.equal(refs.length, 2, text);
      parser.reset();
    }
  });

  it('english pinpoint without an anchor stays unlinked', () => {
    const parser = new LagrumParser(NAMEDLAWS_DATA, {
      basefile: 'x',
      parse_types: [LAGRUM, ENGLAGRUM],
    });
    assert.deepEqual(parser.parse_text('obligations under Chapter 3 Section 2 of the Finnish act'), []);
    parser.reset();
    assert.deepEqual(parser.parse_text('the Minerals Act ch. 4 s. 2 para. 5'), []);
    parser.reset();
    const refs = parser.parse_text('miljöbalken gäller. Chapter 2, Section 3 of the Finnish Act');
    assert.deepEqual(refs.map(r => r.uri), ['https://lagen.nu/1998:808']);
  });
});
