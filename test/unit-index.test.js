import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fillerPrefixes, parseFilter, parseUnits, unitKey } from '../src/unit-index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/unit-index.json', import.meta.url)));
const bytes = b64 => { const b = Buffer.from(b64, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };

test('the filter ferenda writes answers membership and lists the most-cited units', async () => {
  const filter = parseFilter(bytes(fixture.filter));
  for (const uri of fixture.held) assert.equal(filter.has(await unitKey(uri)), true, uri);
  for (const uri of fixture.absent) assert.equal(filter.has(await unitKey(uri)), false, uri);
  assert.deepEqual(filter.popular[0], { prefix32: fixture.popular0[0], weight: fixture.popular0[1] });
  assert.equal(filter.popular.length, 2);
});

test('an answer decodes to each unit, its text inflated', async () => {
  const units = await parseUnits(bytes(fixture.answer));
  const key = await unitKey(fixture.held[1]);
  const unit = units.get(Number((key >> 16n) & 0xFFFFFFFFn));
  assert.deepEqual(unit, { uri: fixture.held[1], text: fixture.text });
  assert.deepEqual(units.get(1), { uri: fixture.held[0], text: null });
});

test('fillers are the same from one secret and avoid the real prefixes', async () => {
  const popular = [{ prefix32: 0xabcd0000, weight: 1000 }];
  const a = await fillerPrefixes(64, 16, popular, [0xabcd], 'secret');
  const b = await fillerPrefixes(64, 16, popular, [0xabcd], 'secret');
  assert.deepEqual(a, b);
  assert.equal(a.length, 64);
  assert.equal(new Set(a).size, 64);
  assert.ok(!a.includes(0xabcd));
  assert.notDeepEqual(a, await fillerPrefixes(64, 16, popular, [0xabcd], 'other'));
});
