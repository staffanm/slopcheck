// Benchmarks the browser model through the code path privacy mode uses: the
// Vite app in Chromium, the semantic worker, onnxruntime-web and the JS
// tokenizer. The model is the one src/model-manifest.json names.
//
// 1. test/fixtures/legal-claims.jsonl: claim extraction, evidence selection and
//    the label policy, as in test/semantic.browser.js.
// 2. The audited test partition: each source split into paragraphs, one
//    assessment per row, three-way (misleading counts as neutral).
//
// Run: node scripts/benchmark-browser-model.mjs --out report.json [--test-data data/test.audited.jsonl] [--limit N]

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readLegalClaims } from '../test/legal-fixture.js';

const { values: args } = parseArgs({ options: {
  out: { type: 'string' }, 'test-data': { type: 'string', default: 'data/test.audited.jsonl' }, limit: { type: 'string' },
} });
const root = new URL('..', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('src/model-manifest.json', root), 'utf8'));

// A label is wrong when it points the reader the wrong way; see test/semantic.browser.js.
const FORBIDDEN = {
  supported: ['contradiction', 'incorrect', 'misleading', 'missing'],
  misleading: ['supported', 'correct'],
  incorrect: ['supported', 'correct'],
  nonsensical: ['supported', 'correct', 'contradiction', 'incorrect'],
  unsupported: ['supported', 'correct'],
};
const THREE_WAY = { supported: 'entailment', unsupported: 'neutral', incorrect: 'contradiction', misleading: 'neutral' };
const STATUS_TO_THREE = { correct: 'entailment', supported: 'entailment', missing: 'neutral', incorrect: 'contradiction', contradiction: 'contradiction' };

const server = await createServer({ root: root.pathname, server: { port: 5190, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5190/');

const inputs = readLegalClaims().map(({ id, label, markdown, occurrence, blocks, sources }) =>
  ({ id, label, markdown, occurrence, blocks, uri: sources[0].uri }));
const legal = await page.evaluate(async inputs => {
  const { claimContext, selectEvidence } = await import('/src/analysis.js');
  const { semanticClaim } = await import('/src/semantic.js');
  const { semanticClient } = await import('/src/semantic-client.js');
  const client = semanticClient(() => {});
  const results = [];
  for (const item of inputs) {
    const claim = semanticClaim(item.occurrence, claimContext(item.occurrence, item.blocks), item.blocks);
    const evidence = selectEvidence(item.markdown, item.uri, claim);
    const began = performance.now();
    const result = claim.assessable ? await client.assess(claim, evidence, new AbortController().signal) : { status: 'unassessable', comparisons: [] };
    results.push({ id: item.id, label: item.label, status: result.status, backend: result.backend, ms: performance.now() - began,
      scores: result.comparisons?.[0]?.scores });
  }
  client.stop();
  return results;
}, inputs);

let rows = (await readFile(new URL(args['test-data'], root), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
if (args.limit) rows = rows.slice(0, Number(args.limit));
const partition = [];
for (let offset = 0; offset < rows.length; offset += 50) {
  const batch = rows.slice(offset, offset + 50).map(row => ({ id: row.id, label: row.label, claim: row.claim,
    passages: row.sources.flatMap(source => source.text.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean)
      .map(text => ({ text, section: source.citation }))) }));
  partition.push(...await page.evaluate(async batch => {
    const { semanticClient } = await import('/src/semantic-client.js');
    const client = semanticClient(() => {});
    const results = [];
    for (const row of batch) {
      const began = performance.now();
      const result = await client.assess({ hypothesis: row.claim }, { passages: row.passages }, new AbortController().signal);
      results.push({ id: row.id, label: row.label, status: result.status, ms: performance.now() - began, scores: result.comparisons?.[0]?.scores });
    }
    client.stop();
    return results;
  }, batch));
  process.stderr.write(`\rtest partition ${partition.length} / ${rows.length}`);
}
process.stderr.write('\n');
await browser.close();
await server.close();

const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const assessedLegal = legal.filter(item => item.status !== 'unassessable');
const scored = partition.filter(item => item.scores);
const argmax = scores => Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
const accepted = partition.filter(item => STATUS_TO_THREE[item.status]);
const confusion = {};
for (const item of scored) {
  const key = `${THREE_WAY[item.label]}->${argmax(item.scores)}`;
  confusion[key] = (confusion[key] ?? 0) + 1;
}
const summary = {
  version: manifest.version,
  thresholds: manifest.thresholds,
  backend: legal.find(item => item.backend)?.backend,
  legal_claims: {
    assessed: assessedLegal.length,
    substantive: assessedLegal.filter(item => item.status !== 'abstain').length,
    wrong: assessedLegal.filter(item => FORBIDDEN[item.label]?.includes(item.status)).length,
    median_ms: Math.round(median(assessedLegal.map(item => item.ms))),
  },
  test_partition: {
    rows: partition.length,
    scored: scored.length,
    argmax_accuracy: scored.filter(item => argmax(item.scores) === THREE_WAY[item.label]).length / scored.length,
    accepted: accepted.length,
    precision_on_accepted: accepted.filter(item => STATUS_TO_THREE[item.status] === THREE_WAY[item.label]).length / accepted.length,
    accepted_by_label: Object.fromEntries(['entailment', 'neutral', 'contradiction'].map(label => [label,
      accepted.filter(item => STATUS_TO_THREE[item.status] === label).length])),
    confusion,
    median_ms: Math.round(median(partition.map(item => item.ms))),
  },
};
console.log(JSON.stringify(summary, null, 2));
if (args.out) await writeFile(args.out, JSON.stringify({ summary, legal, partition }, null, 2) + '\n');
