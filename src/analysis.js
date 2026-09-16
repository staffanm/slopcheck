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

export function claimContext(occurrence, blocks) {
  const parts = occurrence.locations.map(location => {
    const block = blocks.find(item => item.id === location.block_id);
    if (!block || location.start < 0 || location.end > block.text.length) {
      throw new Error('API:t returnerar en position som saknas i dokumentet.');
    }
    // Segment a masked citation so "NJA 2013 s. 372" remains one sentence.
    const masked = block.text.slice(0, location.start)
      + 'X'.repeat(location.end - location.start) + block.text.slice(location.end);
    const normalized = extractionText(masked);
    const citationStart = normalized.offsets.indexOf(location.start);
    const segments = [...new Intl.Segmenter('sv', { granularity: 'sentence' }).segment(normalized.text)];
    const index = segments.findIndex(s => s.index <= citationStart && s.index + s.segment.length > citationStart);
    const segment = segments[index];
    if (!segment) return '';
    const contextStart = segment.segment.replace(/X/g, '').replace(/\b(se|jfr|även)\b/gi, '').replace(/[^\p{L}]/gu, '').length < 20 && index > 0
      ? segments[index - 1].index : segment.index;
    return block.text.slice(normalized.offsets[contextStart], normalized.offsets[segment.index + segment.segment.length]).trim();
  });
  const text = [...new Set(parts)].join(' ');
  return { text, assessable: text.length <= 1600 && text.replace(occurrence.text, '').match(/\p{L}{3,}/gu)?.length >= 6 };
}

function words(text) {
  return normalizeQuote(text).match(/\p{L}{3,}/gu)?.filter(word => !STOP.has(word)) ?? [];
}

export function provisionText(markdown, uri) {
  const fragment = new URL(uri).hash.slice(1);
  if (!fragment) return { text: markdown, exact: false };
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
  const paragraphs = [];
  for (const block of markdown.split(/\n\s*\n/).filter(Boolean)) {
    const heading = /^(#{1,6}) (.+)$/.exec(block.trim());
    if (heading) {
      section = plainText(heading[2]);
      const namedCourt = courtName(section);
      if (heading[1] === '#') { role = reportingCourt ? 'summary' : 'unknown'; headnote = Boolean(reportingCourt); }
      else if (namedCourt) { court = namedCourt; role = 'unknown'; }
      else if (/^(?:sammanfattning|sammanfattande (?:slutsatser|bedömning)|slutsatser?)$/i.test(section)) role = 'summary';
      else if (/^(?:(?:hovrättens|tingsrättens|HD:s|HFD:s|högsta domstolens|högsta förvaltningsdomstolens) )?(?:domslut|beslut|avgörande)$/i.test(section)) role = 'decision';
      else if (/bakgrund|parternas|yrkanden|inställning|betänkande|skiljaktig/i.test(section)) role = 'reported';
      else if (/^(?:mål nr|föredraget)/i.test(section)) role = 'metadata';
      else if (court) role = 'reasoning';
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
    : [...new Intl.Segmenter('sv', { granularity: 'sentence' }).segment(unit)].map(item => item.segment.trim()).filter(Boolean))
    .map((text, index) => ({ text, group: 0, index }));
}

function passageChunks(paragraphs) {
  const passages = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    const sentences = [...new Intl.Segmenter('sv', { granularity: 'sentence' }).segment(paragraph.text)].map(item => item.segment);
    let chunks = [''];
    for (const sentence of sentences) {
      if (chunks.at(-1) && chunks.at(-1).length + sentence.length > 1400) chunks.push('');
      chunks[chunks.length - 1] += sentence; // Preserve long sentences for tokenizer rejection, never cut off their conditions.
    }
    for (let text of chunks) {
      if (chunks.length === 1) for (let next = index + 1; next < Math.min(index + 4, paragraphs.length); next++) {
        const following = paragraphs[next];
        if (following.group !== paragraph.group || following.role !== paragraph.role || text.length + following.text.length + 2 > 1400) break;
        text += '\n\n' + following.text;
      }
      passages.push({ ...paragraph, text: text.trim(), index: passages.length });
    }
  }
  return passages;
}

export function selectEvidence(markdown, uri, claim) {
  const scope = provisionText(markdown, uri);
  const plain = plainText(scope.text);
  const judgment = new URL(uri).pathname.startsWith('/dom/');
  const paragraphs = scope.exact ? provisionUnits(plain) : sourceParagraphs(scope.text, judgment ? REPORTING_COURT[new URL(uri).pathname.split('/')[2]] : undefined);
  const terms = new Set(words(claim.hypothesis ?? claim.text));
  const quotes = [...claim.text.matchAll(/[“”"«']([^“”"»']{20,})[“”"»']/g)].map(match => normalizeQuote(match[1]));
  const ranked = (scope.exact ? paragraphs : passageChunks(paragraphs)).map(passage => {
    const tokens = new Set(words(passage.text));
    const quote = quotes.some(q => normalizeQuote(passage.text).includes(q));
    return { ...passage, quote, score: [...terms].filter(term => tokens.has(term)).length / Math.sqrt(tokens.size || 1) + (quote ? 100 : 0) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!judgment) {
    const passages = ranked.slice(0, 5);
    return { passages, exact: scope.exact, quote: passages.some(p => p.quote) };
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
    line.items.push(item);
  }
  return lines.map((line, index) => {
    const previous = lines[index - 1];
    const separator = !previous ? '' : Math.abs(previous.y - line.y) > Math.max(previous.height, line.height) * 1.8 ? '\n\n' : ' ';
    return separator + line.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
  }).join('').trim();
}

export function validateBlocks(blocks) {
  if (!blocks.length || blocks.every(block => !block.text.trim())) throw new Error('Dokumentet saknar läsbar text. En skannad PDF behöver OCR.');
  if (blocks.length > 5000) throw new Error('Dokumentet innehåller fler än 5 000 textblock.');
  if (blocks.reduce((sum, block) => sum + [...block.text].length, 0) > 250000) throw new Error('Texten är längre än 250 000 tecken. Använd en kortare text eller dela upp filen före uppladdning.');
}
