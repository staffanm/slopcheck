import { CASENUMBERS_DATA } from './datasets.js';
import { Ref } from './lagrum.js';

export const COURT_LETTERS = "B Ö T A M UM P ÖH ÖÄ F PMT Ä FT PMÖ PMÖÄ ÖM H PMÄ ÖP UMS ÖF PMFT K PMB TVA ÖVA ÖÅ X".split(" ");

const COURT_LETTERS_SORTED = COURT_LETTERS.slice().sort((a, b) => b.length - a.length);

export const CASE_NUMBER = new RegExp(
  "(?<![\\w\\u00E5\\u00E4\\u00F6\\u00C5\\u00C4\\u00D6-])(?:(" +
  COURT_LETTERS_SORTED.join("|") +
  ")[ -]?)?(\\d{1,5}-\\d{2,4})(?![-\\d])",
  "gi"
);

export const COURT_PHRASES = {
  "högsta domstolen": ["HDO"],
  "hd": ["HDO"],
  "högsta förvaltningsdomstolen": ["HFD"],
  "hfd": ["HFD"],
  "regeringsrätten": ["REGR"],
  "regr": ["REGR"],
  "arbetsdomstolen": ["ADO"],
  "ad": ["ADO"],
  "mark- och miljööverdomstolen": ["MMOD", "MOD"],
  "miljööverdomstolen": ["MOD", "MMOD"],
  "möd": ["MMOD", "MOD"],
  "migrationsöverdomstolen": ["MIOD"],
  "mig": ["MIOD"],
  "marknadsdomstolen": ["MDO"],
  "patent- och marknadsöverdomstolen": ["PMOD"],
  "pmöd": ["PMOD"],
  "patentbesvärsrätten": ["PBR"],
  "svea hovrätt": ["HSV", "HYOD", "MMOD", "MOD", "PMOD"],
  "göta hovrätt": ["HGO"],
  "hovrätten över skåne och blekinge": ["HSB"],
  "hovrätten för västra sverige": ["HVS"],
  "hovrätten för nedre norrland": ["HNN"],
  "hovrätten för övre norrland": ["HON"],
  "kammarrätten i stockholm": ["KST"],
  "kammarrätten i göteborg": ["KGG"],
  "kammarrätten i jönköping": ["KJO"],
  "kammarrätten i sundsvall": ["KSU"],
  "rättshjälpsnämnden": ["RHN"],
};

const COURT_WINDOW = 90;
const DATE_GAP = 3;

const PHRASES_SORTED = Object.keys(COURT_PHRASES).sort((a, b) => b.length - a.length);
const RE_COURT = new RegExp(`\\b(${PHRASES_SORTED.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?::?s|ens)?\\b`, 'gi');
const RE_MAL = /\b(?:i\s+)?mål(?:et|en|nr|nummer)?\.?\s*(?:nr\.?\s*)?$/i;
const RE_ISO_DATE = /\b(?:19|20)\d\d-\d\d-\d\d\b/g;
const RE_OTHER_COURT = /\b\w*(?:tingsrätt|hovrätt|kammarrätt|förvaltningsrätt|domstol|nämnd)\w*/i;

const MONTH_MAP = {
  januari: '01', februari: '02', mars: '03', april: '04', maj: '05', juni: '06',
  juli: '07', augusti: '08', september: '09', oktober: '10', november: '11', december: '12',
};
const MONTHS_PATTERN = Object.keys(MONTH_MAP).join('|');
const RE_SV_DATE = new RegExp(`\\b(?:den\\s+)?(\\d{1,2})\\s+(${MONTHS_PATTERN})\\s+(\\d{4})\\b`, 'gi');

function canonical(letters, number) {
  return letters ? `${letters.toUpperCase()} ${number}` : number;
}

export function normalize(text) {
  return text.replace(CASE_NUMBER, (_, letters, number) => canonical(letters, number));
}

function courtNamed(before) {
  const matches = [];
  let m;
  const re = new RegExp(RE_COURT.source, 'gi');
  while ((m = re.exec(before)) !== null) {
    matches.push({ phrase: m[1].toLowerCase(), end: re.lastIndex });
  }
  if (!matches.length) return [];
  const last = matches[matches.length - 1];
  const afterLast = before.slice(last.end);
  if (RE_OTHER_COURT.test(afterLast)) return [];
  return COURT_PHRASES[last.phrase] || [];
}

function dateNamed(before) {
  const dates = [];
  let m;
  const reIso = new RegExp(RE_ISO_DATE.source, 'g');
  while ((m = reIso.exec(before)) !== null) {
    dates.push({ date: m[0], end: reIso.lastIndex });
  }
  const reSv = new RegExp(RE_SV_DATE.source, 'gi');
  while ((m = reSv.exec(before)) !== null) {
    const day = String(parseInt(m[1], 10)).padStart(2, '0');
    const month = MONTH_MAP[m[2].toLowerCase()];
    const year = m[3];
    dates.push({ date: `${year}-${month}-${day}`, end: reSv.lastIndex });
  }
  if (!dates.length) return null;
  dates.sort((a, b) => a.end - b.end);
  const last = dates[dates.length - 1];
  return { date: last.date, gap: before.length - last.end };
}

function resolveNumber(number, before, snapshot) {
  const candidates = snapshot.numbers ? snapshot.numbers[number] : null;
  if (!candidates || !candidates.length) return null;
  const courts = courtNamed(before);
  if (!courts.length) return null;
  const dated = dateNamed(before);
  if (!(RE_MAL.test(before) || number.includes(' ') || (dated && dated.gap <= DATE_GAP))) {
    return null;
  }
  const courtSet = new Set(courts);
  let matched = candidates.filter(c => courtSet.has(c[0]));
  if (dated) {
    const withDate = matched.filter(c => c[1] === dated.date);
    if (withDate.length > 0) {
      matched = withDate;
    }
  }
  return matched.length === 1 ? matched[0] : null;
}

export function spans(text, base = 'https://lagen.nu/', snapshot = CASENUMBERS_DATA) {
  if (!snapshot || !snapshot.numbers) return [];
  const out = [];
  const re = new RegExp(CASE_NUMBER.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const can = canonical(m[1], m[2]);
    const before = text.slice(Math.max(0, m.index - COURT_WINDOW), m.index);
    const found = resolveNumber(can, before, snapshot);
    if (found) {
      out.push([m.index, m.index + m[0].length, base + found[2]]);
    }
  }
  return out;
}

export function refs(text, base = 'https://lagen.nu/', predicate = 'dcterms:references', orig = text, snapshot = CASENUMBERS_DATA) {
  return spans(text, base, snapshot).map(([start, end, uri]) =>
    new Ref(start, end, orig.slice(start, end), predicate, uri)
  );
}
