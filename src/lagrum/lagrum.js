// LagrumParser in JavaScript
// Replicating ferenda/lib/lagrum.py

import { Lark, Token, Tree, UnexpectedInput } from './lark.js';
import {
  DEPENDS,
  EU_EXTRA_RULES,
  EU_NAMNAKT_RULES,
  EU_TERMINALS,
  ROOTS,
  RULES,
  TERMINALS,
  TRIGGER_SRC,
  EU_TRIGGER_SRC_ENG,
  EU_RULES_ENG,
  TYPE_ORDER,
} from './grammar.js';
import {
  ABBREVIATIONS_DATA,
  ATTRIBUTE_ORDER,
  EDPB_FOUNDED,
  EDPB_NAMES,
  EU_KEYS,
  FRAGMENT_LETTERS,
  FS_DESIGNATIONS,
  FS_SLUG,
  INDEFINITE_HEADS,
  JO_ARSBERATTELSE,
  LAW_SYNONYMS,
  NAMEDACTS_DATA,
  NAMEDLAWS_DATA,
  NAMESPACES,
  NOLAW,
  ORDINALS,
  TREATIES_DATA,
  TREATY_PIN_DATA,
  WP29_GROUP,
  CASENUMBERS_DATA,
} from './datasets.js';
import * as emdref from './emdref.js';
import * as malnummer from './malnummer.js';

export const LAGRUM = 'LAGRUM';
export const KORTLAGRUM = 'KORTLAGRUM';
export const EULAGSTIFTNING = 'EULAGSTIFTNING';
export const RATTSFALL = 'RATTSFALL';
export const FORARBETEN = 'FORARBETEN';
export const EURATTSFALL = 'EURATTSFALL';
export const MYNDIGHETSBESLUT = 'MYNDIGHETSBESLUT';
export const VAGLEDNING = 'VAGLEDNING';
export const FORESKRIFT = 'FORESKRIFT';
export const STALLNINGSTAGANDE = 'STALLNINGSTAGANDE';
export const EMDRATTSFALL = 'EMDRATTSFALL';
export const MALNUMMER = 'MALNUMMER';
export const ENGLAGRUM = 'ENGLAGRUM';
export const ENKLALAGRUM = 'ENKLALAGRUM';

export const ALL_PARSE_TYPES = [
  LAGRUM, KORTLAGRUM, EULAGSTIFTNING, RATTSFALL,
  FORARBETEN, EURATTSFALL, MYNDIGHETSBESLUT, VAGLEDNING,
  FORESKRIFT, STALLNINGSTAGANDE, EMDRATTSFALL, MALNUMMER,
  ENGLAGRUM
];

const WINDOW = 220;

const ABSORB_MARKERS = new Set([
  'SM', 'DSM', 'SECTION_CHAR', 'CHAPTER_CHAR', 'ORDINAL_WORD', 'PIECE_WORD',
  'PIECE_DIGIT', 'SENTENCE_WORD', 'KAP', 'MOM', 'PUNKTEN', 'ITEM_CHAR'
]);

const BARE_PARTS = new Set([
  'eu_ref', 'artikel_part', 'artikel_item',
  'artikel_ref_id', 'underartikel_ref_id', 'punkt_ref_id',
  'stycke_ref', 'stycke_ref_id'
]);

const EU_GENERIC_AKTTYP = {
  'förordningen': 'R', 'direktivet': 'L',
  'rättsakten': null,
  'regulation': 'R', 'directive': 'L'
};

const DOC_PREFIX = {
  'prop_ref': 'prop', 'bet_ref': 'bet',
  'skrivelse_ref': 'rskr', 'sou_ref': 'sou', 'ds_ref': 'ds',
  'dir_ref': 'dir', 'so_ref': 'so'
};

const RE_PLACEHOLDER_SFS = /^\d+:0+$/;
const RE_BASEFILE_LAW = /\d+:(?:bih\.[_ ]?|N)?\d+(?:[_ ]s\.\d+|[_ ]\d+)?/;
const RE_FRAGMENT = /^(?:K([0-9a-z]+))?(?:P([0-9a-z]+))?(?:S(\d+))?(?:N(\d+))?/;

const RE_OTHER_ISSUER = new RegExp(
  '(?<![\\wåäöÅÄÖ])' +
  '(?!(?:' + EDPB_NAMES.map(escapeRegex).join('|') + ')(?:s|:s)?\\s+$)' +
  '[A-ZÅÄÖ][\\wåäöÅÄÖ-]*' +
  '(?:\\s+[a-zåäö][\\wåäöÅÄÖ-]*)?' +
  '(?:s|:s)\\s+$'
);

const RE_EDPB_SELF = new RegExp(
  '(?<![\\wåäöÅÄÖ])(?:' + EDPB_NAMES.map(escapeRegex).join('|') + ')(?:s|:s)?\\s+$',
  'i'
);

const RE_ABBREV_DEF = /\)?(?:\s+om\s+[^,.;:()§]{0,60}?)?(?:,\s*(?:förkorta[dst]|nedan(?:\s+kallad)?|i\s+det\s+följande(?:\s+(?:benämnd|kallad))?|benämnd|kallad)\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö]{1,9})\b|\s*\((?:förkorta[dst]\s+)?([A-ZÅÄÖ][A-Za-zÅÄÖåäö]{1,9})\))/;

export class Ref {
  constructor(start, end, text, predicate, uri, kind = null) {
    this.start = start;
    this.end = end;
    this.text = text;
    this.predicate = predicate;
    this.uri = uri;
    this.kind = kind;
  }
}

export class NoLink extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'NoLink';
  }
}

export class Pinpoint {
  constructor(artikel = null, underartikel = null, stycke = null, punkt = null) {
    this.artikel = artikel;
    this.underartikel = underartikel;
    this.stycke = stycke;
    this.punkt = punkt;
  }
}

const NO_PINPOINT = new Pinpoint();

export class NamedLaws {
  constructor(current, history = {}) {
    if (current && typeof current === 'object' && ('current' in current || 'history' in current)) {
      history = current.history || {};
      current = current.current || {};
    }
    this.current = { ...current };
    this._history = { ...history };
  }

  get(name) {
    return this.current[name] ?? null;
  }

  has(name) {
    return name in this.current;
  }

  clear() {
    this.current = {};
    this._history = {};
  }

  set(name, val) {
    this.current[name] = val;
  }

  at(name, when = null) {
    const spans = this._history[name];
    if (!when || !spans) {
      return this.get(name);
    }
    const whenStr = typeof when === 'object' && when.toISOString
      ? when.toISOString().slice(0, 10)
      : String(when);
    for (const [start, until, lawid] of spans) {
      if ((start === null || start <= whenStr) && (until === null || whenStr < until)) {
        return lawid;
      }
    }
    const earliest = spans.find(s => s[0])?.[0];
    return earliest && whenStr < earliest ? null : this.get(name);
  }
}

export class DocState {
  constructor() {
    this.lastlaw = null;
    this.namedlaws = new Map();
    this.abbrevs = new Map();
    this.abbrev_shadows = new Map();
    this.abbrev_uses = new Map();
    this.last_forarbete = null;
    this.last_eu_act = null;
    this.last_eu_act_by_akttyp = new Map();
    this.self_eu_act = null;
  }

  remember_eu_act(celex) {
    this.last_eu_act = celex;
    const akttyp = eu_akttyp(celex);
    if (akttyp) {
      this.last_eu_act_by_akttyp.set(akttyp, celex);
    }
  }
}

class MatchState {
  constructor() {
    this.currentlaw = null;
    this.currentchapter = null;
    this.currentsection = null;
    this.currentpiece = null;
  }
}

export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function verboseRegexToJs(src) {
  let out = '';
  let inClass = false;
  const lines = src.split('\n');
  for (const line of lines) {
    let stripped = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && i + 1 < line.length) {
        if (line[i + 1] === ' ') {
          stripped += ' ';
          i++;
        } else {
          stripped += c + line[i + 1];
          i++;
        }
        continue;
      }
      if (c === '[' && !inClass) inClass = true;
      else if (c === ']' && inClass) inClass = false;
      else if (c === '#' && !inClass) break;
      if (inClass || !/\s/.test(c)) {
        stripped += c;
      }
    }
    out += stripped;
  }
  // Adapt Swedish word boundaries and character classes for JS (where \w and \b are ASCII only)
  out = out.replace(/\\b\[\\w([åäö\u00e5\u00e4\u00f6])/g, '(?<![\\w$1\\u00c5\\u00c4\\u00d6])[\\w$1\\u00c5\\u00c4\\u00d6');
  out = out.replace(/\[\\w([åäö\u00e5\u00e4\u00f6])/g, '[\\w$1\\u00c5\\u00c4\\u00d6');
  out = out.replace(/(stadgans\?)\)\\b/g, '$1)(?![\\w\\u00e5\\u00e4\\u00f6\\u00c5\\u00c4\\u00d6])');
  return out;
}

export function buildTrigger(types, lang = 'swe') {
  const parts = [];
  for (const t of TYPE_ORDER) {
    if (types.has(t)) {
      const src = (lang === 'eng' && t === EULAGSTIFTNING) ? EU_TRIGGER_SRC_ENG : TRIGGER_SRC[t];
      if (src) {
        parts.push(verboseRegexToJs(src).trim());
      }
    }
  }
  return new RegExp(parts.join('|'), 'g');
}

export function with_indefinite_aliases(named_acts) {
  const out = { ...named_acts };
  for (const [alias, celex] of Object.entries(named_acts)) {
    for (const [definite, indefinite] of Object.entries(INDEFINITE_HEADS)) {
      if (alias.endsWith(definite)) {
        const candidate = alias.slice(0, -definite.length) + indefinite;
        if (!(candidate in out)) {
          out[candidate] = celex;
        }
        break;
      }
    }
  }
  return out;
}

export function treeTokens(tree) {
  return [...tree.scan_values(v => v instanceof Token)];
}

export function nodeSpan(node) {
  const toks = treeTokens(node);
  if (!toks.length) return [0, 0];
  return [Math.min(...toks.map(t => t.start_pos)), Math.max(...toks.map(t => t.end_pos))];
}

export function lawIdSpan(law_node) {
  const toks = treeTokens(law_node).filter(t => t.type === 'LAW_REF_ID' || t.type === 'NAMED_LAW');
  return toks.length ? [toks[0].start_pos, toks[0].end_pos] : nodeSpan(law_node);
}

export function findRefids(tree) {
  const d = {};
  for (const sub of tree.iter_subtrees_topdown()) {
    if (sub.data.endsWith('_ref_id')) {
      const key = sub.data.slice(0, -7);
      d[key] = treeTokens(sub).map(t => t.value).join(' ').trim();
    }
  }
  return d;
}

export function subtree(tree, name, defaultVal = undefined) {
  for (const s of tree.iter_subtrees_topdown()) {
    if (s.data === name) return s;
  }
  if (defaultVal !== undefined) return defaultVal;
  throw new Error(`Subtree not found: ${name}`);
}

export function tokenText(tree) {
  return treeTokens(tree).map(t => t.value).join('');
}

export function normalizeSfsid(sfsid) {
  let s = sfsid.replace(/^(1736:0123) ?s\.? ?/, '$1 ');
  return s.replace(/(\d+:\d+)\.(\d)/, '$1 $2').replace(/\n/g, ' ');
}

export function normalizeLawname(name) {
  const n = name.toLowerCase();
  return n.endsWith('s') ? n.slice(0, -1) : n;
}

export function namedAt(mapping, name, when) {
  if (mapping && typeof mapping.at === 'function') {
    return mapping.at(name, when);
  }
  if (mapping && typeof mapping.get === 'function') {
    return mapping.get(name);
  }
  return mapping ? (mapping[name] ?? null) : null;
}

export function isPlaceholderSfsid(sfsid) {
  return RE_PLACEHOLDER_SFS.test(sfsid.trim());
}

export function lagrumUri(attrs, base = 'https://lagen.nu/') {
  const a = { ...attrs };
  if ('lawref' in a) {
    a.law = a.law;
    a.lawref = a.lawref;
  }
  if (('item' in a || 'itemnumeric' in a) && !('piece' in a)) {
    a.piece = '1';
  }
  for (const [k, v] of Object.entries(a)) {
    if (v in ORDINALS) a[k] = ORDINALS[v];
  }
  let law = normalizeSfsid(String(a.law || '')).replace(/\u00a0/g, ' ');
  law = law.replace(/ ?s\.? ?(\d+)$/, '_s.$1');
  const uri = base + law.replace(/bih\. /g, 'bih.').replace(/ /g, '_');
  if ('lawref' in a) {
    return uri + '#L' + a.lawref;
  }
  let frag = '';
  for (const [key, letter] of FRAGMENT_LETTERS) {
    if (a[key]) {
      frag += letter + a[key].replace(/ /g, '').replace(/\u00a0/g, '');
    }
  }
  return uri + (frag ? '#' + frag : '');
}

export function celexYear(value) {
  const v = String(value);
  const year = parseInt(v, 10) + (v.length <= 2 ? 1900 : 0);
  return year >= 1950 && year <= 2050 ? year : null;
}

export function celexOf(uri) {
  const prefix = 'https://lagen.nu/celex/';
  if (uri.startsWith(prefix)) {
    return uri.slice(prefix.length).split('#')[0];
  }
  return null;
}

export function celexUri(attrs, base = 'https://lagen.nu/') {
  const a = { ...attrs };
  if (!a.akttyp) {
    if (a.forordning) a.akttyp = 'förordning';
    else if (a.direktiv) a.akttyp = 'direktiv';
  }
  if (!a.akttyp || !a.ar || !a.lopnummer) {
    throw new NoLink();
  }
  let year = celexYear(a.ar);
  let number;
  if (year !== null) {
    number = parseInt(a.lopnummer, 10);
  } else {
    year = celexYear(a.lopnummer);
    number = parseInt(a.ar, 10);
  }
  if (year === null || Number.isNaN(number)) {
    throw new NoLink();
  }
  const letters = {
    'direktiv': 'L', 'förordning': 'R',
    'rekommendation': 'H', 'beslut': 'D',
    'directive': 'L', 'regulation': 'R',
    'recommendation': 'H', 'decision': 'D'
  };
  const letter = letters[a.akttyp.toLowerCase()];
  if (!letter) throw new NoLink();
  const uri = `${base}celex/3${String(year).padStart(4, '0')}${letter}${String(number).padStart(4, '0')}`;
  const frag = euFragment(new Pinpoint(a.artikel, a.underartikel, a.stycke, a.punkt));
  return uri + (frag ? '#' + frag : '');
}

export function toRoman(num) {
  let out = '';
  let value = num;
  for (const [amount, sign] of [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
    while (value >= amount) {
      out += sign;
      value -= amount;
    }
  }
  return out;
}

export function euFragment(pin) {
  if (!pin.artikel) return '';
  let frag = [pin.artikel, pin.underartikel].filter(Boolean).join('.');
  if (pin.punkt) return frag + '.' + pin.punkt;
  return frag + (pin.stycke ? '.S' + pin.stycke : '');
}

export function eu_akttyp(celex) {
  if (!celex || celex.length < 6) return null;
  return celex[5];
}

export function foldSwedish(str) {
  return str.replace(/[åä]/gi, 'a').replace(/ö/gi, 'o');
}

export function rattsfallUri(court, year, tail, base = 'https://lagen.nu/') {
  const slug = foldSwedish(court.toLowerCase());
  return `${base}dom/${slug}/${year}${tail}`;
}

export function riksmoteStr(node) {
  const nums = treeTokens(node).filter(t => t.type === 'NUMBER').map(t => t.value);
  if (nums.length === 2 && nums[1].length === 4 && nums[1].slice(0, 2) === nums[0].slice(0, 2)) {
    nums[1] = nums[1].slice(2);
  }
  return nums.join('/');
}

export function avgIds(node, name) {
  const res = [];
  for (const s of node.iter_subtrees_topdown()) {
    if (s.data === name) {
      res.push([tokenText(s), nodeSpan(s)]);
    }
  }
  return res;
}

export function numberSlug(number) {
  return number.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function ownNumberSlug(number) {
  return number.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function vagledningSlug(number) {
  const [serial, year] = number.split('/');
  return `${parseInt(serial, 10).toString().padStart(2, '0')}-${year}`;
}

export function jkIsDate(dnr) {
  const parts = dnr.split('-').map(Number);
  if (parts.length !== 3) return false;
  const [ordinal, second, third] = parts;
  const currentYear = new Date().getFullYear();
  return ordinal >= 1980 && ordinal <= currentYear && second >= 1 && second <= 12 && third >= 1 && third <= 31;
}

export function fragmentContext(basefile, fragment) {
  const m = RE_BASEFILE_LAW.exec(basefile.replace(/ /g, '_'));
  const ctx = { law: (m ? m[0] : basefile).replace(/_/g, ' ') };
  if (fragment) {
    const fm = RE_FRAGMENT.exec(fragment);
    if (fm) {
      const keys = ['chapter', 'section', 'piece', 'item'];
      for (let i = 0; i < keys.length; i++) {
        if (fm[i + 1]) ctx[keys[i]] = fm[i + 1];
      }
    }
  }
  return ctx;
}

export function linkSpans(attrlist, tree, length) {
  const spans = attrlist.map(a => [...(a._span || [0, length])]);
  if (!spans.length) return spans;
  const tokens = treeTokens(tree);
  const markers = tokens.filter(t => ABSORB_MARKERS.has(t.type))
    .map(t => [t.start_pos, t.end_pos])
    .sort((a, b) => a[0] - b[0]);

  for (const [mstart, mend] of markers) {
    if (spans.some(([s, e]) => s <= mstart && mend <= e)) continue;
    let cand = null;
    for (let i = 0; i < spans.length; i++) {
      const [, e] = spans[i];
      if (e <= mstart && !tokenBetween(tokens, e, mstart) && (cand === null || e > spans[cand][1])) {
        cand = i;
      }
    }
    if (cand !== null) {
      spans[cand][1] = Math.max(spans[cand][1], mend);
    }
  }
  return spans;
}

function tokenBetween(tokens, a, b) {
  return tokens.some(t => a < t.start_pos && t.end_pos <= b);
}

export function citationSource(uri) {
  const prefix = 'https://lagen.nu/';
  if (!uri.startsWith(prefix)) return null;
  const tail = uri.slice(prefix.length);

  for (const [ns, source] of Object.entries(NAMESPACES)) {
    if (tail.startsWith(ns)) return source;
  }
  if (/^[0-9]{4}:[^/#]+(?:#.*)?$/.test(tail)) {
    return 'sfs';
  }
  const firstSeg = tail.split('/')[0];
  if (Object.values(FS_SLUG).includes(firstSeg)) {
    return 'foreskrift';
  }
  return null;
}

export class LagrumParser {
  constructor(namedlaws = {}, basefile = 'query', base = 'https://lagen.nu/',
              abbreviations = null, parse_types = null, named_acts = null,
              lang = 'swe', written = null) {
    let casenumbers = null;
    let emd_cases = null;
    if (typeof basefile === 'object' && basefile !== null) {
      const opts = basefile;
      basefile = opts.basefile ?? 'query';
      base = opts.base ?? 'https://lagen.nu/';
      abbreviations = opts.abbreviations ?? null;
      parse_types = opts.parse_types ?? opts.parseTypes ?? null;
      named_acts = opts.named_acts ?? opts.namedActs ?? null;
      lang = opts.lang ?? 'swe';
      written = opts.written ?? null;
      casenumbers = opts.casenumbers ?? null;
      emd_cases = opts.emd_cases ?? null;
    }
    this.namedlaws = namedlaws instanceof NamedLaws ? namedlaws : new NamedLaws(namedlaws);
    this.written = written;
    this.basefile = basefile;
    this.base = base;
    this.lang = lang;
    this.named_acts = with_indefinite_aliases(named_acts || {});
    this.self_law_uri = lagrumUri({ law: fragmentContext(basefile, null).law }, base);
    this.state = new DocState();
    this.abbreviations = abbreviations instanceof NamedLaws ? abbreviations : new NamedLaws(abbreviations || {});

    if (parse_types === null) {
      parse_types = [LAGRUM, EULAGSTIFTNING];
      if (abbreviations && Object.keys(abbreviations.current || abbreviations).length > 0) {
        parse_types.push(KORTLAGRUM);
      }
    }
    const requested = new Set(parse_types);
    this.parse_types = this._expandTypes(parse_types);
    this.enkla = requested.has(ENKLALAGRUM) && !requested.has(LAGRUM);

    const abbrevs = Object.keys(this.abbreviations.current || this.abbreviations)
      .sort((a, b) => b.length - a.length);
    const eu_acts = Object.keys(this.named_acts).sort((a, b) => b.length - a.length);

    this.lark = this._buildLark(requested, this.parse_types, abbrevs, eu_acts, lang);
    this.trigger = buildTrigger(this.parse_types, lang);
    this.emd = requested.has(EMDRATTSFALL);
    this.case_numbers = requested.has(MALNUMMER);
    this.eng = requested.has(ENGLAGRUM);
    this.casenumbers = casenumbers || CASENUMBERS_DATA;
    this.emd_cases = emd_cases;
  }

  _expandTypes(types) {
    const out = new Set(types);
    for (const t of types) {
      for (const dep of DEPENDS[t] || []) {
        out.add(dep);
      }
    }
    return out;
  }

  _buildLark(requested, expanded, abbrevs, eu_acts, lang) {
    const rules = { ...RULES };
    if (lang === 'eng' && EU_RULES_ENG) {
      rules[EULAGSTIFTNING] = EU_RULES_ENG;
    }
    const roots = [];
    for (const t of TYPE_ORDER) {
      if (requested.has(t) && ROOTS[t]) {
        roots.push(...ROOTS[t]);
      }
    }

    let g = 'start: ref\n?ref: ' + roots.join('\n    | ') + '\n';
    for (const t of TYPE_ORDER) {
      if (expanded.has(t) && rules[t]) {
        g += rules[t];
      }
    }
    g += TERMINALS;

    if (expanded.has(EULAGSTIFTNING)) {
      g += EU_TERMINALS[lang] || '';
    }
    if (expanded.has(KORTLAGRUM) && abbrevs.length > 0) {
      g += `\nLAW_ABBREV: /(?:${abbrevs.map(escapeRegex).join('|')})(?![\\w-])/\n`;
    }
    if (expanded.has(EULAGSTIFTNING) && lang !== 'eng') {
      g += EU_EXTRA_RULES;
      const treaties = Object.keys(TREATIES_DATA).sort((a, b) => b.length - a.length);
      g += '\nEU_TREATY: ' + treaties.map(t => JSON.stringify(t) + 'i').join(' | ') + '\n';
      if (eu_acts.length > 0) {
        g += EU_NAMNAKT_RULES;
        g += '\nEU_NAMNAKT: ' + eu_acts.map(a => JSON.stringify(a) + 'i').join(' | ') + '\n';
      }
    }
    if (expanded.has(FORESKRIFT)) {
      const desigs = [...FS_DESIGNATIONS].sort((a, b) => b.length - a.length);
      g += '\nFS_DESIGNATION: ' + desigs.map(d => JSON.stringify(d)).join(' | ') + '\n';
    }

    return new Lark(g, { parser: 'earley' });
  }

  reset(written = null) {
    this.state = new DocState();
    this.written = written;
    this._scan_text = '';
    this._scan_base = 0;
  }

  parse_text(text, fragment = null, context = null, predicate = 'dcterms:references') {
    if (typeof fragment === 'object' && fragment !== null && context === null) {
      if ('context' in fragment || 'fragment' in fragment || 'predicate' in fragment) {
        predicate = fragment.predicate ?? 'dcterms:references';
        context = fragment.context ?? null;
        fragment = fragment.fragment ?? null;
      } else {
        context = fragment;
        fragment = null;
      }
    }
    if (context === null) {
      context = fragmentContext(this.basefile, fragment);
    }
    this.nobaseuri = !context || Object.keys(context).length === 0;
    const orig = text;
    text = text.replace(/[\u00a0\u202f]/g, ' ');
    const refs = [];

    this.trigger.lastIndex = 0;
    let m;
    while ((m = this.trigger.exec(text)) !== null) {
      const start = m.index;
      const [tree, length] = this.try_parse(text, start);
      if (tree !== null && this.acceptable(tree, text, start, start + length)) {
        const base = start;
        this._scan_text = text;
        this._scan_base = base;
        try {
          const attrlist = this.format_root(tree, context);
          const spans = linkSpans(attrlist, tree, length);
          for (let i = 0; i < attrlist.length; i++) {
            const attrs = attrlist[i];
            const [s, e] = spans[i];
            let uri;
            if ('_uri' in attrs) {
              uri = attrs._uri;
            } else if (EU_KEYS.some(k => k in attrs)) {
              uri = celexUri(attrs, this.base);
              const celex = celexOf(uri);
              if (celex) this.state.remember_eu_act(celex);
            } else if (isPlaceholderSfsid(String(attrs.law || ''))) {
              throw new NoLink();
            } else {
              uri = lagrumUri(attrs, this.base);
              if ('law' in attrs) {
                this._learn_abbrev(text, base + e, attrs);
              }
            }
            refs.push(new Ref(base + s, base + e, orig.slice(base + s, base + e), predicate, uri));
          }
        } catch (err) {
          if (!(err instanceof NoLink)) throw err;
        }
        this.trigger.lastIndex = start + length;
      } else {
        this.trigger.lastIndex = start + 1;
      }
    }

    let result = refs;
    if (this.eng) {
      const sfs = yield_overlaps(
        spans_as_refs(_english_sfs_spans(text, this.base), orig, predicate),
        result
      );
      const anchors = result.concat(sfs).map(r => [r.end, r.uri]);
      const pins = yield_overlaps(
        spans_as_refs(english_pinpoint_spans(text, anchors), orig, predicate),
        result.concat(sfs)
      );
      result = result.concat(sfs, pins).sort((a, b) => a.start - b.start);
    }
    if (this.emd) {
      result = merge_refs(result, emdref.refs(text, this.base, predicate, orig, this.emd_cases || undefined));
    }
    if (this.case_numbers) {
      result = merge_refs(result, malnummer.refs(text, this.base, predicate, orig, this.casenumbers || undefined));
    }
    return result;
  }

  parseText(...args) {
    return this.parse_text(...args);
  }

  try_parse(text, start) {
    let window = text.slice(start, start + WINDOW);
    for (let iter = 0; iter < 8; iter++) {
      window = window.replace(/[ ,;]+$/, '');
      if (!window) return [null, 0];
      try {
        const tree = this.lark.parse(window);
        return [tree, window.length];
      } catch (err) {
        if (!(err instanceof UnexpectedInput)) throw err;
        const upto = err.pos_in_stream;
        if (!upto) return [null, 0];
        if (upto >= window.length) {
          window = window.replace(/\S+$/, '');
        } else {
          window = window.slice(0, upto);
        }
      }
    }
    return [null, 0];
  }

  tryParse(text, start) {
    return this.try_parse(text, start);
  }

  acceptable(tree, text, start, end) {
    const node = tree.children[0];
    if (node instanceof Tree && node.data === 'change_ref') {
      const has_dot = treeTokens(node).some(t => t.type === 'DOT');
      if (!has_dot && (end >= text.length || text[end] === ' ' || text[end] === ',')) {
        return false;
      }
    }
    if (node instanceof Tree && (node.data === 'riktlinje_ref' || node.data === 'rekommendation_ref')) {
      const pre = text.slice(0, start);
      if (RE_OTHER_ISSUER.test(pre) && !RE_EDPB_SELF.test(pre)) {
        return false;
      }
    }
    if (node instanceof Tree && node.data === 'wp_ref') {
      const number = tokenText(subtree(node, 'wp_id'));
      if (number === WP29_GROUP) return false;
    }
    return true;
  }

  format_root(tree, context) {
    const match = new MatchState();
    const out = [];
    this.dispatch(tree.children[0], match, out, context);
    if (match.currentlaw) {
      this.state.lastlaw = match.currentlaw;
    }
    return out;
  }

  emit(attrs, match, out, context, span = null) {
    const d = { ...attrs };
    if (span !== null) d._span = span;
    if (EU_KEYS.some(k => k in d)) {
      out.push(d);
      return;
    }
    for (const [key, val] of [
      ['law', match.currentlaw],
      ['chapter', match.currentchapter],
      ['section', match.currentsection],
      ['piece', match.currentpiece]
    ]) {
      if (val && !d[key]) d[key] = val;
    }

    let specificity = false;
    for (const key of ATTRIBUTE_ORDER) {
      if (key in d) {
        specificity = true;
      } else if (!specificity && context && key in context) {
        d[key] = context[key];
      }
    }
    if (!d.law) return;
    out.push(d);
  }

  dispatch(node, match, out, context) {
    if (node instanceof Token) return;
    const handler = this['fmt_' + node.data];
    if (handler) {
      handler.call(this, node, match, out, context);
    } else {
      for (const child of node.children) {
        this.dispatch(child, match, out, context);
      }
    }
  }

  fmt_change_ref(node, match, out, context) {
    this.emit({ lawref: normalizeSfsid(findRefids(node).law) },
              match, out, context, nodeSpan(node));
  }

  fmt_sfs_nr(node, match, out, context) {
    const law = normalizeSfsid(findRefids(node).law);
    match.currentlaw = law;
    if (this.nobaseuri && context) {
      context.law = law;
    }
    this.emit({ law }, match, out, context, lawIdSpan(node));
  }

  fmt_generic_ref(node, match, out, context) {
    const ids = findRefids(node);
    this.emit(ids, match, out, context, nodeSpan(node));
    if (ids.chapter) {
      match.currentchapter = ids.chapter;
    }
  }

  fmt_section_anatomy(node, match, out, context) {
    this.fmt_generic_ref(node, match, out, context);
  }

  fmt_piece_item_ref(node, match, out, context) {
    this.fmt_generic_ref(node, match, out, context);
  }

  fmt_individual_chapter_section_refs(node, match, out, context) {
    const sections = node.children.filter(c => c instanceof Tree && c.data === 'section_ref');
    match.currentchapter = findRefids(node.children[0]).chapter;
    this.emit({ section: findRefids(sections[0]).section },
              match, out, context,
              [nodeSpan(node.children[0])[0], nodeSpan(sections[0])[1]]);
    for (let i = 1; i < sections.length; i++) {
      this.emit({ section: findRefids(sections[i]).section },
                match, out, context, nodeSpan(sections[i]));
    }
  }

  fmt_chapter_section_refs(node, match, out, context) {
    const [chapter_ref, sections] = node.children;
    match.currentchapter = findRefids(chapter_ref).chapter;
    this.emit({ chapter: match.currentchapter }, match, out, context, nodeSpan(chapter_ref));
    this.dispatch(sections, match, out, context);
    match.currentchapter = null;
  }

  fmt_chapter_section_piece_refs(node, match, out, context) {
    const [chapter_ref, section_pieces] = node.children;
    match.currentchapter = findRefids(chapter_ref).chapter;
    this.emit({ chapter: match.currentchapter }, match, out, context, nodeSpan(chapter_ref));
    this.dispatch(section_pieces, match, out, context);
  }

  fmt_single_section_ref(node, match, out, context) {
    this.emit({ section: findRefids(node).section }, match, out, context, nodeSpan(node));
  }

  fmt_section_ref(node, match, out, context) {
    this.fmt_single_section_ref(node, match, out, context);
  }

  fmt_section_piece_refs(node, match, out, context) {
    const section = node.children[0];
    match.currentsection = findRefids(section).section;
    const pieces = node.children.slice(1).filter(c => c instanceof Tree);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const span = i === 0 ? [nodeSpan(section)[0], nodeSpan(piece)[1]] : nodeSpan(piece);
      this.emit(findRefids(piece), match, out, context, span);
    }
    match.currentsection = null;
  }

  fmt_section_piece_item_range(node, match, out, context) {
    const [section, piece] = node.children;
    match.currentsection = findRefids(section).section;
    match.currentpiece = findRefids(piece).piece;
    this.emit({ piece: match.currentpiece }, match, out, context, [nodeSpan(section)[0], nodeSpan(piece)[1]]);
    for (const item of node.children.slice(2)) {
      if (item instanceof Tree) {
        this.emit(findRefids(item), match, out, context, nodeSpan(item));
      }
    }
    match.currentsection = null;
    match.currentpiece = null;
  }

  fmt_section_item_refs(node, match, out, context) {
    const section = node.children[0];
    match.currentsection = findRefids(section).section;
    this.emit({ section: match.currentsection }, match, out, context, nodeSpan(section));
    for (const item of node.children.slice(1)) {
      if (item instanceof Tree && item.data === 'item_ref') {
        this.emit(findRefids(item), match, out, context, nodeSpan(item));
      }
    }
    match.currentsection = null;
  }

  fmt_piece_and_item_refs(node, match, out, context) {
    this.emit(findRefids(node.children[0]), match, out, context, nodeSpan(node.children[0]));
    this.emit(findRefids(node.children[node.children.length - 1]), match, out, context,
              nodeSpan(node.children[node.children.length - 1]));
  }

  fmt_piece_item_refs(node, match, out, context) {
    const piece = node.children[0];
    match.currentpiece = findRefids(piece).piece;
    const items = node.children.slice(1).filter(c => c instanceof Tree);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const span = i === 0 ? [nodeSpan(piece)[0], nodeSpan(item)[1]] : nodeSpan(item);
      this.emit(findRefids(item), match, out, context, span);
    }
    match.currentpiece = null;
  }

  fmt_external_ref(node, match, out, context) {
    const law_node = node.children[node.children.length - 1];
    const anonymous = law_node instanceof Tree && law_node.data === 'anonymous_external_law';
    this.resolve_law(law_node, match);
    const inner = [];
    this.dispatch(node.children[0], match, inner, context);
    out.push(...inner);

    const combined = inner.length === 1 && (this.enkla || 'section' in inner[0]);
    const same_law = law_node instanceof Tree && law_node.data === 'same_law';

    if (combined && inner[0]._span) {
      inner[0]._span = [inner[0]._span[0], nodeSpan(law_node)[1]];
    }
    if (!combined && !same_law) {
      match.currentchapter = null;
      const span = anonymous ? lawIdSpan(law_node) : nodeSpan(law_node);
      this.emit({ law: match.currentlaw }, match, out, context, span);
    }
  }

  fmt_external_refs(node, match, out, context) {
    this.fmt_external_ref(node, match, out, context);
  }

  fmt_named_external_law_ref(node, match, out, context) {
    this.resolve_law(node, match);
    this.emit({ law: match.currentlaw }, match, out, context, nodeSpan(node));
    if (this.nobaseuri && context) {
      context.law = match.currentlaw;
    }
  }

  fmt_kortlagrum_normal(node, match, out, context) {
    match.currentlaw = this.abbrev_to_sfsid(node);
    const genref = node.children.find(c => c instanceof Tree);
    this.dispatch(genref, match, out, context);
  }

  fmt_kortlagrum_refs(node, match, out, context) {
    this.fmt_kortlagrum_normal(node, match, out, context);
  }

  fmt_kortlagrum_short(node, match, out, context) {
    match.currentlaw = this.abbrev_to_sfsid(node);
    const nums = node.children.filter(t => t instanceof Token && t.type === 'NUMBER').map(t => t.value);
    const attrs = { chapter: nums[0], section: nums[1] };
    const piece = node.children.find(c => c instanceof Tree && c.data === 'piece_ref');
    if (piece) {
      Object.assign(attrs, findRefids(piece));
    }
    this.emit(attrs, match, out, context, nodeSpan(node));
  }

  abbrev_to_sfsid(node) {
    const abbrevTok = treeTokens(node).find(t => t.type === 'LAW_ABBREV');
    if (!abbrevTok) throw new NoLink();
    const abbrev = abbrevTok.value;
    const local = this.state.abbrevs.get(abbrev);
    if (local !== undefined) {
      this.state.abbrev_uses.set(abbrev, (this.state.abbrev_uses.get(abbrev) || 0) + 1);
      return local;
    }
    const law = namedAt(this.abbreviations, abbrev, this.written);
    if (!law) throw new NoLink();
    return normalizeSfsid(law);
  }

  _learn_abbrev(text, end, attrs) {
    const m = RE_ABBREV_DEF.exec(text.slice(end));
    if (!m || m.index !== 0) return;
    const abbrev = m[1] || m[2];
    if (!abbrev) return;
    const hasGlobal = this.abbreviations && (this.abbreviations.has?.(abbrev) || abbrev in this.abbreviations);
    if (!hasGlobal || this.state.abbrevs.has(abbrev)) return;
    const law = normalizeSfsid(String(attrs.law));
    this.state.abbrevs.set(abbrev, law);
    const glob = namedAt(this.abbreviations, abbrev, this.written);
    const normGlob = glob ? normalizeSfsid(glob) : null;
    if (normGlob !== law) {
      this.state.abbrev_shadows.set(abbrev, normGlob);
    }
  }

  local_abbreviations() {
    const state = this.state;
    const res = {};
    for (const [abbrev, law] of state.abbrevs.entries()) {
      const entry = { sfs: law, uses: state.abbrev_uses.get(abbrev) || 0 };
      if (state.abbrev_shadows.has(abbrev)) {
        entry.shadows = state.abbrev_shadows.get(abbrev);
      }
      res[abbrev] = entry;
    }
    return res;
  }

  localAbbreviations() {
    return this.local_abbreviations();
  }

  resolve_law(law_node, match) {
    if (law_node instanceof Tree && law_node.data !== 'same_law') {
      const refids = findRefids(law_node);
      const nameTok = treeTokens(law_node).find(t => t.type === 'NAMED_LAW');
      const name = nameTok ? nameTok.value : null;
      if (refids.law) {
        match.currentlaw = normalizeSfsid(refids.law);
        if (name) {
          this.state.namedlaws.set(normalizeLawname(name), match.currentlaw);
        }
        return;
      }
      match.currentlaw = this.namedlaw_to_sfsid(name);
      if (!match.currentlaw) throw new NoLink();
      return;
    }
    if (!this.state.lastlaw) throw new NoLink();
    match.currentlaw = this.state.lastlaw;
  }

  namedlaw_to_sfsid(name) {
    if (!name) return null;
    const norm = normalizeLawname(name);
    if (NOLAW.has(norm) || LAW_SYNONYMS.has(norm)) {
      return null;
    }
    return this.state.namedlaws.get(norm) || namedAt(this.namedlaws, norm, this.written) || null;
  }

  // EU formatting
  _eu_celex_uri(celex, pin = NO_PINPOINT, remember = true) {
    if (remember) {
      this.state.remember_eu_act(celex);
    }
    const frag = euFragment(pin);
    return this.base + 'celex/' + celex + (frag ? '#' + frag : '');
  }

  _treaty_uri(path, pin = NO_PINPOINT) {
    const uri = this.base + path;
    if (!pin.artikel) return uri;
    if (path.startsWith('coe/')) {
      const art = String(pin.artikel).replace(/^0+/, '');
      const under = pin.underartikel ? `P${pin.underartikel.replace(/^0+/, '')}` : '';
      const punkt = pin.punkt ? `L${pin.punkt.toLowerCase()}` : '';
      return `${uri}#A${art}${under}${punkt}`;
    }
    if (path.startsWith('untc/') || path.startsWith('icrc/')) {
      const entry = TREATY_PIN_DATA[path];
      const val = parseInt(pin.artikel, 10);
      if (entry && (val < 1 || val > entry.last_article)) {
        return uri;
      }
      const anchor = entry?.anchor || 'A';
      const written = entry?.numerals === 'roman' ? toRoman(val) : String(val);
      return `${uri}#${anchor}${written}`;
    }
    const frag = euFragment(pin);
    return uri + (frag ? '#' + frag : '');
  }

  _article_specs(node) {
    const items = [];
    for (const s of node.iter_subtrees_topdown()) {
      if (s.data === 'artikel_item') items.push(s);
    }

    const out = [];
    for (const it of items) {
      const d = findRefids(it);
      const span = items.length === 1
        ? [nodeSpan(subtree(node, 'artikel_part'))[0], nodeSpan(node)[1]]
        : nodeSpan(it);
      const letters = [];
      for (const s of it.iter_subtrees_topdown()) {
        if (s.data === 'punkt_ref_id') letters.push(s);
      }
      const makeSpec = (sp, punkt) => {
        const stycke = d.stycke ? (ORDINALS[d.stycke] || d.stycke) : null;
        return [new Pinpoint(d.artikel, d.underartikel, stycke, punkt), sp];
      };
      if (letters.length <= 1) {
        out.push(makeSpec(span, letters.length ? tokenText(letters[0]) : null));
      } else {
        for (const l of letters) {
          out.push(makeSpec(nodeSpan(l), tokenText(l)));
        }
      }
    }
    return out;
  }

  _recital_specs(node) {
    const items = [];
    for (const it of node.iter_subtrees_topdown()) {
      if (it.data === 'skal_item') items.push(it);
    }
    const partSpan = nodeSpan(subtree(node, 'skal_part'));
    return items.map(it => [
      findRefids(it).skal,
      items.length === 1 ? partSpan : nodeSpan(it)
    ]);
  }

  _act_span(node) {
    return nodeSpan(subtree(node, 'rattsakt_part'));
  }

  _emit_uris(out, specs, node, build) {
    if (!specs.length) {
      out.push({ _uri: build(NO_PINPOINT), _span: nodeSpan(node) });
      return;
    }
    for (const [pin, span] of specs) {
      out.push({ _uri: build(pin), _span: span });
    }
  }

  _emit_recitals(out, node, act_uri) {
    for (const [recital, span] of this._recital_specs(node)) {
      out.push({ _uri: `${act_uri}#recital-${recital}`, _span: span });
    }
  }

  _emit_act_ref(out, node, parts, specs, build) {
    if (parts.has('skal_item')) {
      const act_uri = build(NO_PINPOINT);
      this._emit_recitals(out, node, act_uri);
      if (!specs.length) {
        out.push({ _uri: act_uri, _span: this._act_span(node) });
        return;
      }
    }
    this._emit_uris(out, specs, node, build);
  }

  fmt_eu_ref(node, match, out, context) {
    const parts = new Set();
    for (const sub of node.iter_subtrees()) {
      parts.add(sub.data);
    }
    const specs = parts.has('artikel_item') ? this._article_specs(node) : [];

    if (parts.has('eu_treaty')) {
      const treatyKey = tokenText(subtree(node, 'eu_treaty')).toLowerCase();
      const path = TREATIES_DATA[treatyKey];
      if (!path) throw new NoLink();
      this._emit_uris(out, specs, node, pin => this._treaty_uri(path, pin));
      return;
    }

    if (parts.has('eu_namnakt')) {
      const nameKey = tokenText(subtree(node, 'eu_namnakt')).toLowerCase();
      const celex = this.named_acts[nameKey];
      if (!celex) throw new NoLink();
      this._emit_act_ref(out, node, parts, specs, pin => this._eu_celex_uri(celex, pin));
      return;
    }

    let isBare = true;
    for (const p of parts) {
      if (!BARE_PARTS.has(p)) { isBare = false; break; }
    }

    if (parts.has('eu_generic') || isBare) {
      if (parts.has('eu_generic')) {
        const tail = this._scan_text.slice(this._scan_base + nodeSpan(node)[1], this._scan_base + nodeSpan(node)[1] + 16);
        if (/^\s*\((?:EEG|EG|EU|Euratom)\)|^\s*(?:nr\s*)?\d{2,4}\/\d/.test(tail)) {
          throw new NoLink();
        }
      }
      if (isBare) {
        const tail = this._scan_text.slice(this._scan_base + nodeSpan(node)[1], this._scan_base + nodeSpan(node)[1] + 14);
        const guard = this.lang === 'eng'
          ? /^\s*(?:,|and|or)\s*\d|^\s+of\s|^\s+(?:[Rr]egulation|[Dd]irective)\b/
          : /^\s*(?:,|och|eller|samt)\s*\d|^\s+i\s|^\s+(?:förordning|direktiv)/;
        if (guard.test(tail)) throw new NoLink();
      }
      let target = (isBare ? this.state.self_eu_act : null) || this.state.last_eu_act;
      if (parts.has('eu_generic')) {
        const genTok = treeTokens(subtree(node, 'eu_generic')).find(t => t.type === 'EU_GENERIC');
        const akttyp = genTok ? EU_GENERIC_AKTTYP[genTok.value.toLowerCase()] : null;
        if (akttyp && eu_akttyp(target) !== akttyp) {
          target = this.state.last_eu_act_by_akttyp.get(akttyp) || null;
        }
      }
      if (!target) throw new NoLink();
      this._emit_act_ref(out, node, parts, specs, pin => this._eu_celex_uri(target, pin, false));
      return;
    }

    const attrs = findRefids(node);
    const tokens = treeTokens(node);
    for (const t of tokens) {
      if (['DIREKTIV', 'FORORDNING', 'REKOMMENDATION', 'BESLUT'].includes(t.type)) {
        attrs.akttyp = t.value.replace(/en$/, '').replace(/et$/, '');
      }
    }
    if (!attrs.akttyp) {
      if (parts.has('direktiv_part')) attrs.akttyp = 'direktiv';
      else if (parts.has('forordning_part')) attrs.akttyp = 'förordning';
    }
    if (parts.has('forordning_part') && attrs.ar && attrs.lopnummer &&
        !tokens.some(t => t.type === 'NR' || t.type === 'NO_EN')) {
      const tmp = attrs.ar;
      attrs.ar = attrs.lopnummer;
      attrs.lopnummer = tmp;
    }
    const act = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (!['artikel', 'underartikel', 'stycke', 'punkt'].includes(k)) {
        act[k] = v;
      }
    }
    if (parts.has('skal_item')) {
      this._emit_recitals(out, node, celexUri(act, this.base));
      if (!specs.length) {
        this.emit(attrs, match, out, context, this._act_span(node));
        return;
      }
    }
    if (!specs.length) {
      this.emit(attrs, match, out, context, nodeSpan(node));
      return;
    }
    for (const [pin, span] of specs) {
      const d = { ...act, artikel: pin.artikel };
      if (pin.underartikel) d.underartikel = pin.underartikel;
      if (pin.stycke) d.stycke = pin.stycke;
      if (pin.punkt) d.punkt = pin.punkt;
      this.emit(d, match, out, context, span);
    }
  }

  // RATTSFALL
  fmt_nja_referat(node, match, out, context) {
    const a = findRefids(node);
    out.push({ _uri: `${this.base}dom/nja/${a.year}s${a.sidnr}` });
  }

  fmt_nja_notis(node, match, out, context) {
    const a = findRefids(node);
    out.push({ _uri: `${this.base}dom/nja/${a.year}/not/${a.notnr}` });
  }

  fmt_court_referat(node, match, out, context) {
    const a = findRefids(node);
    out.push({ _uri: rattsfallUri(a.court, a.year, ':' + a.rf_lopnr, this.base) });
  }

  fmt_court_notis(node, match, out, context) {
    const a = findRefids(node);
    out.push({ _uri: rattsfallUri(a.court, a.year, '/not/' + a.notnr, this.base) });
  }

  // FORARBETEN
  fmt_forarb_doc(node, match, out, context) {
    out.push({ _uri: this.forarb_doc_uri(node.children[0]) });
  }

  fmt_forarb_refs(node, match, out, context) {
    const doc = node.children[0];
    const base = this.forarb_doc_uri(doc.children[0]);
    this.emit_pages(node, base, out, nodeSpan(doc)[0]);
  }

  fmt_anon_prop_refs(node, match, out, context) {
    if (!this.state.last_forarbete) throw new NoLink();
    this.emit_pages(node, this.state.last_forarbete, out, node.children[0].start_pos);
  }

  emit_pages(node, base, out, doc_start) {
    const pages = [];
    for (const s of node.iter_subtrees_topdown()) {
      if (s.data === 'sida_num') pages.push(s);
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const [pstart, pend] = nodeSpan(page);
      const span = [i === 0 ? doc_start : pstart, pend];
      out.push({ _uri: `${base}#sid${tokenText(page)}`, _span: span });
    }
  }

  fmt_avsnitt_external(node, match, out, context) {
    const komm = context ? context.kommittensbetankande : null;
    if (!komm) throw new NoLink();
    const base = this.base + 'sou/' + komm;
    for (const frag of this.avsnitt_frags(node)) {
      out.push({ _uri: `${base}#${frag}` });
    }
  }

  fmt_avsnitt_list(node, match, out, context) {
    const base = this.context_doc_uri(context);
    if (!base) throw new NoLink();
    for (const frag of this.avsnitt_frags(node)) {
      out.push({ _uri: `${base}#${frag}` });
    }
  }

  forarb_doc_uri(inner) {
    if (inner.data === 'celex_ref') {
      const txt = tokenText(inner);
      let [year, lopnr] = txt.slice(1).split('L');
      if (year.length === 2) year = '19' + year;
      return `${this.base}celex/3${year}L${lopnr}`;
    }
    if (inner.data === 'prop_ref') {
      const body = inner.children.find(c => c instanceof Tree);
      const riksmote = riksmoteStr(subtree(body, 'riksmote_ref_id'));
      let lopnr = tokenText(subtree(body, 'lopnr_ref_id'));
      if (body.data === 'prop_x') {
        const sub = tokenText(subtree(body, 'subriksmote_ref_id'));
        if (sub !== 'A') lopnr = sub + lopnr;
      }
      const uri = `${this.base}prop/${riksmote}:${lopnr}`;
      this.state.last_forarbete = uri;
      return uri;
    }
    const riksmote = riksmoteStr(subtree(inner, 'riksmote_ref_id'));
    let no = tokenText(inner.data === 'bet_ref' ? subtree(inner, 'bet_no_ref_id') : subtree(inner, 'lopnr_ref_id'));
    if (inner.data === 'dir_ref') {
      no = String(parseInt(no, 10));
    }
    const prefix = DOC_PREFIX[inner.data];
    return `${this.base}${prefix}/${riksmote}:${no}`;
  }

  context_doc_uri(context) {
    if (!context || !['type', 'year', 'no'].every(k => k in context)) return null;
    const prefix = context.type.includes('Proposition') ? 'prop' : 'sou';
    return `${this.base}${prefix}/${context.year}:${context.no}`;
  }

  avsnitt_frags(node) {
    const frags = [];
    for (const s of node.iter_subtrees_topdown()) {
      if (s.data === 'avsnitt_ref_id') {
        frags.push('S' + tokenText(s).replace(/\./g, '-'));
      }
    }
    return frags;
  }

  // EURATTSFALL
  fmt_ecj_ref(node, match, out, context) {
    let hasDecision = false;
    let decision = 'C';
    for (const s of node.iter_subtrees_topdown()) {
      if (s.data === 'ecj_decision') {
        hasDecision = true;
        decision = tokenText(s);
      }
    }
    const serial = tokenText(subtree(node, 'ecj_serial'));
    let year = tokenText(subtree(node, 'ecj_year'));
    if (year.length === 2) {
      year = (parseInt(year, 10) < 54 ? '20' : '19') + year;
    }
    const intYear = parseInt(year, 10);
    if (!hasDecision && (intYear < 1954 || intYear > 1989)) {
      throw new NoLink();
    }
    const celex = `6${year}${decision}J${String(parseInt(serial, 10)).padStart(4, '0')}`;
    out.push({ _uri: this.base + 'celex/' + celex });
  }

  // FORESKRIFT
  fmt_foreskrift_ref(node, match, out, context) {
    const toks = {};
    for (const t of treeTokens(node)) toks[t.type] = t.value;
    const [arsutgava, lopnummer] = toks.FS_NUMBER.split(':');
    out.push({
      _uri: `${this.base}${FS_SLUG[toks.FS_DESIGNATION]}/${arsutgava}:${parseInt(lopnummer, 10)}`,
      _span: nodeSpan(node),
    });
  }

  // MYNDIGHETSBESLUT
  fmt_arn_refs(node, match, out, context) {
    for (const [dnr, span] of avgIds(node, 'arn_ref_id')) {
      out.push({ _uri: this.base + 'avg/arn/' + dnr, _span: span });
    }
  }

  fmt_jo_refs(node, match, out, context) {
    for (const [dnr, span] of avgIds(node, 'jo_ref_id')) {
      out.push({ _uri: this.base + 'avg/jo/' + dnr, _span: span });
    }
  }

  fmt_jo_arsb_ref(node, match, out, context) {
    const nums = treeTokens(node).filter(t => t.type === 'NUMBER').map(t => t.value);
    let [y1, y2, page] = nums;
    if (y1.length === 2) y1 = '19' + y1;
    const dnrs = JO_ARSBERATTELSE[`${y1}/${y2} s. ${page}`] || [];
    if (dnrs.length === 1) {
      out.push({ _uri: this.base + 'avg/jo/' + dnrs[0] });
    }
  }

  fmt_jk_refs(node, match, out, context) {
    for (const [dnr, span] of avgIds(node, 'jk_ref_id')) {
      if (!jkIsDate(dnr)) {
        out.push({ _uri: this.base + 'avg/jk/' + dnr, _span: span });
      }
    }
  }

  // STALLNINGSTAGANDE
  fmt_skv_st_refs(node, match, out, context) {
    for (const [dnr, span] of avgIds(node, 'skv_st_ref_id')) {
      out.push({ _uri: this.base + 'rs/skv/' + numberSlug(dnr), _span: span });
    }
  }

  // VAGLEDNING
  _vagledning(node, serie, out) {
    const slug = vagledningSlug(tokenText(subtree(node, 'vl_id')));
    const year = parseInt(slug.split('-').pop(), 10);
    if (year < EDPB_FOUNDED) return;
    out.push({
      _uri: `${this.base}guidance/edpb/${serie}/${slug}`,
      _span: nodeSpan(node),
    });
  }

  fmt_riktlinje_ref(node, match, out, context) {
    this._vagledning(node, 'riktlinjer', out);
  }

  fmt_rekommendation_ref(node, match, out, context) {
    this._vagledning(node, 'rekommendationer', out);
  }

  fmt_wp_ref(node, match, out, context) {
    const number = tokenText(subtree(node, 'wp_id'));
    if (number === WP29_GROUP) return;
    out.push({
      _uri: this.base + 'guidance/edpb/wp/' + number,
      _span: nodeSpan(node),
    });
  }

  _guidance_number(node, path, out) {
    out.push({ _uri: this.base + 'guidance/' + path, _span: nodeSpan(node) });
  }

  _slashed(node, name) {
    const parts = tokenText(subtree(node, name)).split('/');
    const ar = parts[parts.length - 2];
    const lopnummer = parseInt(parts[parts.length - 1], 10);
    return `${ar}-${String(lopnummer).padStart(2, '0')}`;
  }

  fmt_esrb_ref(node, match, out, context) {
    this._guidance_number(node, `esrb/${this._slashed(node, 'esrb_id')}`, out);
  }

  fmt_ecb_ref(node, match, out, context) {
    this._guidance_number(node, `ecb/con/${this._slashed(node, 'con_id')}`, out);
  }

  fmt_eba_ref(node, match, out, context) {
    const parts = tokenText(subtree(node, 'eba_id')).split('/');
    const serie = parts[1].toLowerCase();
    const ar = parts[2];
    const lopnummer = parseInt(parts[3], 10);
    this._guidance_number(node, `eba/${serie}/${ar}-${String(lopnummer).padStart(2, '0')}`, out);
  }

  fmt_esma_ref(node, match, out, context) {
    this._guidance_number(node, `esma/riktlinjer/${ownNumberSlug(tokenText(subtree(node, 'esma_id')))}`, out);
  }

  fmt_berec_ref(node, match, out, context) {
    this._guidance_number(node, `berec/riktlinjer/${ownNumberSlug(tokenText(subtree(node, 'bor_id')))}`, out);
  }
}

export function paragrafAnchor(kapitel, paragraf, stycke = null) {
  const par = String(paragraf).replace(/\s+/g, '');
  const anchor = kapitel ? `K${String(kapitel).replace(/\s+/g, '')}P${par}` : `P${par}`;
  return stycke ? `${anchor}S${stycke}` : anchor;
}

const RE_ENG_SFS = /\bSFS[:\s]\s*(\d{4}:\d{1,4})\b/g;
const RE_ENG_PINPOINT = /(?:chapter|chap\.|ch\.)\s*(\d+)[,\s]+(?:sections?|sec\.|s\.)\s*(\d+(?:\s?[a-h])?)\b(?:\s*,?\s*(?:para\.|paragraph)\s*(\d+)\b)?/gi;
const RE_ENG_GAP = /^[\s,)]{0,6}$/;
const RE_SFS_URI_TAIL = /\/\d{4}:\d{1,4}(?:_s\.\d+)?$/;

export function _english_sfs_spans(text, base = 'https://lagen.nu/') {
  const out = [];
  const re = new RegExp(RE_ENG_SFS.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length, lagrumUri({ law: m[1] }, base)]);
  }
  return out;
}

export function english_pinpoint_spans(text, anchors) {
  const out = [];
  const re = new RegExp(RE_ENG_PINPOINT.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    let anchor = null;
    for (const [end, uri] of anchors) {
      if (end <= m.index && !uri.includes('#') && RE_SFS_URI_TAIL.test(uri)) {
        if (RE_ENG_GAP.test(text.slice(end, m.index))) {
          if (!anchor || end > anchor[0]) {
            anchor = [end, uri];
          }
        }
      }
    }
    if (!anchor) continue;
    const fragment = paragrafAnchor(m[1], m[2], m[3]);
    out.push([m.index, m.index + m[0].length, `${anchor[1]}#${fragment}`]);
  }
  return out;
}

export function spans_as_refs(spans, orig, predicate = 'dcterms:references') {
  return spans.map(([start, end, uri]) => new Ref(start, end, orig.slice(start, end), predicate, uri));
}

export function yield_overlaps(unresolved, resolved) {
  return unresolved.filter(u => !resolved.some(r => u.start < r.end && r.start < u.end));
}

export function merge_refs(...lists) {
  let kept = [];
  for (const refs of lists) {
    kept = kept.concat(yield_overlaps(refs, kept));
  }
  return kept.sort((a, b) => a.start - b.start);
}

