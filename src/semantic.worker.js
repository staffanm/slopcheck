import { Tokenizer } from '@huggingface/tokenizers';
import { InferenceSession, Tensor, env } from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import wasmModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import manifest from './model-manifest.json';
import { MODEL_VERSION, scoresFromLogits, semanticResult } from './semantic.js';
import { modelPassages, pairInput, premiseWindow } from './semantic-input.js';
import { sha256Hex } from './sha256.js';

env.wasm.numThreads = 1; // Works on static hosts without cross-origin isolation.
env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
let tokenizer;
let session;
let backend;
let modelBytes;

// Stream a download so the UI can show a real progress bar for the model file.
async function readWithProgress(response, total, onBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received, total || received);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged.buffer;
}

async function asset(base, name, onBytes) {
  if (!Object.hasOwn(manifest.files, name)) throw new Error('Okänd modellfil.');
  const url = new URL(`models/${MODEL_VERSION}/${name}`, base);
  if (url.origin !== self.location.origin) throw new Error('Modellfiler måste komma från samma webbplats.');
  let cache;
  try { cache = await globalThis.caches?.open(`slopcheck-model-${MODEL_VERSION}`); }
  catch (error) { if (!(error instanceof DOMException)) throw error; } // Private mode can prohibit asset storage.
  let response = await cache?.match(url);
  let bytes;
  if (response) {
    bytes = await response.arrayBuffer();
  } else {
    response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Modellfilen kunde inte hämtas (${response.status}).`);
    bytes = onBytes && response.body ? await readWithProgress(response, manifest.files[name].bytes, onBytes) : await response.arrayBuffer();
  }
  const digest = await sha256Hex(bytes);
  if (bytes.byteLength !== manifest.files[name].bytes || digest !== manifest.files[name].sha256) {
    await cache?.delete(url);
    throw new Error('Modellfilen stämmer inte med den publicerade versionen.');
  }
  try { await cache?.put(url, new Response(bytes)); }
  catch (error) { if (!(error instanceof DOMException)) throw error; } // Quota denial need not prevent inference.
  return bytes;
}

async function start(base, id) {
  if (session) return;
  self.postMessage({ id, progress: 'Hämtar lokal språkmodell · 25 MB + körmiljö första gången…', fraction: null });
  const onModelBytes = (received, total) => self.postMessage({ id, progress: `Hämtar lokal språkmodell · ${Math.round(received / total * 100)} %`, fraction: received / total });
  const files = await Promise.all(['tokenizer.json', 'tokenizer_config.json', 'model.onnx'].map(name => asset(base, name, name === 'model.onnx' ? onModelBytes : null)));
  tokenizer = new Tokenizer(...files.slice(0, 2).map(bytes => JSON.parse(new TextDecoder().decode(bytes))));
  modelBytes = files[2];
  if (self.navigator.gpu) {
    try {
      session = await InferenceSession.create(modelBytes, { executionProviders: ['webgpu'] });
      backend = 'WebGPU';
    } catch {
      // Unsupported GPU/operators recover through the same local CPU model.
      self.postMessage({ id, progress: 'WebGPU kunde inte användas. Startar lokal CPU-jämförelse…' });
    }
  }
  if (!session) await startWasm();
}

async function startWasm() {
  if (session) await session.release();
  session = await InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
  backend = 'WASM';
}

async function compare(encoded) {
  const feeds = Object.fromEntries(Object.entries(encoded).map(([name, values]) => [name, new Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length])]));
  let outputs;
  try { outputs = await session.run(feeds); }
  catch (error) {
    if (backend !== 'WebGPU') throw error;
    await startWasm();
    outputs = await session.run(feeds);
  }
  return scoresFromLogits(Array.from(outputs.logits.data));
}

self.onmessage = async ({ data: { id, base, claim, evidence } }) => {
  try {
    await start(base, id);
    const selected = modelPassages(evidence.passages, tokenizer, claim?.hypothesis);
    // The premise shape must match the weights. The shipped model scores one
    // passage at a time. A model trained on merged windows reads one window,
    // the way backend/model.py reads it. See docs/semantic-evaluation.md.
    const premises = manifest.premise === 'window'
      ? [premiseWindow(selected.passages, tokenizer, claim.hypothesis)].filter(Boolean)
      : selected.passages.map(({ text, court, section, role }) => ({ text, court, section, role }));
    const comparisons = [];
    for (const premise of premises) {
      const encoded = pairInput(tokenizer, premise.text, claim.hypothesis);
      if (!encoded) { selected.incomplete = true; continue; }
      comparisons.push({ ...premise, scores: await compare(encoded) });
    }
    self.postMessage({ id, result: { ...semanticResult(comparisons, { ...selected, requireConclusion: evidence.requireConclusion, reason: evidence.reason, exact: evidence.exact }), backend, model: MODEL_VERSION } });
  } catch (error) {
    // Worker boundary: preserve deterministic results and expose a retryable abstention.
    self.postMessage({ id, error: `Den lokala modellen kunde inte jämföra texten: ${error.message}` });
  }
};
