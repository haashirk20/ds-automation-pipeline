import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import raw from '../config/pipeline.config.ts';
import { loadConfig, parseConfig } from '../src/config/index.ts';
import { Brief } from '../src/contracts.ts';
import { setLlmClient } from '../src/llm/client.ts';
import { produceSlot, type ProduceDeps } from '../src/render/produce.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { chooseTier, clipProviders, generateClip, monthSpendUsd, type ClipProvider } from '../src/router/index.ts';
import { config, fresh } from './helpers.ts';

const NOW = new Date('2026-11-12T02:30:00Z');
const cfg = (mix: { t0: number; t1: number; t2: number }, over: Record<string, unknown> = {}) =>
  parseConfig({ ...raw, tiers: { ...raw.tiers, mix, ...over } });
const T1 = cfg({ t0: 0, t1: 1, t2: 0 });

// A provider that records calls; `stall` makes fetch fail once, to simulate a crash after submit.
function mkProvider(opts: { configured?: boolean; failSubmit?: boolean; failFetchOnce?: boolean } = {}) {
  const calls = { submit: 0, fetch: [] as string[] };
  let failFetch = !!opts.failFetchOnce;
  const p: ClipProvider = {
    name: 'fal',
    configured: () => opts.configured ?? true,
    submit: async () => {
      calls.submit++;
      if (opts.failSubmit) throw new Error('boom Bearer abcdef123456');
      return { jobId: 'job-' + calls.submit };
    },
    fetch: async (id, out) => {
      calls.fetch.push(id);
      if (failFetch) { failFetch = false; throw new Error('crash'); }
      writeFileSync(out, 'video');
    },
  };
  return { p, calls, reg: { fal: p } };
}
const job = (db: ReturnType<typeof fresh>, slotId = 's#1') => ({ slotId, tier: 't1' as const, imagePath: '/i.jpg', prompt: 'p', outFile: join(process.env.DATA_DIR!, 'clips', 'c.mp4'), signal: new AbortController().signal });
const rows = (db: ReturnType<typeof fresh>) => db.prepare('SELECT * FROM spend ORDER BY id').all() as any[];

test('chooseTier: stable per slot, follows the mix', async () => {
  const db = fresh();
  const { reg } = mkProvider();
  const c = cfg({ t0: 0.5, t1: 0.5, t2: 0 });
  const n = { t0: 0, t1: 0, t2: 0 };
  for (let i = 0; i < 400; i++) {
    const id = `2026-11-12#${i}`;
    const a = await chooseTier(db, c, reg, id, NOW);
    assert.equal(a, await chooseTier(db, c, reg, id, NOW));
    n[a]++;
  }
  assert.ok(n.t1 > 140 && n.t1 < 260 && n.t2 === 0, JSON.stringify(n));
});

test('chooseTier: missing or unconfigured provider gives t0', async () => {
  const db = fresh();
  assert.equal(await chooseTier(db, T1, {}, 'a#1', NOW), 't0');
  assert.equal(await chooseTier(db, T1, mkProvider({ configured: false }).reg, 'a#1', NOW), 't0');
  assert.equal(await chooseTier(db, T1, mkProvider().reg, 'a#1', NOW), 't1');
  assert.deepEqual(clipProviders(), {}); // 'fake' is not offered without CLIP_STUB_FILE
});

test('cap blocks the tier, alerts once per month, failed jobs count', async () => {
  const db = fresh();
  const { reg } = mkProvider();
  // 15 / 0.17: 88 clips fit, the 89th does not
  const ins = db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES (?, 't1','fal','m',?,?,?,?)");
  for (let i = 0; i < 88; i++) ins.run('x#' + i, i % 2 ? 'failed' : 'rejected', 0.17, NOW.toISOString(), NOW.toISOString());
  ins.run('old#1', 'succeeded', 5, '2026-10-31T23:59:59Z', '2026-10-31T23:59:59Z'); // last month: not counted
  assert.ok(Math.abs(monthSpendUsd(db, 't1', NOW) - 88 * 0.17) < 1e-9);
  assert.equal(await chooseTier(db, T1, reg, 'a#1', NOW), 't0');
  assert.equal(await chooseTier(db, T1, reg, 'a#2', new Date('2026-11-20T00:00:00Z')), 't0');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'budget_cap'").get() as any).n, 1);
});

test('generateClip: submits once, stores the job id before waiting, resumes without a second submit', async () => {
  const db = fresh();
  const { p, calls, reg } = mkProvider({ failFetchOnce: true });
  // Simulate a crash after submit: fetch throws, but first check the row says 'submitted' with its job id.
  const orig = p.fetch;
  p.fetch = async (id, out, s) => {
    const r = rows(db)[0];
    assert.equal(r.state, 'submitted');
    assert.equal(r.job_id, id);
    return orig(id, out, s);
  };
  // Crash: put the row back into 'submitted' by hand after the failed first call, as a killed process would leave it.
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false);
  assert.equal(rows(db)[0].state, 'failed');
  db.prepare("UPDATE spend SET state = 'submitted', error = NULL").run();
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), true);
  assert.equal(calls.submit, 1);
  assert.deepEqual(calls.fetch, ['job-1', 'job-1']);
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].state, 'succeeded');
  assert.equal(readFileSync(job(db).outFile, 'utf8'), 'video');
  // done: reused, no new calls
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), true);
  assert.equal(calls.submit, 1);
  assert.equal(calls.fetch.length, 2);
});

test('generateClip: a reserved row is never re-submitted; maxJobsPerSlot holds', async () => {
  const db = fresh();
  const { calls, reg } = mkProvider({ failSubmit: true });
  db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES ('s#1','t1','fal','m','reserved',0.17,?,?)").run(NOW.toISOString(), NOW.toISOString());
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false);
  assert.equal(calls.submit, 0);
  assert.equal(rows(db)[0].state, 'failed');
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false); // second row (submit fails)
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false); // limit of 2 rows reached
  assert.equal(calls.submit, 1);
  assert.equal(rows(db).length, 2);
});

test('generateClip: provider error marks failed with a scrubbed error', async () => {
  const db = fresh();
  const { reg } = mkProvider({ failSubmit: true });
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false);
  const r = rows(db)[0];
  assert.equal(r.state, 'failed');
  assert.ok(!r.error.includes('abcdef123456'));
  assert.equal(r.quoted_usd, 0.17);
});

test('PIPELINE_CONFIG loads an alternative file and rejects an invalid one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const good = join(dir, 'good.config.ts');
  const bad = join(dir, 'bad.config.ts');
  writeFileSync(good, `export default ${JSON.stringify({ ...raw, tiers: { ...raw.tiers, mix: { t0: 0, t1: 1, t2: 0 } } })};`);
  writeFileSync(bad, `export default ${JSON.stringify({ ...raw, tiers: { ...raw.tiers, mix: { t0: 1, t1: 1, t2: 0 } } })};`);
  try {
    process.env.PIPELINE_CONFIG = good;
    assert.equal((await loadConfig()).tiers.mix.t1, 1);
    process.env.PIPELINE_CONFIG = bad;
    await assert.rejects(loadConfig(), /shares must sum to 1/);
  } finally {
    delete process.env.PIPELINE_CONFIG;
  }
  assert.equal((await loadConfig()).tiers.mix.t0, 1);
});

// produceSlot with a clip
const samples = JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8'));
const brief = Brief.parse(samples.brief);
const deps = (over: Partial<ProduceDeps>): Partial<ProduceDeps> => ({
  ingest: async () => {},
  makeBed: async () => {},
  synthesize: async (j) => ({ durationMs: 12000, lines: j.lines.map((l, i) => ({ id: l.id, startMs: i * 3000, endMs: i * 3000 + 2500, words: l.text.split(/\s+/).map((text, k) => ({ text, startMs: i * 3000 + k * 100, endMs: i * 3000 + k * 100 + 90 })) })) }),
  render: async (o) => writeFileSync(o.outFile, 'x'),
  qa: async () => ({ pass: true, checks: [] }),
  prepareImage: async (_s, _c, out) => writeFileSync(out, 'jpg'),
  probeClip: async () => ({ width: 720, height: 1280, seconds: 4 }),
  ...over,
});
function seed(db: ReturnType<typeof fresh>) {
  db.prepare("INSERT INTO products (handle, title, raw_json, fetched_at) VALUES (?,?,'{}','t')").run(brief.product.handle, brief.product.title);
  db.prepare('INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?,?,?,?)').run(brief.product.handle, brief.sourceHash, JSON.stringify(brief), NOW.toISOString());
  db.prepare("INSERT INTO kv (key, value) VALUES ('ingest_at', ?)").run(NOW.toISOString());
  planDay(db, config, '2026-11-12', NOW);
}
afterEach(() => { delete process.env.LLM_STUB; setLlmClient(null); });

test('produceSlot with a provider: clip shot in the EDL, ai.visuals, tier and cost', async () => {
  process.env.LLM_STUB = '1';
  const db = fresh();
  seed(db);
  const { reg, calls } = mkProvider();
  const T = new Date('2026-11-12T02:31:00Z');
  await produceSlot(db, T1, '2026-11-12#1', T, deps({ providers: reg }));
  const s = db.prepare('SELECT * FROM slots WHERE id = ?').get('2026-11-12#1') as any;
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.tier, 't1');
  const edl = JSON.parse(s.master_json).edl;
  assert.equal(edl.beats[0].shots[0].kind, 'clip');
  assert.equal(edl.beats[0].shots[0].crop, null);
  assert.ok(existsSync(edl.beats[0].shots[0].src));
  assert.equal(edl.ai.visuals, true);
  const spent = rows(db).reduce((a, r) => a + r.quoted_usd, 0);
  assert.equal(spent, 0.17);
  assert.ok(Math.abs(s.cost_usd - (spent + (db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS c FROM llm_calls WHERE slot_id = ?").get(s.id) as any).c)) < 1e-9);
  assert.equal(calls.submit, 1);
});

test('produceSlot falls back to tier 0 when the provider fails or the clip is too small', async () => {
  process.env.LLM_STUB = '1';
  for (const [name, over, state] of [
    ['provider error', { providers: mkProvider({ failSubmit: true }).reg }, 'failed'],
    ['small clip', { providers: mkProvider().reg, probeClip: async () => ({ width: 300, height: 400, seconds: 4 }) }, 'rejected'],
  ] as const) {
    const db = fresh();
    seed(db);
    await produceSlot(db, T1, '2026-11-12#1', new Date('2026-11-12T02:31:00Z'), deps(over as Partial<ProduceDeps>));
    const s = db.prepare('SELECT * FROM slots WHERE id = ?').get('2026-11-12#1') as any;
    assert.equal(s.status, 'ready', name + s.error);
    assert.equal(s.tier, 't0', name);
    assert.equal(JSON.parse(s.master_json).edl.ai.visuals, false);
    assert.equal(rows(db)[0].state, state, name);
    assert.ok(s.cost_usd >= 0.17, 'the failed job is still billed to the slot');
  }
});
