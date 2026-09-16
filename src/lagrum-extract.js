import { extractionText, originalOccurrences } from './analysis.js';
import {
  ALL_PARSE_TYPES,
  citationSource,
  LagrumParser,
} from './lagrum/lagrum.js';
import {
  ABBREVIATIONS_DATA,
  CITATION_NAMES,
  FS_SLUG,
  NAMEDACTS_DATA,
  NAMEDLAWS_DATA,
} from './lagrum/datasets.js';
import { resolve } from './lagrum/resolve.js';
import * as treatyref from './lagrum/treatyref.js';

let defaultParser = null;

export function getLocalParser() {
  if (!defaultParser) {
    defaultParser = new LagrumParser(NAMEDLAWS_DATA, {
      basefile: 'query',
      abbreviations: ABBREVIATIONS_DATA,
      named_acts: NAMEDACTS_DATA,
      parse_types: ALL_PARSE_TYPES,
    });
  }
  return defaultParser;
}

const _IDENTIFIERS = new RegExp(
  "https://lagen\\.nu/[^\\s<>\"'\\u201d]+" +
  "|\\bECLI:[A-Z]{2}:[A-Z0-9.]+:[0-9]{4}:[A-Z0-9.]+" +
  "|\\b(?:CELEX\\s*:\\s*)?[01356][0-9]{4}[A-Z][A-Z0-9/()_-]*" +
  "|\\bICC-[0-9]+/[0-9]+-[0-9]+/[0-9]+-[0-9]+(?:-[A-Z0-9]+)*" +
  "|\\b(?:ICJ\\s+)?[0-9]{3}[-_][0-9]{8}[-_][A-Z]{3}[-_][0-9]{2}[-_][0-9]{2}" +
  "(?:[-_](?:EN|FR|BI)C?)?(?:\\.pdf)?" +
  "|\\b(?:C?ETS\\s*(?:No\\.?\\s*)?|CoE\\s+|ICRC\\s+)[0-9]+" +
  "|\\bUNTC\\s+[IV]+-[0-9]+" +
  "|\\b(?:HUDOC\\s+)?001-[0-9]+" +
  "|\\bSFS\\s+[0-9]{4}:-?[0-9]+",
  "gi"
);

const _NJA = /\bNJA\s+[0-9]{4}\s*s\.?\s*-?[0-9]+(?:\s*[-–]\s*[0-9]+|[.,][0-9]+)?(?:\s+[IVX]+\b)?/gi;

const _ICJ_REPORT = /I\.?\s?C\.?\s?J\.?\s+Reports\s+(\d{4})\s*(?:\(([IVX]+)\))?,?\s*(?:at\s+)?pp?\.\s*(\d+)/gi;

const _PINPOINT = "(?:[0-9]+\\s*[a-z]?\\s*kap\\.?\\s*)?[0-9]+(?:\\s?[a-z]\\b)?\\s*§";
const _BEFORE_PROVISION = new RegExp(_PINPOINT + "(?:\\s+i)?\\s*$", "i");
const _AFTER_PROVISION = new RegExp("^\\s+(?:" + _PINPOINT + "|[0-9]+:[0-9]+[a-z]?)", "i");

let cachedNamesRe = null;
function getNamesRegex() {
  if (!cachedNamesRe) {
    const escaped = (CITATION_NAMES || []).map(name =>
      name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
    );
    cachedNamesRe = new RegExp(
      "(?<![\\w\\u00E5\\u00E4\\u00F6\\u00C5\\u00C4\\u00D6])(?:" + escaped.join("|") +
      ")(?![\\w\\u00E5\\u00E4\\u00F6\\u00C5\\u00C4\\u00D6])(?:\\s+(?:art(?:ikel|icle)?\\.?\\s*)?" +
      "[0-9]+(?:\\s*kap\\.?\\s*[0-9]+\\s*§|[.:][0-9]+|\\s*§)?)?",
      "gi"
    );
  }
  return cachedNamesRe;
}

let cachedRegsRe = null;
function getRegulationsRegex() {
  if (!cachedRegsRe) {
    const slugs = Object.keys(FS_SLUG).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    cachedRegsRe = new RegExp(`\\b(?:${slugs.join('|')})\\s*[0-9]{4}:[0-9]+`, 'gi');
  }
  return cachedRegsRe;
}

function* candidates(value) {
  const regsRe = getRegulationsRegex();
  const patterns = [
    _IDENTIFIERS,
    _NJA,
    _ICJ_REPORT,
    getNamesRegex(),
    regsRe,
  ];

  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(value)) !== null) {
      let start = match.index;
      let end = match.index + match[0].length;
      let surface = value.slice(start, end).replace(/[.,;!?]+$/, '');
      for (const [left, right] of [['[', ']'], ['(', ')']]) {
        const countRight = (surface.match(new RegExp('\\' + right, 'g')) || []).length;
        const countLeft = (surface.match(new RegExp('\\' + left, 'g')) || []).length;
        const trailingRight = surface.length - surface.replace(new RegExp('\\' + right + '+$'), '').length;
        const excess = Math.min(countRight - countLeft, trailingRight);
        if (excess > 0) {
          surface = surface.slice(0, -excess);
        }
      }
      end = start + surface.length;

      if (pattern === regsRe) {
        const beforeWindow = value.slice(Math.max(0, start - 80), start);
        const beforeMatch = _BEFORE_PROVISION.exec(beforeWindow);
        const afterWindow = value.slice(end);
        const afterMatch = _AFTER_PROVISION.exec(afterWindow);
        if (beforeMatch) {
          start = Math.max(0, start - 80) + beforeMatch.index;
        } else if (afterMatch) {
          end += afterMatch[0].length;
        }
      }
      yield [start, end];
    }
  }
}

export function extractLocal(blocks) {
  const normalized = blocks.map(block => ({ id: block.id, ...extractionText(block.text) }));
  const value = normalized.map(b => b.text).join('\n');
  const parser = getLocalParser();
  parser.reset();

  try {
    const refs = parser.parse_text(value, {});
    const treatyRefs = treatyref.refs(value);
    const allRefs = refs.concat(treatyRefs);

    const grouped = new Map();
    for (const ref of allRefs) {
      const source = citationSource(ref.uri);
      if (source) {
        const key = `${ref.start},${ref.end}`;
        if (!grouped.has(key)) {
          grouped.set(key, { start: ref.start, end: ref.end, targets: new Map() });
        }
        grouped.get(key).targets.set(ref.uri, source);
      }
    }

    const interpreted = new Map();
    for (const [start, end] of candidates(value)) {
      const key = `${start},${end}`;
      const query = value.slice(start, end).split(/\s+/).join(' ');
      const isNja = /^\bNJA\s+[0-9]{4}\s*s\.?\s*-?[0-9]+(?:\s*[-–]\s*[0-9]+|[.,][0-9]+)?(?:\s+[IVX]+\b)?$/i.test(query);
      if (grouped.has(key) && !isNja) {
        continue;
      }
      if (!interpreted.has(query)) {
        const hits = resolve(query);
        const targetMap = new Map();
        for (const hit of hits) {
          targetMap.set(hit.uri, hit.source);
        }
        interpreted.set(query, targetMap);
      }
      grouped.set(key, { start, end, targets: new Map(interpreted.get(query)) });
    }

    // Sort by start ascending, then length descending
    const items = Array.from(grouped.values()).sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });

    // Keep outer spans, suppressing nested/partial matches
    const selected = [];
    for (const item of items) {
      if (selected.length && item.start < selected[selected.length - 1].end) {
        continue;
      }
      selected.push(item);
    }

    // Calculate block boundary offsets in the joined string
    const starts = [];
    let cursor = 0;
    for (const block of normalized) {
      starts.push(cursor);
      cursor += block.text.length + 1;
    }

    const occurrences = [];
    for (const { start, end, targets } of selected) {
      const locations = [];
      for (let i = 0; i < normalized.length; i++) {
        const bStart = starts[i];
        const bLen = normalized[i].text.length;
        const bEnd = bStart + bLen;
        if (bStart < end && bEnd > start) {
          const left = Math.max(0, start - bStart);
          const right = Math.min(bLen, end - bStart);
          if (left < right) {
            locations.push({
              block_id: normalized[i].id,
              start: left,
              end: right,
            });
          }
        }
      }
      occurrences.push({
        text: value.slice(start, end),
        locations,
        targets: Array.from(targets.entries()).map(([uri, source]) => ({ uri, source })),
      });
    }

    return originalOccurrences(occurrences, blocks, normalized);
  } finally {
    parser.reset();
  }
}
