import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produceSlot } from '../src/render/produce.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { tick } from '../src/scheduler/loop.ts';
import { makePublishers } from '../src/publish/registry.ts';
import { kvGet } from '../src/db/index.ts';
import { makeProducer } from '../src/scheduler/loop.ts';
import { AT_SLOT1, config, fakePublishers, fresh, readyDb, stubProducer } from './helpers.ts';
const publishers = makePublishers(config, { now: () => new Date() });

const count = (db: ReturnType<typeof fresh>, t: string) => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;

test('planDay creates 2 slots and 8 publications, idempotent', () => {
  const db = fresh();
  const now = new Date('2026-11-12T02:30:00Z');
  planDay(db, config, '2026-11-12', now);
  planDay(db, config, '2026-11-12', now);
  assert.equal(count(db, 'slots'), 2);
  assert.equal(count(db, 'publications'), 8);
  const p = db.prepare("SELECT scheduled_at FROM publications WHERE slot_id = '2026-11-12#2' AND platform = 'tiktok'").get() as { scheduled_at: string };
  assert.equal(p.scheduled_at, '2026-11-13T00:45:00.000Z');
});

test('only future slots are planned', () => {
  const db = fresh();
  planDay(db, config, '2026-11-12', new Date('2026-11-12T20:00:00Z')); // 15:00 local
  assert.deepEqual(db.prepare('SELECT id FROM slots').all().map((r) => r.id), ['2026-11-12#2']);
});

test('tick: nothing before produceAt, plans after', async () => {
  const db = fresh();
  const deps = { db, config, publishers, producer: stubProducer(db), wait: true };
  await tick(deps, new Date('2026-11-12T01:30:00Z'));
  assert.equal(count(db, 'slots'), 0);
  await tick(deps, new Date('2026-11-12T02:30:00Z'));
  assert.equal(count(db, 'slots'), 2);
  assert.equal(db.prepare("SELECT count(*) c FROM slots WHERE status = 'ready'").get()?.c, 2);
});

test('stuck producing slot returns to planned, then fails after maxAttempts', async () => {
  const db = fresh();
  const deps = { db, config, publishers, producer: stubProducer(db), wait: true };
  const t0 = new Date('2026-11-12T02:30:00Z');
  planDay(db, config, '2026-11-12', t0);
  const status = () => db.prepare("SELECT status, attempt FROM slots WHERE id = '2026-11-12#1'").get() as any;
  const stick = (attempt: number) => db.prepare("UPDATE slots SET status = 'producing', attempt = ?, updated_at = ? WHERE id = '2026-11-12#1'").run(attempt, t0.toISOString());
  const later = new Date(t0.getTime() + 91 * 60000);
  stick(1);
  await tick(deps, later);
  assert.equal(status().status, 'planned'); // the error gap holds it back
  await tick(deps, new Date(later.getTime() + 11 * 60000));
  assert.equal(status().status, 'ready'); // re-produced (attempt 2)
  assert.equal(status().attempt, 2);
  stick(2);
  await tick(deps, later);
  assert.equal(status().status, 'failed');
});

test('produce claim is atomic: only a planned slot is produced, once', async () => {
  const db = fresh();
  const t = new Date('2026-11-12T02:30:00Z');
  planDay(db, config, '2026-11-12', t);
  const ingest = async () => { throw new Error('no store'); };
  await Promise.all([produceSlot(db, config, '2026-11-12#1', t, { ingest }), produceSlot(db, config, '2026-11-12#1', t, { ingest })]);
  const s = db.prepare("SELECT status, attempt FROM slots WHERE id = '2026-11-12#1'").get() as any;
  assert.deepEqual([s.status, s.attempt], ['planned', 0]); // no brief and the store is down: released, attempt not burned
  assert.equal(count(db, 'events'), 2); // the failed ingest and the waiting slot, once each
  await produceSlot(db, config, '2026-11-12#1', t, { ingest });
  assert.equal((db.prepare("SELECT attempt FROM slots WHERE id = '2026-11-12#1'").get() as any).attempt, 0);
});

test('tick writes the heartbeat before it publishes', async () => {
  const db = await readyDb();
  let seen: string | undefined;
  const { publishers: fake } = fakePublishers(async () => { seen ??= kvGet(db, 'heartbeat'); return { postId: 'p', postUrl: null }; });
  await tick({ db, config, publishers: fake, producer: stubProducer(db) }, AT_SLOT1);
  assert.equal(seen, AT_SLOT1.toISOString());
});

test('a planned slot with an error is not started for 10 minutes', async () => {
  const db = fresh();
  const now = new Date('2026-11-12T03:00:00Z');
  planDay(db, config, '2026-11-12', now);
  const started: string[] = [];
  const deps = { db, config, publishers: fakePublishers().publishers, producer: makeProducer(async (id) => void started.push(id)), wait: true };
  const mark = (min: number) => db.prepare("UPDATE slots SET error = 'video service busy', updated_at = ? WHERE id = '2026-11-12#1'").run(new Date(now.getTime() - min * 60000).toISOString());
  mark(3);
  await tick(deps, now);
  assert.deepEqual(started, ['2026-11-12#2']);
  mark(11);
  await tick(deps, now);
  assert.deepEqual(started, ['2026-11-12#2', '2026-11-12#1', '2026-11-12#2']);
});
