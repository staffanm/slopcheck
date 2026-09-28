import { request } from './api.js';
import { NAMEDLAWS_DATA } from './lagrum/datasets.js';
import { loadFilter, unitKey, unitText } from './unit-index.js';

// Documents fetched in normal mode, by uri
export const documentCache = new Map();

export function canonicalUri(uri) {
  if (!uri) return '';
  try {
    const parsed = new URL(uri);
    return `${parsed.origin.toLowerCase()}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return uri.trim();
  }
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
 * Resolves a citation without a request that names it: the unit filter
 * (unit-index.js) says whether the document and the cited provision exist.
 */
export async function resolveTargetPrivate(uri, signal) {
  const canonical = canonicalUri(uri);
  const rootUri = canonical.split('#')[0];
  const hasPinpoint = canonical.includes('#');
  const filter = await loadFilter(signal);
  if (!filter) throw new Error('Integritetslägets filter kunde inte hämtas från lagen.nu. Försök igen.');
  const rootFound = filter.has(await unitKey(rootUri));
  const targetFound = hasPinpoint && filter.has(await unitKey(canonical));
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
 * A document's source text. In privacy mode it is the cited unit's own text,
 * fetched among fillers by prefetchUnits; nothing is fetched by uri.
 */
export async function getDocumentSource(uri, signal, { privacyMode = false, unit = null } = {}) {
  const rootUri = canonicalUri(uri.split('#')[0]);
  if (privacyMode) {
    const cited = canonicalUri(unit ?? uri);
    const own = unitText(cited);
    if (own === null) throw new Error('Hänvisningen gäller hela dokumentet. Integritetsläget hämtar bara text för enskilda bestämmelser.');
    if (own === undefined) throw new Error('Källtexten kunde inte hämtas anonymt. Försök igen.');
    const fragment = cited.split('#')[1];
    return { uri: rootUri, markdown: own, anchors: fragment ? { [fragment]: [0, own.length] } : {} };
  }
  if (documentCache.has(rootUri)) {
    return documentCache.get(rootUri);
  }

  // The markdown format has no page markers, so a förarbete is fetched as a
  // structured artifact and converted here, which yields sidN anchors for page
  // pinpoints.
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
