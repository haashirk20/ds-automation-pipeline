import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Brief, Script, UgcConcept } from '../src/contracts.ts';
import { RetryableLlmError, setLlmClient } from '../src/llm/client.ts';
import { aboutConcept, aboutScript, copyProblems, fallbackCopy, writeCopy } from '../src/creative/copy.ts';
import { produceSlot, type ProduceDeps } from '../src/render/produce.ts';
import { pickStoredClip } from '../src/render/produce-ugc.ts';
import { planDay } from '../src/scheduler/planner.ts';
import type { ClipProvider } from '../src/router/index.ts';
import { config, fresh } from './helpers.ts';

const samples = JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8'));
const brief = Brief.parse(samples.brief);
const script = Script.parse(samples.samples[0].script);
const good = UgcConcept.parse(JSON.parse(readFileSync(new URL('./fixtures/llm/ugc.json', import.meta.url), 'utf8')));
const NOW = new Date('2026-11-12T02:30:00Z'); // 21:30 Toronto on 2026-11-11
const T = new Date('2026-11-12T02:31:00Z');
const ID = '2026-11-12#1';
const concept = (caption: string): UgcConcept => ({ ...good, caption });

afterEach(() => { delete process.env.LLM_STUB; setLlmClient(null); });

function setup() {
  const db = fresh();
  db.prepare("INSERT INTO products (handle, title, raw_json, fetched_at) VALUES (?,?,'{}','t')").run(brief.product.handle, brief.product.title);
  db.prepare('INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?,?,?,?)').run(brief.product.handle, brief.sourceHash, JSON.stringify(brief), NOW.toISOString());
  db.prepare("INSERT INTO kv (key, value) VALUES ('ingest_at', ?)").run(NOW.toISOString());
  planDay(db, config, '2026-11-12', NOW);
  return db;
}
const slot = (db: ReturnType<typeof fresh>) => db.prepare('SELECT * FROM slots WHERE id = ?').get(ID) as any;
const spend = (db: ReturnType<typeof fresh>) => db.prepare('SELECT * FROM spend ORDER BY id').all() as any[];

// A clip provider that writes a small file; `checkThrows` makes check refuse.
function provider(opts: { checkThrows?: boolean } = {}) {
  const calls = { submit: 0, fetch: 0 };
  const p: ClipProvider = {
    name: 'higgsfield',
    configured: () => true,
    check: async () => { if (opts.checkThrows) throw new Error('refused'); },
    submit: async () => { calls.submit++; return { jobId: 'job' + calls.submit }; },
    fetch: async (_id, out) => { calls.fetch++; writeFileSync(out, 'clip' + calls.fetch); },
  };
  return { providers: { higgsfield: p }, calls };
}

// Test deps: the concept writer hands out `concepts` in order and records `recent`; the frame check answers `checks` in order.
function rig(over: { concepts?: UgcConcept[]; checks?: boolean[]; providers?: Record<string, ClipProvider>; deps?: Partial<ProduceDeps> } = {}) {
  const concepts = [...(over.concepts ?? [concept('first caption'), concept('second caption')])];
  const checks = [...(over.checks ?? [true, true])];
  const seen = { recent: [] as { caption: string; setting: string }[][], rendered: [] as string[] };
  const deps: Partial<ProduceDeps> = {
    ingest: async () => {},
    providers: over.providers ?? provider().providers,
    concept: async (_db, _c, _b, recent) => { seen.recent.push(recent); const c = concepts.shift(); if (!c) throw new Error('no concept'); return c; },
    prepareImage: async (_s, _c, out) => writeFileSync(out, 'jpg'),
    probeClip: async () => ({ width: 720, height: 1280, seconds: 15 }),
    checkClip: async () => { const pass = checks.shift() ?? true; return { pass, problems: pass ? [] : ['the product does not match the reference'], verdict: {} as any }; },
    renderUgc: async (o) => { seen.rendered.push(o.caption); writeFileSync(o.outFile, 'video:' + o.caption); },
    qa: async () => ({ pass: true, checks: [] }),
    ...over.deps,
  };
  return { deps, seen };
}

function stored(db: ReturnType<typeof fresh>, id: string, date: string, c: UgcConcept, file: string | null, handle = brief.product.handle, status = 'done') {
  const i = Number(id.split('#')[1]);
  db.prepare("INSERT INTO slots (id, local_date, idx, status, product_handle, master_json, created_at, updated_at) VALUES (?,?,?,?,?,?,'t','t')")
    .run(id, date, i, status, handle, JSON.stringify({ mode: 'ugc', concept: c, clipFile: file, reusedFrom: null }));
}
// A stored clip lives in DATA_DIR/clips: call after setup(), which sets DATA_DIR.
const clipFile = (name: string) => { const d = resolve(process.env.DATA_DIR!, 'clips'); mkdirSync(d, { recursive: true }); const f = join(d, name + '.mp4'); writeFileSync(f, name); return f; };
const events = (db: ReturnType<typeof fresh>, kind: string) => db.prepare('SELECT message FROM events WHERE kind = ?').all(kind) as { message: string }[];

test('new clip: ready, one row per platform with the same file, concept and ledger stored', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const { deps } = rig();
  await produceSlot(db, config, ID, T, deps);
  const s = slot(db);
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.tier, 't2');
  assert.equal(s.hook_id, null);
  const m = JSON.parse(s.master_json);
  assert.equal(m.mode, 'ugc');
  assert.equal(m.concept.caption, 'first caption');
  assert.equal(m.reusedFrom, null);
  assert.equal(m.clipFile, 'clips/2026-11-12-1.mp4');
  assert.ok(existsSync(resolve(process.env.DATA_DIR!, m.clipFile)));
  const rows = db.prepare('SELECT * FROM renders WHERE slot_id = ?').all(ID) as any[];
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((r) => r.sha256)).size, 1);
  assert.equal(new Set(rows.map((r) => r.file_path)).size, 4);
  for (const r of rows) {
    assert.equal(readFileSync(r.file_path, 'utf8'), 'video:first caption');
    assert.deepEqual(JSON.parse(r.ai_json), { visuals: true, voice: true, music: false });
    assert.ok(r.caption.includes(brief.disclosures[0]));
  }
  const sp = spend(db);
  assert.deepEqual(sp.map((r) => [r.state, r.tier]), [['succeeded', 't2']]);
  assert.ok(s.cost_usd >= 0.57);
});

test('the frame check fails once: two jobs, the first rejected, the second concept sees the first caption', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const { deps, seen } = rig({ checks: [false, true] });
  await produceSlot(db, config, ID, T, deps);
  const s = slot(db);
  assert.equal(s.status, 'ready', s.error);
  assert.deepEqual(spend(db).map((r) => r.state), ['rejected', 'succeeded']);
  assert.equal(seen.recent.length, 2);
  assert.equal(seen.recent[1][0].caption, 'first caption');
  assert.equal(JSON.parse(s.master_json).concept.caption, 'second caption');
  assert.deepEqual(seen.rendered, ['second caption']);
});

test('both attempts rejected: a stored clip that is old enough is posted again; an empty library fails the slot with one alert', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const old = concept('an old caption');
  const f = clipFile('old');
  stored(db, '2026-10-01#1', '2026-10-01', old, f);
  const { deps, seen } = rig({ checks: [false, false] });
  await produceSlot(db, config, ID, T, deps);
  const s = slot(db);
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.tier, 't0');
  const m = JSON.parse(s.master_json);
  assert.deepEqual([m.reusedFrom, m.clipFile, m.concept.caption], ['2026-10-01#1', 'clips/old.mp4', 'an old caption']);
  assert.equal(events(db, 'degraded').length, 1);
  assert.match(events(db, 'degraded')[0].message, /2026-10-01#1.*every clip was rejected/);
  assert.deepEqual(seen.rendered, ['an old caption']);
  assert.deepEqual(spend(db).map((r) => r.state), ['rejected', 'rejected']);

  const empty = setup();
  await produceSlot(empty, config, ID, T, rig({ checks: [false, false] }).deps);
  assert.equal(slot(empty).status, 'failed');
  assert.match(slot(empty).error, /no stored clip can be posted again/);
  assert.equal((empty.prepare("SELECT count(*) c FROM events WHERE kind = 'produce_failed'").get() as any).c, 1);
});

test('the provider refuses to start: no ledger row, the stored clip is used', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  stored(db, '2026-10-01#1', '2026-10-01', concept('an old caption'), clipFile('old'));
  await produceSlot(db, config, ID, T, rig({ providers: provider({ checkThrows: true }).providers }).deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  assert.equal(JSON.parse(slot(db).master_json).reusedFrom, '2026-10-01#1');
  assert.equal(spend(db).length, 0);
});

test('the concept writer is down: the stored clip is used and the copy falls back to deterministic text', async () => {
  const db = setup();
  setLlmClient({ create: async () => { throw new Error('model down'); } });
  stored(db, '2026-10-01#1', '2026-10-01', concept('an old caption'), clipFile('old'));
  const { deps } = rig({ deps: { concept: async () => { throw new Error('model down'); } } });
  await produceSlot(db, config, ID, T, deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  const r = db.prepare("SELECT title, caption FROM renders WHERE slot_id = ? AND platform = 'tiktok'").get(ID) as any;
  assert.equal(r.title, 'an old caption');
  assert.ok(r.caption.startsWith(`an old caption\n${brief.product.title} from ${brief.shop.name}.`));
  assert.ok(!r.caption.includes(brief.product.priceText));
  assert.equal(spend(db).length, 0);
});

test('resume after a crash: the stored concept is used, the job is fetched, nothing is submitted or written again', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  db.prepare("UPDATE slots SET master_json = ? WHERE id = ?").run(JSON.stringify({ mode: 'ugc', concept: concept('stored caption') }), ID);
  db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, job_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(ID, 't2', 'higgsfield', 'wan3_0', 'submitted', 0.57, 'job-old', NOW.toISOString(), NOW.toISOString());
  const p = provider();
  const { deps, seen } = rig({ providers: p.providers });
  await produceSlot(db, config, ID, T, deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  assert.equal(seen.recent.length, 0); // the concept writer was not called
  assert.deepEqual([p.calls.submit, p.calls.fetch], [0, 1]);
  assert.equal(JSON.parse(slot(db).master_json).concept.caption, 'stored caption');
  assert.deepEqual(spend(db).map((r) => r.state), ['succeeded']);
});

test('pickStoredClip: reuseAfterDays, oldest last use, missing files and other products ignored', () => {
  const db = setup();
  const [a, b, c, gone, other, fresh_] = ['a', 'b', 'c', 'gone', 'other', 'fresh'].map(clipFile);
  rmSync(gone);
  stored(db, '2026-09-01#1', '2026-09-01', concept('A'), a);
  stored(db, '2026-10-01#1', '2026-10-01', concept('B old'), b);
  stored(db, '2026-10-20#1', '2026-10-20', concept('B again'), b); // b's last use is 10-20
  stored(db, '2026-09-05#1', '2026-09-05', concept('C'), c);
  stored(db, '2026-09-02#1', '2026-09-02', concept('gone'), gone);
  stored(db, '2026-09-03#1', '2026-09-03', concept('other'), other, 'another-product');
  stored(db, '2026-11-05#1', '2026-11-05', concept('fresh'), fresh_);
  stored(db, '2026-09-04#1', '2026-09-04', concept('failed'), clipFile('failed'), brief.product.handle, 'failed');
  const pick = (date: string) => pickStoredClip(db, config, brief, NOW, date);
  assert.deepEqual([pick('2026-11-12')?.clipFile, pick('2026-11-12')?.concept.caption], [a, 'A']); // oldest last use
  assert.equal(pick('2026-09-10'), null); // a was used 09-01: 9 days < 14
  assert.equal(pick('2026-09-15')?.clipFile, a);
  db.prepare("UPDATE slots SET status = 'failed' WHERE id = '2026-09-01#1'").run();
  assert.equal(pick('2026-11-12')?.clipFile, c); // c last used 09-05
  assert.equal(pick('2026-11-12')?.slotId, '2026-09-05#1');
  // b's last use is 10-20: 13 days old on 11-02, eligible on 11-03
  db.prepare("UPDATE slots SET status = 'failed' WHERE id = '2026-09-05#1'").run();
  assert.equal(pick('2026-11-02'), null);
  assert.deepEqual([pick('2026-11-03')?.clipFile, pick('2026-11-03')?.concept.caption, pick('2026-11-03')?.slotId], [b, 'B again', '2026-10-20#1']);
});

test('a lost claim stops the run: the newer claimant keeps the slot and its files', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inRender!: () => void;
  const started = new Promise<void>((r) => (inRender = r));
  const p = provider();
  const first = produceSlot(db, config, ID, T, rig({ providers: p.providers, deps: { renderUgc: async (o) => { inRender(); await gate; writeFileSync(o.outFile, 'first'); } } }).deps);
  await started;
  db.prepare("UPDATE slots SET status = 'planned' WHERE id = ?").run(ID); // stale recovery
  await produceSlot(db, config, ID, new Date('2026-11-12T03:10:00Z'), rig({ providers: p.providers, deps: { renderUgc: async (o) => writeFileSync(o.outFile, 'second') } }).deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  release();
  await first; // stops without writing
  const s = slot(db);
  assert.deepEqual([s.status, s.claimed_at, s.attempt], ['ready', '2026-11-12T03:10:00.000Z', 2]);
  const rows = db.prepare('SELECT file_path FROM renders WHERE slot_id = ?').all(ID) as any[];
  assert.equal(rows.length, 4);
  for (const r of rows) assert.equal(readFileSync(r.file_path, 'utf8'), 'second');
  assert.equal(p.calls.submit, 1); // the second claimant found the first's clip
});

test('copy: aboutScript keeps today\'s user message and fallback exactly', async () => {
  const users: string[] = [];
  setLlmClient({ create: async (p) => { users.push((p.messages as { content: string }[])[0].content); throw new Error('stop'); } });
  await assert.rejects(writeCopy(fresh(), config, brief, aboutScript(script), NOW, 's1'));
  const lines = script.beats.map((b) => `${b.kind}: ${b.chunks.map((c) => c.say).join(' ')}`).join('\n');
  assert.equal(users[0], `Write copy for these platforms: youtube, facebook, instagram, tiktok.\nThe video's script:\n${lines}`);
  const fb = fallbackCopy(brief, aboutScript(script));
  assert.equal(fb.tiktok.caption, `${script.hook.headline} ${brief.product.title}, ${brief.product.priceText}, at ${brief.shop.name}.`);
  assert.equal(fb.tiktok.title, script.hook.headline.slice(0, 90));
});

test('copy: the ugc message starts with style: ugc; the fallback has no price and passes; a year passes only with years', async () => {
  const users: string[] = [];
  setLlmClient({ create: async (p) => { users.push((p.messages as { content: string }[])[0].content); throw new Error('stop'); } });
  const about = aboutConcept(good);
  await assert.rejects(writeCopy(fresh(), config, brief, about, NOW, 's1'));
  assert.ok(users[0].startsWith('style: ugc\n'));
  assert.match(users[0], /On-screen caption: POV: your office is freezing/);
  assert.match(users[0], /Spoken line: It's freezing in here\./);
  assert.match(users[0], /What happens:\n- Close on her face/);
  const fb = fallbackCopy(brief, about);
  assert.ok(!fb.youtube.text.includes(brief.product.priceText));
  assert.ok(fb.youtube.caption!.endsWith(`\n${brief.product.title} from ${brief.shop.name}.`));
  assert.deepEqual(copyProblems(brief, fb), []);
  const yr = fallbackCopy(brief, aboutConcept(concept('the coziest gift of 2026')));
  assert.ok(copyProblems(brief, yr).some((p) => /2026/.test(p)));
  assert.deepEqual(copyProblems(brief, yr, [2026, 2027]), []);
});

test('a claim stolen while the images are prepared stops the run: no reuse of a stored clip, the newer row is untouched', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  stored(db, 'old#1', '2026-10-01', concept('old caption'), clipFile('old'));
  const p = provider();
  let rendered = 0;
  await produceSlot(db, config, ID, T, rig({ providers: p.providers, deps: {
    prepareImage: async (_s, _c, out) => {
      writeFileSync(out, 'jpg');
      db.prepare("UPDATE slots SET claimed_at = '2026-11-12T03:10:00.000Z', status = 'producing', attempt = 2 WHERE id = ?").run(ID);
    },
    renderUgc: async () => { rendered++; },
  } }).deps);
  assert.equal(rendered, 0);
  const s = slot(db);
  assert.deepEqual([s.status, s.claimed_at, s.attempt, s.master_json === null || JSON.parse(s.master_json).reusedFrom === undefined], ['producing', '2026-11-12T03:10:00.000Z', 2, true]);
  assert.equal(p.calls.submit, 0);
});

const LATER = new Date('2026-11-12T02:40:00Z');
const down = () => { throw new RetryableLlmError('model down'); };

test('the frame check is down: the slot waits with the attempt given back and the paid clip kept, then is ready on the same clip', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const p = provider();
  const base = rig({ providers: p.providers });
  let concepts = 0;
  const countConcept: ProduceDeps['concept'] = async (...a) => { concepts++; return base.deps.concept!(...a); };
  await produceSlot(db, config, ID, T, { ...base.deps, concept: countConcept, checkClip: async () => down() });
  let s = slot(db);
  assert.deepEqual([s.status, s.attempt], ['planned', 0]);
  assert.match(s.error, /model down/);
  assert.deepEqual(spend(db).map((r) => r.state), ['succeeded']);
  assert.equal(events(db, 'degraded').length, 1);
  assert.equal(events(db, 'produce_failed').length, 0);
  await produceSlot(db, config, ID, LATER, { ...base.deps, concept: countConcept });
  s = slot(db);
  assert.equal(s.status, 'ready', s.error);
  assert.deepEqual([p.calls.submit, concepts], [1, 1]);
});

test('the frame check fails with another error every run: planned once with the attempt counted, then failed; the ledger row stays succeeded', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const deps = rig({ deps: { checkClip: async () => { throw new Error('bad answer'); } } }).deps;
  await produceSlot(db, config, ID, T, deps);
  assert.deepEqual([slot(db).status, slot(db).attempt], ['planned', 1]);
  await produceSlot(db, config, ID, LATER, deps);
  assert.equal(slot(db).status, 'failed');
  assert.equal(events(db, 'produce_failed').length, 1);
  assert.equal(events(db, 'degraded').length, 0);
  assert.deepEqual(spend(db).map((r) => r.state), ['succeeded']);
});

test('the caption render throws once after the clip was paid for: planned, then ready on the same clip', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const p = provider();
  let n = 0;
  const base = rig({ providers: p.providers });
  const deps = { ...base.deps, renderUgc: async (o: any) => { if (n++ === 0) throw new Error('renderer crashed'); writeFileSync(o.outFile, 'v'); } };
  await produceSlot(db, config, ID, T, deps);
  assert.deepEqual([slot(db).status, slot(db).attempt], ['planned', 1]);
  await produceSlot(db, config, ID, LATER, deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  assert.equal(p.calls.submit, 1);
});

test('the paid job cannot be fetched now: the slot waits, the attempt is given back and no stored clip is rendered', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  stored(db, '2026-10-01#1', '2026-10-01', concept('an old caption'), clipFile('old'));
  const p = provider();
  p.providers.higgsfield.fetch = async () => { throw new Error('download failed'); };
  const { deps, seen } = rig({ providers: p.providers });
  await produceSlot(db, config, ID, T, deps);
  const s = slot(db);
  assert.deepEqual([s.status, s.attempt], ['planned', 0]);
  assert.deepEqual(seen.rendered, []);
  assert.equal(events(db, 'degraded').length, 1);
  assert.deepEqual(spend(db).map((r) => r.state), ['submitted']); // fails until the router keeps the row submitted
});

test('probeClip throws: the clip is rejected and a second job is submitted', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const p = provider();
  let n = 0;
  const base = rig({ providers: p.providers });
  await produceSlot(db, config, ID, T, { ...base.deps, probeClip: async () => { if (n++ === 0) throw new Error('corrupt file'); return { width: 720, height: 1280, seconds: 15 }; } });
  assert.equal(slot(db).status, 'ready', slot(db).error);
  assert.equal(p.calls.submit, 2);
  assert.deepEqual(spend(db).map((r) => r.state), ['rejected', 'succeeded']);
});

test('the concept writer is down: an empty library waits; a stored clip is posted with one alert that names the reason', async () => {
  process.env.LLM_STUB = '1';
  const empty = setup();
  const deps = rig({ deps: { concept: async () => down() } }).deps;
  await produceSlot(empty, config, ID, T, deps);
  assert.deepEqual([slot(empty).status, slot(empty).attempt], ['planned', 0]);
  assert.equal(events(empty, 'produce_failed').length, 0);

  const db = setup();
  stored(db, '2026-10-01#1', '2026-10-01', concept('an old caption'), clipFile('old'));
  await produceSlot(db, config, ID, T, deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  const ev = events(db, 'degraded');
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /2026-10-01#1.*the concept writer failed/);
});

test('pickStoredClip: a caption with last year is skipped, a relative path is found, a path outside DATA_DIR/clips is refused', () => {
  const db = setup();
  const good1 = clipFile('good');
  stored(db, '2026-09-01#1', '2026-09-01', concept('the coziest gift of 2025'), clipFile('stale'));
  assert.equal(pickStoredClip(db, config, brief, NOW, '2026-11-12'), null);
  stored(db, '2026-09-02#1', '2026-09-02', concept('A'), 'clips/good.mp4');
  assert.deepEqual([pickStoredClip(db, config, brief, NOW, '2026-11-12')?.clipFile, pickStoredClip(db, config, brief, NOW, '2026-11-12')?.slotId], [good1, '2026-09-02#1']);
  db.prepare("UPDATE slots SET status = 'failed' WHERE id = '2026-09-02#1'").run();
  const outside = join(mkdtempSync(join(tmpdir(), 'clip-')), 'x.mp4');
  writeFileSync(outside, 'x');
  stored(db, '2026-09-03#1', '2026-09-03', concept('B'), outside);
  stored(db, '2026-09-04#1', '2026-09-04', concept('C'), '../secret.mp4');
  writeFileSync(resolve(process.env.DATA_DIR!, 'secret.mp4'), 'x');
  assert.equal(pickStoredClip(db, config, brief, NOW, '2026-11-12'), null);
});

test('a job unfetched for over 2 hours is given up and a stored clip that is old enough is posted', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  stored(db, '2026-10-01#1', '2026-10-01', concept('an old caption'), clipFile('old'));
  db.prepare('UPDATE slots SET master_json = ? WHERE id = ?').run(JSON.stringify({ mode: 'ugc', concept: concept('stuck caption') }), ID);
  const made = new Date(T.getTime() - 2 * 3600_000 - 60_000).toISOString();
  db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, job_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(ID, 't2', 'higgsfield', 'wan3_0', 'submitted', 0.57, 'job-stuck', made, made);
  const p = provider();
  p.providers.higgsfield.fetch = async () => { throw new Error('HTTP 503'); };
  await produceSlot(db, config, ID, T, rig({ providers: p.providers }).deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  assert.equal(JSON.parse(slot(db).master_json).reusedFrom, '2026-10-01#1');
  assert.equal(spend(db)[0].state, 'failed');
  assert.match(spend(db)[0].error, /did not finish within 2 hours/);
});

test('a deferral is retried 10 minutes after the attempt ENDED, not after it was claimed', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const end = new Date(T.getTime() + 40 * 60_000);
  await produceSlot(db, config, ID, T, rig({ deps: { concept: async () => down(), clock: () => end } }).deps);
  assert.deepEqual([slot(db).status, slot(db).attempt, slot(db).updated_at], ['planned', 0, end.toISOString()]);
});

test('the concept writer deferral gives the attempt back once; a repeat counts, and the next one fails the slot', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  const deps = rig({ deps: { concept: async () => down() } }).deps;
  await produceSlot(db, config, ID, T, deps);
  assert.deepEqual([slot(db).status, slot(db).attempt], ['planned', 0]);
  await produceSlot(db, config, ID, T, deps);
  assert.deepEqual([slot(db).status, slot(db).attempt], ['planned', 1]);
  await produceSlot(db, config, ID, T, deps);
  assert.equal(slot(db).status, 'failed');
});

test('a wait alert does not hide the later alert that a stored clip is posted again', async () => {
  process.env.LLM_STUB = '1';
  const db = setup();
  await produceSlot(db, config, ID, T, rig({ deps: { concept: async () => down() } }).deps);
  stored(db, '2026-10-01#1', '2026-10-01', concept('an old caption'), clipFile('old'));
  await produceSlot(db, config, ID, T, rig({ deps: { concept: async () => down() } }).deps);
  assert.equal(slot(db).status, 'ready', slot(db).error);
  assert.equal(events(db, 'degraded').length, 2);
});
