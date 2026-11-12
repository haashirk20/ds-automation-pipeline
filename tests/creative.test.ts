import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Brief, Script } from '../src/contracts.ts';
import { setLlmClient } from '../src/llm/client.ts';
import { checkHook, checkScript } from '../src/creative/claims.ts';
import { hookFloor, pickHook, refillHooks } from '../src/creative/hooks.ts';
import { writeScript, ScriptRejectedError } from '../src/creative/script.ts';
import { writeCopy, CopyRejectedError } from '../src/creative/copy.ts';
import { config, fresh } from './helpers.ts';

const samples = JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8'));
const brief = Brief.parse(samples.brief);
const sample = (i: number): Script => Script.parse(samples.samples[i].script);
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/llm/${n}.json`, import.meta.url), 'utf8'));
const NOW = new Date('2026-11-12T17:00:00Z'); // 2026-11-12 in Toronto

afterEach(() => {
  delete process.env.LLM_STUB;
  setLlmClient(null);
});

function mutated(f: (s: Script) => void): string[] {
  const s = structuredClone(sample(0));
  f(s);
  return checkScript(brief, s);
}
const has = (ps: string[], re: RegExp) => assert.ok(ps.some((p) => re.test(p)), `${re} in ${JSON.stringify(ps)}`);

test('checkScript passes the three sample scripts', () => {
  for (let i = 0; i < 3; i++) assert.deepEqual(checkScript(brief, sample(i)), [], `sample ${i}`);
});

test('checkScript catches bad scripts', () => {
  has(mutated((s) => (s.beats[2].chunks[1].show = '$44.99')), /price "\$44.99"/);
  has(mutated((s) => (s.beats[2].chunks[1].show = '$49.99 sale')), /discount/);
  has(mutated((s) => (s.beats[1].factIds.push('f-nope'))), /unknown fact/);
  has(mutated((s) => (s.beats[1].shotIds.push('nope'))), /unknown shot/);
  has(mutated((s) => (s.beats[1].chunks[0].show = 'The best seller')), /banned/);
  has(mutated((s) => (s.beats[1].chunks[0].show = 'Rated five stars')), /review/);
  has(mutated((s) => (s.beats[1].chunks[0].show = '12 heat levels')), /number 12/);
  has(mutated((s) => (s.beats[3].chunks[0].show = 'Visit evil.com')), /foreign URL/);
  has(mutated((s) => (s.beats[1].shotIds = ['loose-throw'])), /not our product/);
  has(mutated((s) => (s.beats[1].chunks = s.beats[1].chunks.slice(0, 1))), /benefit beat: 4 spoken words/);
  has(mutated((s) => s.beats.reverse()), /in that order/);
  assert.deepEqual(mutated((s) => (s.beats[3].chunks[0].show = 'Shop at shopgiftwell.myshopify.com')), []);
});

test('review and discount words are allowed when the brief permits them', () => {
  const b = structuredClone(brief);
  b.rules.reviewClaims = true;
  b.rules.discountClaims = true;
  const s = structuredClone(sample(0));
  s.beats[1].chunks[0].show = 'Great sale';
  assert.deepEqual(checkScript(b, s), []);
});

test('fixture hooks all pass checkHook and checkHook rejects bad ones', () => {
  const hooks = fixture('hooks').hooks;
  assert.equal(hooks.length, 24);
  for (const h of hooks) assert.deepEqual(checkHook(brief, h), [], h.headline);
  const h = { framework: 'bold-claim', headline: 'Save big with this one', say: 'Save big', factIds: ['f-x'] };
  assert.ok(checkHook(brief, h).length >= 1);
  assert.ok(checkHook(brief, { ...h, factIds: [], headline: 'one two three four five six seven eight nine' }).some((p) => /over 8 words/.test(p)));
});

test('hookFloor is 42 by default', () => {
  assert.equal(hookFloor(config), 42);
});

test('refillHooks (stub) inserts the fixture hooks once, then adds nothing new', async () => {
  const db = fresh();
  process.env.LLM_STUB = '1';
  assert.equal(await refillHooks(db, config, brief, NOW), 24);
  assert.equal(await refillHooks(db, config, brief, NOW), 0); // all duplicates of existing headlines
  assert.equal((db.prepare('SELECT COUNT(*) n FROM hooks').get() as { n: number }).n, 24);
});

test('pickHook honours the no-repeat window and prefers the least recently used', () => {
  const db = fresh();
  const add = (h: string) => Number(db.prepare("INSERT INTO hooks (product_handle, framework, headline, say, fact_ids_json, created_at) VALUES ('p','pov',?, 's','[]','t')").run(h).lastInsertRowid);
  const [a, b, c] = [add('a'), add('b'), add('c')];
  let idx = 0;
  const use = (hookId: number, date: string) => db.prepare("INSERT INTO slots (id, local_date, idx, created_at, updated_at, product_handle, hook_id) VALUES (?,?,?,'t','t','p',?)").run(`${date}#${idx++}`, date, idx, hookId);
  use(a, '2026-11-10'); // inside the window
  use(b, '2026-10-20'); // outside the 14 days
  assert.equal(pickHook(db, config, 'p', NOW)?.headline, 'c'); // never used goes first
  use(c, '2026-11-12');
  assert.equal(pickHook(db, config, 'p', NOW)?.headline, 'b');
  use(b, '2026-11-11');
  assert.equal(pickHook(db, config, 'p', NOW), null);
  assert.equal(pickHook(db, config, 'other', NOW), null);
});

test('writeScript (stub) returns the fixture script for a matching hook', async () => {
  const db = fresh();
  process.env.LLM_STUB = '1';
  const hook = { id: 1, productHandle: 'p', framework: 'problem-agitate', headline: 'Still cold on the couch?', say: 'Still cold on the couch?', factIds: [] };
  const s = await writeScript(db, config, brief, hook, NOW, 's1');
  assert.deepEqual(s.beats, sample(0).beats);
  // script + claims judge
  assert.equal((db.prepare('SELECT COUNT(*) n FROM llm_calls').get() as { n: number }).n, 2);
});

test('writeScript retries once with the problems, then throws ScriptRejectedError', async () => {
  const db = fresh();
  const bad = structuredClone(sample(0));
  bad.beats[2].chunks[1].show = '$44.99';
  const users: string[] = [];
  setLlmClient({
    create: async (p) => {
      users.push((p.messages as { content: string }[])[0].content);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(bad) }], usage: { input_tokens: 10, output_tokens: 10 } };
    },
  });
  const hook = { id: 1, productHandle: 'p', framework: 'problem-agitate', headline: 'Still cold on the couch?', say: 'Still cold on the couch?', factIds: [] };
  await assert.rejects(writeScript(db, config, brief, hook, NOW, 's1'), (e) => e instanceof ScriptRejectedError && e.problems.some((p) => /price/.test(p)));
  assert.equal(users.length, 2);
  assert.match(users[1], /previous attempt had these problems/);
});

test('writeCopy (stub) builds platform text: link only where clickable, disclosures, hashtags', async () => {
  const db = fresh();
  process.env.LLM_STUB = '1';
  const c = await writeCopy(db, config, brief, sample(0), NOW, 's1');
  for (const p of ['youtube', 'facebook'] as const) assert.ok(c[p].text.includes(brief.product.url), p);
  for (const p of ['instagram', 'tiktok'] as const) assert.ok(!c[p].text.includes('http'), p);
  for (const p of Object.keys(c) as (keyof typeof c)[]) {
    assert.ok(c[p].text.includes('Power bank not included.'));
    assert.ok(c[p].text.endsWith(c[p].hashtags.join(' ')));
  }
});

test('writeCopy fails loudly on bad copy', async () => {
  const good = fixture('copy');
  async function run(edit: (c: any) => void) {
    const c = structuredClone(good);
    edit(c);
    setLlmClient({ create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(c) }], usage: { input_tokens: 1, output_tokens: 1 } }) });
    return writeCopy(fresh(), config, brief, sample(0), NOW, 's1');
  }
  const rejects = (edit: (c: any) => void, re: RegExp) => assert.rejects(run(edit), (e) => e instanceof CopyRejectedError && e.problems.some((p) => re.test(p)));
  await rejects((c) => (c.youtube.title = 'x'.repeat(91)), /title is 91/);
  await rejects((c) => (c.tiktok.hashtags = ['#a', '#b']), /hashtags, want 3 to 6/);
  await rejects((c) => (c.tiktok.hashtags = ['#a', '#b', '#c d']), /bad hashtag/);
  await rejects((c) => (c.facebook.caption = 'Big discount today'), /discount/);
  await rejects((c) => (c.instagram.caption = 'Visit evil.com now'), /URL/);
  await rejects((c) => (c.youtube.caption = 'x'.repeat(2300)), /max 2200/);
  await rejects((c) => (c.youtube.caption = 'Only $19.99 today'), /price/);
});
