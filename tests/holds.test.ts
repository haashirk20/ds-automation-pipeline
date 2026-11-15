import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/index.ts';
import { publishDue } from '../src/publish/index.ts';
import { approveHold, discardHold, holdsTick, manualToday, planManual } from '../src/scheduler/holds.ts';
import { tick } from '../src/scheduler/loop.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { adConfig, config, fakePublishers, fresh } from './helpers.ts';

const NOW = new Date('2026-11-12T17:20:00Z'); // 12:20 Toronto
const DAY = '2026-11-12';
const mins = (m: number, from = NOW) => new Date(from.getTime() + m * 60000);
type Db = ReturnType<typeof fresh>;

// A manual slot as the producer leaves it: ready, renders stored, waiting.
function held(db: Db, now = NOW, model: string | null = null) {
  const r = planManual(db, config, now, model);
  assert.ok('slotId' in r, JSON.stringify(r));
  const ts = now.toISOString();
  for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) db.prepare("INSERT INTO renders (slot_id, platform, file_path, qa_pass, qa_json, title, caption, created_at) VALUES (?,?,?,1,'{}','t','c',?)").run(r.slotId, p, `/x/${p}.mp4`, ts);
  db.prepare("UPDATE slots SET status = 'ready', hold = 'waiting', held_at = ? WHERE id = ?").run(ts, r.slotId);
  return r.slotId;
}
const slot = (db: Db, id: string) => db.prepare('SELECT * FROM slots WHERE id = ?').get(id) as any;
const pubs = (db: Db, id: string) => db.prepare('SELECT * FROM publications WHERE slot_id = ? ORDER BY platform').all(id) as any[];
const events = (db: Db, kind: string) => db.prepare('SELECT * FROM events WHERE kind = ?').all(kind) as any[];

test('planManual: ids #101 and #102, one pending row per enabled platform at now', () => {
  const db = fresh();
  const a = planManual(db, config, NOW, null) as { slotId: string };
  assert.equal(a.slotId, `${DAY}#101`);
  assert.deepEqual(manualToday(db, config, NOW), { made: 1, inFlight: true });
  const s = slot(db, a.slotId);
  assert.deepEqual([s.kind, s.idx, s.status, s.hold, s.video_model], ['manual', 101, 'planned', null, null]);
  db.prepare("UPDATE slots SET status = 'ready' WHERE id = ?").run(a.slotId);
  assert.deepEqual(planManual(db, config, NOW, null), { slotId: `${DAY}#102` });
  assert.deepEqual(pubs(db, a.slotId).map((p) => [p.platform, p.state, p.scheduled_at]), ['facebook', 'instagram', 'tiktok', 'youtube'].map((p) => [p, 'pending', NOW.toISOString()]));
});

test('planManual refuses: in flight, at the cap, no platform, ad mode, unknown model', () => {
  const db = fresh();
  planManual(db, config, NOW, null);
  assert.match((planManual(db, config, NOW, null) as any).refused, /already being made/);
  for (let i = 0; i < 2; i++) { db.prepare("UPDATE slots SET status = 'ready' WHERE kind = 'manual'").run(); assert.ok('slotId' in planManual(db, config, NOW, null)); }
  db.prepare("UPDATE slots SET status = 'ready' WHERE kind = 'manual'").run();
  assert.match((planManual(db, config, NOW, null) as any).refused, /limit of 3/);
  assert.match((planManual(fresh(), config, NOW, 'nope') as any).refused, /unknown video model/);
  assert.match((planManual(fresh(), adConfig, NOW, null) as any).refused, /ugc/);
  const off = parseConfig({ ...config, platforms: Object.fromEntries(Object.entries(config.platforms).map(([k, v]) => [k, { ...v, enabled: false }])) });
  assert.match((planManual(fresh(), off, NOW, null) as any).refused, /no platform/);
  // another local day starts at zero
  assert.ok('slotId' in planManual(db, config, new Date('2026-11-13T17:20:00Z'), null));
});

test('a manual slot does not stop planDay or tick from planning the day', async () => {
  const db = fresh();
  planManual(db, config, NOW, null);
  const producer = { busy: () => true, start: async () => {} };
  await tick({ db, config, publishers: {}, producer }, NOW);
  const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM slots WHERE local_date = ? GROUP BY kind ORDER BY kind').all(DAY) as any[];
  assert.deepEqual(kinds.map((k) => k.kind), ['manual', 'planned']);
});

test('tick starts the manual slot before the planned ones', async () => {
  const db = fresh();
  planDay(db, config, DAY, new Date('2026-11-12T02:30:00Z'));
  planManual(db, config, NOW, null);
  const started: string[] = [];
  await tick({ db, config, publishers: {}, producer: { busy: () => false, start: async (id) => { started.push(id); } } }, NOW);
  assert.equal(started[0], `${DAY}#101`);
});

test('approve: only from waiting, scheduled_at is max(), a second call is false', () => {
  const db = fresh();
  const id = held(db);
  const later = mins(60);
  assert.equal(approveHold(db, id, later), true);
  assert.equal(approveHold(db, id, mins(61)), false);
  assert.equal(slot(db, id).hold, 'approved');
  assert.ok(pubs(db, id).every((p) => p.scheduled_at === later.toISOString() && p.state === 'pending'));
  assert.equal(approveHold(db, `${DAY}#999`, later), false);
  // a scheduled time in the future is kept
  const id2 = held(db, mins(120));
  db.prepare("UPDATE publications SET scheduled_at = ? WHERE slot_id = ?").run(mins(500).toISOString(), id2);
  assert.equal(approveHold(db, id2, mins(121)), true);
  assert.equal(pubs(db, id2)[0].scheduled_at, mins(500).toISOString());
  // a slot not yet ready cannot be approved
  const r = planManual(db, config, NOW, null) as { slotId: string };
  db.prepare("UPDATE slots SET hold = 'waiting' WHERE id = ?").run(r.slotId);
  assert.equal(approveHold(db, r.slotId, later), false);
});

test('approving a custom model stamps approved_at once', () => {
  const db = fresh();
  db.prepare("INSERT INTO video_models (id, name, model, params_json, max_credits, keep_credits, created_at) VALUES (1,'m','wan3_0','{}',50,350,'t')").run();
  const id = held(db, NOW, 'custom:1');
  approveHold(db, id, mins(5));
  assert.equal((db.prepare('SELECT approved_at FROM video_models WHERE id = 1').get() as any).approved_at, mins(5).toISOString());
  const id2 = held(db, mins(10), 'custom:1');
  approveHold(db, id2, mins(30));
  assert.equal((db.prepare('SELECT approved_at FROM video_models WHERE id = 1').get() as any).approved_at, mins(5).toISOString());
});

test('approve against discard: exactly one wins', () => {
  const db = fresh();
  const id = held(db);
  assert.equal(discardHold(db, id, mins(1)), true);
  assert.equal(approveHold(db, id, mins(2)), false);
  const id2 = held(db, mins(3));
  assert.equal(approveHold(db, id2, mins(4)), true);
  assert.equal(discardHold(db, id2, mins(5)), false);
  assert.ok(pubs(db, id2).every((p) => p.state === 'pending'));
});

test('a waiting slot is neither published nor doomed, however late; after approve it publishes', async () => {
  const db = fresh();
  const id = held(db);
  const { publishers, calls } = fakePublishers();
  const late = mins(config.publish.maxLatenessMinutes + 600);
  await publishDue(db, config, publishers, late);
  assert.equal(calls.length, 0);
  assert.ok(pubs(db, id).every((p) => p.state === 'pending' && p.error === null));
  assert.equal(slot(db, id).status, 'ready');
  approveHold(db, id, late); // later than scheduled time + lateness
  await publishDue(db, config, publishers, late);
  assert.equal(calls.length, 4);
  assert.ok(pubs(db, id).every((p) => p.state === 'published'));
  assert.equal(slot(db, id).status, 'done');
});

test('approved slot publishes in a dry run without calling publishers', async () => {
  const db = fresh();
  const id = held(db);
  approveHold(db, id, NOW);
  process.env.DRY_RUN = '1';
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, NOW);
  assert.equal(calls.length, 0);
  assert.ok(pubs(db, id).every((p) => p.state === 'published' && p.dry_run === 1));
});

test('discard skips the rows (no handle) and publishDue makes the slot done', async () => {
  const db = fresh();
  const id = held(db);
  assert.equal(discardHold(db, id, mins(1)), true);
  assert.equal(discardHold(db, id, mins(2)), false);
  assert.ok(pubs(db, id).every((p) => p.state === 'skipped' && p.error === 'discarded by the owner' && p.handle_json === null));
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, mins(3));
  assert.equal(calls.length, 0);
  assert.deepEqual([slot(db, id).status, slot(db, id).hold], ['done', 'discarded']);
});

test('expiry skips the rows and alerts once; the waiting alert is sent once, with or without an event row', async () => {
  const db = fresh();
  const id = held(db);
  await holdsTick(db, config, mins(10));
  await holdsTick(db, config, mins(20));
  assert.equal(events(db, 'approval_waiting').length, 1);
  assert.equal(slot(db, id).hold, 'waiting');
  const id2 = held(db, mins(30));
  db.prepare("DELETE FROM events").run(); // no event row exists: the next tick sends again
  await holdsTick(db, config, mins(31));
  assert.equal(events(db, 'approval_waiting').length, 2);
  const after = mins(config.approval.expireHours * 60 + 1);
  await holdsTick(db, config, after);
  await holdsTick(db, config, mins(5, after));
  assert.deepEqual([slot(db, id).hold, slot(db, id2).hold], ['expired', 'waiting']); // the second was held 30 minutes later
  assert.ok(pubs(db, id).every((p) => p.state === 'skipped' && /not approved within 24 hours/.test(p.error) && p.handle_json === null));
  assert.equal(events(db, 'hold_expired').length, 1);
  await holdsTick(db, config, mins(40, after));
  assert.equal(slot(db, id2).hold, 'expired');
  assert.equal(events(db, 'hold_expired').length, 2);
});

test('a manual slot that is still being made is not doomed as too late', async () => {
  const db = fresh();
  const a = planManual(db, config, NOW, null) as { slotId: string };
  const { publishers } = fakePublishers();
  await publishDue(db, config, publishers, mins(config.publish.maxLatenessMinutes + 60));
  assert.ok(pubs(db, a.slotId).every((p) => p.state === 'pending' && p.error === null));
  db.prepare("UPDATE slots SET status = 'producing' WHERE id = ?").run(a.slotId);
  await publishDue(db, config, publishers, mins(config.publish.maxLatenessMinutes + 60));
  assert.ok(pubs(db, a.slotId).every((p) => p.state === 'pending'));
});

test('approve with no pending row left returns nothing and leaves the hold waiting', () => {
  const db = fresh();
  const id = held(db);
  db.prepare("UPDATE publications SET state = 'skipped' WHERE slot_id = ?").run(id);
  assert.equal(approveHold(db, id, NOW), 'nothing');
  assert.equal(slot(db, id).hold, 'waiting');
  assert.equal(approveHold(db, 'nope', NOW), false);
});

test('inFlight counts a manual slot of an earlier day; a failed delivery is not repeated within 15 minutes', async () => {
  const db = fresh();
  const a = planManual(db, config, mins(-24 * 60), null) as { slotId: string };
  assert.equal(manualToday(db, config, NOW).inFlight, true);
  db.prepare("UPDATE slots SET status = 'failed' WHERE id = ?").run(a.slotId);
  const id = held(db);
  db.prepare("INSERT INTO events (ts, kind, key, message, delivered) VALUES (?, 'approval_waiting', ?, 'x', 0)").run(mins(-5).toISOString(), id);
  await holdsTick(db, config, NOW);
  assert.equal(events(db, 'approval_waiting').length, 1);
  await holdsTick(db, config, mins(11));
  assert.equal(events(db, 'approval_waiting').length, 2);
});
