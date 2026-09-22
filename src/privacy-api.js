import { API, request, resolveTarget } from './api.js';
import { NAMEDLAWS_DATA } from './lagrum/datasets.js';
import {
  OHTTP_CONFIG,
  ohttpFetch,
} from './ohttp.js';

export { OHTTP_CONFIG, ohttpFetch };

// Top-cited SFS statutes in the Core Statute Pack (top 250 in catalog.sqlite)
const CORE_SFS = new Set([
  '1736:0123_2', '1891:35_s.1', '1915:218', '1920:405', '1921:225', '1928:370', '1942:740', '1947:576',
  '1949:105', '1949:381', '1953:272', '1956:623', '1957:297', '1958:637', '1960:729', '1962:381',
  '1962:700', '1964:167', '1967:837', '1968:64', '1969:387', '1970:979', '1970:988', '1970:994',
  '1971:289', '1971:291', '1971:69', '1971:948', '1972:207', '1972:429', '1972:620', '1972:719',
  '1973:1149', '1973:1173', '1973:289', '1973:349', '1973:90', '1974:152', '1974:371', '1975:1385',
  '1975:1418', '1975:635', '1976:125', '1976:580', '1977:1160', '1977:179', '1977:480', '1979:1152',
  '1979:230', '1979:429', '1980:100', '1980:620', '1981:774', '1982:673', '1982:713', '1982:763',
  '1982:80', '1984:387', '1985:1100', '1985:125', '1986:223', '1987:10', '1987:230', '1987:259',
  '1987:619', '1987:667', '1987:672', '1988:534', '1988:870', '1988:950', '1989:529', '1990:324',
  '1990:52', '1990:782', '1990:931', '1991:1128', '1991:1129', '1991:1469', '1991:45', '1991:481',
  '1991:614', '1991:900', '1992:1434', '1992:859', '1993:100', '1993:1617', '1993:20', '1993:387',
  '1993:581', '1993:787', '1993:891', '1994:1000', '1994:1009', '1994:1564', '1994:1738', '1994:1776',
  '1994:200', '1995:1554', '1995:450', '1995:584', '1996:242', '1996:67', '1997:238', '1997:483',
  '1997:857', '1998:1474', '1998:204', '1998:488', '1998:620', '1998:808', '1999:1078', '1999:1229',
  '1999:1395', '2000:1225', '2000:980', '2001:453', '2002:160', '2003:389', '2004:168', '2004:297',
  '2004:46', '2004:519', '2005:104', '2005:551', '2005:716', '2007:1091', '2007:1244', '2007:515',
  '2007:528', '2008:355', '2008:486', '2008:567', '2008:579', '2009:366', '2009:400', '2010:110',
  '2010:1622', '2010:2039', '2010:2043', '2010:361', '2010:610', '2010:659', '2010:696', '2010:751',
  '2010:800', '2010:900', '2011:1244', '2011:203', '2014:801', '2015:315', '2016:1145', '2016:1146',
  '2017:30', '2017:630', '2017:725', '2017:900', '2018:1138', '2018:1177', '2018:218', '2018:585',
  '2025:400',
]);

// In-memory caches for range buckets and packs
export const rangeBucketCache = new Map();
export const packCache = new Map();
export const documentCache = new Map();

const PACK_CACHE_NAME = 'slopcheck-packs-v1';

export async function getPackFromCache(packId) {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(PACK_CACHE_NAME);
    const match = await cache.match(`/packs/${packId}`);
    if (match) {
      return match.json();
    }
  } catch {
    // CacheStorage can throw in restricted contexts
  }
  return null;
}

export async function putPackInCache(packId, packData) {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(PACK_CACHE_NAME);
    const response = new Response(JSON.stringify(packData), {
      headers: { 'Content-Type': 'application/json' },
    });
    await cache.put(`/packs/${packId}`, response);
  } catch {
    // Ignore cache write errors
  }
}

export function canonicalUri(uri) {
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    return `${parsed.origin.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return uri.trim();
  }
}

import { sha256Hex } from './sha256.js';

export { sha256Hex };

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
 * Follows ferenda/lib/packs.py contract.
 */
export function packIdForUri(uri, { ignoreCore = false } = {}) {
  const clean = (uri || '').split('#')[0].trim();

  // 1. SFS acts (Lag / förordning)
  const sfsMatch = /^https:\/\/lagen\.nu\/(\d{4}):(\d+)/i.exec(clean);
  if (sfsMatch) {
    const sfsId = `${sfsMatch[1]}:${sfsMatch[2]}`;
    if (!ignoreCore && CORE_SFS.has(sfsId)) {
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
  // e.g. https://lagen.nu/celex/12012M/TXT, https://lagen.nu/celex/32016R0679, https://lagen.nu/celex/62015CJ0123
  const celexMatch = /^https:\/\/lagen\.nu\/celex\/([0-9])(\d{4})/i.exec(clean);
  if (celexMatch) {
    const sector = celexMatch[1];
    const year = celexMatch[2];
    if (sector === '1') {
      return 'celex/1';
    }
    return `celex/${sector}/${year}`;
  }

  // 5. Förarbeten: Propositioner (prop), SOU, Ds, Betänkanden
  const propMatch = /^https:\/\/lagen\.nu\/prop\/(\d{4}(?:[-/]\d{2,4})?)/i.exec(clean);
  if (propMatch) {
    const sess = propMatch[1].replace('/', '-');
    return `prop/${sess}`;
  }
  const souMatch = /^https:\/\/lagen\.nu\/sou\/(\d{4}):/i.exec(clean);
  if (souMatch) {
    return `sou/${souMatch[1]}`;
  }
  const dsMatch = /^https:\/\/lagen\.nu\/ds\/(\d{4}):/i.exec(clean);
  if (dsMatch) {
    return `ds/${dsMatch[1]}`;
  }
  const forarbeteMatch = /^https:\/\/lagen\.nu\/([a-z]+)\/(\d{4}):/i.exec(clean);
  if (forarbeteMatch) {
    return `${forarbeteMatch[1].toLowerCase()}/${forarbeteMatch[2]}`;
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
        const fetcher = ohttp
          ? ohttpFetch(`range/${decoy}`, { signal, headers: { accept: 'text/plain' } }).then(r => r.text())
          : request(`range/${decoy}`, { signal, headers: { accept: 'text/plain, application/json' } });
        fetcher.then(res => {
          parseBucketResponse(res);
        }).catch(() => {});
      }
    }
  }

  const promise = (async () => {
    try {
      const response = ohttp
        ? await ohttpFetch(`range/${normPrefix}`, { signal, headers: { accept: 'text/plain' } }).then(r => r.text())
        : await request(`range/${normPrefix}`, { signal, headers: { accept: 'text/plain, application/json' } });
      return parseBucketResponse(response);
    } catch (err) {
      rangeBucketCache.delete(normPrefix);
      throw err;
    }
  })();

  rangeBucketCache.set(normPrefix, promise);
  return promise;
}

export function parseBucketResponse(data) {
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

export function formatPinLabel(fragment) {
  if (!fragment) return '';
  const clean = fragment.replace(/^#/, '');
  const kpMatch = /^K(\d+[a-z]?)P(\d+[a-z]?)$/i.exec(clean);
  if (kpMatch) {
    const k = kpMatch[1].replace(/([a-z]+)/i, ' $1');
    const p = kpMatch[2].replace(/([a-z]+)/i, ' $1');
    return `${k} kap. ${p} §`;
  }
  const pMatch = /^P(\d+[a-z]?)$/i.exec(clean);
  if (pMatch) {
    const p = pMatch[1].replace(/([a-z]+)/i, ' $1');
    return `${p} §`;
  }
  const kMatch = /^K(\d+[a-z]?)$/i.exec(clean);
  if (kMatch) {
    const k = kMatch[1].replace(/([a-z]+)/i, ' $1');
    return `${k} kap.`;
  }
  const sidMatch = /^sid(\d+)$/i.exec(clean);
  if (sidMatch) {
    return `s. ${sidMatch[1]}`;
  }
  const recitalMatch = /^recital-(\d+)$/i.exec(clean);
  if (recitalMatch) {
    return `skäl ${recitalMatch[1]}`;
  }
  if (/^\d+(\.\d+)*$/.test(clean)) {
    return `art. ${clean}`;
  }
  return clean;
}

export function formatDisplayTitle(rootUri) {
  if (!rootUri) return '';
  const clean = rootUri.trim().replace(/\/$/, '');

  // SFS
  const sfsMatch = /^https:\/\/lagen\.nu\/(\d{4}):(\d+)$/i.exec(clean);
  if (sfsMatch) {
    const sfsId = `${sfsMatch[1]}:${sfsMatch[2]}`;
    if (NAMEDLAWS_DATA?.current) {
      for (const [name, sfs] of Object.entries(NAMEDLAWS_DATA.current)) {
        if (sfs === sfsId || sfs.startsWith(sfsId + ' ')) {
          return name.charAt(0).toUpperCase() + name.slice(1);
        }
      }
    }
    return `Lag (${sfsId})`;
  }

  // NJA
  const njaMatch = /^https:\/\/lagen\.nu\/dom\/nja\/(\d{4})s(\d+)$/i.exec(clean);
  if (njaMatch) {
    return `NJA ${njaMatch[1]} s. ${njaMatch[2]}`;
  }

  // HFD
  const hfdMatch = /^https:\/\/lagen\.nu\/dom\/hfd\/(\d{4}):(\d+)$/i.exec(clean);
  if (hfdMatch) {
    return `HFD ${hfdMatch[1]} ref. ${hfdMatch[2]}`;
  }

  // Prop
  const propMatch = /^https:\/\/lagen\.nu\/prop\/(.+)$/i.exec(clean);
  if (propMatch) {
    return `Prop. ${propMatch[1]}`;
  }

  return clean.split('/').pop() || clean;
}

/**
 * Resolves a citation URI anonymously via k-anonymity range lookup in a SINGLE round-trip.
 * Bucket prefix is sha256(root_uri)[:3]. The bucket co-locates the parent document and all its pinpoints.
 * Suffixes are truncated to 16 hex characters (64 bits).
 * Falls back to direct resolve if the range endpoint is not yet supported on the backend.
 */
export async function resolveTargetPrivate(uri, signal, { fallbackToResolve = false, sendDecoys = false } = {}) {
  const canonical = canonicalUri(uri);
  const rootUri = canonical.split('#')[0];
  const rootHash = await sha256Hex(rootUri);
  const prefix = rootHash.slice(0, 3).toLowerCase();
  const rootSuffix = rootHash.slice(0, 16).toLowerCase();

  let bucket;
  try {
    bucket = await fetchRangeBucket(prefix, signal, { sendDecoys });
  } catch (error) {
    if (fallbackToResolve) {
      return resolveTarget(uri, signal);
    }
    throw error;
  }

  const rootFound = bucket.has(rootSuffix) || CORE_SFS.has(rootUri.split('/').pop());
  const hasPinpoint = canonical.includes('#');
  const displayTitle = formatDisplayTitle(rootUri);
  const identifier = rootUri.split('/').pop();

  // If citation has no pinpoint, result is direct
  if (!hasPinpoint) {
    if (rootFound) {
      return {
        status: 'found',
        result: { uri: rootUri, identifier, display: displayTitle, title: displayTitle },
      };
    }
    const isInvalid = isDeterministicAbsence(rootUri);
    return {
      status: isInvalid ? 'invalid' : 'unconfirmed',
      result: undefined,
    };
  }

  // Citation has a pinpoint fragment: check parent root URI and pinpoint anchor in the SAME bucket
  const targetHash = await sha256Hex(canonical);
  const targetSuffix = targetHash.slice(0, 16).toLowerCase();
  const targetFound = bucket.has(targetSuffix);

  if (targetFound) {
    const fragment = canonical.split('#')[1];
    return {
      status: 'found',
      result: {
        uri: rootUri,
        display: displayTitle,
        title: displayTitle,
        pin: { uri: canonical, label: formatPinLabel(fragment) },
        identifier,
      },
    };
  }

  // Parent root exists in corpus, but this exact pinpoint does not -> INVALID provision
  if (rootFound) {
    return {
      status: 'invalid',
      result: undefined,
      reason: 'Bestämmelsen saknas i författningen.',
    };
  }

  // Neither parent nor pinpoint found
  const isInvalid = isDeterministicAbsence(rootUri);
  return {
    status: isInvalid ? 'invalid' : 'unconfirmed',
    result: undefined,
  };
}

export function inlineRunsToText(runs) {
  if (!runs) return '';
  if (typeof runs === 'string') return runs;
  if (Array.isArray(runs)) {
    return runs.map(run => {
      if (typeof run === 'string') return run;
      if (run && typeof run === 'object') {
        const text = run.text || '';
        const uri = run.uri;
        if (uri && text) {
          return `[${text}](${uri})`;
        }
        return text;
      }
      return '';
    }).join('');
  }
  return '';
}

/**
 * Converts a raw JSON artifact AST into markdown and an anchor offset map.
 */
export function artifactToMarkdown(art) {
  if (!art) return { markdown: '', anchors: {} };
  if (typeof art === 'string') return { markdown: art, anchors: {} };
  if (art.markdown) {
    return { markdown: art.markdown, anchors: art.anchors || {}, title: art.title || '' };
  }

  const title = art.title
    || art.metadata?.properties?.['dcterms:title']
    || art.metadata?.properties?.['dcterms:identifier']
    || art.label
    || '';

  const anchors = {};
  const chunks = [];
  let currentLen = 0;
  // Every node of a förarbete carries its printed page. A page runs from its
  // first node to the first node of a later page, so nesting never matters.
  const pageStarts = [];

  function appendChunk(text) {
    if (!text) return;
    chunks.push(text);
    currentLen += text.length;
  }

  if (title) {
    appendChunk(`# ${title}\n\n`);
  }

  function walk(node, depth = 1) {
    if (!node || typeof node !== 'object') return;
    const type = node.type || '';
    const id = node.id;
    const startIndex = currentLen;
    if (typeof node.page === 'number') pageStarts.push([node.page, startIndex]);

    const bodyRuns = node.text || '';
    const body = inlineRunsToText(bodyRuns).trim();

    if (type === 'rubrik' || type === 'heading') {
      const hDepth = Math.min(6, (node.depth || depth) + 1);
      appendChunk(`${'#'.repeat(hDepth)} ${body}\n\n`);
    } else if (type === 'avdelning' || type === 'kapitel') {
      const heading = node.rubrik ? inlineRunsToText(node.rubrik).trim() : body;
      const num = node.num ? `${node.num} kap.` : '';
      const hTitle = [num, heading].filter(Boolean).join(' ');
      if (hTitle) appendChunk(`## ${hTitle}\n\n`);
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    } else if (type === 'paragraf') {
      const bet = node.beteckning || (node.num ? `${node.num} §` : '');
      if (bet) {
        appendChunk(`**${bet}** `);
      }
      if (body) {
        appendChunk(`${body}\n\n`);
      }
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
      if (!body && !node.children?.length) {
        appendChunk('\n\n');
      }
    } else if (type === 'stycke' || type === 'paragraph') {
      const bet = node.beteckning ? `**${node.beteckning}** ` : (node.num ? `${node.num}. ` : '');
      appendChunk(`${bet}${body}\n\n`);
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    } else if (type === 'punkt' || type === 'point') {
      const num = node.ordinal || node.num;
      const marker = num ? `${num}. ` : '- ';
      appendChunk(`${marker}${body}\n\n`);
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    } else if (type === 'article') {
      const num = node.num ? `Artikel ${node.num}` : '';
      if (num) appendChunk(`## ${num}\n\n`);
      if (body) appendChunk(`${body}\n\n`);
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    } else if (type === 'recital') {
      const num = node.num ? `(${node.num}) ` : '';
      appendChunk(`${num}${body}\n\n`);
    } else {
      if (body) {
        appendChunk(`${body}\n\n`);
      }
      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    }

    const endIndex = currentLen;
    if (id) {
      anchors[id] = [startIndex, endIndex];
      if (/^P\d+[a-z]?$/i.test(id)) {
        anchors[id.toUpperCase()] = [startIndex, endIndex];
      }
    }
  }

  const nodes = art.structure || art.artifact?.structure || art.body || art.children || [];
  for (const node of nodes) {
    walk(node, 1);
  }

  const markdown = chunks.join('');
  pageStarts.forEach(([page, start], index) => {
    if (anchors[`sid${page}`]) return;
    const end = pageStarts.slice(index + 1).find(([later]) => later > page)?.[1] ?? markdown.length;
    anchors[`sid${page}`] = [start, end];
  });
  return { markdown, anchors, title };
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
 * Uses browser CacheStorage when available.
 */
export async function loadPack(packId, signal) {
  if (packCache.has(packId)) {
    return packCache.get(packId);
  }

  const promise = (async () => {
    try {
      let data = await getPackFromCache(packId);
      if (!data) {
        if (OHTTP_CONFIG.enabled) {
          const res = await ohttpFetch(`packs/${packId}`, { signal });
          data = res.json();
          await putPackInCache(packId, data);
        } else {
          if (typeof caches !== 'undefined') {
            try {
              const res = await fetch(`${API}/packs/${packId}`, {
                signal,
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
              });
              if (res.ok) {
                const cache = await caches.open(PACK_CACHE_NAME);
                await cache.put(`/packs/${packId}`, res.clone());
                data = await res.json();
              }
            } catch {
              // Fall through to request()
            }
          }
          if (!data) {
            data = await request(`packs/${packId}`, { signal });
            await putPackInCache(packId, data);
          }
        }
      }

      if (data && typeof data.documents === 'object') {
        for (const [docUri, docData] of Object.entries(data.documents)) {
          if (docData && typeof docData === 'object' && !docData.markdown) {
            const converted = artifactToMarkdown(docData);
            docData.markdown = converted.markdown;
            docData.anchors = converted.anchors;
            docData.title = docData.title || converted.title;
          }
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
 * Pre-fetches the Core Statute Pack in the background during initialization.
 */
export async function prefetchCorePack(signal) {
  try {
    return await loadPack('core', signal);
  } catch {
    return null;
  }
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
      // If packId was 'core' but the document was not included, try its era volume pack
      if (packId === 'core') {
        const volumePackId = packIdForUri(rootUri, { ignoreCore: true });
        if (volumePackId && volumePackId !== 'core') {
          await loadPack(volumePackId, signal);
          if (documentCache.has(rootUri)) {
            return documentCache.get(rootUri);
          }
        }
      }
    } catch {
      // Pack endpoint not available or missing; fall back to direct document fetch
    }
  }

  // 3. Fallback to direct document fetch. The markdown format has no page
  // markers, so a förarbete is fetched as a structured artifact and converted
  // here, which yields sidN anchors for page pinpoints.
  const paged = /^\/(?:prop|sou|ds|bet)\//.test(new URL(rootUri).pathname);
  const response = await request(`document?${new URLSearchParams(paged ? { uri: rootUri } : { uri: rootUri, format: 'md' })}`, { signal });
  if (response && typeof response === 'object' && !response.markdown) {
    const converted = artifactToMarkdown(response);
    response.markdown = converted.markdown;
    response.anchors = converted.anchors;
    response.title = response.title || converted.title;
  }
  documentCache.set(rootUri, response);
  return response;
}
