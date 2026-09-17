import { API, request, resolveTarget } from './api.js';
import { NAMEDLAWS_DATA } from './lagrum/datasets.js';

// Set of core SFS numbers (promulgated in NAMEDLAWS_DATA) that belong in the Core Statute Pack
const CORE_SFS = new Set(Object.values(NAMEDLAWS_DATA?.current ?? {}).map(s => s.split(' ')[0]));

// In-memory caches for range buckets and packs
export const rangeBucketCache = new Map();
export const packCache = new Map();
export const documentCache = new Map();

// Configuration for OHTTP relay
export const OHTTP_CONFIG = {
  enabled: false,
  relayUrl: null, // e.g. 'https://privacy-gateway.cloudflare.com/relay'
  get gatewayUrl() {
    return this._gatewayUrl ?? `${API}/ohttp-gateway`;
  },
  set gatewayUrl(url) {
    this._gatewayUrl = url;
  },
};

export function canonicalUri(uri) {
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    return `${parsed.origin.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return uri.trim();
  }
}

export async function sha256Hex(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function splitHash(hash, prefixLength = 3, suffixLength = 16) {
  return {
    prefix: hash.slice(0, prefixLength).toLowerCase(),
    suffix: hash.slice(0, suffixLength).toLowerCase(),
  };
}

export function hashSuffix(hash, length = 16) {
  return (hash || '').slice(0, length).toLowerCase();
}

export function rootPrefix(hash, length = 3) {
  return (hash || '').slice(0, length).toLowerCase();
}

/**
 * Deterministically maps a canonical legal URI to its static volume pack identifier.
 */
export function packIdForUri(uri) {
  const clean = (uri || '').split('#')[0].trim();
  
  // 1. SFS acts (Lag / förordning)
  const sfsMatch = /^https:\/\/lagen\.nu\/(\d{4}):(\d+)/i.exec(clean);
  if (sfsMatch) {
    const sfsId = `${sfsMatch[1]}:${sfsMatch[2]}`;
    if (CORE_SFS.has(sfsId)) {
      return 'core';
    }
    const decade = sfsMatch[1].slice(0, 3) + '0s';
    return `sfs/${decade}`;
  }

  // 2. NJA court cases (5-year volume blocks, e.g. nja/2010-2014)
  const njaMatch = /^https:\/\/lagen\.nu\/dom\/nja\/(\d{4})s/i.exec(clean);
  if (njaMatch) {
    const year = parseInt(njaMatch[1], 10);
    const startYear = Math.floor(year / 5) * 5;
    return `nja/${startYear}-${startYear + 4}`;
  }

  // 3. Other Swedish court series (HFD, AD, RH, MD, MIG, etc.)
  const courtMatch = /^https:\/\/lagen\.nu\/dom\/([a-z0-9_-]+)\/(\d{4})/i.exec(clean);
  if (courtMatch) {
    const court = courtMatch[1].toLowerCase();
    const year = parseInt(courtMatch[2], 10);
    const startYear = Math.floor(year / 5) * 5;
    return `dom/${court}/${startYear}-${startYear + 4}`;
  }

  // 4. CELEX / EU Acquis (regulations, directives, CJEU case law sector 6, etc.)
  // e.g. https://lagen.nu/celex/32016R0679 or https://lagen.nu/celex/62015CJ0123
  const celexMatch = /^https:\/\/lagen\.nu\/celex\/[0-9](\d{4})/i.exec(clean);
  if (celexMatch) {
    return `celex/${celexMatch[1]}`;
  }

  // 5. Förarbeten: Propositioner (prop), SOU, Ds
  const propMatch = /^https:\/\/lagen\.nu\/prop\/(\d{4})/i.exec(clean);
  if (propMatch) {
    const year = parseInt(propMatch[1], 10);
    const startYear = Math.floor(year / 5) * 5;
    return `prop/${startYear}-${startYear + 4}`;
  }
  const souMatch = /^https:\/\/lagen\.nu\/sou\/(\d{4}):/i.exec(clean);
  if (souMatch) {
    const decade = souMatch[1].slice(0, 3) + '0s';
    return `sou/${decade}`;
  }
  const dsMatch = /^https:\/\/lagen\.nu\/ds\/(\d{4}):/i.exec(clean);
  if (dsMatch) {
    const decade = dsMatch[1].slice(0, 3) + '0s';
    return `ds/${decade}`;
  }

  return 'other';
}

/**
 * Generates random 3-hex decoy prefixes to prevent traffic correlation.
 */
export function generateDecoyPrefixes(realPrefixes, count = 3) {
  const realSet = new Set(realPrefixes.map(p => p.toLowerCase()));
  const decoys = [];
  while (decoys.length < count) {
    const val = Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0');
    if (!realSet.has(val) && !decoys.includes(val)) {
      decoys.push(val);
    }
  }
  return decoys;
}

/**
 * Fetches a range bucket containing 16-hex hash suffixes matching the 3-hex root prefix.
 */
export async function fetchRangeBucket(prefix, signal, { ohttp = OHTTP_CONFIG.enabled, sendDecoys = false } = {}) {
  const normPrefix = prefix.toLowerCase();
  if (rangeBucketCache.has(normPrefix)) {
    return rangeBucketCache.get(normPrefix);
  }

  if (sendDecoys) {
    const decoys = generateDecoyPrefixes([normPrefix], 2);
    // Fire decoys in the background without awaiting them
    for (const decoy of decoys) {
      if (!rangeBucketCache.has(decoy)) {
        request(`range/${decoy}`, { signal }).then(res => {
          parseBucketResponse(res);
        }).catch(() => {});
      }
    }
  }

  const promise = (async () => {
    try {
      const response = await request(`range/${normPrefix}`, { signal });
      return parseBucketResponse(response);
    } catch (err) {
      rangeBucketCache.delete(normPrefix);
      throw err;
    }
  })();

  rangeBucketCache.set(normPrefix, promise);
  return promise;
}

function parseBucketResponse(data) {
  const suffixes = new Set();
  if (typeof data === 'string') {
    for (const line of data.split('\n')) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed) {
        // Take first 16 hex characters (64-bit suffix)
        suffixes.add(trimmed.slice(0, 16));
      }
    }
  } else if (data && Array.isArray(data.suffixes)) {
    for (const s of data.suffixes) suffixes.add(s.trim().slice(0, 16).toLowerCase());
  } else if (data && typeof data === 'object') {
    for (const key of Object.keys(data)) suffixes.add(key.trim().slice(0, 16).toLowerCase());
  }
  return suffixes;
}

/**
 * Checks series boundaries (e.g. NJA closed years) to classify deterministic non-existence.
 */
export function isDeterministicAbsence(uri) {
  const clean = (uri || '').trim();
  const nja = /^https:\/\/lagen\.nu\/dom\/nja\/(\d{4})s(\d+)/i.exec(clean);
  if (nja) {
    const year = parseInt(nja[1], 10);
    const page = parseInt(nja[2], 10);
    if (year < 1874) return true; // Before series start
    if (year > 2026) return true; // Future year
    if (year >= 1981 && year <= 2025) return true; // Complete indexing
    if (page === 0) return true;
  }
  const sfs = /^https:\/\/lagen\.nu\/(\d{4}):-?\d+$/i.exec(clean);
  if (sfs) {
    const year = parseInt(sfs[1], 10);
    if (year < 1600 || year > 2027) return true;
  }
  return false;
}

/**
 * Resolves a citation URI anonymously via k-anonymity range lookup in a SINGLE round-trip.
 * Bucket prefix is sha256(root_uri)[:3]. The bucket co-locates the parent document and all its pinpoints.
 * Suffixes are truncated to 16 hex characters (64 bits).
 * Falls back to direct resolve if the range endpoint is not yet supported on the backend.
 */
export async function resolveTargetPrivate(uri, signal, { fallbackToResolve = true, sendDecoys = false } = {}) {
  const canonical = canonicalUri(uri);
  const rootUri = canonical.split('#')[0];
  const rootHash = await sha256Hex(rootUri);
  const prefix = rootHash.slice(0, 3).toLowerCase();
  const rootSuffix = rootHash.slice(0, 16).toLowerCase();

  let bucket;
  try {
    bucket = await fetchRangeBucket(prefix, signal, { sendDecoys });
  } catch (error) {
    // If range endpoint returns 404/not implemented, seamlessly fall back to direct resolve
    if (fallbackToResolve) {
      return resolveTarget(uri, signal);
    }
    throw error;
  }

  const rootFound = bucket.has(rootSuffix) || CORE_SFS.has(rootUri.split('/').pop());
  const hasPinpoint = canonical.includes('#');

  // If citation has no pinpoint, result is direct
  if (!hasPinpoint) {
    if (rootFound) {
      return {
        status: 'found',
        result: { uri: rootUri, identifier: rootUri.split('/').pop() }
      };
    }
    const isInvalid = isDeterministicAbsence(rootUri);
    return {
      status: isInvalid ? 'invalid' : 'unconfirmed',
      result: undefined
    };
  }

  // Citation has a pinpoint fragment: check parent root URI and pinpoint anchor in the SAME bucket
  const targetHash = await sha256Hex(canonical);
  const targetSuffix = targetHash.slice(0, 16).toLowerCase();
  const targetFound = bucket.has(targetSuffix);

  if (targetFound) {
    return {
      status: 'found',
      result: {
        uri: rootUri,
        pin: { uri: canonical, label: canonical.split('#')[1] },
        identifier: rootUri.split('/').pop()
      }
    };
  }

  // Parent root exists in corpus, but this exact pinpoint does not -> INVALID provision
  if (rootFound) {
    return {
      status: 'invalid',
      result: undefined,
      reason: 'Bestämmelsen saknas i författningen.'
    };
  }

  // Neither parent nor pinpoint found
  const isInvalid = isDeterministicAbsence(rootUri);
  return {
    status: isInvalid ? 'invalid' : 'unconfirmed',
    result: undefined
  };
}

/**
 * Extracts the specific provision text for a given URI (including #pinpoint) from a document object.
 * If anchors map is present and has the pinpoint anchor, slices markdown using [start, end].
 * Otherwise returns the full markdown.
 */
export function getProvisionText(docData, uri) {
  if (!docData) return '';
  const markdown = typeof docData === 'string' ? docData : (docData.markdown || docData.text || '');
  if (!uri || !uri.includes('#')) {
    return markdown;
  }
  const anchor = uri.split('#')[1];
  if (docData.anchors && docData.anchors[anchor]) {
    const [start, end] = docData.anchors[anchor];
    if (typeof start === 'number' && typeof end === 'number' && end >= start) {
      return markdown.slice(start, end).trim();
    }
  }
  return markdown;
}

/**
 * Loads a static volume pack (e.g. "core" or "sfs/2010s").
 */
export async function loadPack(packId, signal) {
  if (packCache.has(packId)) {
    return packCache.get(packId);
  }

  const promise = (async () => {
    try {
      const data = await request(`packs/${packId}`, { signal });
      if (data && typeof data.documents === 'object') {
        for (const [docUri, docData] of Object.entries(data.documents)) {
          documentCache.set(canonicalUri(docUri), docData);
        }
      }
      return data;
    } catch (err) {
      packCache.delete(packId);
      throw err;
    }
  })();

  packCache.set(packId, promise);
  return promise;
}

/**
 * Retrieves a document source text, prioritizing local pack caches in Privacy Mode.
 */
export async function getDocumentSource(uri, signal, { privacyMode = false } = {}) {
  const rootUri = canonicalUri(uri.split('#')[0]);

  // 1. Check in-memory document cache
  if (documentCache.has(rootUri)) {
    return documentCache.get(rootUri);
  }

  // 2. In privacy mode, attempt to load the document from its static pack
  if (privacyMode) {
    const packId = packIdForUri(rootUri);
    try {
      await loadPack(packId, signal);
      if (documentCache.has(rootUri)) {
        return documentCache.get(rootUri);
      }
    } catch {
      // Pack endpoint not available yet or missing; fall back to direct document fetch
    }
  }

  // 3. Fallback to direct document fetch
  const response = await request(`document?${new URLSearchParams({ uri: rootUri, format: 'md' })}`, { signal });
  documentCache.set(rootUri, response);
  return response;
}
