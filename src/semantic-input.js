// Never truncate a premise or hypothesis: doing so can remove an exception or
// negation. Retain the exact sentence text shown in the report.
export function modelPassages(passages, tokenizer) {
  const result = [];
  let incomplete = false;
  const count = text => tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  for (const passage of passages) {
    if (count(passage.text) <= 350) {
      result.push(passage);
      continue;
    }
    const sentences = [...new Intl.Segmenter('sv', { granularity: 'sentence' }).segment(passage.text)].map(item => item.segment);
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
  return { passages: unique.slice(0, 10), incomplete: incomplete || unique.length > 10 };
}

export function pairInput(tokenizer, premise, hypothesis) {
  const encoded = tokenizer.encode(premise, { text_pair: hypothesis, return_token_type_ids: true });
  if (encoded.ids.length > 512 || tokenizer.encode(hypothesis, { add_special_tokens: false }).ids.length > 150) return null;
  return { input_ids: encoded.ids, attention_mask: encoded.attention_mask, token_type_ids: encoded.token_type_ids };
}
