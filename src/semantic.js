import { extractionText } from './analysis.js';

export const MODEL_VERSION = 'scandi-nli-small-5c7d1ee-q8-v1';
export const SEMANTIC = {
  supported: ['Stöd hittat', 'Källavsnittet tycks stödja påståendet. Granska villkor och sammanhang.'],
  contradiction: ['Möjlig motsägelse', 'Källavsnittet kan motsäga påståendet. Kontrollera vem som uttalar sig och vilka villkor som gäller.'],
  missing: ['Stöd inte hittat', 'De jämförda avsnitten gav inget tydligt stöd. Det bevisar inte att påståendet är fel.'],
  abstain: ['Kunde inte bedömas', 'Jämförelsen ger inget tillräckligt säkert resultat.'],
  pending: ['Väntar på jämförelse', ''],
};

// Provisional precision-first thresholds. See docs/semantic-evaluation.md.
export const THRESHOLDS = { supported: 0.97, contradiction: 0.97, neutral: 0.90, conflict: 0.20 };

export function semanticClaim(occurrence, context, blocks) {
  let hypothesis = extractionText(context.text).text;
  const citation = extractionText(occurrence.text).text;
  const containing = hypothesis.split(';').find(part => part.includes(citation));
  if (containing) hypothesis = containing;
  hypothesis = hypothesis.replace(citation, 'CITATION');
  const courtStatement = /^(Högsta\s+domstolen|HD|Högsta\s+förvaltningsdomstolen|HFD|(?:[\p{L} -]+\s+)?tingsrätten|(?:[\p{L} -]+\s+)?hovrätten)\s+har\s+(?:i\s+CITATION\s+)?(?:slagit fast|fastslagit|funnit|bedömt|konstaterat)\s+att\s+(.+)$/iu.exec(hypothesis);
  const provisionStatement = /CITATION(?:\s*\(\d{4}:\d+\))?\s*,\s*som\s+(?:stadgar|anger|föreskriver|innebär)\s+att\s+(.+)$/iu.exec(hypothesis);
  const authority = courtStatement ? courtStatement[1].toLocaleLowerCase('sv').replace(/^hd$/, 'högsta domstolen').replace(/^hfd$/, 'högsta förvaltningsdomstolen') : undefined;
  if (courtStatement) hypothesis = courtStatement[2];
  else if (provisionStatement) hypothesis = provisionStatement[1];
  hypothesis = hypothesis
    .replace(/\(?\b(?:se även|se|jfr)\s+CITATION\)?[.,]?/gi, '')
    .replace(/\b(?:enligt|i)\s+CITATION\s*/gi, '')
    .replace(/CITATION/g, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  const block = blocks.find(item => item.id === occurrence.locations[0].block_id);
  if ((hypothesis.match(/\p{L}{3,}/gu)?.length ?? 0) < 6 && block?.claimContext) {
    hypothesis = extractionText(block.claimContext).text;
  }
  if ((hypothesis.match(/\p{L}{3,}/gu)?.length ?? 0) < 6 && !/^(Fotnot|Slutnot)/.test(block.label ?? '')) {
    const previous = blocks[blocks.indexOf(block) - 1];
    if (previous && /[.!?]\s*$/.test(previous.text)) {
      hypothesis = [...new Intl.Segmenter('sv', { granularity: 'sentence' }).segment(extractionText(previous.text).text)].at(-1).segment.trim();
    }
  }
  let reason;
  const before = block.text.slice(0, occurrence.locations[0].start);
  const heading = before.split(/\n/).filter(line => line.trim()).findLast(line => /^(?:#{1,6}\s*)?(?:källförteckning|referenser|rättsfallsförteckning|litteratur|bibliografi)\s*$/i.test(line.trim()));
  if (heading) reason = 'Hänvisningen står i en källförteckning.';
  else if (/<[^>]+>|\uFFFD/.test(hypothesis)) reason = 'Påståendet innehåller text som inte kunde läsas säkert.';
  else if (occurrence.locations.length > 1) reason = 'Påståendet går över flera textblock.';
  else if (/^(Fotnot|Slutnot)/.test(block.label ?? '') && !block.claimContext) reason = 'Noten saknar en säker koppling till påståendet.';
  else if (hypothesis.length > 1600) reason = 'Påståendet är för långt för en säker jämförelse.';
  else if (/^(?:han|hon)\b|^(?:detta|det|den|de)\s+(?:är|var|ska|kan|gäller|följer|innebär)\b/i.test(hypothesis)) reason = 'Påståendet hänvisar till ett sammanhang som inte kunde avgränsas.';
  else if ((hypothesis.match(/\p{L}{3,}/gu)?.length ?? 0) < 6
    || !/(?<!\p{L})(?:är|var|vara|har|hade|ska|skall|kan|får|måste|gäller|gällde|ansvarar|kräver|innebär|utgör|blir|blev|ger|anges|sägs|framgår|står|fann|ansåg|ogillade|biföll|hindrar|fälls|medför|följer|saknar|förutsätter)(?!\p{L})/iu.test(hypothesis)) {
    reason = 'Inget avgränsat påstående kunde skiljas från hänvisningen.';
  }
  // A small NLI model cannot safely resolve nested speech or who endorsed it.
  else if (/\b(?:käranden|svaranden|ombudet|ombud|parten)\b.*\b(?:anförde|påstod|uppgav|menade|hävdade)|\b(?:tingsrätten|hovrätten|domstolen)\b.*\b(?:erinrade|återgav|redovisade)\b/i.test(hypothesis)) {
    reason = 'Återgivna partsuppgifter eller flera talare kräver egen granskning.';
  }
  return { ...context, hypothesis, authority, requireConclusion: Boolean(courtStatement), assessable: !reason, reason };
}

export function scoresFromLogits(logits) {
  if (logits.length !== 3 || !logits.every(Number.isFinite)) throw new Error('Modellen gav ogiltiga sannolikheter.');
  const exps = logits.map(value => Math.exp(value - Math.max(...logits)));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(['entailment', 'neutral', 'contradiction'].map((label, index) => [label, exps[index] / total]));
}

export function semanticResult(comparisons, { incomplete = false, requireConclusion = false } = {}) {
  if (!comparisons.length) return { status: 'abstain', reason: 'Inga källavsnitt ryms i modellens textgräns.', comparisons };
  const best = label => comparisons.reduce((a, b) => a.scores[label] >= b.scores[label] ? a : b);
  const support = best('entailment');
  const conflict = best('contradiction');
  let status = 'abstain';
  let evidence = support;
  let reason = SEMANTIC.abstain[1];
  if (incomplete) reason = 'Alla utvalda avsnitt kunde inte jämföras. Texten är för lång.';
  else if (support.scores.entailment >= THRESHOLDS.conflict && conflict.scores.contradiction >= THRESHOLDS.conflict) {
    reason = 'Källavsnitten ger motstridiga signaler.';
  } else if (support.scores.entailment >= THRESHOLDS.supported) {
    const conclusion = comparisons.find(item => ['summary', 'decision'].includes(item.role) && item.scores.entailment >= THRESHOLDS.supported);
    if (requireConclusion && !conclusion) reason = 'Modellen hittar liknande text, men kan inte bekräfta påståendet i domstolens sammanfattning eller avgörande.';
    else { status = 'supported'; evidence = conclusion ?? support; }
  }
  else if (conflict.scores.contradiction >= THRESHOLDS.contradiction) {
    status = 'contradiction';
    evidence = conflict;
  } else if (comparisons.every(item => item.scores.neutral >= THRESHOLDS.neutral)) status = 'missing';
  return { status, reason: status === 'abstain' ? reason : SEMANTIC[status][1], evidence, comparisons };
}

export function rowSemantic(row) {
  const results = [...row.semantic.values()];
  if (!results.length) return 'abstain';
  if (results.some(item => item.status === 'contradiction')) return 'contradiction';
  if (results.some(item => item.status === 'missing')) return 'missing';
  if (results.some(item => item.status === 'pending')) return 'pending';
  if (results.every(item => item.status === 'supported')) return 'supported';
  return 'abstain';
}

export function matchesFilter(filter, status, semantic) {
  if (filter === 'review') return ['contradiction', 'missing'].includes(semantic);
  if (filter === 'unassessed') return ['abstain', 'pending'].includes(semantic);
  return filter === 'all' || filter === status;
}
