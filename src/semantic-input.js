import { sentenceSegments } from './analysis.js';
import { rankPassagesBM25 } from './windowing.js';

// Never truncate a premise or hypothesis: doing so can remove an exception or
// negation. Retain the exact sentence text shown in the report.
export function modelPassages(passages, tokenizer, hypothesis = '') {
  const result = [];
  let incomplete = false;
  const count = text => tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  for (const passage of passages) {
    if (count(passage.text) <= 350) {
      result.push(passage);
      continue;
    }
    const sentences = sentenceSegments(passage.text).map(item => item.segment);
    for (let start = 0; start < sentences.length;) {
      let end = start;
      let text = '';
      while (end < sentences.length && count(text + sentences[end]) <= 350) text += sentences[end++];
      if (end === start) { incomplete = true; start++; continue; }
      result.push({ ...passage, text: text.trim() });
      start = end < sentences.length && end > start + 1 ? end - 1 : end;
    }
  }
  const unique = [...new Map(result.map(passage => [passage.text, passage])).values()];
  if (unique.length <= 10) {
    return { passages: unique, incomplete };
  }
  if (hypothesis) {
    const scores = rankPassagesBM25(unique, hypothesis);
    const ranked = unique.map((p, i) => ({ passage: p, score: scores[i], originalIndex: i }));
    ranked.sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
    const selected = ranked.slice(0, 10).sort((a, b) => a.originalIndex - b.originalIndex).map(item => item.passage);
    return { passages: selected, incomplete: true };
  }
  return { passages: unique.slice(0, 10), incomplete: true };
}

export function pairInput(tokenizer, premise, hypothesis) {
  const encoded = tokenizer.encode(premise, { text_pair: hypothesis, return_token_type_ids: true });
  if (encoded.ids.length > 512 || tokenizer.encode(hypothesis, { add_special_tokens: false }).ids.length > 150) return null;
  return { input_ids: encoded.ids, attention_mask: encoded.attention_mask, token_type_ids: encoded.token_type_ids };
}
