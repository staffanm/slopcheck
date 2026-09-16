import {
  CITATION_NAMES,
  CITATION_SERIES,
  FS_SLUG,
  NAMEDACTS_DATA,
  NAMEDCASES_DATA,
  NAMEDLAWS_DATA,
  NAMESPACES,
  TREATIES_DATA,
  TREATY_NAMES_DATA,
  TREATY_PIN_DATA,
} from './datasets.js';
import {
  ALL_PARSE_TYPES,
  citationSource,
  FORESKRIFT,
  LAGRUM,
  LagrumParser,
} from './lagrum.js';
import * as treatyref from './treatyref.js';

let sfsParser = null;
let foreskriftParser = null;
let generalParser = null;

function getSfsParser() {
  if (!sfsParser) {
    sfsParser = new LagrumParser(NAMEDLAWS_DATA, {
      basefile: 'query',
      parse_types: [LAGRUM],
    });
  }
  sfsParser.reset();
  return sfsParser;
}

function getForeskriftParser() {
  if (!foreskriftParser) {
    foreskriftParser = new LagrumParser({}, {
      basefile: 'query',
      parse_types: [FORESKRIFT],
    });
  }
  foreskriftParser.reset();
  return foreskriftParser;
}

function getGeneralParser() {
  if (!generalParser) {
    generalParser = new LagrumParser(NAMEDLAWS_DATA, {
      basefile: 'query',
      parse_types: ALL_PARSE_TYPES,
    });
  }
  generalParser.reset();
  return generalParser;
}

const NAMED_SPANS = {
  hyreslagen: { lawid: '1970:994', first: 'K12' },
  köplagen: { lawid: '1990:931' },
};

export function resolvePageCitation(q) {
  for (const series of CITATION_SERIES) {
    if (!series.citation) continue;
    const re = new RegExp(
      `^${series.citation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+([0-9]{4})\\s*s\\.?\\s*(-?[0-9]+)\\.?$`,
      'i'
    );
    const m = re.exec(q.trim());
    if (m) {
      const year = m[1];
      const page = m[2];
      return [{
        uri: `${series.uri_prefix}${year}s${page}`,
        source: series.source,
      }];
    }
  }
  return [];
}

function normalizePinpoint(rem) {
  let s = rem.trim().replace(/\.+$/, '').trim();
  const m = /^(\d+):(\d+)\s*([a-z]?)$/i.exec(s);
  if (m) {
    s = `${m[1]} kap. ${m[2]} ${m[3] ? m[3] + ' ' : ''}§`;
  } else if (!s.includes('§') && /\d/.test(s)) {
    s += ' §';
  }
  return s;
}

export function resolveRegulation(q) {
  const parser = getForeskriftParser();
  const refs = parser.parse_text(q, {});
  if (refs.length !== 1) return null;
  const ref = refs[0];
  const before = q.slice(0, ref.start).trim();
  const after = q.slice(ref.end).trim();
  if (before && after) return null;
  const pinpoint = before ? before.replace(/\s+i$/i, '') : after;
  if (pinpoint) {
    const sfs = getSfsParser();
    const pins = sfs.parse_text(normalizePinpoint(pinpoint), { law: 'query' });
    if (pins.length === 1 && pins[0].uri.includes('#')) {
      return ref.uri + '#' + pins[0].uri.split('#')[1];
    }
  }
  return ref.uri;
}

const RE_TREATY_ART = /^(?:art(?:ikel|icle)?\.?\s*)?(\d+)(?:[.\s:]+(\d+))?$/i;

export function resolveTreaty(q) {
  const low = q.toLowerCase();
  for (const [number, entry] of Object.entries(TREATY_PIN_DATA)) {
    const aliases = [entry.abbr, entry.label].filter(Boolean);
    for (const alias of aliases) {
      const a = alias.toLowerCase();
      if (low.startsWith(a) && low.length > a.length && !/[a-z0-9åäö]/i.test(low[a.length])) {
        const tail = q.slice(alias.length).trim();
        const m = RE_TREATY_ART.exec(tail);
        if (m) {
          const num = m[1];
          const stycke = m[2] ? `P${m[2]}` : '';
          return `https://lagen.nu/coe/${number.padStart(3, '0')}#A${num}${stycke}`;
        }
      }
    }
  }
  return null;
}

const RE_EU_ART = /^art(?:ikel|icle)?\.?\s*(\d+)(?:[.\s]+(\d+))?/i;
const RE_EU_BARE_ART = /^(\d+)(?:[.\s:]+(\d+))?$/;
const RE_EU_RECITAL = /^\(\s*(\d+)\s*\)?$|^(?:sk[äa]l|recital)\.?\s*(\d+)$/i;

export function resolveEu(q) {
  const low = q.toLowerCase();
  const namedActs = Object.entries(NAMEDACTS_DATA).sort((a, b) => b[0].length - a[0].length);
  for (const [label, celex] of namedActs) {
    const a = label.toLowerCase();
    if (low.startsWith(a) && (low.length === a.length || !/[a-z0-9åäö]/i.test(low[a.length]))) {
      let uri = `https://lagen.nu/celex/${celex}`;
      const rest = q.slice(label.length).trim();
      const recital = RE_EU_RECITAL.exec(rest);
      if (recital) {
        return `${uri}#recital-${recital[1] || recital[2]}`;
      }
      const m = RE_EU_ART.exec(rest) || RE_EU_BARE_ART.exec(rest);
      if (m) {
        uri += `#${m[1]}${m[2] ? '.' + m[2] : ''}`;
      }
      return uri;
    }
  }
  return null;
}

export function resolveEcj(q) {
  const m = /^(?:(?:Case|[Mm]ål)\s+)?([CTFctf])[-‑‐–—]\s?(\d{1,4})\/(\d{2,4})$/.exec(q.trim());
  if (m) {
    const court = m[1].toUpperCase();
    const serial = String(parseInt(m[2], 10)).padStart(4, '0');
    let year = m[3];
    if (year.length === 2) {
      year = (parseInt(year, 10) < 54 ? '20' : '19') + year;
    }
    return `https://lagen.nu/celex/6${year}${court}J${serial}`;
  }
  return null;
}

export function resolveDv(q) {
  const low = q.trim().toLowerCase();
  if (NAMEDCASES_DATA && NAMEDCASES_DATA[low]) {
    return NAMEDCASES_DATA[low];
  }
  return null;
}

export function resolveSfs(q) {
  const span = NAMED_SPANS[q.trim().toLowerCase()];
  if (span) {
    return `https://lagen.nu/${span.lawid}${span.first ? '#' + span.first : ''}`;
  }
  const sfsnr = /^(?:SFS\s+)?(\d{4}:\d{1,4}(?:_s\.\d+)?)(?:\s+(.*))?$/i.exec(q.trim());
  if (sfsnr) {
    const lawid = sfsnr[1];
    const rem = sfsnr[2];
    if (rem) {
      const parser = getSfsParser();
      const pins = parser.parse_text(normalizePinpoint(rem), { law: lawid });
      const frag = pins.find(r => r.uri.includes('#'));
      if (frag) return frag.uri;
    }
    return `https://lagen.nu/${lawid}`;
  }
  const parser = getSfsParser();
  const refs = parser.parse_text(q, {});
  const frag = refs.find(r => r.uri.includes('#'));
  return frag ? frag.uri : (refs.length ? refs[0].uri : null);
}

function resolveCourtId(q) {
  if (/^ICC-\d+\/\d+-\d+\/\d+-\d+(?:-[A-Za-z0-9]+)*$/i.test(q)) {
    return `https://lagen.nu/icc/${q.replace(/\//g, '_')}`;
  }
  let stem = q.replace(/^ICJ\s+/i, '').replace(/(?:[-_](?:EN|FR|BI)C?)?(?:\.pdf)?$/i, '');
  const m = /^(\d{3})[-_](\d{8})[-_]([A-Za-z]{3})[-_](\d{2})[-_](\d{2})$/.exec(stem);
  if (m) {
    const norm = `${m[1]}-${m[2]}-${m[3].toUpperCase()}-${m[4]}-${m[5]}`;
    return `https://lagen.nu/icj/${norm}`;
  }
  return null;
}

function resolveInstrument(q) {
  const low = q.toLowerCase();
  // Name + optional article
  const insts = TREATY_NAMES_DATA && TREATY_NAMES_DATA.instruments ? TREATY_NAMES_DATA.instruments : [];
  for (const inst of insts) {
    for (const name of (inst.names || [])) {
      const nLow = name.toLowerCase();
      if (low === nLow) {
        return [`https://lagen.nu/${inst.target}`];
      }
      if (low.startsWith(nLow + ' ')) {
        const tail = q.slice(name.length).trim();
        const m = RE_TREATY_ART.exec(tail);
        if (m) {
          const number = m[1];
          const refs = treatyref.references(`article ${number} of the ${name}`);
          if (refs.length) {
            return refs.map(r => r.uri);
          }
        }
      }
    }
  }
  return [];
}

export function resolveGeneral(q) {
  // Page citations range check: do not reinterpret ranges as prefixes
  if (CITATION_SERIES.some(s => s.citation && new RegExp(`^${s.citation}\\s+[0-9]{4}\\s*s\\b`, 'i').test(q))) {
    return [];
  }
  const courtUri = resolveCourtId(q);
  if (courtUri) return [courtUri];
  if (q.startsWith('https://lagen.nu/') && citationSource(q)) return [q];

  const mCelex = /^(?:CELEX\s*:\s*)?([01356][0-9]{4}[A-Z][A-Z0-9/()_-]*)$/i.exec(q);
  if (mCelex) {
    return [`https://lagen.nu/celex/${mCelex[1].toUpperCase()}`];
  }
  const mEts = /^(?:C?ETS\s*(?:No\.?\s*)?|CoE\s+)([0-9]+)$/i.exec(q);
  if (mEts) {
    return [`https://lagen.nu/coe/${mEts[1].padStart(3, '0')}`];
  }
  const mIcrc = /^(?:ICRC\s+)([0-9]+)$/i.exec(q);
  if (mIcrc) {
    return [`https://lagen.nu/icrc/${parseInt(mIcrc[1], 10)}`];
  }
  const mUntc = /^(?:UNTC\s+)([IV]+-[0-9]+)$/i.exec(q);
  if (mUntc) {
    return [`https://lagen.nu/untc/${mUntc[1].toUpperCase()}`];
  }
  const mHudoc = /^(?:HUDOC\s+)?(001-[0-9]+)$/i.exec(q);
  if (mHudoc) {
    return [`https://lagen.nu/dom/echr/${mHudoc[1]}`];
  }
  const instruments = resolveInstrument(q);
  if (instruments.length) return instruments;

  const parser = getGeneralParser();
  const refs = parser.parse_text(q, {});
  return refs.map(r => r.uri);
}

export function resolve(q) {
  const query = (q || '').trim();
  if (!query) return [];
  if (query.startsWith('https://lagen.nu/')) {
    const s = citationSource(query);
    if (s) return [{ uri: query, source: s }];
  }
  const pageHits = resolvePageCitation(query);
  if (pageHits.length) return pageHits;

  const resolvers = [
    ['foreskrift', resolveRegulation],
    ['coe', resolveTreaty],
    ['sfs', resolveSfs],
    ['eurlex', resolveEu],
    ['eurlex', resolveEcj],
    ['dv', resolveDv],
  ];

  const out = [];
  for (const [defSource, fn] of resolvers) {
    const uri = fn(query);
    if (uri && !out.some(o => o.uri === uri)) {
      out.push({ uri, source: citationSource(uri) || defSource });
    }
  }
  if (!out.length) {
    for (const uri of resolveGeneral(query)) {
      const source = citationSource(uri);
      if (source && !out.some(o => o.uri === uri)) {
        out.push({ uri, source });
      }
    }
  }
  return out;
}
