// D-46: the per-product ASMR unboxing style.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brief, UgcConcept } from '../src/contracts.ts';
import { setLlmClient } from '../src/llm/client.ts';
import { fileText, isEditable } from '../src/llm/prompts.ts';
import { buildClipPrompt, conceptProblems, writeConcept } from '../src/creative/ugc.ts';
import { fallbackCopy, aboutConcept, copyProblems } from '../src/creative/copy.ts';
import { languageProblems } from '../src/creative/claims.ts';
import { checkClip } from '../src/qa/vision.ts';
import { defaultStyle, videoStyle, videoStyles } from '../src/shopify/catalog.ts';
import { kvSet } from '../src/db/index.ts';
import { config, fresh } from './helpers.ts';

const brief = Brief.parse(JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8')).brief);
const asmr = UgcConcept.parse(JSON.parse(readFileSync(new URL('./fixtures/llm/ugc-asmr.json', import.meta.url), 'utf8')));
const story = UgcConcept.parse(JSON.parse(readFileSync(new URL('./fixtures/llm/ugc.json', import.meta.url), 'utf8')));
const notebook = { ...brief, product: { ...brief.product, handle: 'magic-world-green', title: 'Magic World Notebook Gift Kit' } };
const NOW = new Date('2026-11-12T17:00:00Z');
const cfg = { ...config, tiers: { ...config.tiers, clipSeconds: 15 } };

afterEach(() => {
  delete process.env.LLM_STUB;
  setLlmClient(null);
});

test('video style: the stored choice, else asmr for a notebook or journal title, else story; bad values ignored', () => {
  const db = fresh();
  assert.equal(defaultStyle('Magic World NOTEBOOK kit'), 'asmr');
  assert.equal(defaultStyle('Sweet Ribbon Journal'), 'asmr');
  assert.equal(defaultStyle('Heated Shawl Wrap'), 'story');
  assert.equal(videoStyle(db, notebook.product), 'asmr');
  assert.equal(videoStyle(db, brief.product), 'story');
  kvSet(db, 'video_styles', JSON.stringify({ 'magic-world-green': 'story', [brief.product.handle]: 'asmr', other: 'loud' }));
  assert.deepEqual(videoStyles(db), { 'magic-world-green': 'story', [brief.product.handle]: 'asmr' });
  assert.equal(videoStyle(db, notebook.product), 'story');
  assert.equal(videoStyle(db, brief.product), 'asmr');
  kvSet(db, 'video_styles', 'not json');
  assert.equal(videoStyle(db, notebook.product), 'asmr');
});

test('ugc-asmr is an editable text read from prompts/ugc-asmr.md', () => {
  assert.ok(isEditable('ugc-asmr'));
  assert.match(fileText('ugc-asmr'), /`Product note:` line in the request/);
  assert.match(fileText('ugc-asmr'), /`line`: always an empty string/);
});

function fake(answer: unknown, purposes: string[], systems: string[]) {
  setLlmClient({
    create: async (p) => {
      const content = (p.messages as { content: string }[])[0].content;
      const judge = /Judge these/.test(content);
      purposes.push(judge ? 'claims' : 'concept');
      systems.push(JSON.stringify(p.system));
      const n = Number(/Judge these (\d+)/.exec(content)?.[1]);
      const body = judge ? { verdicts: Array.from({ length: n }, (_, i) => i + 1).map((chunk) => ({ chunk, supported: true, factId: null, reason: 'ok' })) } : answer;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }], usage: { input_tokens: 10, output_tokens: 10 } };
    },
  });
}

test('writeConcept: a notebook uses the ugc-asmr instructions and the line is forced empty in code', async () => {
  const db = fresh();
  const purposes: string[] = [];
  const systems: string[] = [];
  fake({ ...asmr, line: 'I love this so much' }, purposes, systems);
  const c = await writeConcept(db, cfg, notebook, [], NOW, 's1');
  assert.equal(c.line, '');
  assert.equal(c.shots.length, 6);
  assert.ok(systems[0].includes('ASMR unboxing videos'));
  assert.deepEqual((db.prepare('SELECT purpose FROM llm_calls ORDER BY id').all() as { purpose: string }[]).map((r) => r.purpose), ['ugc-asmr', 'claims']);
  // The same product set to story uses the story instructions.
  kvSet(db, 'video_styles', JSON.stringify({ 'magic-world-green': 'story' }));
  fake(story, purposes, systems);
  await writeConcept(db, cfg, notebook, [], NOW, 's1');
  assert.ok(!systems.at(-2)!.includes('ASMR unboxing videos'));
});

test('writeConcept with LLM_STUB=1 and style asmr returns the ugc-asmr fixture', async () => {
  const db = fresh();
  process.env.LLM_STUB = '1';
  const c = await writeConcept(db, cfg, brief, [], NOW, 's1', 'asmr');
  assert.equal(c.line, '');
  assert.match(c.caption, /reading nook/);
});

test('conceptProblems: asmr skips the woman rule and allows 6 shots; story keeps both; speech is rejected in both', () => {
  assert.deepEqual(conceptProblems(brief, asmr, 15, [], [], 'asmr'), []);
  const p = conceptProblems(brief, asmr, 15, [], [], 'story');
  assert.ok(p.some((x) => /woman/.test(x)));
  assert.ok(p.some((x) => /6 shots, at most 5/.test(x)));
  assert.ok(conceptProblems(brief, { ...asmr, line: 'hi' }, 15, [], [], 'asmr').some((x) => /line must be empty/.test(x)));
  const talk = { ...asmr, shots: [{ ...asmr.shots[0], action: 'She whispers to the camera while untying the ribbon.' }, ...asmr.shots.slice(1)] };
  assert.ok(conceptProblems(brief, talk, 15, [], [], 'asmr').some((x) => /shot 1.*speech/.test(x)));
});

test('buildClipPrompt for asmr: first-person hands only, handling sounds, no speech or music, even with a line', () => {
  const opts = { look: 'A green notebook kit.', brand: 'Giftwell', logo: false, style: 'asmr' as const };
  const r = buildClipPrompt(brief, { ...asmr, line: 'hello there' }, ['front'], opts);
  assert.match(r.prompt, /filmed first person/);
  assert.match(r.prompt, /Only her hands and forearms are ever visible, never a face/);
  assert.match(r.prompt, /Audio: close, crisp ASMR handling sounds only.*Nobody speaks\. No music, no humming/);
  assert.ok(!/says to the camera|hello there/.test(r.prompt));
  assert.equal(r.shots.length, 6);
  // No accessory is named by code: only the references and the owner's note say what is in the box.
  const parts = r.prompt.split('\n\n');
  const fixed = parts[1] + parts.at(-1); // the ASMR line and the audio line; parts[0] is the owner's video text
  assert.doesNotMatch(fixed, /sticker|washi|card|bookmark|ribbon|emblem|notebook/i);
  assert.match(fixed, /items shown in the reference images and listed in the product note/);
  assert.ok(!/first person/.test(buildClipPrompt(brief, story, ['front'], { ...opts, style: undefined }).prompt));
});

test('franchise names are refused in captions, scene text and post copy, for every style', () => {
  for (const style of ['story', 'asmr'] as const) {
    const c = style === 'asmr' ? asmr : story;
    assert.ok(conceptProblems(brief, { ...c, caption: 'my hogwarts era journal' }, 15, [], [], style).some((x) => /caption: franchise name/.test(x)), style);
    assert.ok(conceptProblems(brief, { ...c, setting: 'A Gryffindor common room by the fire.' }, 15, [], [], style).some((x) => /setting: franchise name/.test(x)), style);
  }
  for (const t of ['Harry Potter vibes', 'harrypotter', 'SLYTHERIN', 'ravenclaw', 'hufflepuff', 'quidditch', 'not a muggle']) assert.equal(languageProblems(brief, t, 'x').length, 1, t);
  assert.deepEqual(languageProblems(brief, 'a magic world journal', 'x'), []);
  for (const t of ['a smuggler cove', 'muggleton road', 'hogwartsy']) assert.deepEqual(languageProblems(brief, t, 'x'), [], t);
  const copy = fallbackCopy(brief, aboutConcept(asmr));
  copy.tiktok = { ...copy.tiktok, title: 'Slytherin study night' };
  assert.ok(copyProblems(brief, copy).some((x) => /^tiktok: franchise name/.test(x)));
});

test('vision prompt has the hand and face rules and the product-lettering kind', () => {
  const v = fileText('vision');
  assert.match(v, /`handFault`: true when any frame clearly shows a malformed hand: an extra, missing or fused finger/);
  assert.match(v, /melts/);
  assert.match(v, /`faceVisible`/);
  assert.match(v, /- `product`: lettering or a printed design on the product itself/);
});

test('checkClip: a malformed hand fails any clip; a face fails only an asmr clip; product lettering passes', async () => {
  const ref = join(mkdtempSync(join(tmpdir(), 'vis-')), 'ref.jpg');
  writeFileSync(ref, Buffer.from('ref'));
  const ok = JSON.parse(readFileSync(new URL('./fixtures/llm/vision.json', import.meta.url), 'utf8'));
  const run = (v: unknown, style: 'story' | 'asmr') => {
    setLlmClient({ create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(v) }], usage: { input_tokens: 1, output_tokens: 1 } }) });
    return checkClip(fresh(), config, { clipFile: 'x.mp4', refImages: [ref], brief, concept: asmr, style }, NOW, 's1', { frames: async () => [Buffer.from('a'), Buffer.from('b')] });
  };
  const hand = await run({ ...ok, handFault: true }, 'story');
  assert.equal(hand.pass, false);
  assert.match(hand.problems.join(), /malformed hand/);
  assert.equal((await run({ ...ok, faceVisible: true }, 'story')).pass, true);
  const face = await run({ ...ok, faceVisible: true }, 'asmr');
  assert.equal(face.pass, false);
  assert.match(face.problems.join(), /face is visible/);
  assert.equal((await run({ ...ok, writing: [{ text: 'Magic World', kind: 'product' }] }, 'asmr')).pass, true);
  // Product lettering still gets the claim checks.
  for (const text of ['50% OFF', 'Slytherin', 'only $9', 'No. 1']) {
    const r = await run({ ...ok, writing: [{ text, kind: 'product' }] }, 'story');
    assert.equal(r.pass, false, text);
    assert.match(r.problems.join(), /product writing/, text);
  }
});

test('loudness stop line: -0.75 dBTP for the default target, 1 dB above the lower ASMR target', async () => {
  const { ASMR_TRUE_PEAK_DB, loudnessLanded } = await import('../src/render/render.ts');
  assert.equal(ASMR_TRUE_PEAK_DB, -2);
  assert.equal(loudnessLanded(-14.3, -0.8), true);
  assert.equal(loudnessLanded(-14.3, -0.7), false);
  assert.equal(loudnessLanded(-15.2, -2), false);
  assert.equal(loudnessLanded(-14.9, -1.53, ASMR_TRUE_PEAK_DB), true);
  assert.equal(loudnessLanded(-14.3, -0.9, ASMR_TRUE_PEAK_DB), false);
});
