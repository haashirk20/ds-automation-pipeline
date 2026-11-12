import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Brief, Script, TEMPLATES } from '../src/contracts.ts';
import { ttsLines } from '../src/creative/assemble.ts';
import { PALETTES, captionStyleOf, chooseVariant, produceSlot, type ProduceDeps } from '../src/render/produce.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { makeProducer, tick } from '../src/scheduler/loop.ts';
import { publishDue } from '../src/publish/index.ts';
import { AT_SLOT1, config, fakePublishers, fresh, readyDb, stubProducer } from './helpers.ts';
import { publishers } from '../src/publish/registry.ts';

const samples = JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8'));
const brief = Brief.parse(samples.brief);
const script = Script.parse(samples.samples[0].script);
const NOW = new Date('2026-11-12T02:30:00Z'); // 21:30 Toronto on 2026-11-11
const PLATFORMS = ['youtube', 'facebook', 'instagram', 'tiktok'];

const fakeDeps = (over: Partial<ProduceDeps> = {}): Partial<ProduceDeps> => ({
  ingest: async () => { throw new Error('ingest must not run'); },
  makeBed: async () => {},
  synthesize: async (job) => {
    const lines = ttsLines(script).map((l, i) => {
      const w = l.text.split(/\s+/);
      return { id: l.id, startMs: i * 3000, endMs: i * 3000 + 2500, words: w.map((text, k) => ({ text, startMs: i * 3000 + k * 100, endMs: i * 3000 + k * 100 + 90 })) };
    });
    return { durationMs: 12000, lines };
  },
  render: async (o) => writeFileSync(o.outFile, 'x'),
  qa: async () => ({ pass: true, checks: [] }),
  ...over,
});

function seedBrief(db: ReturnType<typeof fresh>) {
  db.prepare("INSERT INTO products (handle, title, raw_json, fetched_at) VALUES (?,?,'{}','t')").run(brief.product.handle, brief.product.title);
  db.prepare('INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?,?,?,?)').run(brief.product.handle, brief.sourceHash, JSON.stringify(brief), NOW.toISOString());
}

test('degraded: no model, reuses the oldest old script and copy with a new variant, alerts once', async () => {
  const db = fresh();
  seedBrief(db);
  const h = brief.product.handle;
  const oldSlot = (id: string, date: string, title: string, template: string) => {
    db.prepare("INSERT INTO slots (id, local_date, idx, status, product_handle, master_json, created_at, updated_at) VALUES (?,?,1,'done',?,?,'t','t')").run(id, date, h, JSON.stringify({ script, edl: {}, variant: { template } }));
    for (const p of PLATFORMS) db.prepare("INSERT INTO renders (slot_id, platform, file_path, qa_pass, title, caption, created_at) VALUES (?,?,'f',1,?,?,'t')").run(id, p, `${title} ${p}`, `cap ${title} ${p}`);
  };
  oldSlot('2026-09-01#1', '2026-09-01', 'oldest', 'cozy-soft');
  oldSlot('2026-10-01#1', '2026-10-01', 'newer', 'cozy-soft');
  oldSlot('2026-11-05#1', '2026-11-05', 'recent', 'gift-guide'); // inside noRepeatDays: not eligible
  db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd) VALUES ('2026-11-12T00:00:00.000Z','x','m',0,0,0,0,?)").run(config.llm.monthlyCapUsd);
  planDay(db, config, '2026-11-12', NOW);
  await produceSlot(db, config, '2026-11-12#1', new Date('2026-11-12T02:31:00Z'), fakeDeps());
  const s = db.prepare("SELECT status, error, master_json FROM slots WHERE id = '2026-11-12#1'").get() as any;
  assert.equal(s.status, 'ready', s.error);
  const m = JSON.parse(s.master_json);
  assert.deepEqual(m.script, script);
  assert.notEqual(m.variant.template, 'gift-guide'); // differs from the previous slot (2026-11-05#1)
  const r = db.prepare("SELECT title, caption, qa_pass, ai_json FROM renders WHERE slot_id = '2026-11-12#1' AND platform = 'tiktok'").get() as any;
  assert.deepEqual([r.title, r.caption, r.qa_pass], ['oldest tiktok', 'cap oldest tiktok', 1]);
  assert.deepEqual(JSON.parse(r.ai_json), { visuals: false, voice: true, music: false });
  assert.equal((db.prepare("SELECT count(*) c FROM events WHERE kind = 'degraded'").get() as any).c, 1);
});

test('no hook, no old slot: the slot fails with an alert', async () => {
  const db = fresh();
  seedBrief(db);
  db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd) VALUES ('2026-11-12T00:00:00.000Z','x','m',0,0,0,0,?)").run(config.llm.monthlyCapUsd);
  planDay(db, config, '2026-11-12', NOW);
  await produceSlot(db, config, '2026-11-12#1', NOW, fakeDeps());
  assert.equal((db.prepare("SELECT status FROM slots WHERE id = '2026-11-12#1'").get() as any).status, 'failed');
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

test('captionStyleOf reads the style of every template', () => {
  for (const t of TEMPLATES) assert.ok(captionStyleOf(t).fontPx >= 56);
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

test('tick: ingest at most once per 24 hours; a failure alerts and retries in an hour', async () => {
  const db = fresh();
  let calls = 0;
  let fail = true;
  const ingest = async () => { calls++; if (fail) throw new Error('feed down'); };
  const deps = { db, config, publishers, producer: stubProducer(db), wait: true, ingest };
  await tick(deps, NOW);
  assert.equal(calls, 1);
  assert.equal((db.prepare("SELECT count(*) c FROM events WHERE kind = 'ingest_failed'").get() as any).c, 1);
  await tick(deps, new Date(NOW.getTime() + 30 * 60000));
  assert.equal(calls, 1);
  fail = false;
  await tick(deps, new Date(NOW.getTime() + 61 * 60000));
  assert.equal(calls, 2);
  await tick(deps, new Date(NOW.getTime() + 23 * 3600000));
  assert.equal(calls, 2);
  await tick(deps, new Date(NOW.getTime() + 26 * 3600000));
  assert.equal(calls, 3);
});
