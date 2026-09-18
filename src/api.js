import { classifyResolution, extractionText, originalOccurrences } from './analysis.js';

export const API = 'https://lagen.nu/api/v1';
const TRANSIENT = new Set([429, 502, 503, 504]);

export async function request(path, { signal, ...options } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`${API}/${path}`, {
      ...options, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120000)]),
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
    });
    if (TRANSIENT.has(response.status) && attempt < 2) {
      const delay = Math.min(10000, Number(response.headers.get('retry-after') ?? 1) * 1000 * (attempt + 1));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(delay) ? delay : 1000));
      continue;
    }
    if (!response.ok) {
      const messages = { 413: 'Texten är för stor.', 415: 'API:t godtar inte formatet.', 422: 'API:t kunde inte läsa textblocken.', 404: 'Källtexten saknas i lagen.nu.' };
      throw new Error(messages[response.status] ?? `lagen.nu svarar med HTTP ${response.status}. Försök igen.`);
    }
    if (options.responseType === 'text') return response.text();
    if (options.responseType === 'arrayBuffer') return response.arrayBuffer();
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) return response.json();
    if (contentType.includes('text/')) return response.text();
    return response.json();
  }
}

let extractionWorker;
let activeJob;
let nextJobId = 0;

export function stopExtractionWorker(reason = new DOMException('Avbruten', 'AbortError')) {
  extractionWorker?.terminate();
  extractionWorker = undefined;
  activeJob?.reject(reason);
  activeJob = undefined;
}

function extractInWorker(blocks, signal) {
  signal?.throwIfAborted();
  if (activeJob) throw new Error('Endast en lokal identifiering får köras åt gången.');
  if (!extractionWorker) {
    extractionWorker = new Worker(new URL('./extraction.worker.js', import.meta.url), { type: 'module' });
    extractionWorker.onmessage = ({ data }) => {
      if (data.id !== activeJob?.id) return;
      if (data.error) activeJob.reject(new Error(data.error));
      else activeJob.resolve(data.occurrences);
    };
    extractionWorker.onerror = () => {
      stopExtractionWorker(new Error('Identifieraren kunde inte starta. Ladda om sidan och försök igen.'));
    };
  }
  const abort = () => stopExtractionWorker(signal?.reason ?? new DOMException('Avbruten', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  return new Promise((resolve, reject) => {
    activeJob = { id: ++nextJobId, resolve, reject };
    extractionWorker.postMessage({ id: activeJob.id, blocks });
  }).finally(() => {
    signal?.removeEventListener('abort', abort);
    activeJob = undefined;
  });
}

export async function extract(blocks, signal, { local = false } = {}) {
  if (local) {
    signal?.throwIfAborted();
    if (typeof Worker === 'undefined') {
      const { extractLocal } = await import('./lagrum-extract.js');
      return extractLocal(blocks);
    }
    return extractInWorker(blocks, signal);
  }
  const normalized = blocks.map(block => ({ id: block.id, ...extractionText(block.text) }));
  const body = JSON.stringify(normalized.length === 1 && normalized[0].id === 'text'
    ? { text: normalized[0].text } : { blocks: normalized.map(({ id, text }) => ({ id, text })) });
  if (new TextEncoder().encode(body).length > 2000000) throw new Error('Texten överskrider API:ts gräns på 2 MB.');
  const response = await request('citations/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
  if (response.offset_unit !== 'utf-16' || !Array.isArray(response.occurrences)) throw new Error('API:t returnerar ett oväntat textformat.');
  return originalOccurrences(response.occurrences, blocks, normalized);
}

export async function resolveTarget(uri, signal) {
  const response = await request(`resolve?${new URLSearchParams({ q: uri })}`, { signal });
  return { status: classifyResolution(response, uri), result: response.results[0] };
}

export async function pool(items, task, signal, concurrency = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      signal.throwIfAborted();
      await task(items[next++]);
    }
  }));
}

export * from './privacy-api.js';

