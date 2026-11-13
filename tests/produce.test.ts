import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLlmClient } from '../src/llm/client.ts';
import { Brief, Script, TEMPLATES } from '../src/contracts.ts';
import { ttsLines } from '../src/creative/assemble.ts';
import { PALETTES, chooseVariant, produceSlot, type ProduceDeps } from '../src/render/produce.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { childSpawn, makeProducer, tick } from '../src/scheduler/loop.ts';
import { checkScript, judgeClaims } from '../src/creative/claims.ts';
import { copyProblems, fallbackCopy } from '../src/creative/copy.ts';
import { publishDue } from '../src/publish/index.ts';
import { AT_SLOT1, config, fakePublishers, fresh, readyDb, stubProducer } from './helpers.ts';
import { publishers } from '../src/publish/registry.ts';

const samples = JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8'));
const brief = Brief.parse(samples.brief);
const script = Script.parse(samples.samples[0].script);
const NOW = new Date('2026-11-12T02:30:00Z'); // 21:30 Toronto on 2026-11-11

const fakeDeps = (over: Partial<ProduceDeps> = {}): Partial<ProduceDeps> => ({
  ingest: async () => {},
  makeBed: async () => {},
  synthesize: async (job) => {
    const lines = job.lines.map((l, i) => {
      const w = l.text.split(/\s+/);
      return { id: l.id, startMs: i * 3000, endMs: i * 3000 + 2500, words: w.map((text, k) => ({ text, startMs: i * 3000 + k * 100, endMs: i * 3000 + k * 100 + 90 })) };
    });
    return { durationMs: 12000, lines };
  },
  render: async (o) => writeFileSync(o.outFile, 'x'),
  qa: async () => ({ pass: true, checks: [] }),
  ...over,
});

function seedBrief(db: ReturnType<typeof fresh>, b: Brief = brief) {
  db.prepare("INSERT INTO products (handle, title, raw_json, fetched_at) VALUES (?,?,'{}','t')").run(b.product.handle, b.product.title);
  db.prepare('INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?,?,?,?)').run(b.product.handle, b.sourceHash, JSON.stringify(b), NOW.toISOString());
  db.prepare("INSERT INTO kv (key, value) VALUES ('ingest_at', ?)").run(NOW.toISOString()); // ingest is not due
}
const slot = (db: ReturnType<typeof fresh>, id = '2026-11-12#1') => db.prepare('SELECT * FROM slots WHERE id = ?').get(id) as any;
const stubOn = () => { process.env.LLM_STUB = '1'; };
afterEach(() => { delete process.env.LLM_STUB; setLlmClient(null); });

test('produceSlot with the stub model: planned, producing, ready; files in place, copy stored', async () => {
  stubOn();
  const db = fresh();
  seedBrief(db);
  planDay(db, config, '2026-11-12', NOW);
  const seen: string[] = [];
  const T = new Date('2026-11-12T02:31:00Z');
  await produceSlot(db, config, '2026-11-12#1', T, fakeDeps({ render: async (o) => { seen.push(slot(db).status); writeFileSync(o.outFile, 'x'); } }));
  assert.deepEqual([...new Set(seen)], ['producing']);
  const s = slot(db);
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.claimed_at, T.toISOString());
  assert.equal(JSON.parse(s.master_json).variant.template in { 'kinetic-bold': 1, 'cozy-soft': 1, 'gift-guide': 1 }, true);
  const rows = db.prepare("SELECT * FROM renders WHERE slot_id = '2026-11-12#1'").all() as any[];
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.qa_pass, 1);
    assert.ok(r.title && r.caption.includes(brief.disclosures[0]));
    assert.equal(readFileSync(r.file_path, 'utf8'), 'x');
    assert.ok(!r.file_path.includes('attempt-'));
  }
});

test('a second claimant fences the first producer out', async () => {
  stubOn();
  const db = fresh();
  seedBrief(db);
  planDay(db, config, '2026-11-12', NOW);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inRender!: () => void;
  const started = new Promise<void>((r) => (inRender = r));
  const first = produceSlot(db, config, '2026-11-12#1', new Date('2026-11-12T02:31:00Z'), fakeDeps({ render: async (o) => { inRender(); await gate; writeFileSync(o.outFile, 'first'); } }));
  await started;
  db.prepare("UPDATE slots SET status = 'planned' WHERE id = '2026-11-12#1'").run(); // stale recovery
  await produceSlot(db, config, '2026-11-12#1', new Date('2026-11-12T03:10:00Z'), fakeDeps({ render: async (o) => writeFileSync(o.outFile, 'second') }));
  assert.equal(slot(db).status, 'ready');
  release();
  await first; // stops without writing
  const s = slot(db);
  assert.deepEqual([s.status, s.claimed_at, s.attempt], ['ready', '2026-11-12T03:10:00.000Z', 2]);
  const rows = db.prepare("SELECT file_path FROM renders WHERE slot_id = '2026-11-12#1'").all() as any[];
  assert.equal(rows.length, 4);
  for (const r of rows) assert.equal(readFileSync(r.file_path, 'utf8'), 'second');
});

test('cancel: the slot stays producing for stale recovery', async () => {
  stubOn();
  const db = fresh();
  seedBrief(db);
  planDay(db, config, '2026-11-12', NOW);
  const stop = new AbortController();
  await assert.rejects(produceSlot(db, config, '2026-11-12#1', NOW, fakeDeps({ signal: stop.signal, render: async () => { stop.abort(); throw new Error('render cancelled'); } })));
  assert.equal(slot(db).status, 'producing');
});

test('no brief and an unreachable store: the slot is released to planned, attempts not burned', async () => {
  const db = fresh();
  planDay(db, config, '2026-11-12', NOW);
  await produceSlot(db, config, '2026-11-12#1', NOW, fakeDeps({ ingest: async () => { throw new Error('store down'); } }));
  const s = slot(db);
  assert.deepEqual([s.status, s.attempt], ['planned', 0]);
  assert.equal((db.prepare("SELECT count(*) c FROM events WHERE kind = 'ingest_failed'").get() as any).c, 2); // ingest failed, slot waits
});

const oldSlot = (db: ReturnType<typeof fresh>, id: string, date: string, sc: Script) =>
  db.prepare("INSERT INTO slots (id, local_date, idx, status, product_handle, master_json, created_at, updated_at) VALUES (?,?,1,'done',?,?,'t','t')").run(id, date, brief.product.handle, JSON.stringify({ script: sc, edl: {}, variant: { template: 'cozy-soft' } }));
const capReached = (db: ReturnType<typeof fresh>) => db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd) VALUES ('2026-11-12T00:00:00.000Z','x','m',0,0,0,0,?)").run(config.llm.monthlyCapUsd);

test('degraded: no model, reuses the oldest valid old script, fallback copy from the current brief, alerts once', async () => {
  const db = fresh();
  seedBrief(db);
  oldSlot(db, '2026-09-01#1', '2026-09-01', script);
  oldSlot(db, '2026-10-01#1', '2026-10-01', script);
  oldSlot(db, '2026-11-05#1', '2026-11-05', script); // inside noRepeatDays: not eligible
  db.prepare("UPDATE slots SET master_json = ? WHERE id = '2026-11-05#1'").run(JSON.stringify({ script: { nonsense: true }, variant: { template: 'gift-guide' } }));
  capReached(db);
  planDay(db, config, '2026-11-12', NOW);
  await produceSlot(db, config, '2026-11-12#1', new Date('2026-11-12T02:31:00Z'), fakeDeps());
  const s = slot(db);
  assert.equal(s.status, 'ready', s.error);
  const m = JSON.parse(s.master_json);
  assert.deepEqual(m.script, script);
  assert.notEqual(m.variant.template, 'gift-guide');
  const r = db.prepare("SELECT title, caption, qa_pass, ai_json FROM renders WHERE slot_id = '2026-11-12#1' AND platform = 'tiktok'").get() as any;
  assert.equal(r.title, script.hook.headline);
  assert.ok(r.caption.includes(brief.product.priceText) && r.caption.includes(brief.shop.name) && r.caption.includes(brief.disclosures[0]));
  assert.deepEqual(JSON.parse(r.ai_json), { visuals: false, voice: true, music: false });
  assert.equal((db.prepare("SELECT count(*) c FROM events WHERE kind = 'degraded'").get() as any).c, 1);
});

test('degraded: a stored script with a stale price is rejected', async () => {
  const db = fresh();
  seedBrief(db, { ...brief, product: { ...brief.product, priceText: '$54.99' } });
  oldSlot(db, '2026-09-01#1', '2026-09-01', script); // says and shows $49.99
  capReached(db);
  planDay(db, config, '2026-11-12', NOW);
  await produceSlot(db, config, '2026-11-12#1', NOW, fakeDeps());
  assert.equal(slot(db).status, 'failed');
  assert.match(slot(db).error, /no usable old slot/);
});

test('no hook, no old slot: the slot fails with an alert', async () => {
  const db = fresh();
  seedBrief(db);
  capReached(db);
  planDay(db, config, '2026-11-12', NOW);
  await produceSlot(db, config, '2026-11-12#1', NOW, fakeDeps());
  assert.equal(slot(db).status, 'failed');
  assert.equal((db.prepare("SELECT count(*) c FROM events WHERE kind = 'produce_failed'").get() as any).c, 1);
});

test('chooseVariant: deterministic, never repeats the previous template, voices rotate, retry changes template', () => {
  const voices = ['a', 'b', 'c'];
  for (let i = 1; i <= 60; i++) {
    const id = `2026-11-${String(1 + (i % 28)).padStart(2, '0')}#${i}`;
    for (const prev of [null, ...TEMPLATES]) {
      const v = chooseVariant(id, i, prev, voices);
      assert.deepEqual(v, chooseVariant(id, i, prev, voices));
      assert.notEqual(v.template, prev);
      assert.ok(PALETTES[v.template].includes(v.palette));
      assert.equal(v.voice, voices[i % 3]);
      const r = chooseVariant(id, i, prev, voices, 1);
      assert.notEqual(r.template, v.template);
      assert.notEqual(r.template, prev);
    }
  }
});

test('title, caption and ai flags reach the publisher', async () => {
  const db = await readyDb();
  const { publishers: fake, calls } = fakePublishers();
  await publishDue(db, config, fake, AT_SLOT1);
  const yt = calls.find((c: any) => c.idempotencyKey === '2026-11-12#1:youtube') as any;
  assert.deepEqual([yt.title, yt.caption], ['title youtube', 'caption youtube']);
});

for (const [ai, tier0, expected] of [
  [{ visuals: false, voice: true, music: false }, true, true],
  [{ visuals: false, voice: true, music: false }, false, false],
  [{ visuals: false, voice: false, music: true }, false, true],
  [{ visuals: true, voice: false, music: false }, false, true],
  [null, false, false], // no record: tier t0 with tier0 off
] as const) {
  test(`aiDisclosure from ai_json ${JSON.stringify(ai)} tier0=${tier0}`, async () => {
    const db = await readyDb();
    db.prepare('UPDATE renders SET ai_json = ?').run(ai ? JSON.stringify(ai) : null);
    const { publishers: fake, calls } = fakePublishers();
    await publishDue(db, { ...config, disclosure: { tier0 } }, fake, AT_SLOT1);
    assert.equal((calls[0] as any).aiDisclosure, expected);
  });
}

test('loop does not wait for a slow producer, and runs one producer at a time', async () => {
  const db = fresh();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const producer = makeProducer(async (id) => { started.push(id); await gate; });
  const deps = { db, config, publishers, producer };
  await tick(deps, NOW); // plans two slots, starts the first producer, returns at once
  assert.deepEqual(started, ['2026-11-12#1']);
  await tick(deps, new Date(NOW.getTime() + 60000));
  assert.equal(started.length, 1); // still busy
  assert.ok(producer.busy());
  release();
  await gate;
  await new Promise((r) => setImmediate(r));
  assert.ok(!producer.busy());
  await tick(deps, new Date(NOW.getTime() + 120000));
  assert.equal(started.length, 2);
});

test('loop marks a planned slot with nothing left to publish in time as failed: too late', async () => {
  const db = fresh();
  planDay(db, config, '2026-11-12', NOW);
  const started: string[] = [];
  const producer = makeProducer(async (id) => void started.push(id));
  await tick({ db, config, publishers, producer, wait: true }, new Date('2026-11-13T00:00:00Z')); // slot 1 was due 12:15 local, 6 h limit passed
  assert.deepEqual([slot(db, '2026-11-12#1').status, slot(db, '2026-11-12#1').error], ['failed', 'too late']);
  assert.deepEqual(started, ['2026-11-12#2']);
});

test('a producer child that ignores SIGTERM is killed after the grace period', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-'));
  const pidFile = join(dir, 'pid');
  const code = `require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const spawnChild = childSpawn(config, { timeoutMs: 300, graceMs: 400, argv: () => ['-e', code, pidFile] });
  const t0 = Date.now();
  await spawnChild('2026-11-12#1', NOW);
  const took = Date.now() - t0;
  assert.ok(took >= 650 && took < 5000, `took ${took} ms`); // SIGTERM ignored for the whole grace period, then SIGKILL
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

// Claim checks that must not be bypassed.
const checks = (edit: (s: Script) => void) => {
  const sc = structuredClone(script);
  edit(sc);
  return checkScript(brief, sc);
};
const has = (ps: string[], re: RegExp) => assert.ok(ps.some((p) => re.test(p)), `${re} in ${JSON.stringify(ps)}`);

test('claim bypasses: zero-width characters, fullwidth digits, spoken price, invented counts', () => {
  has(checks((s) => (s.beats[1].chunks[0].show = 'The best​seller')), /banned/);
  has(checks((s) => (s.beats[2].chunks[1].show = '$４４.９９')), /price/);
  has(checks((s) => (s.beats[2].chunks[1].say = 'Thirty-nine ninety-nine.')), /spoken numbers/);
  has(checks((s) => (s.beats[2].chunks[1].say = 'Fifty dollars.')), /spoken numbers/);
  has(checks((s) => (s.beats[1].chunks[0].say = 'Three heat levels')), /number 3/);
  has(checks((s) => (s.beats[1].chunks[0].show = 'Rated ٣ stars')), /non-ASCII|review/);
  has(checks((s) => (s.beats[1].chunks[0].show = 'Half off today only')), /discount or urgency/);
  has(checks((s) => (s.beats[1].chunks[0].show = 'Free shipping')), /free shipping/);
  has(checks((s) => (s.beats[1].chunks[0].show = '€40 wrap')), /currency/);
  assert.deepEqual(checks(() => {}), []);
});

test('claim bypasses: copy with an invented count and claim hashtags', () => {
  const base = fallbackCopy(brief, script);
  assert.deepEqual(copyProblems(brief, base), []);
  const withCaption = (caption: string, hashtags = base.youtube.hashtags) => ({ ...base, youtube: { ...base.youtube, caption, hashtags, text: `${caption}\n\n${brief.product.url}\n\n${brief.disclosures.join('\n')}\n\n${hashtags.join(' ')}` } });
  has(copyProblems(brief, withCaption('Over 10,000 sold')), /number 10000/);
  has(copyProblems(brief, withCaption('Warm.', ['#Cozy', '#50OFF', '#Gift'])), /discount/);
  has(copyProblems(brief, withCaption('Warm.', ['#Cozy', '#BlackFridaySale', '#Gift'])), /discount/);
  has(copyProblems(brief, withCaption('Warm.', ['#Cozy', '#FiveStar', '#Gift'])), /review/);
});

test('judgeClaims: one verdict per chunk, supporting fact needed for benefit and offer', async () => {
  const db = fresh();
  const n = script.beats.reduce((a, b) => a + b.chunks.length, 0);
  const verdicts = [{ chunk: 1, supported: true, factId: null, reason: 'r' }, { chunk: 1, supported: true, factId: 'f-title', reason: 'r' }, ...Array.from({ length: n - 3 }, (_, i) => ({ chunk: i + 3, supported: true, factId: null, reason: 'r' }))];
  setLlmClient({ create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ verdicts }) }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  const problems = await judgeClaims(db, config, brief, script, NOW);
  has(problems, /more than one verdict/);
  has(problems, /no verdict for chunk 2/);
  has(problems, /no supporting fact/);
});
