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
const input = { clipFile: 'x.mp4', refImages: [ref, ref], brief, concept };
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

test('clean verdict passes; the shop name alone is allowed, also with "The" and punctuation', async () => {
  assert.equal((await run(ok)).pass, true);
  assert.equal((await run({ ...ok, writing: [{ text: 'GIFTWELL', kind: 'prominent' }, { text: 'The Giftwell!', kind: 'prominent' }] })).pass, true);
});

test('background writing is listed and does not fail the clip', async () => {
  assert.equal((await run({ ...ok, writing: [{ text: 'EXIT', kind: 'background' }, { text: 'illegible', kind: 'background' }] })).pass, true);
});

test('prominent writing other than the shop name fails; an overlay fails even when it is the shop name', async () => {
  const p = await run({ ...ok, writing: [{ text: 'Giftwell', kind: 'prominent' }, { text: 'SALE', kind: 'prominent' }] });
  assert.equal(p.pass, false);
  assert.match(p.problems.join(' '), /prominent writing.*"SALE"/);
  assert.doesNotMatch(p.problems.join(' '), /"Giftwell"/);
  const o = await run({ ...ok, writing: [{ text: 'Giftwell', kind: 'overlay' }] });
  assert.equal(o.pass, false);
  assert.match(o.problems.join(' '), /over the picture.*"Giftwell"/);
});

test('writing one or two letters away from the shop name fails, whatever its kind; spacing, case and "the" do not', async () => {
  for (const kind of ['background', 'prominent'] as const) {
    const r = await run({ ...ok, writing: [{ text: 'Giftwel', kind }] });
    assert.equal(r.pass, false, kind);
    assert.match(r.problems.join(' '), /nearly spells the shop's name.*"Giftwel"/);
  }
  assert.equal((await run({ ...ok, writing: [{ text: 'GIFT WELL', kind: 'background' }, { text: 'EXIT', kind: 'background' }, { text: 'Gift', kind: 'background' }] })).pass, true);
  const marts = { ...brief, shop: { ...brief.shop, name: 'Merry Marts' } };
  answer({ ...ok, writing: [{ text: 'The Merry Marts', kind: 'prominent' }] });
  assert.equal((await checkClip(fresh(), config, { ...input, brief: marts }, NOW, 's1', { frames })).pass, true);
});

test('each boolean fails with a readable problem', async () => {
  const cases: [object, RegExp][] = [
    [{ productVisible: false }, /not clearly visible/],
    [{ productMatches: false }, /does not match/],
    [{ brandMisspelled: true }, /misspelled/],
    [{ bodyGlitch: true }, /generation fault/],
  ];
  for (const [o, re] of cases) {
    const r = await run({ ...ok, ...o });
    assert.equal(r.pass, false);
    assert.match(r.problems.join(' '), re);
  }
});

test('the request carries all references, the owner note and the frames, and the system text is stable', async () => {
  const seen: { system: unknown; content: any[] }[] = [];
  setLlmClient({ create: async (p: any) => (seen.push({ system: p.system, content: p.messages[0].content }), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(ok) }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  await checkClip(fresh(), config, input, NOW, 's1', { frames });
  await checkClip(fresh(), config, { ...input, concept: { ...concept, setting: 'elsewhere' } }, NOW, 's1', { frames });
  assert.equal(seen[0].content.filter((c) => c.type === 'image').length, 4);
  assert.match(seen[0].content.at(-1).text, /The first 2 images are REFERENCE photos[\s\S]*Owner's note on the product: /);
  assert.deepEqual(seen[0].system, seen[1].system);
});

test('a model error propagates', async () => {
  setLlmClient({ create: async () => { throw new Error('boom'); } });
  await assert.rejects(checkClip(fresh(), config, input, NOW, 's1', { frames }), /boom/);
});
