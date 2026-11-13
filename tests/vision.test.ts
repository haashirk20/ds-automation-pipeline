import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Brief, UgcConcept } from '../src/contracts.ts';
import { buildParams, setLlmClient } from '../src/llm/client.ts';
import { checkClip } from '../src/qa/vision.ts';
import { z } from 'zod';
import { config, fresh } from './helpers.ts';

const brief = Brief.parse(JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8')).brief);
const concept = UgcConcept.parse(JSON.parse(readFileSync(new URL('./fixtures/llm/ugc.json', import.meta.url), 'utf8')));
const ok = JSON.parse(readFileSync(new URL('./fixtures/llm/vision.json', import.meta.url), 'utf8'));
const ref = join(mkdtempSync(join(tmpdir(), 'vis-')), 'ref.jpg');
writeFileSync(ref, Buffer.from('ref'));
const frames = async () => [Buffer.from('a'), Buffer.from('b')];
const input = { clipFile: 'x.mp4', refImage: ref, brief, concept };
const NOW = new Date('2026-11-12T17:00:00Z');

afterEach(() => setLlmClient(null));

const answer = (v: unknown) => setLlmClient({ create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(v) }], usage: { input_tokens: 1, output_tokens: 1 } }) });
const run = (v: unknown) => (answer(v), checkClip(fresh(), config, input, NOW, 's1', { frames }));

test('buildParams puts images first, then text', () => {
  const p = buildParams({ purpose: 'x', model: 'm', system: 's', user: 'hi', schema: z.object({}), maxTokens: 1, effort: 'low', images: [{ mediaType: 'image/png', data: 'AA' }, { mediaType: 'image/jpeg', data: 'BB' }] });
  const c = (p.messages as { content: unknown }[])[0].content;
  assert.deepEqual(c, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BB' } },
    { type: 'text', text: 'hi' },
  ]);
  const plain = buildParams({ purpose: 'x', model: 'm', system: 's', user: 'hi', schema: z.object({}), maxTokens: 1, effort: 'low' });
  assert.equal((plain.messages as { content: unknown }[])[0].content, 'hi');
});

test('clean verdict passes; shop name in extraText is ignored', async () => {
  assert.equal((await run(ok)).pass, true);
  assert.equal((await run({ ...ok, extraText: ['GIFTWELL'] })).pass, true);
});

test('each bad field fails with a readable problem', async () => {
  const cases: [object, RegExp][] = [
    [{ productVisible: false }, /not clearly visible/],
    [{ productMatches: false }, /does not match/],
    [{ extraText: ['SALE'] }, /"SALE"/],
    [{ brandMisspelled: true }, /misspelled/],
    [{ bodyGlitch: true }, /generation fault/],
  ];
  for (const [o, re] of cases) {
    const r = await run({ ...ok, ...o });
    assert.equal(r.pass, false);
    assert.match(r.problems.join(' '), re);
  }
});

test('a model error propagates', async () => {
  setLlmClient({ create: async () => { throw new Error('boom'); } });
  await assert.rejects(checkClip(fresh(), config, input, NOW, 's1', { frames }), /boom/);
});
