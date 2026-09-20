/**
 * Zero-dependency BM25 paragraph ranking and windowing for client-side Swedish text.
 * Mirrors backend/windowing.py for exact algorithmic parity between server and client.
 */

export function tokenizeWords(text) {
  if (!text) return [];
  return (text.toLowerCase().match(/\p{L}+|\d+/gu) || []);
}

export class BM25 {
  constructor(corpus, k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.corpusSize = corpus.length;
    this.docLens = corpus.map(doc => tokenizeWords(doc).length);
    this.avgdl = this.docLens.reduce((a, b) => a + b, 0) / Math.max(this.corpusSize, 1);
    this.docFreqs = [];
    const df = new Map();

    for (const doc of corpus) {
      const words = tokenizeWords(doc);
      const tf = new Map();
      for (const w of words) {
        tf.set(w, (tf.get(w) || 0) + 1);
      }
      this.docFreqs.push(tf);
      for (const w of tf.keys()) {
        df.set(w, (df.get(w) || 0) + 1);
      }
    }

    this.idf = new Map();
    for (const [w, freq] of df.entries()) {
      this.idf.set(w, Math.log((this.corpusSize - freq + 0.5) / (freq + 0.5) + 1.0));
    }
  }

  score(query) {
    const qWords = tokenizeWords(query);
    const scores = [];
    for (let idx = 0; idx < this.corpusSize; idx++) {
      const tf = this.docFreqs[idx];
      const dl = this.docLens[idx];
      let s = 0;
      for (const w of qWords) {
        if (tf.has(w)) {
          const count = tf.get(w);
          const num = count * (this.k1 + 1);
          const denom = count + this.k1 * (1 - this.b + this.b * (dl / Math.max(this.avgdl, 1e-6)));
          s += (this.idf.get(w) || 0) * (num / denom);
        }
      }
      scores.push(s);
    }
    return scores;
  }
}

/**
 * Scores an array of passage objects against a query text using BM25.
 * Returns array of scores matching passages length.
 */
export function rankPassagesBM25(passages, query) {
  if (!passages.length || !query) return passages.map(() => 0);
  const bm25 = new BM25(passages.map(p => p.text || ''));
  return bm25.score(query);
}

/**
 * Counts premise tokens with the model tokenizer, or estimates them without one.
 * The estimate matches estimate_tokens in backend/windowing.py.
 */
function tokenCount(text, tokenizer) {
  if (tokenizer) return tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  return Math.floor((text.match(/\S+/g) || []).length * 1.35) + 5;
}

/**
 * Selects the passages of one premise window of at most maxTokens tokens.
 * Ranks the passages by BM25 against the query, then returns the selected
 * passages in document order. Mirrors window_premise in backend/windowing.py.
 */
export function selectWindow(passages, query, maxTokens = 350, tokenizer = null) {
  if (!passages?.length) return [];
  const joined = passages.map(passage => passage.text).join('\n\n');
  if (tokenCount(joined, tokenizer) <= maxTokens) return [...passages];

  const scores = rankPassagesBM25(passages, query);
  const ranked = passages.map((passage, index) => ({ passage, score: scores[index], index }));
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = [];
  let total = 0;
  for (const item of ranked) {
    const tokens = tokenCount(item.passage.text, tokenizer);
    if (total + tokens <= maxTokens || !selected.length) {
      selected.push(item);
      total += tokens;
    }
    if (total >= maxTokens) break;
  }
  selected.sort((a, b) => a.index - b.index);
  return selected.map(item => item.passage);
}
