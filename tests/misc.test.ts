import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/index.ts';
import { migrate, schemaVersion } from '../src/db/index.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alert } from '../src/ops/alert.ts';
import { redact, scrub } from '../src/ops/log.ts';
import raw from '../config/pipeline.config.ts';
import { fresh } from './helpers.ts';

const mod = (f: (c: any) => void) => {
  const c = structuredClone(raw);
  f(c);
  return c;
};

test('default config is valid', () => assert.ok(parseConfig(raw)));

test('config validation failures', () => {
  assert.throws(() => parseConfig(mod((c) => (c.platforms.youtube.slots = ['25:00', '19:45']))), /HH:MM/);
  assert.throws(() => parseConfig(mod((c) => (c.publish.timeoutMinutes = 30))), /less than uploadTimeoutMinutes/);
  assert.throws(() => parseConfig(mod((c) => (c.platforms.tiktok.slots = ['12:15']))), /same number of slots/);
  assert.throws(() => parseConfig(mod((c) => (c.platforms.tiktok.handle = ''))), /tiktok\.handle/);
  assert.throws(() => parseConfig(mod((c) => (c.timezone = 'Nowhere/Land'))), /time zone/);
  assert.throws(() => parseConfig(mod((c) => (c.creative.mode = 'video'))), /creative\.mode/);
  assert.throws(() => parseConfig(mod((c) => (c.ugc.reuseAfterDays = 0))), /reuseAfterDays/);
  assert.throws(() => parseConfig(mod((c) => (c.ugc.captionPx = 40))), /captionPx/);
  assert.throws(() => parseConfig(mod((c) => (c.ugc.captionPx = 120))), /captionPx/);
  assert.throws(() => parseConfig(mod((c) => (c.brand.logo = ''))), /brand\.logo/);
  // a disabled platform may differ in slot count
  assert.ok(parseConfig(mod((c) => { c.platforms.tiktok.enabled = false; c.platforms.tiktok.slots = ['12:15']; })));
});

test('migrations apply once', () => {
  const db = fresh();
  const files = readdirSync(new URL('../src/db/migrations', import.meta.url)).filter((f) => f.endsWith('.sql')).length;
  assert.equal(schemaVersion(db), files);
  migrate(db);
  assert.equal(schemaVersion(db), files);
  assert.equal(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name IN ('slots','kv','publications')").get()?.c, 3);
});

test('alert de-duplicates within 6 hours', async () => {
  const db = fresh();
  const t = new Date('2026-11-12T00:00:00Z');
  const n = () => db.prepare('SELECT count(*) c FROM events').get()?.c;
  await alert(db, 'k', 'a', 'm', t);
  await alert(db, 'k', 'a', 'm', new Date(t.getTime() + 5 * 3600e3));
  assert.equal(n(), 1);
  await alert(db, 'k', 'b', 'm', t);
  assert.equal(n(), 2);
  await alert(db, 'k', 'a', 'm', new Date(t.getTime() + 7 * 3600e3));
  assert.equal(n(), 3);
});

test('redact hides secret-like keys, recursively', () => {
  assert.deepEqual(redact({ a: 1, apiKey: 'x', nested: { Authorization: 'y', list: [{ password: 'z', ok: 2 }] }, client_secret: 's', accessToken: 't' }),
    { a: 1, apiKey: '[redacted]', nested: { Authorization: '[redacted]', list: [{ password: '[redacted]', ok: 2 }] }, client_secret: '[redacted]', accessToken: '[redacted]' });
});

test('config module does not load .env (tests never read a developer .env)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envtest-'));
  writeFileSync(join(dir, '.env'), 'DRY_RUN=1\nZZ_PROBE=loaded\n');
  const mod = new URL('../src/config/index.ts', import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import('${mod}').then(async m => { await m.loadConfig(); console.log(String(process.env.ZZ_PROBE), String(process.env.DRY_RUN)); })`], { cwd: dir, env: { PATH: process.env.PATH } }).toString().trim();
  assert.equal(out, 'undefined undefined');
});

async function withFetch(statuses: (number | 'throw')[], f: (calls: string[]) => Promise<void>) {
  const orig = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const s = statuses.shift()!;
    if (s === 'throw') throw new Error(`network down ${url}`);
    return { ok: s < 400, status: s } as Response;
  }) as typeof fetch;
  try { await f(calls); } finally { globalThis.fetch = orig; }
}

test('alert: failed send is recorded but not de-duplicated; delivered send is', async () => {
  const db = fresh();
  process.env.ALERT_DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/123/abcSECRETtoken99';
  const lines: string[] = [];
  const origWrite = process.stderr.write;
  process.stderr.write = ((s: string) => { lines.push(String(s)); return true; }) as typeof process.stderr.write;
  const t = new Date('2026-11-12T00:00:00Z');
  try {
    await withFetch([500, 'throw', 200], async (calls) => {
      await alert(db, 'k', 'a', 'm', t);
      await alert(db, 'k', 'a', 'm', t); // previous undelivered: sent again
      await alert(db, 'k', 'a', 'm', t); // delivered now
      await alert(db, 'k', 'a', 'm', t); // deduplicated
      assert.equal(calls.length, 3);
    });
  } finally { process.stderr.write = origWrite; delete process.env.ALERT_DISCORD_WEBHOOK; }
  assert.deepEqual(db.prepare('SELECT delivered FROM events ORDER BY id').all().map((r) => r.delivered), [0, 0, 1]);
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('').match(/abcSECRETtoken99|discord\.com\/api/));
});

test('scrub: env secret values, Bearer tokens, bot tokens, webhook URLs', () => {
  process.env.MY_API_KEY = 'supersecretvalue123';
  try {
    const out = scrub('fail supersecretvalue123 Authorization: Bearer abc.DEF-123 ?access_token=zzz999&x=1 /bot123456:AAH-xyz_9/send https://discord.com/api/webhooks/1/tok');
    assert.ok(!/supersecretvalue123|abc\.DEF|zzz999|AAH-xyz|webhooks\/1/.test(out), out);
    assert.deepEqual((redact({ msg: 'x', e: 'Bearer tok123' }) as any).e, 'Bearer [redacted]');
  } finally { delete process.env.MY_API_KEY; }
});

test('scrub: refresh tokens, JSON token fields, JWTs and Shopify tokens', () => {
  const jwt = 'eyJhbGciOi.eyJzdWIiOiIx.sig_-9';
  const out = scrub(`refresh_token=rrr111&x=1 {"access_token":"aaa222","refresh_token": "bbb333"} ${jwt} shpat_0123abcDEF shpca_9z`);
  assert.ok(!/rrr111|aaa222|bbb333|eyJ|shpat_|shpca_/.test(out), out);
  assert.ok(out.includes('x=1'));
});

// Runs from an empty directory (so no developer .env is loaded) with a minimal environment.
const CLI = join(import.meta.dirname, '../src/cli.ts');
const cli = (args: string[], dry: string) => {
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd: mkdtempSync(join(tmpdir(), 'cwd-')), env: { PATH: process.env.PATH, DRY_RUN: dry, DATA_DIR: mkdtempSync(join(tmpdir(), 'cli-')) }, stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (e: any) { return { status: e.status as number, stderr: String(e.stderr) }; }
};

test('run and publish refuse a clock override unless DRY_RUN is 1', () => {
  for (const args of [['run', '--once'], ['publish']]) {
    const r = cli(['--now', '2026-11-12T17:20:00Z', ...args], '0');
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /refused/);
  }
});

// `run --once` would start the Remotion producer, so the accepted case uses `publish`, which goes through the same check.
test('with DRY_RUN=1 a clock override is accepted', () => {
  const r = cli(['--now', '2026-11-12T17:20:00Z', 'publish'], '1');
  assert.deepEqual([r.status, r.stderr], [0, '']);
});
