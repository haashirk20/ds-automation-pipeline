// D-45: the owner's Stop and Start for daily posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoPaused, kvSet, type Db } from '../src/db/index.ts';
import { overviewPage } from '../src/admin/pages.ts';
import { townState } from '../src/admin/town.ts';
import { publishDue } from '../src/publish/index.ts';
import { planManual } from '../src/scheduler/holds.ts';
import { makeProducer, tick } from '../src/scheduler/loop.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { AT_SLOT1, config, fakePublishers, fresh, readyDb } from './helpers.ts';

const NOW = new Date('2026-11-12T02:30:00Z'); // 21:30 Toronto on 2026-11-11, after produceAt
const SLOT = '2026-11-12#1';
const stop = (db: Db) => kvSet(db, 'auto_paused', JSON.stringify({ at: NOW.toISOString() }));
const start = (db: Db) => db.prepare("DELETE FROM kv WHERE key = 'auto_paused'").run();
const pub = (db: Db, slot: string, platform: string) => ({ ...(db.prepare('SELECT state, error, attempt FROM publications WHERE slot_id = ? AND platform = ?').get(slot, platform) as { state: string; error: string | null; attempt: number }) });
const events = (db: Db) => (db.prepare("SELECT kind FROM events WHERE kind != 'daily_summary'").all() as { kind: string }[]).map((e) => e.kind);
const recorder = () => {
  const started: string[] = [];
  return { started, producer: makeProducer(async (id) => void started.push(id)) };
};

test('autoPaused: absent is running, a damaged value still counts as stopped', () => {
  const db = fresh();
  assert.equal(autoPaused(db), null);
  stop(db);
  assert.deepEqual(autoPaused(db), { at: NOW.toISOString() });
  kvSet(db, 'auto_paused', 'not json');
  assert.deepEqual(autoPaused(db), { at: '' });
});

test('tick while stopped plans nothing but makes a manual video; Start resumes planning', async () => {
  const db = fresh();
  stop(db);
  const manual = (planManual(db, config, NOW, null) as { slotId: string }).slotId;
  const { started, producer } = recorder();
  const { publishers } = fakePublishers();
  await tick({ db, config, publishers, producer, wait: true }, NOW);
  assert.deepEqual(started, [manual]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM slots WHERE kind = 'planned'").get() as { n: number }).n, 0);

  start(db);
  await tick({ db, config, publishers, producer, wait: true }, new Date(NOW.getTime() + 60000));
  assert.deepEqual(started.filter((id) => id !== manual), ['2026-11-12#1', '2026-11-12#2']); // the recorder never finishes the manual one
});

test('a daily post planned before Stop is not produced while stopped and stays planned', async () => {
  const db = fresh();
  planDay(db, config, '2026-11-12', NOW);
  stop(db);
  const { started, producer } = recorder();
  await tick({ db, config, publishers: fakePublishers().publishers, producer, wait: true }, NOW);
  assert.deepEqual(started, []);
  assert.equal((db.prepare('SELECT status FROM slots WHERE id = ?').get(SLOT) as { status: string }).status, 'planned');
});

test('publishDue while stopped holds daily posts and publishes manual ones; on Start the held ones go out', async () => {
  const db = await readyDb();
  // Slot 2 stands in for a "Make a video now" video the owner approved, due at the same time.
  db.prepare("UPDATE slots SET kind = 'manual' WHERE id = '2026-11-12#2'").run();
  db.prepare("UPDATE publications SET scheduled_at = (SELECT scheduled_at FROM publications WHERE slot_id = ? AND platform = 'youtube') WHERE slot_id = '2026-11-12#2'").run(SLOT);
  stop(db);
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c: any) => c.idempotencyKey.startsWith('2026-11-12#2:')));
  assert.equal(pub(db, SLOT, 'youtube').state, 'pending');
  start(db);
  await publishDue(db, config, publishers, new Date(AT_SLOT1.getTime() + 60000));
  assert.equal(pub(db, SLOT, 'youtube').state, 'published');
});

test('while stopped, an earlier attempt with a stored handle is still reconciled (stale uploading and pending retry)', async () => {
  const db = await readyDb();
  db.prepare("UPDATE publications SET state = 'uploading', attempt = 1, claimed_at = '2026-11-12T16:00:00.000Z', handle_json = '{\"h\":1}' WHERE slot_id = ? AND platform = 'youtube'").run(SLOT);
  db.prepare("UPDATE publications SET state = 'pending', attempt = 1, handle_json = '{\"h\":2}' WHERE slot_id = ? AND platform = 'tiktok'").run(SLOT);
  stop(db);
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  const handles = Object.fromEntries(calls.map((c: any) => [c.idempotencyKey, c.handle]));
  assert.deepEqual(handles, { [`${SLOT}:youtube`]: { h: 1 }, [`${SLOT}:tiktok`]: { h: 2 } }); // nothing without a handle
  assert.equal(pub(db, SLOT, 'youtube').state, 'published');
  assert.equal(pub(db, SLOT, 'tiktok').state, 'published');
  assert.equal(pub(db, SLOT, 'facebook').state, 'pending');
});

test('late daily posts while stopped end quietly as paused; one with a handle still needs attention', async () => {
  const db = await readyDb();
  db.prepare("UPDATE publications SET handle_json = '{\"h\":1}' WHERE slot_id = ? AND platform = 'tiktok'").run(SLOT);
  stop(db);
  await publishDue(db, config, fakePublishers().publishers, new Date(AT_SLOT1.getTime() + 361 * 60000));
  assert.deepEqual(pub(db, SLOT, 'youtube'), { state: 'skipped', error: 'paused', attempt: 0 });
  assert.equal(pub(db, SLOT, 'tiktok').state, 'needs_attention');
  assert.deepEqual(events(db), ['publish_needs_attention']);
});

test('a planned slot past lateness while stopped fails quietly as paused, its posts skipped, no alert', async () => {
  const db = fresh();
  planDay(db, config, '2026-11-12', NOW);
  stop(db);
  const { started, producer } = recorder();
  await tick({ db, config, publishers: fakePublishers().publishers, producer, wait: true }, new Date('2026-11-13T00:00:00Z'));
  assert.deepEqual(started, []);
  assert.deepEqual({ ...(db.prepare('SELECT status, error FROM slots WHERE id = ?').get(SLOT) as object) }, { status: 'failed', error: 'paused' });
  assert.deepEqual(pub(db, SLOT, 'youtube'), { state: 'skipped', error: 'paused', attempt: 0 });
  assert.deepEqual(events(db), []);
});

test('Home: stopped by you is its own headline, counts as needing you, and is not the factory being down', async () => {
  const db = fresh();
  kvSet(db, 'heartbeat', NOW.toISOString());
  const home = async () => String((await overviewPage({ db, now: NOW, method: 'GET', path: '/overview', query: new URLSearchParams(), form: new URLSearchParams(), csrf: 'c' })).body);
  assert.ok((await home()).includes('<p>All good.</p>'));
  stop(db);
  const off = await home();
  assert.ok(off.includes('<p>Daily posts are stopped.</p>') && off.includes('Factory running · daily posts stopped'));
  assert.match(off, /tile warn"[^>]*><span class="tile-l">Needs you<\/span><span class="tile-v">1</);
});

test('Stop pressed during a publish holds the remaining platforms of a daily post', async () => {
  const db = await readyDb();
  const { publishers, calls } = fakePublishers(async () => { stop(db); return { postId: 'p', postUrl: 'u' }; });
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(calls.length, 1);
  const states = (db.prepare('SELECT state FROM publications WHERE slot_id = ? ORDER BY state').all(SLOT) as { state: string }[]).map((r) => r.state);
  assert.deepEqual(states, ['pending', 'pending', 'pending', 'published']);
});

test('Stop pressed during a production in run --once prevents the next daily-post spawn', async () => {
  const db = fresh();
  planDay(db, config, '2026-11-12', NOW);
  const started: string[] = [];
  const producer = makeProducer(async (id) => { started.push(id); stop(db); });
  await tick({ db, config, publishers: fakePublishers().publishers, producer, wait: true }, NOW);
  assert.deepEqual(started, [SLOT]);
});

test('while stopped, a planned slot that failed for a real reason keeps its error and alert', async () => {
  const db = await readyDb();
  db.prepare("UPDATE slots SET status = 'failed', error = 'render broke' WHERE id = ?").run(SLOT);
  stop(db);
  await publishDue(db, config, fakePublishers().publishers, AT_SLOT1);
  assert.deepEqual(pub(db, SLOT, 'youtube'), { state: 'skipped', error: 'slot failed', attempt: 0 });
  assert.ok(events(db).includes('publish_skipped'));
});

test('Town: while stopped, the next post leaves out daily posts, as Home does', async () => {
  const db = fresh();
  planDay(db, config, '2026-11-12', NOW);
  assert.ok((await townState(db, NOW)).next);
  stop(db);
  assert.equal((await townState(db, NOW)).next, null);
});
