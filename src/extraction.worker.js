import { extractLocal } from './lagrum-extract.js';

self.onmessage = event => {
  const { id, blocks } = event.data;
  try {
    const occurrences = extractLocal(blocks);
    self.postMessage({ id, occurrences });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
