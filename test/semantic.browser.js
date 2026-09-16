import { test, expect } from '@playwright/test';
import cases from './fixtures/semantic-cases.json' with { type: 'json' };
import { readFile, writeFile } from 'node:fs/promises';
import legalCases from './fixtures/legal-claims.json' with { type: 'json' };

test('real model: Swedish evaluation, asset cache, and local-only inference', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const requests = [];
  page.on('request', r => requests.push({ url: r.url(), method: r.method(), body: r.postData() }));
  await page.goto('/');
  const results = await page.evaluate(async cases => {
    const { semanticClient } = await import('/src/semantic-client.js');
    const client = semanticClient(() => {});
    const signal = new AbortController().signal;
    const results = [];
    for (const item of cases.filter(item => item.assessable !== false)) {
      const start = performance.now();
      const result = await client.assess({ hypothesis: item.hypothesis }, { passages: [{ text: item.premise }] }, signal);
      results.push({ id: item.id, expected: item.expected, split: item.split, ms: performance.now() - start, ...result });
    }
    client.stop();
    return results;
  }, cases);
  await testInfo.attach('semantic-evaluation.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  await writeFile(testInfo.outputPath('semantic-evaluation.json'), JSON.stringify(results, null, 2) + '\n');
  expect(results).toHaveLength(20);
  expect(results.every(r => ['WASM', 'WebGPU'].includes(r.backend))).toBe(true);
  expect(results.find(r => r.id === 'late-acceptance').status).toBe('supported');
  expect(results.find(r => r.id === 'late-acceptance-negated').status).toBe('contradiction');
  expect(results.find(r => r.id === 'party-attribution').status).toBe('abstain');
  for (const result of results) {
    if (result.status !== 'abstain') expect(result.status, result.id).toBe(result.expected);
    expect(result.comparisons[0].text).toBe(cases.find(item => item.id === result.id).premise);
  }
  const assets = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('slopcheck-model-'));
    const cache = await caches.open(names[0]);
    return (await cache.keys()).map(r => r.url);
  });
  expect(assets).toHaveLength(3);
  expect(assets.every(url => /\/(model.onnx|tokenizer.json|tokenizer_config.json)$/.test(url))).toBe(true);
  expect(requests.every(r => r.method === 'GET' && !r.body)).toBe(true);
  expect(requests.every(r => new URL(r.url).origin === new URL(page.url()).origin)).toBe(true);
  await page.route('**/models/**', route => route.abort());
  const warm = await page.evaluate(async () => {
    const { semanticClient } = await import('/src/semantic-client.js');
    const client = semanticClient(() => {});
    const result = await client.assess({ hypothesis: 'Ett sent svar ska räknas som ett nytt anbud.' }, { passages: [{ text: 'Ett sent svar ska räknas som ett nytt anbud.' }] }, new AbortController().signal);
    client.stop();
    return result;
  });
  expect(warm.status).toBe('supported');
});

// A label is wrong when it points the reader the wrong way. A correct claim
// must never read as contradicted or unsupported; a misleading, incorrect or
// nonsensical claim must never read as supported. Abstention is always allowed.
const FORBIDDEN = {
  correct: ['contradiction', 'missing'],
  misleading: ['supported'],
  incorrect: ['supported'],
  nonsensical: ['supported', 'contradiction'],
};

test('real model: corpus claims about statutes and judgments never receive a wrong label', async ({ page }, testInfo) => {
  test.setTimeout(600000);
  const inputs = await Promise.all(legalCases.map(async item => ({ ...item,
    markdown: await readFile(new URL(`./fixtures/legal-sources/${item.file}`, import.meta.url), 'utf8'),
  })));
  await page.goto('/');
  const results = await page.evaluate(async inputs => {
    const { claimContext, selectEvidence } = await import('/src/analysis.js');
    const { semanticClaim } = await import('/src/semantic.js');
    const { semanticClient } = await import('/src/semantic-client.js');
    const client = semanticClient(() => {});
    const results = [];
    for (const item of inputs) {
      const start = item.text.indexOf(item.citation);
      const occurrence = { text: item.citation, locations: [{ block_id: 'text', start, end: start + item.citation.length }] };
      const blocks = [{ id: 'text', text: item.text }];
      const claim = semanticClaim(occurrence, claimContext(occurrence, blocks), blocks);
      const evidence = selectEvidence(item.markdown, item.uri, claim);
      const began = performance.now();
      const result = claim.assessable ? await client.assess(claim, evidence, new AbortController().signal) : { status: 'unassessable', reason: claim.reason, comparisons: [] };
      results.push({ id: item.id, kind: item.kind, defect: item.defect, known_gap: item.known_gap, ms: performance.now() - began, claim, evidence, result });
    }
    client.stop();
    return results;
  }, inputs);
  await testInfo.attach('legal-claim-results.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  await writeFile(testInfo.outputPath('legal-claim-results.json'), JSON.stringify(results, null, 2) + '\n');
  expect(results).toHaveLength(legalCases.length);
  for (const { id, kind, result } of results) {
    expect(FORBIDDEN[kind], `${id}: ${result.status} (${result.reason})`).not.toContain(result.status);
    expect(result.reason, id).not.toContain('sammanhang som inte kunde avgränsas');
  }
  // The two originally reported claims keep their attribution behaviour.
  const judgment = results.find(item => item.id === 'lower-court');
  expect(judgment.result.comparisons.length).toBeGreaterThan(0);
  expect(judgment.result.comparisons.every(p => p.court === 'högsta domstolen')).toBe(true);
  expect(judgment.result.comparisons.some(p => p.role === 'summary')).toBe(true);
  expect(judgment.result.comparisons.some(p => p.role === 'decision')).toBe(true);
  expect(results.find(item => item.id === 'guarantee').result.comparisons.length).toBe(2);
  // Every assessable judgment claim compares only the attributed court's own text.
  for (const { id, evidence, result } of results.filter(item => item.evidence.authority && item.result.comparisons.length)) {
    expect(result.comparisons.every(p => p.court === evidence.authority), id).toBe(true);
  }
});
