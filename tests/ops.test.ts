import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, fresh } from './helpers.ts';
import { kvGet } from '../src/db/index.ts';
import { backupStatus, buildSummary, summaryDaily } from '../src/ops/summary.ts';
import { scrub } from '../src/ops/log.ts';
import { afterRestore, snapshotDaily } from '../src/ops/snapshot.ts';
import { checkDisk, housekeeping, housekeepingDaily, safeRemove } from '../src/ops/housekeeping.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ['ALERT_DISCORD_WEBHOOK', 'HEALTHCHECK_DAILY_URL', 'BACKUP_STATUS_DIR', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID']) delete process.env[k];
});

// 09:00 Toronto on 2026-11-13; yesterday is 2026-11-12.
const AT = new Date('2026-11-13T14:00:00Z');
const events = (db: ReturnType<typeof fresh>, kind: string) => db.prepare('SELECT delivered, ts FROM events WHERE kind = ? ORDER BY id').all(kind) as { delivered: number; ts: string }[];

function seed(db: ReturnType<typeof fresh>) {
  const ts = '2026-11-12T00:00:00Z';
  const slot = (id: string, date: string, idx: number, status: string, master: string | null = null, updated = ts) =>
    db.prepare('INSERT INTO slots (id, local_date, idx, status, master_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, date, idx, status, master, ts, updated);
  slot('2026-11-12#1', '2026-11-12', 1, 'done');
  slot('2026-11-13#1', '2026-11-13', 1, 'ready', JSON.stringify({ reusedFrom: '2026-11-01#1' }));
  slot('2026-11-13#2', '2026-11-13', 2, 'failed');
  db.prepare("INSERT INTO publications (slot_id, platform, scheduled_at, state, post_url) VALUES ('2026-11-12#1','youtube','x','published','https://y.example/1')").run();
  db.prepare("INSERT INTO publications (slot_id, platform, scheduled_at, state) VALUES ('2026-11-12#1','tiktok','x','needs_attention')").run();
}

test('summary lists yesterday, today, spend, attention, backup', () => {
  const db = fresh();
  seed(db);
  db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES ('s','t2','h','m','succeeded',0.57,'2026-11-05T00:00:00Z','2026-11-05T00:00:00Z')").run();
  db.prepare("INSERT INTO events (ts, kind, key, message, delivered) VALUES (?, 'x', 'k', 'm', 0)").run('2026-11-13T00:00:00Z');
  const t = buildSummary(db, config, AT);
  assert.match(t, /#1 youtube: published https:\/\/y\.example\/1/);
  assert.match(t, /#1 ready, reused from 2026-11-01#1/);
  assert.match(t, /#2 failed/);
  assert.match(t, /t2 \$0\.57 of \$52/);
  assert.match(t, /Needs attention: 1/);
  assert.match(t, /Undelivered alerts, last 24h: 1/);
  assert.match(t, /Backup: not configured/);
});

test('summary is cut to 1900 characters', () => {
  const db = fresh();
  for (let i = 1; i <= 60; i++) {
    db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at) VALUES (?, '2026-11-12', ?, 'done', 'a', 'a')").run(`2026-11-12#${i}`, i);
    db.prepare("INSERT INTO publications (slot_id, platform, scheduled_at, state, post_url) VALUES (?, 'youtube', 'x', 'published', ?)").run(`2026-11-12#${i}`, 'https://example.com/' + 'a'.repeat(60));
  }
  const t = buildSummary(db, config, AT);
  assert.equal(t.length, 1900);
  assert.ok(t.endsWith('...'));
});

test('summary: before summaryAt nothing, one per day, 15-minute retry, ping only after delivery', async () => {
  const db = fresh();
  process.env.ALERT_DISCORD_WEBHOOK = 'https://discord.example/hook';
  process.env.HEALTHCHECK_DAILY_URL = 'https://hc.example/daily';
  const calls: string[] = [];
  let hookOk = false;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { ok: String(url).includes('hc.example') || hookOk, status: 200 } as Response;
  }) as typeof fetch;

  await summaryDaily(db, config, new Date('2026-11-13T12:00:00Z')); // 07:00 local
  assert.equal(calls.length, 0);

  await summaryDaily(db, config, AT); // send fails
  assert.deepEqual(events(db, 'daily_summary').map((e) => e.delivered), [0]);
  assert.deepEqual(calls, ['https://discord.example/hook']); // no ping

  await summaryDaily(db, config, new Date(AT.getTime() + 10 * 60000)); // too soon
  assert.equal(events(db, 'daily_summary').length, 1);

  hookOk = true;
  await summaryDaily(db, config, new Date(AT.getTime() + 16 * 60000));
  assert.deepEqual(events(db, 'daily_summary').map((e) => e.delivered), [0, 1]);
  assert.equal(calls.at(-1), 'https://hc.example/daily');

  const n = calls.length;
  await summaryDaily(db, config, new Date(AT.getTime() + 60 * 60000)); // already delivered
  assert.equal(calls.length, n);
});

test('snapshot writes a readable database and the ready marker, once a day', async () => {
  const db = fresh();
  seed(db);
  const dir = path.join(process.env.DATA_DIR!, 'backup');
  await snapshotDaily(db, config, new Date('2026-11-13T07:00:00Z')); // 02:00 local, too early
  assert.equal(existsSync(dir), false);

  const at = new Date('2026-11-13T09:00:00Z'); // 04:00 local
  await snapshotDaily(db, config, at);
  const copy = new DatabaseSync(path.join(dir, 'pipeline.db'), { readOnly: true });
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM slots').get() as { n: number }).n, 3);
  copy.close();
  assert.equal(readFileSync(path.join(dir, 'ready'), 'utf8'), at.toISOString());
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(dir, 'ready')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(dir, 'pipeline.db')).mode & 0o777, 0o600);
  assert.equal(existsSync(path.join(dir, 'pipeline.db.tmp')), false);
  assert.equal(kvGet(db, 'snapshot_at'), '2026-11-13');

  await snapshotDaily(db, config, new Date(at.getTime() + 3600000));
  assert.equal(readFileSync(path.join(dir, 'ready'), 'utf8'), at.toISOString()); // not rewritten
});

test('snapshot failure alerts snapshot_failed and does not throw', async () => {
  const db = fresh();
  mkdirSync(process.env.DATA_DIR!, { recursive: true });
  writeFileSync(path.join(process.env.DATA_DIR!, 'backup'), 'a file where the folder should be');
  await snapshotDaily(db, config, new Date('2026-11-13T09:00:00Z'));
  assert.equal(events(db, 'snapshot_failed').length, 1);
  assert.equal(kvGet(db, 'snapshot_at'), undefined);
});

// Builds a tree and returns helpers; every file is `old` unless told otherwise.
function tree() {
  const db = fresh();
  const out = path.resolve(process.env.OUT_DIR!);
  const data = path.resolve(process.env.DATA_DIR!);
  const old = new Date('2026-10-01T00:00:00Z');
  const put = (f: string, mtime = old) => {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, 'x');
    utimesSync(f, mtime, mtime);
  };
  const slot = (id: string, status: string, updated = '2026-10-01T00:00:00Z', master: object | null = null) => {
    const date = id.slice(0, 10);
    db.prepare('INSERT INTO slots (id, local_date, idx, status, master_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, date, +id.split('#')[1], status, master && JSON.stringify(master), updated, updated);
    return path.join(out, date, id.replace('#', '-'));
  };
  const pub = (id: string, platform: string, state: string) => db.prepare('INSERT INTO publications (slot_id, platform, scheduled_at, state) VALUES (?,?,?,?)').run(id, platform, 'x', state);
  return { db, out, data, put, slot, pub };
}
const NOW = new Date('2026-11-13T09:00:00Z');

test('housekeeping deletes what it should and keeps the rest', () => {
  const { db, out, data, put, slot, pub } = tree();
  const done = slot('2026-10-01#1', 'done', undefined, { clipFile: 'clips/keep.mp4' });
  put(path.join(done, 'attempt-1', 'work', 'a.mp4'));
  put(path.join(done, 'youtube.mp4'));
  put(path.join(done, 'tiktok.mp4'));
  pub('2026-10-01#1', 'youtube', 'published');
  pub('2026-10-01#1', 'tiktok', 'skipped');

  const open = slot('2026-10-01#2', 'done');
  put(path.join(open, 'youtube.mp4'));
  put(path.join(open, 'tiktok.mp4'));
  pub('2026-10-01#2', 'youtube', 'published');
  pub('2026-10-01#2', 'tiktok', 'needs_attention'); // keeps both renders

  const recent = slot('2026-11-12#1', 'done');
  put(path.join(recent, 'youtube.mp4'), NOW);
  pub('2026-11-12#1', 'youtube', 'published'); // under 7 days old

  const producing = slot('2026-11-13#1', 'producing', NOW.toISOString());
  put(path.join(producing, `attempt-${NOW.getTime() - 10 * 60000}`, 'x.mp4'), NOW); // inside the produce timeout
  put(path.join(producing, `attempt-${NOW.getTime() - 100 * 60000}`, 'x.mp4'), NOW); // older than the timeout
  const failedNew = slot('2026-11-11#1', 'failed', '2026-11-10T00:00:00Z');
  put(path.join(failedNew, 'attempt-1', 'x.mp4'));
  const failedOld = slot('2026-10-02#1', 'failed', '2026-10-02T00:00:00Z');
  put(path.join(failedOld, 'attempt-1', 'x.mp4'));

  put(path.join(data, 'clips', 'keep.mp4')); // ready/done slot references it
  put(path.join(data, 'clips', 'abs.mp4'));
  slot('2026-10-03#1', 'ready', undefined, { clipFile: path.join(data, 'clips', 'abs.mp4') }); // old absolute value
  put(path.join(data, 'clips', 'paid.mp4'));
  db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, file_path, created_at, updated_at) VALUES ('2026-11-13#1','t2','h','m','succeeded',1,'clips/paid.mp4','a','a')").run();
  put(path.join(data, 'clips', 'unpaid.mp4'));
  db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, file_path, created_at, updated_at) VALUES ('2026-10-01#1','t2','h','m','succeeded',1,'clips/unpaid.mp4','a','a')").run(); // slot is done, no master holds it
  put(path.join(data, 'clips', 'orphan.mp4'));
  put(path.join(data, 'clips', 'fresh.mp4'), NOW);
  put(path.join(data, 'assets', 'logo.png'));
  put(path.join(data, 'backup', 'pipeline.db'));
  put(path.join(out, 'samples', 's.mp4'));

  const n = housekeeping(db, config, NOW);
  const gone = (f: string) => assert.equal(existsSync(f), false, f);
  const kept = (f: string) => assert.equal(existsSync(f), true, f);
  gone(path.join(done, 'attempt-1'));
  gone(path.join(done, 'youtube.mp4'));
  gone(path.join(done, 'tiktok.mp4'));
  kept(path.join(open, 'youtube.mp4'));
  kept(path.join(open, 'tiktok.mp4'));
  kept(path.join(recent, 'youtube.mp4'));
  kept(path.join(producing, `attempt-${NOW.getTime() - 10 * 60000}`, 'x.mp4'));
  gone(path.join(producing, `attempt-${NOW.getTime() - 100 * 60000}`));
  kept(path.join(failedNew, 'attempt-1', 'x.mp4'));
  gone(path.join(failedOld, 'attempt-1'));
  kept(path.join(data, 'clips', 'keep.mp4'));
  kept(path.join(data, 'clips', 'abs.mp4'));
  kept(path.join(data, 'clips', 'paid.mp4'));
  gone(path.join(data, 'clips', 'orphan.mp4'));
  gone(path.join(data, 'clips', 'unpaid.mp4'));
  kept(path.join(data, 'clips', 'fresh.mp4'));
  kept(path.join(data, 'assets', 'logo.png'));
  kept(path.join(data, 'backup', 'pipeline.db'));
  kept(path.join(out, 'samples', 's.mp4'));
  assert.deepEqual(n, { attempts: 3, renders: 2, clips: 2, errors: [] });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM slots').get() as { n: number }).n, 7); // rows stay
});

test('safeRemove refuses outside paths and does not follow symlinks', () => {
  const { out, put } = tree();
  const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
  put(path.join(outside, 'precious.txt'));
  mkdirSync(out, { recursive: true });
  assert.throws(() => safeRemove(path.join(outside, 'precious.txt'), out), /outside/);
  assert.throws(() => safeRemove(path.join(out, '..', 'x'), out), /outside/);
  symlinkSync(outside, path.join(out, 'link'));
  assert.equal(safeRemove(path.join(out, 'link'), out), false); // the link itself is skipped
  assert.throws(() => safeRemove(path.join(out, 'link', 'precious.txt'), out), /resolves outside/);
  assert.equal(existsSync(path.join(outside, 'precious.txt')), true);
});

test('housekeeping runs once a day, after snapshotAt', async () => {
  const { db } = tree();
  await housekeepingDaily(db, config, new Date('2026-11-13T07:00:00Z')); // 02:00 local
  assert.equal(kvGet(db, 'housekeeping_at'), undefined);
  await housekeepingDaily(db, config, NOW);
  assert.equal(kvGet(db, 'housekeeping_at'), '2026-11-13');
});

test('disk alert above the threshold, none below', async () => {
  const db = fresh();
  const stat = (pct: number) => (() => ({ blocks: 100, bavail: 100 - pct })) as never;
  await checkDisk(db, config, NOW, stat(70));
  assert.equal(events(db, 'disk_full').length, 0);
  await checkDisk(db, config, NOW, stat(85));
  const e = db.prepare("SELECT key, message FROM events WHERE kind = 'disk_full'").all() as { key: string; message: string }[];
  assert.equal(e.length, 1);
  assert.equal(e[0].key, '2026-11-13');
  assert.match(e[0].message, /DATA_DIR 85% used/);
});

test('backup age in the summary', () => {
  const db = fresh();
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-'));
  process.env.BACKUP_STATUS_DIR = dir;
  assert.match(buildSummary(db, config, AT), /Backup: no last-ok yet/);
  writeFileSync(path.join(dir, 'last-ok'), new Date(AT.getTime() - 5 * 3600000).toISOString());
  assert.match(buildSummary(db, config, AT), /Backup: last ok 5\.0h ago/);
});

test('housekeeping: a bad entry does not stop the rest, alerts housekeeping_failed, and the disk check still runs', async () => {
  const { db, out, data, put, slot } = tree();
  const a = slot('2026-10-01#1', 'done');
  const b = slot('2026-10-02#1', 'done');
  put(path.join(a, 'attempt-1', 'x.mp4'));
  put(path.join(b, 'attempt-1', 'x.mp4'));
  put(path.join(data, 'clips', 'old.mp4'));
  // A symlinked slot folder resolves outside the root, so removing inside it throws.
  const outside = mkdtempSync(path.join(tmpdir(), 'outside-'));
  mkdirSync(path.join(outside, 'attempt-1'));
  rmSync(a, { recursive: true });
  symlinkSync(outside, a);
  const disk = (() => ({ blocks: 100, bavail: 5 })) as never;
  await housekeepingDaily(db, config, NOW, disk);
  assert.equal(existsSync(path.join(outside, 'attempt-1')), true);
  assert.equal(existsSync(path.join(b, 'attempt-1')), false); // later entries still done
  assert.equal(existsSync(path.join(data, 'clips', 'old.mp4')), false);
  assert.equal(events(db, 'housekeeping_failed').length, 1);
  assert.equal(events(db, 'disk_full').length, 1);
  assert.equal(kvGet(db, 'housekeeping_at'), '2026-11-13');
  void out;
});

test('backup status: STALE when last-ok lags the snapshot or is over 26 hours old; check-failed is reported', () => {
  fresh();
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-'));
  process.env.BACKUP_STATUS_DIR = dir;
  const ready = path.join(process.env.DATA_DIR!, 'backup', 'ready');
  mkdirSync(path.dirname(ready), { recursive: true });
  const ago = (h: number) => new Date(AT.getTime() - h * 3600000).toISOString();
  writeFileSync(path.join(dir, 'last-ok'), ago(5));
  writeFileSync(ready, ago(5));
  assert.doesNotMatch(backupStatus(AT), /STALE/); // equal
  writeFileSync(ready, ago(0.5));
  assert.doesNotMatch(backupStatus(AT), /STALE/); // newer snapshot, under an hour
  writeFileSync(ready, ago(2));
  assert.match(backupStatus(AT), /STALE/); // snapshot over an hour old, never backed up
  writeFileSync(ready, ago(30));
  writeFileSync(path.join(dir, 'last-ok'), ago(30));
  assert.match(backupStatus(AT), /last ok 30\.0h ago \(STALE\)/);
  writeFileSync(path.join(dir, 'last-ok'), ago(5));
  writeFileSync(ready, ago(5));
  writeFileSync(path.join(dir, 'check-failed'), '2026-11-13T03:00:00.000Z');
  assert.match(backupStatus(AT), /restic check FAILED 2026-11-13T03:00:00\.000Z/);
});

test('scrub removes the whole query string of a signed URL, and leaves plain ones', () => {
  const u = 'https://r2.example/b/k.mp4?X-Amz-Algorithm=AWS4&X-Amz-Credential=AKIA%2F2026&X-Amz-Signature=abc123';
  assert.equal(scrub(`failed ${u} done`), 'failed https://r2.example/b/k.mp4?<redacted> done');
  assert.equal(scrub('https://x.example/f?token=zzz&a=1'), 'https://x.example/f?<redacted>');
  assert.equal(scrub('https://x.example/f?Signature=zzz'), 'https://x.example/f?<redacted>');
  assert.equal(scrub('https://x.example/f?page=2'), 'https://x.example/f?page=2');
});

test('summary reports last month on the 1st (local) only', () => {
  const db = fresh();
  db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES ('s','t2','h','m','succeeded',3.5,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z')").run();
  db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd) VALUES ('2026-10-21T00:00:00Z','p','m',0,0,0,0,1.25)").run();
  assert.doesNotMatch(buildSummary(db, config, AT), /last month/);
  const first = buildSummary(db, config, new Date('2026-11-01T14:00:00Z'));
  assert.match(first, /Spend last month: model calls \$1\.25, t2 \$3\.50/);
  assert.match(first, /Spend this month: model calls \$0\.00 of/);
});

test('dead-man ping: needs a channel, recorded only on an ok response, retried every 15 minutes', async () => {
  const db = fresh();
  process.env.HEALTHCHECK_DAILY_URL = 'https://hc.example/daily';
  const calls: string[] = [];
  let hcOk = false;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { ok: String(url).includes('hc.example') ? hcOk : true, status: hcOk ? 200 : 500 } as Response;
  }) as typeof fetch;

  await summaryDaily(db, config, AT); // no alert channel: summary counts as delivered, no ping
  assert.deepEqual(calls, []);
  assert.equal(kvGet(db, 'summary_ping'), undefined);

  process.env.ALERT_DISCORD_WEBHOOK = 'https://discord.example/hook';
  db.prepare("UPDATE events SET delivered = 0 WHERE kind = 'daily_summary'").run(); // pretend that one was undelivered
  const t1 = new Date(AT.getTime() + 20 * 60000);
  await summaryDaily(db, config, t1); // sends, ping answers 500
  assert.deepEqual(calls.slice(-2), ['https://discord.example/hook', 'https://hc.example/daily']);
  assert.equal(kvGet(db, 'summary_ping'), undefined);

  const n = calls.length;
  await summaryDaily(db, config, new Date(t1.getTime() + 5 * 60000)); // too soon
  assert.equal(calls.length, n);

  hcOk = true;
  await summaryDaily(db, config, new Date(t1.getTime() + 16 * 60000)); // retries the ping only
  assert.equal(calls.length, n + 1);
  assert.equal(kvGet(db, 'summary_ping'), '2026-11-12');
  await summaryDaily(db, config, new Date(t1.getTime() + 60 * 60000));
  assert.equal(calls.length, n + 1);
});

test('after-restore holds back due pending and uploading publications and alerts once', async () => {
  const db = fresh();
  seed(db);
  const pub = (id: string, p: string, state: string, at: string) => db.prepare('INSERT INTO publications (slot_id, platform, scheduled_at, state) VALUES (?,?,?,?)').run(id, p, at, state);
  pub('2026-11-13#1', 'youtube', 'pending', '2026-11-13T12:00:00.000Z');
  pub('2026-11-13#1', 'tiktok', 'uploading', '2026-11-13T12:00:00.000Z');
  pub('2026-11-13#1', 'facebook', 'pending', '2026-11-14T12:00:00.000Z'); // still in the future
  pub('2026-11-13#1', 'instagram', 'published', '2026-11-13T12:00:00.000Z');
  const n = await afterRestore(db, AT);
  assert.equal(n, 2);
  const rows = db.prepare("SELECT platform, state, error FROM publications WHERE slot_id = '2026-11-13#1' ORDER BY platform").all() as { platform: string; state: string; error: string | null }[];
  assert.deepEqual(rows.map((r) => r.state), ['pending', 'published', 'needs_attention', 'needs_attention']);
  assert.equal(rows[2].error, 'restored from backup: check the platform before posting again');
  assert.equal(events(db, 'restored').length, 1);
});

test('housekeeping: a held clip stays, a discarded or expired one goes after keepDays, orphan music files are swept', () => {
  const { db, data, put, slot } = tree();
  const hold = (id: string, status: string, h: string, clip: string) => {
    slot(id, status, undefined, { clipFile: `clips/${clip}.mp4` });
    db.prepare('UPDATE slots SET hold = ? WHERE id = ?').run(h, id);
    put(path.join(data, 'clips', `${clip}.mp4`));
  };
  hold('2026-10-01#101', 'ready', 'waiting', 'waits');
  hold('2026-10-02#101', 'done', 'approved', 'approved');
  hold('2026-10-03#101', 'done', 'discarded', 'discarded');
  hold('2026-10-04#101', 'done', 'expired', 'expired');
  const sha = 'a'.repeat(64);
  db.prepare("INSERT INTO music_tracks (sha256, name, file, seconds, lufs, selected, created_at) VALUES (?, 'n', ?, 30, -20, 1, 't')").run(sha, `music/${sha}.m4a`);
  put(path.join(data, 'music', `${sha}.m4a`));
  put(path.join(data, 'music', `${'b'.repeat(64)}.m4a`));
  put(path.join(data, 'music', '.incoming', 'upload.tmp'));
  put(path.join(data, 'music', 'x.part'));
  const n = housekeeping(db, config, NOW);
  const kept = (f: string) => assert.equal(existsSync(path.join(data, f)), true, f);
  const gone = (f: string) => assert.equal(existsSync(path.join(data, f)), false, f);
  kept('clips/waits.mp4');
  kept('clips/approved.mp4');
  gone('clips/discarded.mp4');
  gone('clips/expired.mp4');
  kept(`music/${sha}.m4a`);
  gone(`music/${'b'.repeat(64)}.m4a`);
  gone('music/.incoming/upload.tmp');
  gone('music/x.part');
  assert.deepEqual(n.errors, []);
});

test('summary: a manual slot waiting for approval is listed with its expiry', () => {
  const db = fresh();
  const ts = '2026-11-13T10:00:00Z';
  db.prepare("INSERT INTO slots (id, local_date, idx, status, kind, hold, held_at, created_at, updated_at) VALUES ('2026-11-13#101','2026-11-13',101,'ready','manual','waiting',?,?,?)").run(ts, ts, ts);
  const s = buildSummary(db, config, AT);
  assert.match(s, /#101 manual ready, waiting for approval/);
  assert.match(s, /Waiting for approval: 1 \(oldest expires 2026-11-14T10:00:00\.000Z\)/);
  db.prepare("UPDATE slots SET hold = 'approved'").run();
  assert.doesNotMatch(buildSummary(db, config, AT), /Waiting for approval/);
});
