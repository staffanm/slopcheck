import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BM25, rankPassagesBM25, tokenizeWords } from '../src/windowing.js';

test('tokenizeWords normalizes case and handles Swedish characters', () => {
  const words = tokenizeWords('Ett skadeståndsansvar enligt 2 kap. 1 § SkL!');
  assert.deepEqual(words, ['ett', 'skadeståndsansvar', 'enligt', '2', 'kap', '1', 'skl']);
});

test('BM25 assigns higher weight to distinctive rare words over common boilerplate', () => {
  const corpus = [
    'Enligt 1 § avtalslagen gäller anbud som avges.',
    'I fråga om skadeståndsansvar för ren förmögenhetsskada krävs brottslig handling enligt skadeståndslagen.',
    'Avtalslagen innehåller regler om fullmakt och ogiltighet.',
  ];
  const bm25 = new BM25(corpus);
  // Query with rare distinctive term 'förmögenhetsskada'
  const scores = bm25.score('Krävs brott för ersättning vid ren förmögenhetsskada?');
  assert.ok(scores[1] > scores[0]);
  assert.ok(scores[1] > scores[2]);
});

test('rankPassagesBM25 scores passages accurately', () => {
  const passages = [
    { text: 'Första stycket: anbud är bindande.' },
    { text: 'Andra stycket: återkallelse av anbud måste ske innan mottagaren tagit del.' },
  ];
  const scores = rankPassagesBM25(passages, 'återkallelse av anbud');
  assert.equal(scores.length, 2);
  assert.ok(scores[1] > scores[0]);
});
