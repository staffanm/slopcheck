const STOP = new Set('och att det den de en ett i på av för med som till är har om inte kan ska skall se enligt vid från eller detta denna dessa'.split(' '));

export function extractionText(text) {
  // Keep a boundary map in UTF-16 units. The API reads joined lines, while
  // document marks and context always refer to the original pasted text.
  let normalized = '';
  const offsets = [0];
  let cursor = 0;
  for (const match of text.matchAll(/\s+/gu)) {
    normalized += text.slice(cursor, match.index);
    for (let index = cursor; index < match.index; index++) offsets.push(index + 1);
    const replacement = (match[0].match(/\r\n|\r|\n/g)?.length ?? 0) > 1 ? '\n\n' : ' ';
    normalized += replacement;
    for (let index = 1; index <= replacement.length; index++) {
      offsets.push(match.index + Math.floor(match[0].length * index / replacement.length));
    }
    cursor = match.index + match[0].length;
  }
  normalized += text.slice(cursor);
  for (let index = cursor; index < text.length; index++) offsets.push(index + 1);
  return { text: normalized, offsets };
}

export function originalOccurrences(occurrences, blocks, normalized) {
  const originals = new Map(blocks.map(block => [block.id, block.text]));
  const maps = new Map(normalized.map(block => [block.id, block.offsets]));
  return occurrences.map(occurrence => {
    const locations = occurrence.locations.map(location => {
      const offsets = maps.get(location.block_id);
      if (!offsets || !Number.isInteger(location.start) || !Number.isInteger(location.end)
        || location.start < 0 || location.end <= location.start || location.end >= offsets.length) {
        throw new Error('API:t returnerar en position som saknas i dokumentet.');
      }
      return { ...location, start: offsets[location.start], end: offsets[location.end] };
    });
    return { ...occurrence, locations, text: locations.map(location => originals.get(location.block_id).slice(location.start, location.end)).join('\n') };
  });
}

export function citationSegments(block, occurrences) {
  // Split overlapping locations into non-overlapping runs. Each character is
  // rendered once, even when two occurrences share part of a span.
  const events = new Map([[0, []], [block.text.length, []]]);
  occurrences.forEach((occurrence, row) => {
    for (const location of occurrence.locations.filter(location => location.block_id === block.id)) {
      for (const [position, delta] of [[location.start, 1], [location.end, -1]]) {
        if (!events.has(position)) events.set(position, []);
        events.get(position).push({ row, delta });
      }
    }
  });
  const active = new Map();
  const segments = [];
  let start = 0;
  for (const end of [...events.keys()].sort((a, b) => a - b)) {
    if (end > start) segments.push({ start, end, rows: [...active.keys()].sort((a, b) => a - b) });
    for (const { row, delta } of events.get(end)) {
      const count = (active.get(row) ?? 0) + delta;
      if (count) active.set(row, count);
      else active.delete(row);
    }
    start = end;
  }
  return segments;
}

// The extract API splits a range such as "4-6 §§ räntelagen" or "4 och 6 §§
// räntelagen (1975:635)" into several occurrences. Merge consecutive
// occurrences of one block into one finding when only punctuation or a
// coordinating word separates them and they share a base source.
const CONNECTOR = /^[\s,–-]*(?:(?:och|samt|eller|respektive)[\s,]*)?$/u;

export function mergeOccurrences(occurrences, blocks) {
  const blockText = id => blocks.find(block => block.id === id)?.text ?? '';
  const base = target => target.uri.split('#')[0];
  const bases = occurrence => new Set((occurrence.targets ?? []).map(base));
  const single = occurrence => occurrence.locations.length === 1 ? occurrence.locations[0] : null;
  const merged = [];
  for (const occurrence of occurrences) {
    const previous = merged.at(-1);
    const a = previous && single(previous);
    const b = single(occurrence);
    if (a && b && a.block_id === b.block_id && b.start >= a.end
      && CONNECTOR.test(blockText(a.block_id).slice(a.end, b.start))
      && [...bases(occurrence)].some(uri => bases(previous).has(uri))) {
      const start = Math.min(a.start, b.start);
      const end = Math.max(a.end, b.end);
      previous.locations = [{ block_id: a.block_id, start, end }];
      previous.text = blockText(a.block_id).slice(start, end);
      const seen = new Set(previous.targets.map(target => target.uri));
      for (const target of occurrence.targets ?? []) if (!seen.has(target.uri)) { previous.targets.push(target); seen.add(target.uri); }
      continue;
    }
    merged.push({ ...occurrence, locations: [...occurrence.locations], targets: [...(occurrence.targets ?? [])] });
  }
  // "(1975:635)" after a provision names its act; it does not cite the whole act.
  for (const occurrence of merged) {
    const specific = new Set(occurrence.targets.filter(target => target.uri.includes('#')).map(base));
    occurrence.targets = occurrence.targets.filter(target => target.uri.includes('#') || !specific.has(base(target)));
  }
  return merged;
}

// One pass over a block that marks both the claim sentence and the citation for
// every row. Each segment lists the rows whose claim covers it and the rows
// whose citation covers it, so a citation can carry both a claim tint and its
// own border.
export function claimSegments(block, rows) {
  const spans = [];
  rows.forEach((row, index) => {
    for (const location of row.claim?.locations ?? []) if (location.block_id === block.id) spans.push({ index, kind: 'claim', ...location });
    for (const location of row.occurrence.locations) if (location.block_id === block.id) spans.push({ index, kind: 'cite', ...location });
  });
  const points = [...new Set([0, block.text.length, ...spans.flatMap(span => [span.start, span.end])])].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const cover = kind => [...new Set(spans.filter(span => span.kind === kind && span.start <= start && span.end >= end).map(span => span.index))].sort((a, b) => a - b);
    segments.push({ start, end, claimRows: cover('claim'), citeRows: cover('cite') });
  }
  return segments;
}

export function plainText(markdown) {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/[*_`#]/g, '').trim();
}

export function normalizeQuote(text) {
  return plainText(text).normalize('NFKC').toLocaleLowerCase('sv')
    .replace(/\u00ad/g, '').replace(/(\p{L})-\s*\n\s*(?=\p{L})/gu, '$1')
    .replace(/[“”„"'‘’]/g, '').replace(/\s+/g, ' ').trim();
}

// Mask only punctuation, never whitespace: every index remains a UTF-16 index
// into the original. Reuse this for claims and sources (including initials).
export function sentenceSegments(text, locations = []) {
  let masked = text
    .replace(/\b(?:t\.\s*ex|bl\.\s*a|d\.\s*v\.\s*s|dvs|m\.\s*fl|m\.\s*m|o\.\s*s\.\s*v|osv|p\.\s*g\.\s*a|s\.\s*k|jfr|prop|kap|st|bil|aktbil|nr|ref|not|avd|art|s|ff)\./gi, m => m.replace(/\./g, '_'))
    .replace(/(?:\b[A-ZÅÄÖ]\.)+(?=\s|[A-ZÅÄÖ])/g, m => m.replace(/\./g, '_'))
    .replace(/(^|\n)[^\p{L}\p{N}\r\n]*\d+(?:\.\d+)*\.(?=\s|\p{Lu})/gu, m => m.replace(/\./g, '_'))
    .replace(/\d\.(?=\d)/g, m => m.replace('.', '_'));
  for (const { start, end } of locations) masked = masked.slice(0, start)
    + masked.slice(start, end).replace(/[^\s]/g, 'X') + masked.slice(end);
  const result = [];
  // Blank lines delimit paragraphs even when headings have no punctuation.
  for (const paragraph of masked.matchAll(/[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g)) {
    for (const part of new Intl.Segmenter('sv', { granularity: 'sentence' }).segment(paragraph[0].replace(/[\r\n]/g, ' '))) {
      const index = paragraph.index + part.index;
      result.push({ index, segment: text.slice(index, index + part.segment.length) });
    }
  }
  return result;
}

// True when nothing but reference wording is left once the citations are
// removed: "Se …", "jfr …", "Detta följer även av …".
export const REFERENCE_SENTENCE = /(?<!\p{L})(?:detta|det)\s+följer\s+(?:även\s+|också\s+)?(?:av|enligt)(?!\p{L})/giu;

export function citationOnly(text) {
  return !text.replace(REFERENCE_SENTENCE, '').replace(/(?<!\p{L})(?:se|jfr|även|bl|a|t|ex|och)(?!\p{L})/giu, '').replace(/[^\p{L}\p{N}]/gu, '');
}

export function claimContext(occurrence, blocks) {
  const ranges = [];
  let incomplete = false;
  for (const location of occurrence.locations) {
    const block = blocks.find(item => item.id === location.block_id);
    if (!block || location.start < 0 || location.end > block.text.length) {
      throw new Error('API:t returnerar en position som saknas i dokumentet.');
    }
    const segments = sentenceSegments(block.text, [location]);
    const index = segments.findIndex(s => s.index <= location.start && s.index + s.segment.length > location.start);
    const segment = segments[index];
    if (!segment) continue;
    const withoutCitation = block.text.slice(segment.index, location.start) + block.text.slice(location.end, segment.index + segment.segment.length);
    const samePara = index > 0 && !/\n\s*\n/.test(block.text.slice(segments[index - 1].index, segment.index));
    // "…ansvarsområden. (Se prop. 2025/26:28, s. 149) Det finns…": a "(Se …)"
    // after a full stop refers back. It belongs to the sentence before, and the
    // sentence after it is not part of the claim.
    const back = /^\s*\((?:se|jfr)\b[^()]*\)/iu.exec(segment.segment);
    if (back && samePara && location.end <= segment.index + back[0].length) {
      ranges.push({ block_id: block.id, start: segments[index - 1].index, end: segment.index + back[0].length });
      continue;
    }
    const contextStart = citationOnly(withoutCitation) && samePara ? segments[index - 1].index : segment.index;
    ranges.push({ block_id: block.id, start: contextStart, end: segment.index + segment.segment.length });
    // A PDF page can end mid-sentence, before a stamp emitted out of reading
    // order. Join only an unambiguous lowercase continuation on the next page.
    if (/^PDF-sida/.test(block.label ?? '') && !/[.!?][”"')\]]*\s*$/.test(segment.segment)) {
      const tail = block.text.slice(segment.index + segment.segment.length).trim();
      const next = blocks[blocks.indexOf(block) + 1];
      const continuation = next && /^PDF-sida/.test(next.label ?? '') && sentenceSegments(next.text)[0];
      if ((!tail || /^(?:[\p{Lu} -]+TINGSRÄTT|INKOM:)/u.test(tail)) && continuation && /^\p{Ll}/u.test(continuation.segment)
        && /[.!?][”"')\]]*\s*$/.test(continuation.segment)) {
        ranges.push({ block_id: next.id, start: continuation.index, end: continuation.index + continuation.segment.length });
      } else incomplete = true;
    }
  }
  const unique = [...new Map(ranges.map(range => [JSON.stringify(range), range])).values()];
  const text = unique.map(range => blocks.find(b => b.id === range.block_id).text.slice(range.start, range.end).trim()).join(' ');
  return { text, locations: unique, incomplete, assessable: !incomplete && text.length <= 1600 };
}

function words(text) {
  return normalizeQuote(text).match(/\p{L}{3,}/gu)?.filter(word => !STOP.has(word)) ?? [];
}

export function provisionText(markdown, uri, anchors) {
  const fragment = new URL(uri).hash.slice(1);
  if (!fragment) return { text: markdown, exact: false };
  // A förarbete page: the extractor cites each page of a range separately.
  const page = /^sid(\d+)$/.exec(fragment);
  if (page && anchors?.[fragment]) {
    return { text: markdown.slice(...anchors[fragment]).trim(), exact: true, page: true, label: `Visa s. ${page[1]}` };
  }
  if (anchors && anchors[fragment]) {
    const [start, end] = anchors[fragment];
    if (typeof start === 'number' && typeof end === 'number' && end >= start) {
      return { text: markdown.slice(start, end).trim(), exact: true };
    }
  }
  // Markdown exposes Swedish chapters as linked headings and provisions in bold.
  const provision = /^(?:K(\d+[a-z]?))?P(\d+[a-z]?)$/i.exec(fragment);
  if (!provision) return { text: markdown, exact: false };
  let text = markdown;
  if (provision[1]) {
    const headings = [...text.matchAll(/^(#{1,6}) .*$/gm)];
    const index = headings.findIndex(match => match[0].includes(`#K${provision[1]})`));
    if (index < 0) return { text: markdown, exact: false };
    // A chapter runs to the next heading of its own level or higher; the
    // sub-headings some statutes print inside a chapter stay within it.
    const end = headings.slice(index + 1).find(match => match[1].length <= headings[index][1].length);
    text = text.slice(headings[index].index, end?.index ?? text.length);
  }
  const paragraphs = [...text.matchAll(/^\*\*(\d+\s*[a-z]?) §\*\*/gm)];
  const index = paragraphs.findIndex(match => match[1].replace(/\s/g, '') === provision[2]);
  if (index < 0) return { text: markdown, exact: false };
  return { text: text.slice(paragraphs[index].index, paragraphs[index + 1]?.index ?? text.length).split(/^#{1,6} /m)[0].trim(), exact: true };
}

function courtName(heading) {
  if (/^högsta domstolen$/i.test(heading)) return 'högsta domstolen';
  if (/^högsta förvaltningsdomstolen$/i.test(heading)) return 'högsta förvaltningsdomstolen';
  if (/^(?:[\p{L} -]+ )?(?:tingsrätt|hovrätt|förvaltningsrätt|kammarrätt)(?:en)?(?: över [\p{L} ]+)?$/iu.test(heading)) return heading.toLocaleLowerCase('sv');
}

// The reporting court behind a judgment uri: the court whose own text a
// referat's headnote summarizes, and the only court an HFD report names.
const REPORTING_COURT = { nja: 'högsta domstolen', hfd: 'högsta förvaltningsdomstolen' };

function sourceParagraphs(markdown, reportingCourt) {
  let court = reportingCourt;
  let section = '';
  // A referat opens with its title and headnote, the reporting court's own
  // summary of the holding. Narrative before the first section heading
  // reports the case history.
  let role = 'unknown';
  let headnote = false;
  let group = 0;
  let reportedDepth;
  const paragraphs = [];
  for (const block of markdown.split(/\n\s*\n/).filter(Boolean)) {
    const heading = /^(#{1,6}) (.+)$/.exec(block.trim());
    if (heading) {
      section = plainText(heading[2]);
      const namedCourt = courtName(section);
      if (namedCourt || (reportedDepth && heading[1].length <= reportedDepth)) reportedDepth = undefined;
      if (heading[1] === '#') { role = reportingCourt ? 'summary' : 'unknown'; headnote = Boolean(reportingCourt); }
      else if (namedCourt) { court = namedCourt; role = 'unknown'; }
      else if (/^(?:sammanfattning|sammanfattande (?:slutsatser|bedömning)|slutsatser?)$/i.test(section)) role = 'summary';
      else if (/^(?:(?:hovrättens|tingsrättens|HD:s|HFD:s|högsta domstolens|högsta förvaltningsdomstolens) )?(?:domslut|beslut|avgörande)$/i.test(section)) role = 'decision';
      else if (/bakgrund|parternas|yrkanden|inställning|betänkande|skiljaktig/i.test(section)) { role = 'reported'; reportedDepth = heading[1].length; }
      else if (/^(?:mål nr|föredraget)/i.test(section)) role = 'metadata';
      else if (court) role = 'reasoning';
      if (reportedDepth) role = 'reported';
      group++;
      continue;
    }
    const text = plainText(block);
    // A court section can itself report another speaker's position. Such
    // passages must not establish what this court decided.
    const reported = /^(?:\d+\.\s*)?(?:käranden|svaranden|åklagaren|riksåklagaren|föredraganden|tingsrätten|hovrätten|förvaltningsrätten|kammarrätten|skatteverket)\b.{0,120}\b(?:yrkade|anförde|hävdade|har dömt|har ansett|föreslog|yttrade|medgav|vidhöll)/iu.test(text);
    // The trailer of a referat lists the decision date, case number, cited
    // provisions and cases. It is not the court's own text.
    const metadata = /^(?:HD:s (?:dom|beslut) meddelad|Mål nr|Lagrum|Rättsfall|Litteratur|Sökord)\b/i.test(text);
    paragraphs.push({ text, court, section, role: metadata ? 'metadata' : reported ? 'reported' : role, group });
    if (headnote) { role = 'reported'; headnote = false; }
  }
  return paragraphs;
}

// One provision as the units a sentence-pair model can judge: each stycke,
// a list joined to its lead-in, and the sentences of any stycke longer than
// a few lines. A whole multi-paragraph provision as one premise scores at
// chance (see docs/semantic-evaluation.md).
function provisionUnits(plain) {
  const units = [];
  for (const block of plain.split(/\n\s*\n/).filter(Boolean)) {
    if (units.length && /^(?:\d+[.)]|[a-z][.)]|[-–•])\s/.test(block)) units[units.length - 1] += '\n\n' + block;
    else units.push(block);
  }
  return units.flatMap(unit => unit.length <= 400 || /\n\n(?:\d+[.)]|[a-z][.)]|[-–•])\s/.test(unit) ? [unit]
    : sentenceSegments(unit).map(item => item.segment.trim()).filter(Boolean))
    .map((text, index) => ({ text, group: 0, index }));
}

function passageChunks(paragraphs) {
  const passages = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    const sentences = sentenceSegments(paragraph.text).map(item => item.segment);
    let chunks = [''];
    for (const sentence of sentences) {
      if (chunks.at(-1) && chunks.at(-1).length + sentence.length > 600) chunks.push('');
      chunks[chunks.length - 1] += sentence; // Preserve long sentences for tokenizer rejection, never cut off their conditions.
    }
    for (let text of chunks) {
      if (chunks.length === 1) for (let next = index + 1; next < Math.min(index + 4, paragraphs.length); next++) {
        const following = paragraphs[next];
        if (following.group !== paragraph.group || following.role !== paragraph.role || text.length + following.text.length + 2 > 600) break;
        text += '\n\n' + following.text;
      }
      passages.push({ ...paragraph, text: text.trim(), index: passages.length });
    }
  }
  return passages;
}

export function selectEvidence(markdown, uri, claim, anchors) {
  const scope = provisionText(markdown, uri, anchors);
  const plain = plainText(scope.text);
  const judgment = new URL(uri).pathname.startsWith('/dom/');
  // A page is read in whole paragraphs; a provision in its units.
  const paragraphs = scope.page ? plain.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean).map((text, index) => ({ text, group: 0, index }))
    : scope.exact ? provisionUnits(plain) : sourceParagraphs(scope.text, judgment ? REPORTING_COURT[new URL(uri).pathname.split('/')[2]] : undefined);
  const terms = new Set(words(claim.hypothesis ?? claim.text));
  const quotes = [...claim.text.matchAll(/[“”"«']([^“”"»']{20,})[“”"»']/g)].map(match => normalizeQuote(match[1]));
  const ranked = (scope.exact ? paragraphs : passageChunks(paragraphs)).map(passage => {
    const tokens = new Set(words(passage.text));
    const quote = quotes.some(q => normalizeQuote(passage.text).includes(q));
    return { ...passage, quote, score: [...terms].filter(term => tokens.has(term)).length / Math.sqrt(tokens.size || 1) + (quote ? 100 : 0) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!judgment) {
    // A cited unit goes to the model whole, in document order; the model
    // windows it itself. Only an uncited whole document is pre-selected here.
    const passages = scope.exact ? [...ranked].sort((a, b) => a.index - b.index) : ranked.slice(0, 5);
    return { passages, exact: scope.exact, label: scope.label, quote: passages.some(p => p.quote) };
  }
  const courts = [...new Set(paragraphs.map(p => p.court).filter(Boolean))];
  const authority = claim.authority ?? REPORTING_COURT[new URL(uri).pathname.split('/')[2]] ?? courts.at(-1);
  const matchesCourt = court => court === authority || (authority === 'tingsrätten' && /tingsrätt(?:en)?$/.test(court ?? '')) || (authority === 'hovrätten' && /hovrätt/.test(court ?? ''));
  const eligible = ranked.filter(p => matchesCourt(p.court) && ['reasoning', 'summary', 'decision'].includes(p.role));
  // Reserve room for the court's conclusion even if earlier narrative matches
  // more words. Never join across courts or source headings.
  const conclusion = ['summary', 'decision'].map(role => eligible.find(p => p.role === role)).filter(Boolean);
  const passages = [...new Map([...conclusion, ...eligible].map(p => [p.index, p])).values()].slice(0, 5);
  const excluded = ranked.filter(p => !eligible.includes(p)).slice(0, 2);
  return {
    passages, excluded, exact: false, quote: passages.some(p => p.quote), authority,
    scope: authority ? `${authority} · domskäl och avgörande` : 'Domstolens egen bedömning kunde inte avgränsas',
    reason: passages.length ? undefined : 'Källtexten saknar tydliga avsnitt för den domstol som påståendet gäller.',
    requireConclusion: claim.requireConclusion,
  };
}

export function classifyResolution(response, uri) {
  if (!Array.isArray(response.results) || !Array.isArray(response.recognized)) {
    throw new Error('API:t returnerar ett oväntat svar för källkontrollen.');
  }
  if (response.recognized.some(item => item.uri === uri && item.invalid === true)) return 'invalid';
  if (response.results.length) return 'found';
  return 'unconfirmed';
}

export function occurrenceStatus(targets) {
  if (!targets.length) return 'unconfirmed';
  for (const status of ['invalid', 'error', 'pending', 'unconfirmed']) {
    if (targets.some(target => target.status === status)) return status;
  }
  return 'found';
}

export function invalidCitationMessage(target, occurrence) {
  const text = (occurrence?.text ?? '').replace(/\s+/g, ' ').trim();
  const uri = target?.uri ?? '';
  const isCase = uri.includes('/dom/') || target?.source === 'dv'
    || /^(?:NJA|HFD|RÅ|RH|AD|MÖD|MIG|PMÖD|MD|RK)\b/i.test(text);

  if (isCase) {
    return `Det finns inget rättsfall betecknat ${text}.`;
  }

  const hash = uri.includes('#') ? uri.split('#')[1] : '';
  const provMatch = /^((?:(?:\d+\s*[a-z]?\s*kap\.?\s*)?(?:\d+\s*[a-z]?\s*§))|(?:(?:\d+\s*[a-z]?\s*§)\s*(?:\d+\s*[a-z]?\s*kap\.?)))(?:\s+(?:i|av)\s+|\s+)(.+)$/i.exec(text);

  if (hash || provMatch) {
    if (provMatch) {
      const prov = provMatch[1].replace(/\s+/g, ' ').replace(/(?<=\d)§/, ' §');
      const law = provMatch[2].trim();
      return `Det finns ingen ${prov} i ${law}.`;
    }
    const kMatch = /K(\d+[a-z]?)/i.exec(hash);
    const pMatch = /P(\d+[a-z]?)/i.exec(hash);
    const provParts = [];
    if (kMatch) provParts.push(`${kMatch[1]} kap.`);
    if (pMatch) provParts.push(`${pMatch[1]} §`);
    const prov = provParts.join(' ');
    if (prov) return `Det finns ingen ${prov} i den angivna författningen (${text}).`;
  }

  if (/^(?:sfs\s+)?\d{4}:-?\d+$/i.test(text)) {
    return `Det finns ingen författning med beteckningen ${text}.`;
  }

  return `Det finns ingen lag som heter ${text}.`;
}

function median(numbers) {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// PDF footnotes have no structure. When the page bottom holds a smaller-font,
// numbered note block and the body holds a matching smaller-font digit marker,
// move each note inline at its marker so its citation reads like an inline one.
// The two matching signals are required together, so an unrelated small line
// (a footer or a page number) never triggers a move. Returns the body lines
// with markers replaced, or null to keep the page unchanged.
function inlinePdfFootnotes(lines) {
  if (lines.length < 3) return null;
  // Body font = the height carrying the most characters, so a few small note
  // lines never move it.
  const chars = new Map();
  for (const line of lines) for (const item of line.items) {
    const height = Math.round(item.height);
    chars.set(height, (chars.get(height) ?? 0) + item.str.trim().length);
  }
  const bodyFont = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!bodyFont) return null;
  const lineFont = line => median(line.items.map(item => item.height));
  let start = lines.length;
  while (start > 0 && lineFont(lines[start - 1]) <= bodyFont * 0.8) start--;
  const region = lines.slice(start);
  if (!region.length || region.length > lines.length * 0.55) return null;
  const regionText = line => line.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
  if (!/^\d{1,3}\b/.test(regionText(region[0]))) return null;

  const notes = new Map();
  let current = null;
  for (const line of region) {
    const text = regionText(line);
    const lead = /^(\d{1,3})[.)\]]?\s+(.*)$/.exec(text);
    if (lead) { current = lead[1]; notes.set(current, `${notes.has(current) ? `${notes.get(current)} ` : ''}${lead[2]}`); }
    else if (current) notes.set(current, `${notes.get(current)} ${text}`);
  }
  for (const [number, text] of notes) {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed) notes.set(number, trimmed); else notes.delete(number);
  }
  if (!notes.size) return null;

  const body = lines.slice(0, start);
  let matched = 0;
  for (const line of body) {
    for (const item of line.items) {
      const digit = item.str.trim();
      if (/^\d{1,3}$/.test(digit) && item.height <= bodyFont * 0.75 && notes.has(digit)) {
        item.str = ` (${notes.get(digit)})`;
        matched++;
      }
    }
  }
  return matched ? body : null;
}

export function pdfPageText(items) {
  const lines = [];
  let line;
  for (const item of items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const y = item.transform[5];
    if (!line || Math.abs(line.y - y) > Math.max(2, item.height * 0.3)) {
      line = { y, height: item.height, items: [] };
      lines.push(line);
    }
    line.items.push({ str: item.str, height: item.height });
  }
  const render = source => source.map((current, index) => {
    const previous = source[index - 1];
    const separator = !previous ? '' : Math.abs(previous.y - current.y) > Math.max(previous.height, current.height) * 1.8 ? '\n\n' : ' ';
    return separator + current.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
  }).join('').trim();
  return render(inlinePdfFootnotes(lines) ?? lines);
}

export function validateBlocks(blocks) {
  if (!blocks.length || blocks.every(block => !block.text.trim())) throw new Error('Dokumentet saknar läsbar text. En skannad PDF behöver OCR.');
  if (blocks.length > 5000) throw new Error('Dokumentet innehåller fler än 5 000 textblock.');
  if (blocks.reduce((sum, block) => sum + [...block.text].length, 0) > 250000) throw new Error('Texten är längre än 250 000 tecken. Använd en kortare text eller dela upp filen före uppladdning.');
}
