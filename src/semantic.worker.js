import { Tokenizer } from '@huggingface/tokenizers';
import { InferenceSession, Tensor, env } from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import wasmModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import manifest from './model-manifest.json';
import { MODEL_VERSION, scoresFromLogits, semanticResult } from './semantic.js';
import { modelPassages, pairInput } from './semantic-input.js';

env.wasm.numThreads = 1; // Works on static hosts without cross-origin isolation.
env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
let tokenizer;
let session;
let backend;
let modelBytes;

async function asset(base, name) {
  if (!Object.hasOwn(manifest.files, name)) throw new Error('Okänd modellfil.');
  const url = new URL(`models/${MODEL_VERSION}/${name}`, base);
  if (url.origin !== self.location.origin) throw new Error('Modellfiler måste komma från samma webbplats.');
  let cache;
  try { cache = await globalThis.caches?.open(`slopcheck-model-${MODEL_VERSION}`); }
  catch (error) { if (!(error instanceof DOMException)) throw error; } // Private mode can prohibit asset storage.
  let response = await cache?.match(url);
  if (!response) {
    response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Modellfilen kunde inte hämtas (${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
  self.postMessage({ id, progress: 'Hämtar lokal språkmodell · 25 MB + körmiljö första gången…' });
  const files = await Promise.all(['tokenizer.json', 'tokenizer_config.json', 'model.onnx'].map(name => asset(base, name)));
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
    const selected = modelPassages(evidence.passages, tokenizer);
    const comparisons = [];
    for (const passage of selected.passages) {
      const encoded = pairInput(tokenizer, passage.text, claim.hypothesis);
      if (!encoded) { selected.incomplete = true; continue; }
      comparisons.push({ text: passage.text, court: passage.court, section: passage.section, role: passage.role, scores: await compare(encoded) });
    }
    self.postMessage({ id, result: { ...semanticResult(comparisons, { ...selected, requireConclusion: evidence.requireConclusion, reason: evidence.reason, exact: evidence.exact }), backend, model: MODEL_VERSION } });
  } catch (error) {
    // Worker boundary: preserve deterministic results and expose a retryable abstention.
    self.postMessage({ id, error: `Den lokala modellen kunde inte jämföra texten: ${error.message}` });
  }
};
