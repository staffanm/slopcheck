// Privacy mode's unit index (ferenda lib/unitindex.py): existence from one
// downloaded filter, and the text of a cited provision from a bucket of units
// that share a prefix of their uri hash. A unit is a document uri or a
// provision uri ("https://lagen.nu/1915:218#P36"); its key is the first 8 bytes
// of sha256(uri), big-endian.
import { request } from './api.js';
import { OHTTP_CONFIG, ohttpFetch } from './ohttp.js';
import { sha256Fallback } from './sha256.js';

export const DEFAULT_BITS = 16;
export const BATCH = 128;          // a check sends a multiple of this many bucket requests
const NO_TEXT = 0xFFFFFFFF;         // a document whose provisions carry its text
const FILTER_MAGIC = 'lagen-fuse16-1\n';
const CACHE = 'slopcheck-units-v2';
const OLD_CACHES = ['slopcheck-packs-v1', 'slopcheck-units-v1'];
const FILTER_MAX_AGE = 24 * 3600 * 1000;
const MASK64 = (1n << 64n) - 1n;

// --- keys -------------------------------------------------------------------

async function digest(uri) {
  const bytes = new TextEncoder().encode(uri);
  if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return sha256Fallback(bytes);
}

/** A unit's key as a BigInt: the first 8 bytes of sha256(uri). */
export async function unitKey(uri) {
  const d = await digest(uri);
  let k = 0n;
  for (let i = 0; i < 8; i++) k = (k << 8n) | BigInt(d[i]);
  return k;
}

// --- the filter (binary fuse, 16-bit fingerprints) ---------------------------

function murmur64(h) {
  h ^= h >> 33n;
  h = (h * 0xFF51AFD7ED558CCDn) & MASK64;
  h ^= h >> 33n;
  h = (h * 0xC4CEB9FE1A85EC53n) & MASK64;
  h ^= h >> 33n;
  return h;
}

/** Reads the filter file: membership, and the most-cited units for fillers. */
export function parseFilter(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, FILTER_MAGIC.length));
  if (magic !== FILTER_MAGIC) throw new Error('Filtret har ett okänt format.');
  const view = new DataView(buffer);
  let at = FILTER_MAGIC.length;
  const seed = view.getBigUint64(at, true);
  const segmentLength = view.getUint32(at + 8, true);
  const segmentCountLength = view.getUint32(at + 12, true);
  const arrayLength = view.getUint32(at + 16, true);
  at += 20;
  const fingerprints = new Uint16Array(buffer.slice(at, at + 2 * arrayLength));
  at += 2 * arrayLength;
  const popular = [];
  const count = view.getUint32(at, true);
  for (let i = 0; i < count; i++) {
    popular.push({ prefix32: view.getUint32(at + 4 + 8 * i, true), weight: view.getUint32(at + 8 + 8 * i, true) });
  }
  const mask = BigInt(segmentLength - 1);
  const segLen = BigInt(segmentLength);
  const n = BigInt(segmentCountLength);
  return {
    popular,
    has(key) {
      const hash = murmur64((key + seed) & MASK64);
      const h0 = (hash * n) >> 64n;
      const h1 = (h0 + segLen) ^ ((hash >> 18n) & mask);
      const h2 = (h0 + 2n * segLen) ^ (hash & mask);
      const f = Number((hash ^ (hash >> 32n)) & 0xFFFFn);
      return (f ^ fingerprints[Number(h0)] ^ fingerprints[Number(h1)] ^ fingerprints[Number(h2)]) === 0;
    },
  };
}

async function fetchBytes(path, signal) {
  if (OHTTP_CONFIG.enabled) return (await ohttpFetch(path, { signal })).arrayBuffer();
  return request(path, { signal, responseType: 'arrayBuffer' });
}

async function cached(path) {
  if (typeof caches === 'undefined') return null;
  try {
    return await (await caches.open(CACHE)).match(`/units/${path}`) ?? null;
  } catch {
    return null;
  }
}

async function store(path, buffer) {
  if (typeof caches === 'undefined') return;
  try {
    await (await caches.open(CACHE)).put(`/units/${path}`,
      new Response(buffer, { headers: { 'x-fetched': String(Date.now()) } }));
  } catch {
    // CacheStorage can refuse in a private window; the answer is still used
  }
}

let filterPromise = null;

/** The filter, from the cache when it is under a day old. Null when the server has none yet. */
export function loadFilter(signal) {
  filterPromise ??= (async () => {
    if (typeof caches !== 'undefined') {
      // the document packs and the padded answers of earlier versions
      await Promise.all(OLD_CACHES.map(name => caches.delete(name).catch(() => false)));
    }
    const hit = await cached('filter');
    if (hit && Date.now() - Number(hit.headers.get('x-fetched')) < FILTER_MAX_AGE) {
      return parseFilter(await hit.arrayBuffer());
    }
    try {
      const buffer = await fetchBytes('range/filter', signal);
      await store('filter', buffer);
      return parseFilter(buffer);
    } catch {
      return hit ? parseFilter(await hit.arrayBuffer()) : null;
    }
  })();
  return filterPromise;
}

// --- buckets of units --------------------------------------------------------

function prefixHex(prefix, bits) {
  const width = Math.ceil(bits / 4);
  return (prefix << (4 * width - bits)).toString(16).padStart(width, '0');
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Reads an answer: Map of the 32 key bits after the prefix -> {uri, text}; text is null for NO_TEXT. */
export async function parseUnits(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'LUR1') throw new Error('Svaret har ett okänt format.');
  const count = view.getUint32(5, true);
  const units = new Map();
  let at = 9;
  for (let i = 0; i < count; i++) {
    const suffix = view.getUint32(at, true);
    const uriLength = view.getUint16(at + 4, true);
    const textLength = view.getUint32(at + 6, true);
    at += 10;
    const uri = new TextDecoder().decode(bytes.subarray(at, at + uriLength));
    at += uriLength;
    if (textLength === NO_TEXT) {
      units.set(suffix, { uri, text: null });
    } else {
      units.set(suffix, { uri, text: await inflate(bytes.subarray(at, at + textLength)) });
      at += textLength;
    }
  }
  return units;
}

async function fetchBucket(prefix, bits, signal) {
  const path = `range/${prefixHex(prefix, bits)}?bits=${bits}`;
  const hit = await cached(path);
  if (hit) return hit.arrayBuffer();
  const buffer = await fetchBytes(path, signal);
  await store(path, buffer);
  return buffer;
}

// --- fillers -----------------------------------------------------------------

function installSecret() {
  try {
    let secret = localStorage.getItem('slopcheck-filler-secret');
    if (!secret) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      secret = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('slopcheck-filler-secret', secret);
    }
    return secret;
  } catch {
    return null;
  }
}

/**
 * `count` filler prefixes, the same on every check from this browser, so a
 * recheck sends nothing the cache does not already hold. Half are drawn from
 * the most-cited units by citation count, half uniformly, so they look like
 * the citations they hide among.
 */
export async function fillerPrefixes(count, bits, popular, exclude, secret = installSecret()) {
  const total = popular.reduce((sum, p) => sum + p.weight, 0);
  const out = [];
  const seen = new Set(exclude);
  const seedText = secret ?? [...crypto.getRandomValues(new Uint8Array(16))].join(',');
  for (let i = 0; out.length < count && i < count * 20; i++) {
    const d = await digest(`${seedText}:${bits}:${i}`);
    const r = new DataView(d.buffer).getUint32(0) / 2 ** 32;
    let prefix;
    if (popular.length && d[4] < 128) {
      let pick = r * total;
      const unit = popular.find(p => (pick -= p.weight) < 0) ?? popular[popular.length - 1];
      prefix = unit.prefix32 >>> (32 - bits);
    } else {
      prefix = Math.floor(r * 2 ** bits);
    }
    if (!seen.has(prefix)) {
      seen.add(prefix);
      out.push(prefix);
    }
  }
  return out;
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- a check -----------------------------------------------------------------

const texts = new Map();         // unit uri -> markdown, or null for a document whose provisions carry it

/** The markdown a unit request returned for this uri: null when the unit has no text of its own, undefined when it was not fetched. */
export function unitText(uri) {
  return texts.get(uri);
}

/**
 * Fetches the text of every cited unit the filter holds, in one batch of a
 * multiple of BATCH requests, the real ones among fillers in random order.
 * Several provisions of one document are several units in unrelated buckets:
 * a bucket holds about 143 units of any document. Returns the uris whose
 * answer is now available through `unitText`.
 */
export async function prefetchUnits(uris, signal, { bits = DEFAULT_BITS, concurrency = 4 } = {}) {
  const filter = await loadFilter(signal);
  if (!filter) return new Set();
  const wanted = [];
  for (const uri of new Set(uris)) {
    if (texts.has(uri)) continue;
    const key = await unitKey(uri);
    if (filter.has(key)) wanted.push({ uri, key });
  }
  if (!wanted.length) return new Set();
  const shift = BigInt(64 - bits);
  const real = [...new Set(wanted.map(w => Number(w.key >> shift)))];
  const size = BATCH * Math.ceil(real.length / BATCH);
  const fillers = await fillerPrefixes(size - real.length, bits, filter.popular, real);
  const answers = new Map();
  const queue = shuffle([...real, ...fillers]);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      signal?.throwIfAborted();
      const prefix = queue.pop();
      const buffer = await fetchBucket(prefix, bits, signal).catch(() => null);
      if (buffer && real.includes(prefix)) answers.set(prefix, await parseUnits(buffer));
    }
  }));
  const found = new Set();
  const suffixShift = BigInt(64 - bits - 32);
  for (const { uri, key } of wanted) {
    const unit = answers.get(Number(key >> shift))?.get(Number((key >> suffixShift) & 0xFFFFFFFFn));
    if (unit?.uri === uri) {
      texts.set(uri, unit.text);
      found.add(uri);
    }
  }
  return found;
}
