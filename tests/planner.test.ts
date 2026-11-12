import { test } from 'node:test';
import assert from 'node:assert/strict';
import { produceSlot } from '../src/render/produce.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { tick } from '../src/scheduler/loop.ts';
import { publishers } from '../src/publish/registry.ts';
import { config, fresh } from './helpers.ts';

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
  const deps = { db, config, publishers };
  await tick(deps, new Date('2026-11-12T01:30:00Z'));
  assert.equal(count(db, 'slots'), 0);
  await tick(deps, new Date('2026-11-12T02:30:00Z'));
  assert.equal(count(db, 'slots'), 2);
  assert.equal(db.prepare("SELECT count(*) c FROM slots WHERE status = 'ready'").get()?.c, 2);
});

test('stuck producing slot returns to planned, then fails after maxAttempts', async () => {
  const db = fresh();
  const deps = { db, config, publishers };
  const t0 = new Date('2026-11-12T02:30:00Z');
  planDay(db, config, '2026-11-12', t0);
  const status = () => db.prepare("SELECT status, attempt FROM slots WHERE id = '2026-11-12#1'").get() as any;
  const stick = (attempt: number) => db.prepare("UPDATE slots SET status = 'producing', attempt = ?, updated_at = ? WHERE id = '2026-11-12#1'").run(attempt, t0.toISOString());
  const later = new Date(t0.getTime() + 31 * 60000);
  stick(1);
  await tick(deps, later);
  assert.equal(status().status, 'ready'); // went planned, then re-produced (attempt 2)
  assert.equal(status().attempt, 2);
  stick(2);
  await tick(deps, later);
  assert.equal(status().status, 'failed');
});

test('produce claim is atomic: only a planned slot is produced, once', async () => {
  const db = fresh();
  const t = new Date('2026-11-12T02:30:00Z');
  planDay(db, config, '2026-11-12', t);
  await Promise.all([produceSlot(db, config, '2026-11-12#1', t), produceSlot(db, config, '2026-11-12#1', t)]);
  const s = db.prepare("SELECT status, attempt FROM slots WHERE id = '2026-11-12#1'").get() as any;
  assert.deepEqual([s.status, s.attempt], ['ready', 1]);
  await produceSlot(db, config, '2026-11-12#1', t);
  assert.equal((db.prepare("SELECT attempt FROM slots WHERE id = '2026-11-12#1'").get() as any).attempt, 1);
});
