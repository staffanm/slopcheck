// RFC 9458 Oblivious HTTP and RFC 9292 Binary HTTP client for Web Crypto
import { API } from './api.js';

export const OHTTP_CONFIG = {
  enabled: false,
  relayUrl: null, // e.g. 'https://privacy-gateway.cloudflare.com/relay'
  get gatewayUrl() {
    return this._gatewayUrl ?? `${API}/ohttp-gateway`;
  },
  set gatewayUrl(url) {
    this._gatewayUrl = url;
  },
  get keysUrl() {
    return this._keysUrl ?? `${API}/ohttp-keys`;
  },
  set keysUrl(url) {
    this._keysUrl = url;
  },
};

export const KEM_ID = 0x0020; // DHKEM(X25519, HKDF-SHA256)
export const KDF_ID = 0x0001; // HKDF-SHA256
export const AEAD_ID = 0x0001; // AES-128-GCM

const HPKE_VERSION = new TextEncoder().encode('HPKE-v1');
const SUITE_ID = concatBytes(
  new TextEncoder().encode('HPKE'),
  new Uint8Array([0x00, 0x20, 0x00, 0x01, 0x00, 0x01])
);
const KEM_SUITE_ID = concatBytes(
  new TextEncoder().encode('KEM'),
  new Uint8Array([0x00, 0x20])
);

export function concatBytes(...arrays) {
  const totalLen = arrays.reduce((acc, a) => acc + (a ? a.length : 0), 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    if (arr && arr.length) {
      out.set(arr, offset);
      offset += arr.length;
    }
  }
  return out;
}

export function hexToBytes(hex) {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// RFC 9000 varint encoding
export function encodeVarint(val) {
  if (val < (1 << 6)) {
    return new Uint8Array([val]);
  } else if (val < (1 << 14)) {
    return new Uint8Array([(0x40 | (val >> 8)), val & 0xff]);
  } else if (val < (1 << 30)) {
    return new Uint8Array([
      (0x80 | (val >> 24)),
      (val >> 16) & 0xff,
      (val >> 8) & 0xff,
      val & 0xff,
    ]);
  }
  throw new Error(`varint too large: ${val}`);
}

export function decodeVarint(bytes, pos) {
  if (pos >= bytes.length) throw new Error('truncated varint');
  const first = bytes[pos];
  const prefix = first >> 6;
  const len = 1 << prefix;
  if (pos + len > bytes.length) throw new Error('truncated varint');
  let val = first & (0x3f);
  if (prefix === 1) {
    val = (val << 8) | bytes[pos + 1];
  } else if (prefix === 2) {
    val = (val << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
  } else if (prefix === 3) {
    throw new Error('64-bit varint not supported');
  }
  return { val, nextPos: pos + len };
}

export function encodeField(bytesOrStr) {
  const b = typeof bytesOrStr === 'string' ? new TextEncoder().encode(bytesOrStr) : bytesOrStr;
  const v = encodeVarint(b.length);
  const out = new Uint8Array(v.length + b.length);
  out.set(v, 0);
  out.set(b, v.length);
  return out;
}

export function decodeField(bytes, pos) {
  const { val: len, nextPos } = decodeVarint(bytes, pos);
  if (nextPos + len > bytes.length) throw new Error('truncated field');
  const field = bytes.slice(nextPos, nextPos + len);
  return { field, nextPos: nextPos + len };
}

// Known-length Binary HTTP Request (RFC 9292 Section 3.1)
export function encodeBhttpRequest(method, path, headers = [], authority = 'lagen.nu') {
  const framing = encodeVarint(0);
  const m = encodeField(method);
  const scheme = encodeField('https');
  const auth = encodeField(authority);
  const p = encodeField(path);

  const headerParts = [];
  for (const [name, val] of headers) {
    headerParts.push(encodeField(name.toLowerCase()));
    headerParts.push(encodeField(val));
  }
  const section = encodeField(concatBytes(...headerParts));

  return concatBytes(framing, m, scheme, auth, p, section);
}

// Known-length Binary HTTP Response (RFC 9292 Section 3.2)
export function decodeBhttpResponse(bytes) {
  let pos = 0;
  const { val: framing, nextPos: p1 } = decodeVarint(bytes, pos);
  pos = p1;
  if (framing !== 1) throw new Error(`unexpected response framing: ${framing}`);
  const { val: status, nextPos: p2 } = decodeVarint(bytes, pos);
  pos = p2;
  const { field: sectionBytes, nextPos: p3 } = decodeField(bytes, pos);
  pos = p3;
  const { field: content, nextPos: p4 } = decodeField(bytes, pos);
  pos = p4;

  const headers = [];
  let sPos = 0;
  while (sPos < sectionBytes.length) {
    const { field: nameBytes, nextPos: sp1 } = decodeField(sectionBytes, sPos);
    const { field: valBytes, nextPos: sp2 } = decodeField(sectionBytes, sp1);
    sPos = sp2;
    headers.push([
      new TextDecoder().decode(nameBytes),
      new TextDecoder().decode(valBytes),
    ]);
  }

  return { status, headers, content };
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
  return new Uint8Array(sig);
}

async function hkdfExpand(prkBytes, infoBytes, length) {
  const n = Math.ceil(length / 32);
  let t = new Uint8Array(0);
  const okm = new Uint8Array(n * 32);
  let offset = 0;
  for (let i = 1; i <= n; i++) {
    const input = concatBytes(t, infoBytes, new Uint8Array([i]));
    t = await hmacSha256(prkBytes, input);
    okm.set(t, offset);
    offset += t.length;
  }
  return okm.slice(0, length);
}

async function labeledExtract(salt, label, ikm, suiteId) {
  const labelBytes = new TextEncoder().encode(label);
  const labeledIkm = concatBytes(HPKE_VERSION, suiteId, labelBytes, ikm);
  const effectiveSalt = (salt && salt.length > 0) ? salt : new Uint8Array(32);
  return hmacSha256(effectiveSalt, labeledIkm);
}

async function labeledExpand(prk, label, info, L, suiteId) {
  const labelBytes = new TextEncoder().encode(label);
  const lBytes = new Uint8Array([(L >> 8) & 0xff, L & 0xff]);
  const labeledInfo = concatBytes(lBytes, HPKE_VERSION, suiteId, labelBytes, info);
  return hkdfExpand(prk, labeledInfo, L);
}

async function keyScheduleBase(sharedSecret, info) {
  const pskIdHash = await labeledExtract(new Uint8Array(0), 'psk_id_hash', new Uint8Array(0), SUITE_ID);
  const infoHash = await labeledExtract(new Uint8Array(0), 'info_hash', info, SUITE_ID);
  const ksContext = concatBytes(new Uint8Array([0x00]), pskIdHash, infoHash);

  const secret = await labeledExtract(sharedSecret, 'secret', new Uint8Array(0), SUITE_ID);
  const key = await labeledExpand(secret, 'key', ksContext, 16, SUITE_ID);
  const baseNonce = await labeledExpand(secret, 'base_nonce', ksContext, 12, SUITE_ID);
  const exporterSecret = await labeledExpand(secret, 'exp', ksContext, 32, SUITE_ID);

  return { key, baseNonce, exporterSecret };
}

export async function hpkeExport(exporterSecret, exporterContext, length) {
  return labeledExpand(exporterSecret, 'sec', exporterContext, length, SUITE_ID);
}

export async function dhkemEncapsulate(pkRBytes, ephemeralKeyPair = null) {
  const pkR = await crypto.subtle.importKey(
    'raw',
    pkRBytes,
    { name: 'X25519' },
    false,
    []
  );

  let keyPair = ephemeralKeyPair;
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(
      { name: 'X25519' },
      true,
      ['deriveBits']
    );
  }

  const encRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const enc = new Uint8Array(encRaw);

  const dhRaw = await crypto.subtle.deriveBits(
    { name: 'X25519', public: pkR },
    keyPair.privateKey,
    256
  );
  const dh = new Uint8Array(dhRaw);

  const kemContext = concatBytes(enc, pkRBytes);
  const eaePrk = await labeledExtract(new Uint8Array(0), 'eae_prk', dh, KEM_SUITE_ID);
  const sharedSecret = await labeledExpand(eaePrk, 'shared_secret', kemContext, 32, KEM_SUITE_ID);

  return { sharedSecret, enc };
}

export async function setupBaseS(pkRBytes, info, ephemeralKeyPair = null) {
  const { sharedSecret, enc } = await dhkemEncapsulate(pkRBytes, ephemeralKeyPair);
  const { key, baseNonce, exporterSecret } = await keyScheduleBase(sharedSecret, info);
  return { enc, key, baseNonce, exporterSecret };
}

export function parseOhttpKeys(bytes) {
  if (bytes.length < 2) throw new Error('keys data too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const keys = [];

  while (pos + 2 <= bytes.length) {
    const configLength = view.getUint16(pos, false);
    pos += 2;
    if (pos + configLength > bytes.length) break;
    const configEnd = pos + configLength;
    const keyId = bytes[pos];
    const kemId = view.getUint16(pos + 1, false);
    const publicKey = bytes.slice(pos + 3, pos + 3 + 32);
    const symLen = view.getUint16(pos + 35, false);
    const kdfId = view.getUint16(pos + 37, false);
    const aeadId = view.getUint16(pos + 39, false);

    keys.push({
      keyId,
      kemId,
      publicKey,
      kdfId,
      aeadId,
    });
    pos = configEnd;
  }
  return keys;
}

let cachedKeyConfigs = null;
let keysExpiry = 0;

export async function fetchOhttpKeys(signal) {
  const now = Date.now();
  if (cachedKeyConfigs && now < keysExpiry) {
    return cachedKeyConfigs;
  }
  const response = await fetch(OHTTP_CONFIG.keysUrl, {
    signal,
    headers: { Accept: 'application/ohttp-keys' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch OHTTP keys: HTTP ${response.status}`);
  }
  const buf = await response.arrayBuffer();
  const keys = parseOhttpKeys(new Uint8Array(buf));
  if (!keys.length) {
    throw new Error('No valid OHTTP keys returned by server');
  }
  cachedKeyConfigs = keys;
  keysExpiry = now + 86400 * 1000;
  return keys;
}

export function setCachedKeyConfigs(configs, ttlMs = 86400000) {
  cachedKeyConfigs = configs;
  keysExpiry = Date.now() + ttlMs;
}

export function clearKeyCache() {
  cachedKeyConfigs = null;
  keysExpiry = 0;
}

export async function encapsulateRequest(bhttpBytes, keyConfig) {
  const header = new Uint8Array([
    keyConfig.keyId,
    (keyConfig.kemId >> 8) & 0xff,
    keyConfig.kemId & 0xff,
    (keyConfig.kdfId >> 8) & 0xff,
    keyConfig.kdfId & 0xff,
    (keyConfig.aeadId >> 8) & 0xff,
    keyConfig.aeadId & 0xff,
  ]);
  const info = concatBytes(new TextEncoder().encode('message/bhttp request\x00'), header);
  const ctx = await setupBaseS(keyConfig.publicKey, info);

  const aesKey = await crypto.subtle.importKey('raw', ctx.key, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ctx.baseNonce, additionalData: new Uint8Array(0) },
    aesKey,
    bhttpBytes
  ));

  const encapsulated = concatBytes(header, ctx.enc, ciphertext);
  return { encapsulated, enc: ctx.enc, exporterSecret: ctx.exporterSecret };
}

export async function decapsulateResponse(encapsulatedResponse, enc, exporterSecret) {
  if (encapsulatedResponse.length < 16 + 16) {
    throw new Error('Encapsulated response is too short');
  }
  const exp = await hpkeExport(exporterSecret, new TextEncoder().encode('message/bhttp response'), 16);
  const nonce = encapsulatedResponse.slice(0, 16);
  const sealed = encapsulatedResponse.slice(16);

  const salt = concatBytes(enc, nonce);
  const prk = await hmacSha256(salt, exp);
  const keyBytes = await hkdfExpand(prk, new TextEncoder().encode('key'), 16);
  const nonceBytes = await hkdfExpand(prk, new TextEncoder().encode('nonce'), 12);

  const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const decrypted = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonceBytes, additionalData: new Uint8Array(0) },
    aesKey,
    sealed
  ));

  return decodeBhttpResponse(decrypted);
}

export async function ohttpFetch(path, { method = 'GET', headers = {}, signal } = {}) {
  const keys = await fetchOhttpKeys(signal);
  const activeKey = keys.find(k => k.kemId === KEM_ID && k.kdfId === KDF_ID && k.aeadId === AEAD_ID) ?? keys[0];

  const fullPath = path.startsWith('/') ? path : `/api/v1/${path}`;
  const headerPairs = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]);

  const bhttp = encodeBhttpRequest(method, fullPath, headerPairs, 'lagen.nu');
  const { encapsulated, enc, exporterSecret } = await encapsulateRequest(bhttp, activeKey);

  const targetUrl = OHTTP_CONFIG.relayUrl || OHTTP_CONFIG.gatewayUrl;
  const postHeaders = {
    'Content-Type': 'message/ohttp-req',
  };
  if (OHTTP_CONFIG.relayUrl) {
    postHeaders['Target'] = OHTTP_CONFIG.gatewayUrl;
  }

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: postHeaders,
    body: encapsulated,
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });

  if (!response.ok) {
    throw new Error(`OHTTP Gateway responded with HTTP ${response.status}`);
  }

  const resBuf = await response.arrayBuffer();
  const inner = await decapsulateResponse(new Uint8Array(resBuf), enc, exporterSecret);

  if (inner.status < 200 || inner.status >= 300) {
    let errorDetail = `Inner HTTP ${inner.status}`;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(inner.content));
      if (parsed.detail) errorDetail = parsed.detail;
    } catch {}
    throw new Error(errorDetail);
  }

  const headerMap = new Map(inner.headers.map(([k, v]) => [k.toLowerCase(), v]));
  const textContent = () => new TextDecoder().decode(inner.content);
  const jsonContent = () => JSON.parse(textContent());

  return {
    status: inner.status,
    headers: headerMap,
    text: textContent,
    json: jsonContent,
    content: inner.content,
  };
}
