import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Brief, UgcConcept } from '../src/contracts.ts';
import { setLlmClient } from '../src/llm/client.ts';
import { buildClipPrompt, conceptProblems, ConceptRejectedError, productLook, writeConcept } from '../src/creative/ugc.ts';
import { config, fresh } from './helpers.ts';

const brief = Brief.parse(JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8')).brief);
const good = UgcConcept.parse(JSON.parse(readFileSync(new URL('./fixtures/llm/ugc.json', import.meta.url), 'utf8')));
const NOW = new Date('2026-11-12T17:00:00Z');
const S = 15;
const cfg = { ...config, tiers: { ...config.tiers, clipSeconds: S } };
const with_ = (o: Partial<UgcConcept>): UgcConcept => ({ ...good, ...o });
const shot0 = (action: string): UgcConcept => with_({ shots: [{ ...good.shots[0], action }, ...good.shots.slice(1)] });
const has = (c: UgcConcept, re: RegExp, recent: string[] = []) => assert.ok(conceptProblems(brief, c, S, recent).some((p) => re.test(p)), re.source);

afterEach(() => {
  delete process.env.LLM_STUB;
  setLlmClient(null);
});

test('fixture passes', () => assert.deepEqual(conceptProblems(brief, good, S, []), []));

test('each caption rule fails', () => {
  has(with_({ caption: 'a'.repeat(61) }), /characters/);
  has(with_({ caption: 'one two three four five six seven eight nine ten eleven twelve thirteen' }), /words/);
  has(with_({ caption: 'so cosy 😭🥶🎄🎁' }), /emoji/);
  has(with_({ caption: 'so cosy #gift' }), /hashtag/);
  has(with_({ caption: 'so cosy @giftwell' }), /@name/);
  has(with_({ caption: 'so cosy for $ 25' }), /states a price/);
  has(with_({ line: 'only $25 today' }), /states a price/);
  has(with_({ caption: 'so cosy for £25' }), /states a price/);
  has(with_({ caption: 'so cosy for CAD 34.50' }), /states a price/);
  has(with_({ line: 'only 34.50 cad today' }), /states a price/);
  has(with_({ caption: 'so cosy see shopgiftwell.com' }), /link/);
  has(with_({ caption: '50% off today' }), /caption.*discount/);
  has(with_({ caption: 'warms to 60 degrees' }), /number/);
  has(good, /repeats/, ['pov: YOUR office is freezing and you found the fix!! 😭😭']);
});

test('each line, shot, colour, person rule fails', () => {
  has(with_({ line: 'one two three four five six seven eight nine ten' }), /line is/);
  has(with_({ line: 'half price today' }), /line.*discount/);
  has(with_({ shots: good.shots.map((s, i) => (i ? s : { ...s, seconds: 4 })) }), /add up/);
  has(shot0('She says "hello" to us.'), /quotation/);
  has(shot0('She films it on her phone.'), /equipment/);
  has(shot0('x'.repeat(301)), /300/);
  has(with_({ color: 'Purple' }), /color/);
  assert.deepEqual(conceptProblems(brief, with_({ color: 'beige' }), S, []), []);
  has(with_({ person: 'A man in a grey polo.' }), /woman/);
});

test('setting and person get the language and price checks; speech is rejected in an action, the setting and the person', () => {
  has(with_({ setting: 'A shop with a 50% off sign.' }), /setting.*discount/);
  has(with_({ person: 'A woman in a navy cardigan, rated five stars.' }), /person.*review/);
  has(with_({ setting: 'An office, the price tag reads $12.' }), /setting.*price/);
  has(shot0('She tells her coworker it is cold.'), /shot 1.*speech/);
  has(shot0('Her coworker shouting from across the room.'), /shot 1.*speech/);
  has(with_({ setting: 'An office where the radio announces the weather.' }), /setting.*speech/);
  has(with_({ person: 'A woman in a cardigan who whispers to her friend.' }), /person.*speech/);
  assert.deepEqual(conceptProblems(brief, with_({ setting: 'A quiet office, a radio on a shelf.' }), S, []), []);
});

test('owner example captions: year in the first is rejected by number rule', () => {
  assert.deepEqual(conceptProblems(brief, with_({ caption: 'Best Business expense ive made all year 😭🥶' }), S, []), []);
  assert.ok(conceptProblems(brief, with_({ caption: 'POV: you find the coziest gift of 2026... 🎄🎄🎄' }), S, []).some((p) => /number 2026/.test(p)));
});

test('buildClipPrompt', () => {
  const opts = { look: 'A waffle-knit shawl.', brand: 'Giftwell', logo: true };
  const r = buildClipPrompt(brief, good, ['front view', 'worn'], opts);
  assert.match(r.prompt, /first 2 reference images/);
  assert.match(r.prompt, /Shot 1 \(0-3s\): .*She says to the camera: "It's freezing in here\."/);
  assert.match(r.prompt, /Shot 2 \(3-7s\)/);
  assert.match(r.prompt, /Shot 4 \(11-15s\)/);
  assert.equal(r.prompt.split('She says to the camera').length, 2);
  assert.match(r.prompt, /logo\. It appears only printed on the lid.*"Giftwell"/);
  assert.match(r.prompt, /only spoken words/);
  assert.match(r.prompt, /no music\. Nothing is written anywhere in the scene: no signs, posters, papers with writing, labels, stickers, or screens showing text or logos\./);
  assert.deepEqual(r.shots.map((s) => s.seconds), [3, 4, 4, 4]);
  assert.ok(!/gift box/.test(buildClipPrompt(brief, good, ['a'], { ...opts, logo: false }).prompt.split('Shot 1')[0]));
  const quiet = buildClipPrompt(brief, with_({ line: '' }), ['a'], opts);
  assert.match(quiet.prompt, /Nobody speaks\./);
  assert.ok(!/says to the camera/.test(quiet.prompt));
});

test('productLook', () => {
  assert.match(productLook('snugwrap-heated-shawl-wrap')!, /waffle-knit/);
  assert.equal(productLook('nope'), null);
});

function fake(answers: unknown[], users: string[] = [], systems: string[] = []) {
  let i = 0;
  setLlmClient({
    create: async (p) => {
      systems.push(JSON.stringify(p.system));
      const content = (p.messages as { content: string }[])[0].content;
      users.push(content);
      const purpose = /Judge these/.test(content) ? 'claims' : 'ugc';
      const body = purpose === 'claims' ? { verdicts: [1, 2].map((chunk) => ({ chunk, supported: true, factId: null, reason: 'ok' })) } : answers[Math.min(i++, answers.length - 1)];
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }], usage: { input_tokens: 10, output_tokens: 10 } };
    },
  });
}

test('writeConcept returns a clean concept; system text ignores recent', async () => {
  const users: string[] = [];
  const systems: string[] = [];
  fake([good], users, systems);
  const db = fresh();
  assert.deepEqual(await writeConcept(db, cfg, brief, [], NOW, 's1'), good);
  await writeConcept(db, cfg, brief, [{ caption: 'old one', setting: 'a kitchen' }], NOW, 's1');
  assert.match(users[0], /Month: November/);
  assert.match(users[0], /Video length: 15 seconds/);
  assert.match(users.find((u) => /a kitchen/.test(u))!, /old one/);
  assert.equal(new Set(systems).size, 2); // ugc system and claims system, each constant
});

test('writeConcept retries once with the problems, then throws', async () => {
  const users: string[] = [];
  fake([with_({ person: 'A man.' })], users);
  const db = fresh();
  await assert.rejects(writeConcept(db, cfg, brief, [], NOW, 's1'), (e) => e instanceof ConceptRejectedError && e.problems.some((p) => /woman/.test(p)));
  assert.equal(users.length, 2);
  assert.match(users[1], /previous attempt had these problems[\s\S]*woman/);
});

test('the owner\'s example captions pass, and a count in a shot action is not treated as a claim', async () => {
  const { conceptProblems } = await import('../src/creative/ugc.ts');
  const { readFileSync } = await import('node:fs');
  const c = JSON.parse(readFileSync(new URL('./fixtures/llm/ugc.json', import.meta.url), 'utf8'));
  const brief = JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8')).brief;
  const ok = (over: object, years: number[] = []) => conceptProblems(brief, { ...c, ...over }, 15, [], years);
  assert.deepEqual(ok({ caption: 'Best Business expense ive made all year 😭🥶' }), []);
  assert.deepEqual(ok({ caption: 'POV: you find the coziest gift of 2026... 🎄🎄🎄' }, [2026]), []);
  assert.match(ok({ caption: 'POV: you find the coziest gift of 2026... 🎄🎄🎄' }).join(), /number 2026/);
  assert.match(ok({ caption: 'warms up in 30 seconds' }, [2026]).join(), /number 30/);
  const shots = c.shots.map((s: { seconds: number; action: string }, i: number) => (i === 1 ? { ...s, action: 'Two coworkers at the next desk look over while she lifts the lid.' } : s));
  assert.deepEqual(ok({ shots }), []);
});
