import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import raw from '../config/pipeline.config.ts';
import { loadConfig, parseConfig } from '../src/config/index.ts';
import { Brief } from '../src/contracts.ts';
import { setLlmClient } from '../src/llm/client.ts';
import { produceSlot, type ProduceDeps } from '../src/render/produce.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { chooseTier, clipProviders, generateClip, monthSpendUsd, type ClipProvider } from '../src/router/index.ts';
import { ClipPendingError, JobEndedError } from '../src/router/errors.ts';
import { NeedsSignInError } from '../src/router/higgsfield-auth.ts';
import { config, fresh } from './helpers.ts';

const NOW = new Date('2026-11-12T02:30:00Z');
const cfg = (mix: { t0: number; t1: number; t2: number }, over: Record<string, unknown> = {}) =>
  parseConfig({ ...raw, creative: { ...raw.creative, mode: 'ad' }, tiers: { ...raw.tiers, mix, clipSeconds: 4, ...over } }); // these tests exercise the ad path
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
const job = (db: ReturnType<typeof fresh>, slotId = 's#1') => ({ slotId, tier: 't1' as const, images: ['/i.jpg'], prompt: 'p', shots: [], outFile: join(process.env.DATA_DIR!, 'clips', 'c.mp4'), signal: new AbortController().signal });
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
  assert.deepEqual(Object.keys(clipProviders(db, T1, () => NOW)), ['higgsfield']); // 'fake' is not offered without CLIP_STUB_FILE
  assert.equal(clipProviders(db, T1, () => NOW).higgsfield.configured(), false); // not signed in
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
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), ClipPendingError);
  assert.equal(rows(db)[0].state, 'submitted');
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

test('generateClip: a submit error marks failed with a scrubbed error', async () => {
  const db = fresh();
  const { reg } = mkProvider({ failSubmit: true });
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false);
  const r = rows(db)[0];
  assert.equal(r.state, 'failed');
  assert.ok(!r.error.includes('abcdef123456'));
  assert.equal(r.quoted_usd, 0.17);
});

test('generateClip: a plain fetch error leaves the row submitted and rejects with ClipPendingError; the next call resumes the same job', async () => {
  const db = fresh();
  const { p, calls, reg } = mkProvider();
  const realFetch = p.fetch;
  p.fetch = async (_id, out) => { writeFileSync(out, 'half'); throw new Error('HTTP 503 Bearer abcdef123456'); };
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), (e: Error) => e instanceof ClipPendingError && !e.message.includes('abcdef123456'));
  assert.equal(rows(db)[0].state, 'submitted');
  assert.equal(existsSync(job(db).outFile + '.part'), false);
  p.fetch = realFetch;
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), true);
  assert.equal(calls.submit, 1);
  assert.deepEqual(calls.fetch, ['job-1']);
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].state, 'succeeded');
});

test('generateClip: a job still unfetched more than 2 hours after it was created is marked failed and returns false', async () => {
  const db = fresh();
  const { p, reg } = mkProvider();
  p.fetch = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), ClipPendingError);
  const later = new Date(NOW.getTime() + 2 * 3600_000 + 1000);
  assert.equal(await generateClip(db, T1, reg, job(db), later), false);
  assert.equal(rows(db)[0].state, 'failed');
  assert.match(rows(db)[0].error, /did not finish within 2 hours/);
});

test('generateClip: a NeedsSignInError during fetch alerts once a day and waits', async () => {
  const db = fresh();
  const { p, reg } = mkProvider();
  p.fetch = async () => { throw new NeedsSignInError('refresh refused'); };
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), ClipPendingError);
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), ClipPendingError);
  assert.equal(rows(db)[0].state, 'submitted');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'clip_sign_in'").get() as any).n, 1);
});

test('generateClip: a JobEndedError from fetch marks failed and returns false', async () => {
  const db = fresh();
  const { p, reg } = mkProvider();
  p.fetch = async () => { throw new JobEndedError('job ended as failed'); };
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false);
  assert.equal(rows(db)[0].state, 'failed');
  // the resume path behaves the same
  db.prepare("UPDATE spend SET state = 'submitted'").run();
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false);
  assert.equal(rows(db)[0].state, 'failed');
});

test('generateClip: resuming a submitted job with a signed-out provider rejects with ClipPendingError and alerts once a day', async () => {
  const db = fresh();
  let signedIn = true;
  const { p, calls, reg } = mkProvider();
  p.configured = () => signedIn;
  p.fetch = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), ClipPendingError);
  signedIn = false;
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), ClipPendingError);
  await assert.rejects(generateClip(db, T1, reg, job(db), NOW), ClipPendingError);
  assert.equal(rows(db)[0].state, 'submitted');
  assert.equal(calls.submit, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'clip_sign_in'").get() as any).n, 1);
});

test('generateClip: the stored clip path is relative to DATA_DIR and a second call finds the clip', async () => {
  const db = fresh();
  const { calls, reg } = mkProvider();
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), true);
  const stored = rows(db)[0].file_path;
  assert.equal(stored, join('clips', 'c.mp4'));
  assert.ok(!isAbsolute(stored));
  const other = { ...job(db), outFile: join(process.env.DATA_DIR!, 'clips', 'copy.mp4') };
  assert.equal(await generateClip(db, T1, reg, other, NOW), true);
  assert.equal(readFileSync(other.outFile, 'utf8'), 'video');
  assert.equal(calls.submit, 1);
  assert.equal(calls.fetch.length, 1);
});

test('alerts: a delivery that failed does not hide the alert for the rest of the day', async () => {
  const db = fresh();
  const { p, reg } = mkProvider();
  p.check = async () => { throw new Error('quote too high'); };
  db.prepare("INSERT INTO events (ts, kind, key, message, delivered) VALUES (?, 'clip_refused', '2026-11-12', 'x', 0)").run(NOW.toISOString());
  await generateClip(db, T1, reg, job(db), NOW);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'clip_refused'").get() as any).n, 2);
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
  assert.equal((await loadConfig()).tiers.mix.t2, 1); // the shipped default
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
  const db = fresh();
  process.env.LLM_STUB = '1'; // after fresh(), which clears it
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
  for (const [name, over, state] of [
    ['provider error', { providers: mkProvider({ failSubmit: true }).reg }, 'failed'],
    ['small clip', { providers: mkProvider().reg, probeClip: async () => ({ width: 300, height: 400, seconds: 4 }) }, 'rejected'],
  ] as const) {
    const db = fresh();
    process.env.LLM_STUB = '1';
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

test('generateClip: a failing check writes no ledger row, returns false, alerts once per kind per day', async () => {
  const db = fresh();
  const { p, calls, reg } = mkProvider();
  p.check = async () => { throw new Error('quote 99 is above maxCredits 40'); };
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), false);
  assert.equal(await generateClip(db, T1, reg, job(db, 's#2'), NOW), false);
  assert.equal(rows(db).length, 0);
  assert.equal(calls.submit, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'clip_refused'").get() as any).n, 1);
  p.check = async () => { throw new NeedsSignInError('x'); };
  await generateClip(db, T1, reg, job(db), NOW);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'clip_sign_in'").get() as any).n, 1);
});

test('generateClip: abort during fetch leaves the row submitted; the next call resumes without a new submit', async () => {
  const db = fresh();
  const { p, calls, reg } = mkProvider();
  const ac = new AbortController();
  const realFetch = p.fetch;
  p.fetch = async (id, out, signal) => { ac.abort(); throw new Error('aborted'); };
  await assert.rejects(generateClip(db, T1, reg, { ...job(db), signal: ac.signal }, NOW), /aborted/);
  assert.equal(rows(db)[0].state, 'submitted');
  p.fetch = realFetch;
  assert.equal(await generateClip(db, T1, reg, job(db), NOW), true);
  assert.equal(calls.submit, 1);
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].state, 'succeeded');
});

test('chooseTier: a slot with a paid job keeps its tier at the cap and without a provider; failed or rejected rows do not', async () => {
  const db = fresh();
  const ins = db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES (?, 't1','fal','m',?,?,?,?)");
  ins.run('fill#1', 'failed', 15, NOW.toISOString(), NOW.toISOString()); // the month is at the cap
  ins.run('sub#1', 'submitted', 0, NOW.toISOString(), NOW.toISOString());
  ins.run('ok#1', 'succeeded', 0, NOW.toISOString(), NOW.toISOString());
  ins.run('bad#1', 'failed', 0, NOW.toISOString(), NOW.toISOString());
  ins.run('bad#2', 'rejected', 0, NOW.toISOString(), NOW.toISOString());
  const { reg } = mkProvider();
  assert.equal(await chooseTier(db, T1, reg, 'sub#1', NOW), 't1');
  assert.equal(await chooseTier(db, T1, mkProvider({ configured: false }).reg, 'ok#1', NOW), 't1');
  assert.equal(await chooseTier(db, T1, reg, 'bad#1', NOW), 't0');
  assert.equal(await chooseTier(db, T1, reg, 'bad#2', NOW), 't0');
  const c0 = cfg({ t0: 1, t1: 0, t2: 0 }); // the mix changed since the job was made
  assert.equal(await chooseTier(db, c0, reg, 'sub#1', NOW), 't1');
});
