import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import manifest from '../src/model-manifest.json' with { type: 'json' };

for (const [name, expected] of Object.entries(manifest.files)) {
  const path = new URL(`../public/models/${manifest.version}/${name}`, import.meta.url);
  let bytes;
  try { bytes = readFileSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Model assets are missing. Run npm run model:prepare before building.');
  }
  if (bytes.byteLength !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error(`Model asset ${name} differs from the evaluated version. Re-export the pinned model.`);
  }
}
