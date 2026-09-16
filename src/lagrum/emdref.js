import EMD_CASES_DEFAULT from './casenames.json' with { type: 'json' };
import { EMD_RESPONDENTS_DATA } from './datasets.js';
import { Ref, yield_overlaps } from './lagrum.js';

const PREDICATE = 'dcterms:references';
const ECHR_LOCAL = 'dom/echr/';

const APPLICANT_WINDOW = 60;
const RESPONDENT_WINDOW = 45;

const RE_SERIAL_AFTER = /^\s*\((?:nr|no\.?)\s*(\d+)\)/i;
const MONTH_MAP = {
  januari: '01', februari: '02', mars: '03', april: '04', maj: '05', juni: '06',
  juli: '07', augusti: '08', september: '09', oktober: '10', november: '11', december: '12',
};
const MONTHS_PATTERN = Object.keys(MONTH_MAP).join('|');

const RE_DATE_AFTER = new RegExp(`^[^.;()]{0,60}?\\bden\\s+(\\d{1,2})\\s+(${MONTHS_PATTERN})\\s+(\\d{4})`, 'i');
const RE_DATE_BEFORE = new RegExp(`\\bden\\s+(\\d{1,2})\\s+(${MONTHS_PATTERN})\\s+(\\d{4})[^.;()]{0,60}$`, 'i');

function parseSwedishDate(day, month, year) {
  const m = MONTH_MAP[month.toLowerCase()];
  if (!m) return null;
  const d = String(parseInt(day, 10)).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

export function fold_party_name(name) {
  const norm = (name || '').trim().split(/\s+/).join(' ').toLowerCase().replace(/\bthe\s+/g, ' ');
  return norm.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function pick(candidates, nearDate, { judgmentKey = 'j', exclude = null } = {}) {
  let list = candidates;
  if (exclude !== null) {
    list = list.filter(c => c[2] !== exclude);
  }
  if (nearDate) {
    const dated = list.filter(c => c[1] === nearDate);
    if (dated.length === 1) return dated[0];
  }
  const judgments = list.filter(c => c[0] === judgmentKey);
  if (judgments.length === 1) return judgments[0];
  if (list.length === 1) return list[0];
  return null;
}

function dateNear(text, start, end) {
  const before = text.slice(Math.max(0, start - 80), start);
  const after = text.slice(end, Math.min(text.length, end + 80));

  const matchAfter = RE_DATE_AFTER.exec(after);
  if (matchAfter) {
    return parseSwedishDate(matchAfter[1], matchAfter[2], matchAfter[3]);
  }
  const matchBefore = RE_DATE_BEFORE.exec(before);
  if (matchBefore) {
    return parseSwedishDate(matchBefore[1], matchBefore[2], matchBefore[3]);
  }
  return null;
}

function nameSpans(text, base, emdCases, respondentsSv) {
  const out = [];
  const reMot = /\smot\s/g;
  let m;
  while ((m = reMot.exec(text)) !== null) {
    const motIdx = m.index;
    const motEnd = m.index + m[0].length;

    const applicantWindow = text.slice(Math.max(0, motIdx - APPLICANT_WINDOW), motIdx);
    const respondentWindow = text.slice(motEnd, Math.min(text.length, motEnd + RESPONDENT_WINDOW));

    let matchedRespKey = null;
    let matchedRespLen = 0;
    const respLower = respondentWindow.toLowerCase();

    for (const [svName, keys] of Object.entries(respondentsSv)) {
      const svLow = svName.toLowerCase();
      if (respLower.startsWith(svLow)) {
        if (respLower.length === svLow.length || /[^a-z0-9åäö]/i.test(respLower[svLow.length])) {
          if (svLow.length > matchedRespLen) {
            matchedRespLen = svLow.length;
            matchedRespKey = keys;
          }
        }
      }
    }

    if (!matchedRespKey) continue;

    const afterResp = respondentWindow.slice(matchedRespLen);
    const serialMatch = RE_SERIAL_AFTER.exec(afterResp);
    const serial = serialMatch ? serialMatch[1] : '';
    const fullRespLen = matchedRespLen + (serialMatch ? serialMatch[0].length : 0);

    // Candidates before " mot "
    const appText = applicantWindow;
    const appWords = appText.split(/\s+/);
    let bestHit = null;

    for (let i = 0; i < appWords.length; i++) {
      const candidateApp = appWords.slice(i).join(' ').replace(/^[^\p{L}\p{N}]+/gu, '');
      if (!candidateApp) continue;
      const folded = fold_party_name(candidateApp);
      if (!folded) continue;

      for (const respKey of matchedRespKey) {
        const lookupKey = `${folded}|${respKey}|${serial}`;
        const candidates = emdCases.cases[lookupKey];
        if (candidates && candidates.length) {
          const appStartInWindow = appText.lastIndexOf(candidateApp);
          if (appStartInWindow !== -1) {
            const start = Math.max(0, motIdx - APPLICANT_WINDOW) + appStartInWindow;
            const end = motEnd + fullRespLen;
            const nearDate = dateNear(text, start, end);
            const picked = pick(candidates, nearDate);
            if (picked) {
              bestHit = [start, end, `${base}${ECHR_LOCAL}${picked[2]}`];
              break;
            }
          }
        }
      }
      if (bestHit) break;
    }

    if (bestHit) {
      out.push(bestHit);
    }
  }
  return out;
}

function appnoSpans(text, base, emdCases) {
  const out = [];
  const reList = /\b(?:ansökan|ansökningarna|ansökningar|klagomålen|klagomål)\s+nr\.?\s*(\d{3,5}\/\d{2}(?:(?:\s*(?:,|och)\s*)\d{3,5}\/\d{2})*)/gi;
  let m;
  while ((m = reList.exec(text)) !== null) {
    const listStr = m[1];
    const reApp = /\d{3,5}\/\d{2}/g;
    let am;
    while ((am = reApp.exec(listStr)) !== null) {
      const appno = am[0];
      const candidates = emdCases.appnos[appno];
      if (candidates && candidates.length) {
        const start = m.index;
        const end = m.index + m[0].length;
        const nearDate = dateNear(text, start, end);
        const picked = pick(candidates, nearDate);
        if (picked) {
          out.push([start, end, `${base}${ECHR_LOCAL}${picked[2]}`]);
        }
      }
    }
  }
  return out;
}

export function spans(text, base = 'https://lagen.nu/', emdCases = EMD_CASES_DEFAULT, respondentsSv = EMD_RESPONDENTS_DATA) {
  if (!emdCases || !emdCases.cases) return [];
  const appnos = appnoSpans(text, base, emdCases);
  const names = nameSpans(text, base, emdCases, respondentsSv);
  // Application number beats the case name printed beside it
  const kept = appnos.concat(names.filter(([ns, ne]) => !appnos.some(([as, ae]) => ns < ae && as < ne)));
  return kept.sort((a, b) => a[0] - b[0]);
}

export function refs(text, base = 'https://lagen.nu/', predicate = PREDICATE, orig = text, emdCases = EMD_CASES_DEFAULT, respondentsSv = EMD_RESPONDENTS_DATA) {
  return spans(text, base, emdCases, respondentsSv).map(([start, end, uri]) =>
    new Ref(start, end, orig.slice(start, end), predicate, uri)
  );
}
