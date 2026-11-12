import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishDue } from '../src/publish/index.ts';
import { AmbiguousError, ClaimLostError, RetryableError } from '../src/publish/types.ts';
import { AT_SLOT1, PermanentError, config, fakePublishers, readyDb } from './helpers.ts';

const SLOT = '2026-11-12#1';
const rows = (db: Awaited<ReturnType<typeof readyDb>>, sql = `SELECT * FROM publications WHERE slot_id = '${SLOT}' AND platform = 'youtube'`) => db.prepare(sql).all() as any[];
const min = (m: number) => new Date(AT_SLOT1.getTime() + m * 60000);

test('dry run publishes without calling publishers', async () => {
  const db = await readyDb();
  process.env.DRY_RUN = '1';
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(calls.length, 0);
  const r = rows(db)[0];
  assert.equal(r.state, 'published');
  assert.equal(r.dry_run, 1);
  assert.equal(r.post_id, 'dry-run');
});

test('success, and no double publish on second run', async () => {
  const db = await readyDb();
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  await publishDue(db, config, publishers, min(1));
  assert.equal(calls.length, 4);
  const r = rows(db)[0];
  assert.deepEqual([r.state, r.post_id, r.post_url, r.attempt], ['published', 'p1', 'u1', 1]);
  assert.equal(rows(db, "SELECT * FROM slots WHERE id = '2026-11-12#1'")[0].status, 'done');
  assert.equal(rows(db, "SELECT * FROM publications WHERE slot_id = '2026-11-12#2' AND state = 'pending'").length, 4);
});

test('retry schedule then exhaustion', async () => {
  const db = await readyDb();
  const { publishers, calls } = fakePublishers(async () => { throw new RetryableError('boom'); });
  let t = AT_SLOT1;
  for (const m of config.publish.retryMinutes) {
    await publishDue(db, config, publishers, t);
    const r = rows(db)[0];
    assert.equal(r.state, 'pending');
    assert.equal(r.next_attempt_at, new Date(t.getTime() + m * 60000).toISOString());
    await publishDue(db, config, publishers, new Date(t.getTime() + m * 60000 - 1000)); // too early
    t = new Date(r.next_attempt_at);
  }
  assert.equal(calls.length, 4 * config.publish.retryMinutes.length);
  await publishDue(db, config, publishers, t);
  const r = rows(db)[0];
  assert.equal(r.state, 'skipped');
  assert.equal(r.attempt, 6);
  assert.equal(rows(db, "SELECT * FROM events WHERE kind = 'publish_skipped'").length > 0, true);
});

test('lateness skip', async () => {
  const db = await readyDb();
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, min(361));
  assert.equal(rows(db)[0].state, 'skipped');
  assert.equal(calls.length, 0);
});

test('PermanentError skips with error stored', async () => {
  const db = await readyDb();
  const { publishers } = fakePublishers(async () => { throw new PermanentError('bad file'); });
  await publishDue(db, config, publishers, AT_SLOT1);
  const r = rows(db)[0];
  assert.deepEqual([r.state, r.error], ['skipped', 'bad file']);
});

test('Ambiguous and unknown errors need attention, never retried', async () => {
  const db = await readyDb();
  let n = 0;
  const { publishers, calls } = fakePublishers(async () => { throw n++ % 2 ? new Error('weird') : new AmbiguousError('maybe posted'); });
  await publishDue(db, config, publishers, AT_SLOT1);
  await publishDue(db, config, publishers, min(60));
  assert.equal(calls.length, 4);
  assert.equal(rows(db, `SELECT * FROM publications WHERE slot_id = '${SLOT}' AND state = 'needs_attention'`).length, 4);
});

test('crash recovery: uploading without handle resets to pending, then publishes', async () => {
  const db = await readyDb();
  db.prepare("UPDATE publications SET state = 'uploading', attempt = 1, claimed_at = '2026-11-12T16:00:00.000Z' WHERE slot_id = ? AND platform = 'youtube'").run(SLOT);
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(rows(db)[0].state, 'published');
  assert.equal((calls[0] as any).handle, null);
});

test('crash recovery: uploading with handle resumes with it', async () => {
  const db = await readyDb();
  db.prepare("UPDATE publications SET state = 'uploading', attempt = 1, claimed_at = '2026-11-12T16:00:00.000Z', handle_json = '{\"u\":1}' WHERE slot_id = ? AND platform = 'youtube'").run(SLOT);
  const { publishers, calls } = fakePublishers(async (i) => { i.saveHandle({ u: 2 }); return { postId: 'p', postUrl: 'u' }; });
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.deepEqual((calls[0] as any).handle, { u: 1 });
  const r = rows(db)[0];
  assert.deepEqual([r.state, r.attempt, r.handle_json], ['published', 2, '{"u":2}']);
});

test('fresh uploading row is left alone, stale one is recovered', async () => {
  const db = await readyDb();
  const fresh = new Date(AT_SLOT1.getTime() - 60000).toISOString();
  db.prepare("UPDATE publications SET state = 'uploading', attempt = 1, claimed_at = ?, handle_json = '{}' WHERE slot_id = ? AND platform = 'youtube'").run(fresh, SLOT);
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(rows(db)[0].state, 'uploading');
  assert.equal(calls.length, 3); // other platforms only
  await publishDue(db, config, publishers, min(31));
  assert.equal(rows(db)[0].state, 'published');
});

test('overdue pending publication of a never-ready slot is skipped', async () => {
  const db = await readyDb();
  db.prepare("UPDATE slots SET status = 'planned' WHERE id = ?").run(SLOT);
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, min(361));
  assert.equal(rows(db)[0].state, 'skipped');
  assert.equal(rows(db)[0].error, 'too late');
  assert.equal(calls.length, 0);
});

test('failed slot: publications skipped, one alert', async () => {
  const db = await readyDb();
  db.prepare("UPDATE slots SET status = 'failed' WHERE id = ?").run(SLOT);
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(rows(db, `SELECT * FROM publications WHERE slot_id = '${SLOT}' AND state = 'skipped' AND error = 'slot failed'`).length, 4);
  assert.equal(rows(db, `SELECT * FROM events WHERE key = '${SLOT}'`).length, 1);
  assert.equal(calls.length, 0); // slot 2 is not yet due; slot 1 was never called
});

for (const [name, tier, tier0, expected] of [['t0, tier0 on', 't0', true, true], ['t0, tier0 off', 't0', false, false], ['t1', 't1', false, true]] as const) {
  test(`aiDisclosure: ${name}`, async () => {
    const db = await readyDb();
    db.prepare('UPDATE slots SET tier = ?').run(tier);
    const cfg = { ...config, disclosure: { tier0 } };
    const { publishers, calls } = fakePublishers();
    await publishDue(db, cfg, publishers, AT_SLOT1);
    assert.equal((calls[0] as any).aiDisclosure, expected);
    assert.equal((calls[0] as any).visibility, 'private');
  });
}

const OLD = '2026-11-12T16:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const stale = (db: Awaited<ReturnType<typeof readyDb>>, platform: string, handle: string | null, attempt = 1) =>
  db.prepare("UPDATE publications SET state = 'uploading', claimed_at = ?, attempt = ?, handle_json = ?, next_attempt_at = ? WHERE slot_id = ? AND platform = ?").run(OLD, attempt, handle, FUTURE, SLOT, platform);
const row = (db: Awaited<ReturnType<typeof readyDb>>, platform: string) => rows(db, `SELECT * FROM publications WHERE slot_id = '${SLOT}' AND platform = '${platform}'`)[0];

test('reentrant publishDue: publisher runs once per row, row published once', async () => {
  const db = await readyDb();
  let nested = false;
  const { publishers, calls } = fakePublishers(async () => {
    if (!nested) { nested = true; await publishDue(db, config, publishers, AT_SLOT1); }
    return { postId: 'p', postUrl: null };
  });
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map((c: any) => c.idempotencyKey)).size, 4);
  assert.equal(rows(db, `SELECT * FROM publications WHERE slot_id = '${SLOT}' AND state = 'published'`).length, 4);
});

test('hung publisher: timeout makes the row retryable and the tick returns', async () => {
  const db = await readyDb();
  const cfg = { ...config, publish: { ...config.publish, timeoutMinutes: 0.0005 } }; // 30 ms
  const { publishers } = fakePublishers(() => new Promise(() => {}));
  await publishDue(db, cfg, publishers, AT_SLOT1);
  const r = row(db, 'youtube');
  assert.deepEqual([r.state, r.attempt, r.claimed_at], ['pending', 1, null]);
  assert.ok(r.next_attempt_at);
});

test('late finisher: saveHandle after re-claim throws ClaimLostError and changes nothing', async () => {
  const db = await readyDb();
  let thrown: unknown;
  const { publishers } = fakePublishers(async (i) => {
    db.prepare("UPDATE publications SET claimed_at = 'other' WHERE slot_id = ? AND platform = 'facebook'").run(SLOT);
    try { i.saveHandle({ a: 1 }); } catch (e) { thrown = e; throw e; }
    return { postId: 'x', postUrl: null };
  });
  await publishDue(db, config, { facebook: publishers.facebook }, AT_SLOT1);
  assert.ok(thrown instanceof ClaimLostError);
  const r = row(db, 'facebook');
  assert.deepEqual([r.state, r.claimed_at, r.handle_json, r.post_id], ['uploading', 'other', null, null]);
});

test('late finisher: successful return after re-claim does not flip the row', async () => {
  const db = await readyDb();
  const { publishers } = fakePublishers(async () => {
    db.prepare("UPDATE publications SET claimed_at = 'other' WHERE slot_id = ? AND platform = 'facebook'").run(SLOT);
    return { postId: 'x', postUrl: null };
  });
  await publishDue(db, config, { facebook: publishers.facebook }, AT_SLOT1);
  assert.deepEqual([row(db, 'facebook').state, row(db, 'facebook').post_id], ['uploading', null]);
});

test('DRY_RUN never calls a publisher, even for stale uploading rows', async () => {
  const db = await readyDb();
  process.env.DRY_RUN = '1';
  stale(db, 'youtube', '{"h":1}');
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(calls.length, 0);
  assert.deepEqual([row(db, 'youtube').state, row(db, 'youtube').claimed_at], ['uploading', OLD]);
});

test('recovery: late with handle -> needs_attention', async () => {
  const db = await readyDb();
  stale(db, 'youtube', '{"h":1}');
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, min(361));
  assert.equal(row(db, 'youtube').state, 'needs_attention');
  assert.equal(calls.filter((c: any) => c.idempotencyKey.endsWith('youtube')).length, 0);
});

test('recovery: late without handle -> skipped', async () => {
  const db = await readyDb();
  stale(db, 'youtube', null);
  await publishDue(db, config, fakePublishers().publishers, min(361));
  assert.equal(row(db, 'youtube').state, 'skipped');
});

test('recovery: not late with handle -> publisher called with handle', async () => {
  const db = await readyDb();
  stale(db, 'youtube', '{"h":1}');
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  const c = calls.find((x: any) => x.idempotencyKey.endsWith('youtube')) as any;
  assert.deepEqual(c.handle, { h: 1 });
  assert.equal(row(db, 'youtube').state, 'published');
  assert.equal(row(db, 'youtube').attempt, 2);
});

test('recovery: not late without handle -> pending, even when the render is missing', async () => {
  const db = await readyDb();
  stale(db, 'youtube', null);
  db.prepare("DELETE FROM renders WHERE slot_id = ? AND platform = 'youtube'").run(SLOT);
  await publishDue(db, config, fakePublishers().publishers, AT_SLOT1);
  const r = row(db, 'youtube');
  assert.deepEqual([r.state, r.claimed_at, r.attempt], ['pending', null, 2]);
});

test('recovery: too many attempts -> needs_attention', async () => {
  const db = await readyDb();
  stale(db, 'youtube', null, config.publish.retryMinutes.length + 1);
  const { publishers, calls } = fakePublishers();
  await publishDue(db, config, publishers, AT_SLOT1);
  assert.equal(row(db, 'youtube').state, 'needs_attention');
  assert.equal(calls.filter((c: any) => c.idempotencyKey.endsWith('youtube')).length, 0);
});
