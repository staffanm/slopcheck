import { citationOnly, extractionText, sentenceSegments } from './analysis.js';

import manifest from './model-manifest.json' with { type: 'json' };

// The version names the asset directory under public/models and the cache. It
// comes from the manifest so that the two cannot disagree.
export const MODEL_VERSION = manifest.version;
export const SEMANTIC = {
  correct: ['Stöd hittat', 'Källavsnittet tycks stödja påståendet. Granska villkor och sammanhang.'],
  supported: ['Stöd hittat', 'Källavsnittet tycks stödja påståendet. Granska villkor och sammanhang.'],
  misleading: ['Vilseledande', 'Källan ställer villkor eller gör undantag som påståendet utelämnar.'],
  incorrect: ['Möjlig motsägelse', 'Källavsnittet kan motsäga påståendet. Kontrollera villkor och sammanhang.'],
  contradiction: ['Möjlig motsägelse', 'Källavsnittet kan motsäga påståendet. Kontrollera villkor och sammanhang.'],
  missing: ['Stöd saknas', 'De jämförda avsnitten gav inget tydligt stöd. Det bevisar inte att påståendet är fel.'],
  nonsensical: ['Meningslöst', 'Påståendet saknar juridisk innebörd eller kan inte bedömas meningsfullt.'],
  abstain: ['Kunde inte bedömas', 'Jämförelsen ger inget tillräckligt säkert resultat.'],
  pending: ['Väntar på jämförelse', ''],
};

// Thresholds come from the manifest when the export was calibrated
// (scripts/evaluate_browser_model.py --calibrate); a value above 1 disables that
// label. The fallback values are the provisional ones set for the original
// ScandiNLI weights, see docs/semantic-evaluation.md.
export const THRESHOLDS = {
  supported: manifest.thresholds?.supported ?? 0.97,
  contradiction: manifest.thresholds?.contradiction ?? 0.97,
  neutral: manifest.thresholds?.neutral ?? 0.90,
  conflict: 0.50,
};

// Work from locations, not string replacement: the same citation may appear in
// several clauses, and a short parser span ("4") must never replace a date.
function markedContext(context, occurrence, blocks, occurrences) {
  if (!context.locations) return context.text.replace(occurrence.text, 'CITATION');
  return context.locations.map(range => {
    const block = blocks.find(b => b.id === range.block_id);
    let text = block.text.slice(range.start, range.end);
    const spans = occurrences.flatMap(o => o.locations).filter(loc => loc.block_id === range.block_id
      && loc.start >= range.start && loc.end <= range.end).sort((a, b) => b.start - a.start);
    let boundary = range.end;
    for (const span of spans) {
      if (span.end > boundary) continue;
      text = text.slice(0, span.start - range.start) + 'CITATION' + text.slice(span.end - range.start);
      boundary = span.start;
    }
    return text;
  }).join(' ');
}

const COURT = String.raw`Högsta\s+domstolen|HD|Högsta\s+förvaltningsdomstolen|HFD|(?:[\p{L} -]+\s+)?tingsrätten|(?:[\p{L} -]+\s+)?hovrätten`;
const HOLDING = String.raw`slagit fast|slog fast|fastslagit|fastställde|funnit|fann|bedömt|bedömde|konstaterat|konstaterade|ansåg|uttalade`;
const courtFirst = new RegExp(`^(${COURT})\\s+(?:har\\s+)?(?:i\\s+CITATION\\s+)?(?:${HOLDING})\\s+att\\s+(.+)$`, 'iu');
const citationFirst = new RegExp(`^(?:Vidare,?\\s+)?[Ii]\\s+CITATION\\s*,?\\s*(slog|fastställde|fann|bedömde|konstaterade|ansåg|uttalade)\\s+(${COURT})\\s+(?:fast\\s+)?att\\s+(.+)$`, 'iu');

export function semanticClaim(occurrence, context, blocks, occurrences = [occurrence]) {
  const block = blocks.find(item => item.id === occurrence.locations[0].block_id);
  let hypothesis = extractionText(markedContext(context, occurrence, blocks, occurrences)).text;
  // Select a clause by its position, not the first equal citation in the text.
  const targetRange = context.locations?.find(r => r.block_id === occurrence.locations[0].block_id
    && r.start <= occurrence.locations[0].start && r.end >= occurrence.locations[0].end);
  const targetText = targetRange && block.text.slice(targetRange.start, occurrence.locations[0].start);
  const clauseIndex = targetText?.split(';').length - 1;
  const parts = hypothesis.split(';');
  if (clauseIndex >= 0 && parts[clauseIndex]?.includes('CITATION')) {
    let result = parts[clauseIndex];
    for (let i = clauseIndex + 1; i < parts.length; i++) {
      if (parts[i].includes('CITATION')) break;
      result += ';' + parts[i];
    }
    hypothesis = result;
  }
  // Remove only the list marker; a capitalized subject is never a heading.
  hypothesis = hypothesis.trim().replace(/^\d+[.)]\s*/, '')
    .replace(/^(?:Rättslig grund|Rättsliga grunder)\s+(?=\p{Lu})/u, '');
  const referenceOnly = citationOnly(hypothesis.replace(/CITATION/g, ''));
  const courtStatement = courtFirst.exec(hypothesis);
  const inverted = citationFirst.exec(hypothesis);
  const namedCourt = courtStatement?.[1] ?? inverted?.[2];
  const authority = namedCourt?.toLocaleLowerCase('sv').replace(/^hd$/, 'högsta domstolen').replace(/^hfd$/, 'högsta förvaltningsdomstolen');
  const provisionStatement = /CITATION(?:\s*\(\d{4}:\d+\))?\s*,\s*(?:som\s+(?:stadgar|anger|föreskriver|innebär)|där\s+det\s+stadgas)\s+att\s+(.+)$/iu.exec(hypothesis);
  const directStatement = /^CITATION\s+(?:anger|stadgar|föreskriver)\s+att\s+(.+)$/iu.exec(hypothesis);
  // A reference about whether a source exists belongs to resolution, not NLI.
  const existenceClaim = !/(?<!\p{L})(?:enligt|i)\s+CITATION/iu.test(hypothesis)
    && (/(?:rättsfall\w*|lagrum\w*|hänvisning\w*)\s+(?:till\s+)?CITATION.*(?:finns\s+inte|inte\s+finns|existerar\s+inte|inte\s+existerar|existerar|är\s+påhitt\w*|var\s+(?:alltså\s+)?påhitt\w*|saknas|felaktig\w*)/iu.test(hypothesis)
      || /(?:inte\s+heller|även)\s+(?:rättsfall\w*|lagrum\w*)?\s*CITATION.*(?:finns|påhitt\w+|existerar)/iu.test(hypothesis)
      || /\bCITATION\s+(?:är|var)\s+(?:ett\s+)?påhitt\w+\s+(?:lagrum\w*|rättsfall\w*)/iu.test(hypothesis)
      || /påhitt\w+\s+(?:lagrum\w*|rättsfall\w*).*\bCITATION\b/iu.test(hypothesis)
      || /(?:lagrum\w*|rättsfall\w*|hänvisning\w*)\s+(?:till\s+)?CITATION.*(?:var|är)\s+(?:alltså\s+)?påhitt\w+/iu.test(hypothesis)
      || /^CITATION\s+(?:finns\s+inte|inte\s+finns|existerar\s+inte|är\s+påhitt\w*)\s*[.!?]?$/iu.test(hypothesis));
  if (courtStatement) hypothesis = courtStatement[2];
  else if (inverted) hypothesis = inverted[3];
  else if (provisionStatement) hypothesis = provisionStatement[1];
  else if (directStatement) hypothesis = directStatement[1];

  // Remove parentheses only if their entire content consists of references.
  // Conditions like "(CITATION, men bara om ...)" must survive.
  hypothesis = hypothesis.replace(/\(([^()]*)\)/g, (whole, content) =>
    content.includes('CITATION') && citationOnly(content.replace(/CITATION/g, '')) ? '' : whole);
  hypothesis = hypothesis
    .replace(/(?<!\p{L})(?:se även|se|jfr)\s+CITATION[.,]?/giu, '')
    .replace(/(?<!\p{L})(?:enligt|i)\s+CITATION(?:\s+och\s+(?:CITATION|rättspraxis))?\s*/giu, '')
    .replace(/(?<!\p{L})enligt fast rättspraxis\s*/giu, '')
    .replace(/CITATION/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:])/g, '$1').replace(/\s+/g, ' ').trim();
  if (referenceOnly && block?.claimContext) {
    hypothesis = extractionText(block.claimContext).text;
  } else if (referenceOnly && !/^(?:Fotnot|Slutnot|PDF-sida)/.test(block.label ?? '')) {
    const previous = blocks[blocks.indexOf(block) - 1];
    if (previous && /[.!?]\s*$/.test(previous.text)) {
      hypothesis = sentenceSegments(previous.text).at(-1).segment.trim();
    }
  }
  let reason;
  const before = block.text.slice(0, occurrence.locations[0].start);
  const heading = before.split(/\n/).filter(line => line.trim()).findLast(line => /^(?:#{1,6}\s*)?(?:källförteckning|referenser|rättsfallsförteckning|litteratur|bibliografi)\s*$/i.test(line.trim()));
  if (context.incomplete) reason = 'Påståendet är avbrutet vid en sid- eller styckegräns.';
  else if (existenceClaim) reason = 'Påståendet gäller källans existens och hanteras av hänvisningskontrollen.';
  else if (heading) reason = 'Hänvisningen står i en källförteckning.';
  else if (/<[^>]+>|\uFFFD/.test(hypothesis)) reason = 'Påståendet innehåller text som inte kunde läsas säkert.';
  else if (occurrence.locations.length > 1) reason = 'Påståendet går över flera textblock.';
  else if (/^(Fotnot|Slutnot)/.test(block.label ?? '') && !block.claimContext) reason = 'Noten saknar en säker koppling till påståendet.';
  else if (hypothesis.length > 1600) reason = 'Påståendet är för långt för en säker jämförelse.';
  else if (/^(?:han|hon)\b|^(?:detta|det|den|de)\s+(?:är|var|ska|kan|gäller|följer|innebär)\b/i.test(hypothesis)) reason = 'Påståendet hänvisar till ett sammanhang som inte kunde avgränsas.';
  else if ((hypothesis.match(/\p{L}{2,}/gu)?.length ?? 0) < 3
    || !/(?<!\p{L})(?:är|var|vara|har|hade|ska|skall|kan|får|måste|gäller|gällde|ansvarar|kräver|innebär|utgör|blir|blev|ger|anges|sägs|framgår|står|fann|ansåg|ogillade|biföll|hindrar|fälls|medför|följer|saknar|förutsätter|skulle|bör|borde|döms|dömas|dömde|dömdes|omfattar|omfattas|avser|avses|krävs|finner|anser|bedömer|bedömde|avslog|avslår|bifaller|undanröjde|undanröjer|fastställde|fastställer|ogillar|ogillas|konstaterade|uttalade|tillåter|hindrade|hindrar|påför|påförs|påförde|påfördes|påföra|föreligger|uppkommer|betalas|upphör|förbjuder|räknas|ersätts|tillämpas|prövas|prövade|beviljas|meddelas|träder|finns|fanns|kommer|kom|utgår|utgick|ingår|ingick|bortfaller|åligger|utdöma|utdöms|utdömdes|fastställa|bifalla|ogilla|stadgar|stadgas|föreskriver|föreskrivs)(?!\p{L})/iu.test(hypothesis)
    && !/(?<!\p{L})\p{L}{3,}(?:as|ade|ades)(?!\p{L})/iu.test(hypothesis)) {
    reason = 'Inget avgränsat påstående kunde skiljas från hänvisningen.';
  }
  // A small NLI model cannot safely resolve nested speech or who endorsed it.
  else if (/\b(?:käranden|svaranden|ombudet|ombud|parten)\b.*\b(?:anförde|påstod|uppgav|menade|hävdade|hänförde\s+sig|hänvisade|åberopade|gjorde\s+gällande)|\b(?:tingsrätten|hovrätten|domstolen)\b.*\b(?:erinrade|återgav|redovisade)\b/iu.test(hypothesis)) {
    reason = 'Återgivna partsuppgifter eller flera talare kräver egen granskning.';
  }
  return { ...context, hypothesis, authority, requireConclusion: Boolean(courtStatement || inverted), assessable: !reason, reason };
}

export function scoresFromLogits(logits) {
  if (logits.length !== 3 || !logits.every(Number.isFinite)) throw new Error('Modellen gav ogiltiga sannolikheter.');
  const exps = logits.map(value => Math.exp(value - Math.max(...logits)));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(['entailment', 'neutral', 'contradiction'].map((label, index) => [label, exps[index] / total]));
}

export function semanticResult(comparisons, { incomplete = false, requireConclusion = false, reason: empty, exact = false, thresholds = THRESHOLDS } = {}) {
  if (!comparisons.length) return { status: 'abstain', reason: empty ?? 'Inga källavsnitt ryms i modellens textgräns.', comparisons };
  const best = label => comparisons.reduce((a, b) => a.scores[label] >= b.scores[label] ? a : b);
  const support = best('entailment');
  const conflict = best('contradiction');
  const strongSupport = support.scores.entailment >= thresholds.supported;
  const strongConflict = conflict.scores.contradiction >= thresholds.contradiction;
  let status = 'abstain';
  let evidence = support;
  let reason = SEMANTIC.abstain[1];
  if (incomplete) reason = 'Alla utvalda avsnitt kunde inte jämföras. Texten är för lång.';
  // A strong signal stands only when no other passage mostly says the opposite.
  else if ((strongSupport && conflict.scores.contradiction >= thresholds.conflict) || (strongConflict && support.scores.entailment >= thresholds.conflict)) {
    reason = 'Källavsnitten ger motstridiga signaler. Det går inte att avgöra om ett villkor saknas eller om modellen misstolkar texten.';
  } else if (strongSupport) {
    const conclusion = comparisons.find(item => (item.roles ?? [item.role]).some(role => ['summary', 'decision'].includes(role)) && item.scores.entailment >= thresholds.supported);
    if (requireConclusion && !conclusion) reason = 'Modellen hittar liknande text, men kan inte bekräfta påståendet i domstolens sammanfattning eller avgörande.';
    else { status = 'correct'; evidence = conclusion ?? support; }
  }
  else if (strongConflict) {
    status = 'incorrect';
    evidence = conflict;
  } else if (comparisons.every(item => item.scores.neutral >= thresholds.neutral)) {
    status = 'missing';
    evidence = comparisons.reduce((a, b) => a.scores.neutral >= b.scores.neutral ? a : b);
  } else if (exact && support.scores.entailment < 0.40 && conflict.scores.contradiction < 0.40 && comparisons.some(item => item.scores.neutral >= 0.60)) {
    status = 'missing';
    evidence = comparisons.reduce((a, b) => a.scores.neutral >= b.scores.neutral ? a : b);
  }
  return { status, reason: status === 'abstain' ? reason : SEMANTIC[status][1], evidence, comparisons };
}

export function rowSemantic(row) {
  const results = [...row.semantic.values()];
  if (!results.length) return 'abstain';
  if (results.some(item => item.status === 'incorrect' || item.status === 'contradiction')) return 'incorrect';
  if (results.some(item => item.status === 'misleading')) return 'misleading';
  if (results.some(item => item.status === 'missing')) return 'missing';
  if (results.some(item => item.status === 'nonsensical')) return 'nonsensical';
  if (results.some(item => item.status === 'pending')) return 'pending';
  if (results.every(item => item.status === 'correct' || item.status === 'supported')) return 'correct';
  return 'abstain';
}

export function matchesFilter(filter, status, semantic) {
  if (filter === 'review') return ['incorrect', 'contradiction', 'misleading', 'missing'].includes(semantic);
  if (filter === 'unassessed') return ['abstain', 'nonsensical', 'pending'].includes(semantic);
  return filter === 'all' || filter === status;
}
