import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SECRET = 'S3CR3T-restic-password';
const READY = '2026-11-13T08:30:00Z';

// A temp data dir, status dir and a fake `restic` that records its arguments. FAIL_ON names the
// subcommand that exits 7; CHECK_RC is the exit code of `check`.
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-'));
  const data = path.join(dir, 'data'), status = path.join(dir, 'status'), bin = path.join(dir, 'bin');
  for (const d of [path.join(data, 'backup'), status, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(data, 'backup', 'pipeline.db'), 'x');
  writeFileSync(path.join(bin, 'restic'), `#!/bin/sh
echo "$@" >> ${dir}/calls
if [ "$1" = backup ]; then for a; do case "$a" in /*) [ -e "$a" ] || exit 3;; esac; done; fi
[ "$1" = "$FAIL_ON" ] && exit 7
exit 0
`, { mode: 0o755 });
  const ready = (v: string) => writeFileSync(path.join(data, 'backup', 'ready'), v);
  const calls = () => (existsSync(path.join(dir, 'calls')) ? readFileSync(path.join(dir, 'calls'), 'utf8') : '');
  const has = (f: string) => existsSync(path.join(status, f));
  // Runs the script until `until()` holds (or 6 s), returns everything it printed.
  async function run(until: () => boolean, env: Record<string, string> = {}, ms = 6000) {
    let out = '';
    const c = spawn('sh', [path.resolve('infra/backup.sh')], {
      env: { PATH: `${bin}:${process.env.PATH}`, RESTIC_REPOSITORY: 'x', RESTIC_PASSWORD: SECRET, BACKUP_DATA_DIR: data, BACKUP_LASTOK_DIR: status, BACKUP_INTERVAL_SECONDS: '600', ...env },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < ms / 50 && !until(); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    process.kill(-c.pid!); // the whole group: a pending `sleep` would hold the pipes open
    return out;
  }
  return { dir, data, status, ready, calls, has, run };
}

test('backup.sh leaves data/clips out of the restic call while the folder does not exist', async () => {
  const t = setup();
  t.ready(READY);
  const lastOk = () => (t.has('last-ok') ? readFileSync(path.join(t.status, 'last-ok'), 'utf8').trim() : '');
  await t.run(() => lastOk() === READY);
  assert.equal(lastOk(), READY);
  assert.doesNotMatch(t.calls(), /clips|assets|brand/);
  for (const d of ['clips', 'assets', 'brand']) mkdirSync(path.join(t.data, d));
  t.ready('2026-11-14T08:30:00Z');
  await t.run(() => lastOk() === '2026-11-14T08:30:00Z');
  assert.match(t.calls(), /backup.*pipeline\.db .*clips .*assets .*brand/);
  assert.match(t.calls(), /-o s3\.connections=2/);
  assert.match(t.calls(), /forget .*--retry-lock 1h/);
});

test('backup.sh refuses a symlinked ready marker and one with other characters, and leaks nothing', async () => {
  const t = setup();
  const envFile = path.join(t.dir, 'environ');
  writeFileSync(envFile, `RESTIC_PASSWORD=${SECRET}\n`);
  const marker = path.join(t.data, 'backup', 'ready');
  symlinkSync(envFile, marker);
  const out1 = await t.run(() => false, {}, 1000);
  const t2 = setup();
  t2.ready(`RESTIC_PASSWORD=${SECRET}`);
  const out2 = await t2.run(() => false, {}, 1000);
  for (const [tt, out] of [[t, out1], [t2, out2]] as const) {
    assert.equal(tt.has('last-ok'), false);
    assert.match(out, /ready marker invalid/);
    assert.equal(tt.calls().includes('backup'), false);
    assert.equal(out.includes(SECRET), false);
  }
});

test('backup.sh rejects a marker longer than 40 bytes', async () => {
  const t = setup();
  t.ready('1'.repeat(41));
  const out = await t.run(() => false, {}, 1000);
  assert.match(out, /ready marker invalid/);
  assert.equal(t.has('last-ok'), false);
});

test('a failed backup doubles the sleep up to the cap and logs the exit code, not the output', async () => {
  const t = setup();
  t.ready(READY);
  const out = await t.run(() => false, { FAIL_ON: 'backup', BACKUP_INTERVAL_SECONDS: '1', BACKUP_MAX_SLEEP_SECONDS: '4' });
  assert.match(out, /restic backup rc=7/);
  const waits = [...out.matchAll(/retry in (\d+)s/g)].map((m) => Number(m[1]));
  assert.deepEqual(waits.slice(0, 3), [2, 4, 4]);
  assert.equal(t.has('last-ok'), false);
});

test('last-ok is written before forget, and a failed forget only logs', async () => {
  const t = setup();
  t.ready(READY);
  const out = await t.run(() => t.calls().includes('forget'), { FAIL_ON: 'forget', BACKUP_INTERVAL_SECONDS: '1' });
  assert.equal(t.has('last-ok'), true);
  assert.match(out, /forget failed: restic forget rc=7/);
  assert.doesNotMatch(out, /retry in/);
});

test('a failed check writes check-failed and last-check, a later good check removes check-failed', async () => {
  const t = setup();
  t.ready(READY);
  await t.run(() => t.has('check-failed'), { FAIL_ON: 'check', BACKUP_CHECK_EVERY_SECONDS: '0' });
  assert.equal(t.has('last-check'), true);
  assert.match(readFileSync(path.join(t.status, 'check-failed'), 'utf8'), /^\d{4}-\d\d-\d\dT[\d:]+Z\n$/);
  await t.run(() => !t.has('check-failed'), { BACKUP_CHECK_EVERY_SECONDS: '0' });
  assert.equal(t.has('check-failed'), false);
});
