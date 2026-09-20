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
