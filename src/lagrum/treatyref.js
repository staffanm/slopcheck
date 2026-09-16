import { TREATY_NAMES_DATA } from './datasets.js';
import { Ref } from './lagrum.js';

const PREDICATE = 'dcterms:references';
const ARTICLE_WINDOW = 40;

const ROMAN_MAP = {
  I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
};

function parseRoman(str) {
  let val = 0;
  let prev = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    const curr = ROMAN_MAP[str[i].toUpperCase()] || 0;
    if (curr < prev) val -= curr;
    else { val += curr; prev = curr; }
  }
  return val;
}

function toRoman(num) {
  const lookup = [
    ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
    ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
    ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]
  ];
  let res = '';
  for (const [letter, val] of lookup) {
    while (num >= val) {
      res += letter;
      num -= val;
    }
  }
  return res;
}

function arabicNumber(str) {
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  return parseRoman(str);
}

function articleFragment(number, anchor = 'A', numerals = 'arabic') {
  const num = arabicNumber(number);
  const formatted = numerals === 'roman' ? toRoman(num) : String(num);
  return `${anchor}${formatted}`;
}

const RE_ARTICLE = /\b[Aa]rticles?\s+(\d{1,3}|[IVXLCDM]+)(?:\s*\(\d+\))*/gi;
const RE_OF_INSTRUMENT = /^\s+of\s+the\b/i;

function getInstruments() {
  const insts = {};
  if (TREATY_NAMES_DATA && TREATY_NAMES_DATA.instruments) {
    for (const entry of TREATY_NAMES_DATA.instruments) {
      insts[entry.target] = entry;
    }
  }
  return insts;
}

function getPatterns() {
  const patterns = [];
  if (TREATY_NAMES_DATA && TREATY_NAMES_DATA.instruments) {
    for (const entry of TREATY_NAMES_DATA.instruments) {
      for (const name of (entry.names || [])) {
        patterns.push({
          regex: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
          target: entry.target,
          name,
          len: name.length,
        });
      }
    }
  }
  return patterns.sort((a, b) => b.len - a.len);
}

function matchNamed(text) {
  const found = [];
  for (const { regex, target, name } of getPatterns()) {
    const re = new RegExp(regex.source, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      found.push({ start: m.index, end: m.index + m[0].length, target, name });
    }
  }
  const kept = [];
  found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  for (const item of found) {
    if (kept.some(k => item.start < k.end && k.start < item.end && (k.start !== item.start || k.end !== item.end))) {
      continue;
    }
    kept.push(item);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function binding(text, named, matchStart, matchEnd) {
  const insts = getInstruments();
  const near = named.filter(entry =>
    entry.start - matchEnd <= ARTICLE_WINDOW &&
    matchStart - entry.end <= ARTICLE_WINDOW &&
    insts[entry.target] && insts[entry.target].articles
  );
  if (!near.length) return [];
  if (!near.some(e => e.start >= matchEnd) && RE_OF_INSTRUMENT.test(text.slice(matchEnd))) {
    return [];
  }

  function distance(entry) {
    if (entry.start >= matchEnd) {
      return entry.start - matchEnd;
    }
    return 1000 + (matchStart - entry.end);
  }

  near.sort((a, b) => distance(a) - distance(b));
  const minEntry = near[0];
  const minDist = distance(minEntry);
  return near.filter(e => distance(e) === minDist);
}

function articleUri(target, number, base) {
  const insts = getInstruments();
  const entry = insts[target];
  if (!entry) return `${base}${target}`;
  const num = arabicNumber(number);
  if (num < 1 || (entry.last_article && num > entry.last_article)) {
    return `${base}${target}`;
  }
  const frag = articleFragment(number, entry.anchor || 'A', entry.numerals);
  return `${base}${target}#${frag}`;
}

export function spans(text, base = 'https://lagen.nu/') {
  const named = matchNamed(text);
  const out = [];
  const bound = new Set();

  const reArt = new RegExp(RE_ARTICLE.source, 'gi');
  let match;
  while ((match = reArt.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    const winners = binding(text, named, matchStart, matchEnd);
    if (!winners.length) continue;
    const number = match[1];
    for (const w of winners) {
      bound.add(`${w.start}:${w.end}:${w.target}`);
      const uri = articleUri(w.target, number, base);
      // Span starts from article match, or encompasses both if name is immediately beside
      out.push([matchStart, Math.max(matchEnd, w.end), uri]);
    }
  }

  for (const item of named) {
    if (!bound.has(`${item.start}:${item.end}:${item.target}`)) {
      out.push([item.start, item.end, `${base}${item.target}`]);
    }
  }

  return out.sort((a, b) => a[0] - b[0]);
}

export function refs(text, base = 'https://lagen.nu/', predicate = PREDICATE) {
  return spans(text, base).map(([start, end, uri]) =>
    new Ref(start, end, text.slice(start, end), predicate, uri)
  );
}

export function references(text, base = 'https://lagen.nu/') {
  return spans(text, base).map(([start, end, uri]) => ({
    uri,
    predicate: PREDICATE,
    text: text.slice(start, end),
  }));
}
