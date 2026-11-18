import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { kvGet, kvSet, type Db } from '../src/db/index.ts';
import { startAdmin, setPassword } from '../src/admin/index.ts';
import { html, esc } from '../src/admin/html.ts';
import { foldDiff, lineDiff } from '../src/admin/diff.ts';
import { ABSOLUTE_MS, IDLE_MS, hashPassword, verifyPassword } from '../src/admin/auth.ts';
import { promptText } from '../src/llm/prompts.ts';
import { scryptSync } from 'node:crypto';
import { fresh, seedBrief } from './helpers.ts';

const PW = 'correct horse battery';
let db: Db;
let server: Server;
let port: number;
let clock = new Date('2026-11-12T17:20:00Z');
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

type R = { status: number; headers: Record<string, string | string[] | undefined>; text: string };
function req(method: string, path: string, o: { host?: string | null; origin?: string | null; cookie?: string; form?: URLSearchParams | Record<string, string>; body?: string; type?: string; headers?: Record<string, string> } = {}): Promise<R> {
  const body = o.body ?? (o.form ? new URLSearchParams(o.form).toString() : undefined);
  const headers: Record<string, string> = { ...o.headers };
  if (o.host !== null) headers.host = o.host ?? `127.0.0.1:${port}`;
  if (method === 'POST') {
    if (o.origin !== null) headers.origin = o.origin ?? `http://${headers.host}`;
    headers['content-type'] = o.type ?? 'application/x-www-form-urlencoded';
  }
  if (o.cookie) headers.cookie = o.cookie;
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const cookieOf = (r: R) => String(([] as string[]).concat(r.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];

// Fields of the form whose action matches, as the browser would submit them.
function formOf(text: string, action: string): URLSearchParams {
  const m = new RegExp(`<form[^>]*action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(text);
  assert.ok(m, `no form ${action}`);
  const un = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const p = new URLSearchParams();
  for (const i of m[1].matchAll(/<input([^>]*)>/g)) {
    const a = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(i[1])?.[1];
    const name = a('name');
    if (!name) continue;
    if (a('type') === 'checkbox') {
      if (/\schecked/.test(i[1])) p.set(name, un(a('value') ?? 'on'));
    } else p.set(name, un(a('value') ?? ''));
  }
  for (const s of m[1].matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) p.set(s[1], /<option value="([^"]*)" selected/.exec(s[2])?.[1] ?? /<option value="([^"]*)"/.exec(s[2])![1]);
  for (const t of m[1].matchAll(/<textarea[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) p.set(t[1], un(t[2]));
  return p;
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await req('POST', '/login', { form: { username: 'admin', password: PW } });
  assert.equal(r.status, 303, r.text);
  const cookie = cookieOf(r);
  const page = await req('GET', '/settings', { cookie });
  return { cookie, csrf: /name="csrf" value="([0-9a-f]+)"/.exec(page.text)![1] };
}

before(async () => {
  db = fresh();
  ({ server, port } = await startAdmin({ db, port: 0, host: '127.0.0.1', now: () => clock }));
  await setPassword({ db, now: () => clock, read: async () => PW });
});
after(() => {
  server.close();
  server.closeAllConnections();
});

test('a wrong Host is refused with 421 on GET and POST', async () => {
  assert.equal((await req('GET', '/login', { host: 'evil.example' })).status, 421);
  assert.equal((await req('GET', '/healthz', { host: 'evil.example:80' })).status, 421);
  assert.equal((await req('POST', '/login', { host: 'evil.example', form: { password: PW } })).status, 421);
  assert.equal((await req('GET', '/healthz', { host: `localhost:${port}` })).status, 200);
  assert.equal((await req('GET', '/healthz', { host: `[::1]:${port}` })).status, 200);
});

test('POST needs the same Origin, same-origin Sec-Fetch-Site and a form content type', async () => {
  const form = { username: 'admin', password: 'x' };
  assert.equal((await req('POST', '/login', { form, origin: null })).status, 403);
  assert.equal((await req('POST', '/login', { form, origin: 'http://evil.example' })).status, 403);
  assert.equal((await req('POST', '/login', { form, origin: `http://127.0.0.1:${port + 1}` })).status, 403);
  assert.equal((await req('POST', '/login', { form, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await req('POST', '/login', { body: '{}', type: 'application/json' })).status, 415);
});

test('https Origin with an allowed host logs in and the cookie is Secure; a plain http one is not', async () => {
  const form = { username: 'admin', password: PW };
  const host = `127.0.0.1:${port}`;
  const https = await req('POST', '/login', { form, origin: `https://${host}` });
  assert.equal(https.status, 303);
  assert.match(String(https.headers['set-cookie']), /; Secure/);
  const http = await req('POST', '/login', { form });
  assert.equal(http.status, 303);
  assert.doesNotMatch(String(http.headers['set-cookie']), /Secure/);
  assert.equal((await req('POST', '/login', { form, origin: 'null' })).status, 403);
  assert.equal((await req('POST', '/login', { form, origin: 'https://evil.example' })).status, 403);
  assert.equal((await req('POST', '/login', { form, origin: `https://127.0.0.1:${port + 1}` })).status, 403);
});

test('scrypt: new hashes use p=3, old p=1 hashes still verify, out-of-bounds parameters are refused', () => {
  const h = hashPassword(PW);
  assert.match(h, /^scrypt\$32768\$8\$3\$/);
  assert.ok(verifyPassword(h, PW) && !verifyPassword(h, PW + 'x'));
  const salt = Buffer.from('0123456789abcdef');
  const old = `scrypt$32768$8$1$${salt.toString('base64')}$${scryptSync(PW, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 * 2 }).toString('base64')}`;
  assert.ok(verifyPassword(old, PW));
  const [alg, , , , s, k] = h.split('$');
  for (const [n, r, p] of [[2 ** 18, 8, 3], [2 ** 14 + 1, 8, 3], [2 ** 13, 8, 3], [32768, 7, 3], [32768, 17, 3], [32768, 8, 0], [32768, 8, 5], [32768, 8, 1.5]]) {
    assert.equal(verifyPassword([alg, n, r, p, s, k].join('$'), PW), false, `${n} ${r} ${p}`);
  }
});

test('a body over the limit is refused with 413', async () => {
  const r = await req('POST', '/login', { body: 'password=' + 'a'.repeat(300_000) }).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
});

test('other methods and unknown paths; nothing is served from disk', async () => {
  assert.equal((await req('PUT', '/login')).status, 405);
  assert.equal((await req('GET', '/nope')).status, 404);
  assert.equal((await req('GET', '/..%2fpackage.json')).status, 404);
  assert.equal((await req('GET', '/package.json')).status, 404);
  assert.equal((await req('GET', '/healthz')).text, 'ok');
  const css = await req('GET', '/style.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers['content-type']), /text\/css/);
});

test('every response carries the security headers and no page has a script tag', async () => {
  const { cookie } = await login();
  // The settings page is the one other page with a script: its own /settings.js and nothing else (D-38).
  const s = await req('GET', '/settings', { cookie });
  assert.equal(s.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.deepEqual([...s.text.matchAll(/<script[^>]*>/gi)].map((m) => m[0]), ['<script src="/settings.js" defer>']);
  assert.ok(!/ style="|<style/i.test(s.text));
  // The town square (home) loads its own /town.js and may fetch this origin, like the Factory page (D-40).
  const t = await req('GET', '/overview', { cookie });
  assert.equal(t.headers['content-security-policy'], "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.deepEqual([...t.text.matchAll(/<script[^>]*>/gi)].map((m) => m[0]), ['<script src="/town.js" defer>']);
  assert.ok(!/ style="|<style/i.test(t.text));
  for (const path of ['/login', '/products', '/products/new', '/prompts', '/prompts/edit?key=ugc', '/prompts/history?key=ugc', '/prompts/view?key=claims', '/activity', '/history', '/posts', '/music', '/models', '/style.css', '/healthz', '/nope']) {
    const r = await req('GET', path, { cookie });
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", path);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'same-origin'); // no-referrer makes browsers send Origin: null
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.ok(!/<script/i.test(r.text), path);
    assert.ok(!/ style="|<style/i.test(r.text), path);
  }
  assert.equal((await req('GET', '/settings')).status, 303); // not signed in
});

test('login cookie flags; only the sha256 of the token is stored', async () => {
  const r = await req('POST', '/login', { form: { username: 'admin', password: PW } });
  const c = ([] as string[]).concat(r.headers['set-cookie'] as string[])[0];
  assert.match(c, /^aap_session=[A-Za-z0-9_-]{43}/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=43200/);
  const token = c.split(';')[0].split('=')[1];
  const rows = db.prepare('SELECT token_sha FROM admin_sessions').all() as { token_sha: string }[];
  assert.ok(rows.length && rows.every((x) => x.token_sha !== token && /^[0-9a-f]{64}$/.test(x.token_sha)));
});

test('the stored hash has the scrypt format', () => {
  assert.match(kvGet(db, 'admin_password')!, /^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
});

test('CSRF: a POST without or with the wrong token is refused', async () => {
  const { cookie, csrf } = await login();
  assert.equal((await req('POST', '/history/activate', { cookie, form: { id: '' } })).status, 403);
  assert.equal((await req('POST', '/history/activate', { cookie, form: { id: '', csrf: 'x'.repeat(csrf.length) } })).status, 403);
  assert.equal((await req('POST', '/history/activate', { cookie, form: { id: '', csrf } })).status, 303);
});

test('idle and absolute session expiry', async () => {
  const a = await login();
  advance(IDLE_MS - 1000);
  assert.equal((await req('GET', '/overview', { cookie: a.cookie })).status, 200); // touches seen_at
  advance(IDLE_MS - 1000);
  assert.equal((await req('GET', '/overview', { cookie: a.cookie })).status, 200);
  advance(IDLE_MS + 1000);
  assert.equal((await req('GET', '/overview', { cookie: a.cookie })).status, 303);

  const b = await login();
  // Active every 50 minutes, the session still ends at 12 hours.
  for (let t = 0; t < ABSOLUTE_MS - 50 * 60_000; t += 50 * 60_000) {
    advance(50 * 60_000);
    assert.equal((await req('GET', '/overview', { cookie: b.cookie })).status, 200);
  }
  advance(50 * 60_000);
  assert.equal((await req('GET', '/overview', { cookie: b.cookie })).status, 303);
});

test('logout ends the session', async () => {
  const { cookie, csrf } = await login();
  const r = await req('POST', '/logout', { cookie, form: { csrf } });
  assert.equal(r.status, 303);
  assert.match(String(r.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await req('GET', '/overview', { cookie })).status, 303);
});

test('five failures lock logins, the right password is refused meanwhile, and `admin password` clears the lock and the sessions', async () => {
  const live = await login();
  for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/login', { form: { password: 'wrong wrong wrong' } })).status, 401);
  const t0 = performance.now();
  const locked = await req('POST', '/login', { form: { password: PW } });
  const ms = performance.now() - t0;
  assert.equal(locked.status, 429);
  assert.ok(ms < 40, `scrypt ran while locked (${ms} ms)`); // one scrypt call takes far longer
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'admin_lockout'").get() as { n: number }).n, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'login.lockout'").get());
  advance(14 * 60_000);
  assert.equal((await req('POST', '/login', { form: { password: PW } })).status, 429);
  advance(2 * 60_000);
  assert.equal((await req('POST', '/login', { form: { password: PW } })).status, 303);

  // Lock again, then reset the password.
  for (let i = 0; i < 5; i++) await req('POST', '/login', { form: { password: 'wrong wrong wrong' } });
  assert.equal((await req('POST', '/login', { form: { password: PW } })).status, 429);
  const sessions = () => (db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get() as { n: number }).n;
  assert.ok(sessions() > 0);
  await setPassword({ db, now: () => clock, read: async () => PW });
  assert.equal(sessions(), 0);
  assert.equal((await req('GET', '/overview', { cookie: live.cookie })).status, 303);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE actor = 'cli' AND action = 'password.set'").get());
  assert.equal((await req('POST', '/login', { form: { password: PW } })).status, 303);
});

test('setPassword refuses a short password; stdin works when it is not a TTY', async () => {
  await assert.rejects(setPassword({ db, now: () => clock, read: async () => 'short' }), /at least 12/);
  const dir = process.env.DATA_DIR!;
  const r = spawnSync(process.execPath, ['-e', "import('./src/admin/index.ts').then((m) => m.setPassword({ now: () => new Date() })).catch((e) => { console.error(e.message); process.exit(1); })"], { input: 'a stdin password 1\n', env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('a stdin password 1') && !r.stderr.includes('a stdin password 1'));
  await setPassword({ db, now: () => clock, read: async () => PW }); // restore for the other tests
});

test('database text is escaped; a caption with <script> shows as text', async () => {
  const { cookie } = await login();
  const master = JSON.stringify({ mode: 'ugc', concept: { caption: '<script>alert(1)</script>' } });
  db.prepare("INSERT INTO slots (id, local_date, idx, status, master_json, created_at, updated_at, error) VALUES ('2026-11-12#1','2026-11-12',1,'failed',?,'t','t','<img src=x onerror=alert(1)>')").run(master);
  db.prepare("INSERT INTO publications (slot_id, platform, scheduled_at, state, post_url, error) VALUES ('2026-11-12#1','youtube','2026-11-12T17:00:00.000Z','needs_attention','javascript:alert(1)','<b>x</b>')").run();
  const r = await req('GET', '/activity', { cookie });
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!r.text.includes('<script'));
  assert.ok(!r.text.includes('<img src=x'));
  assert.ok(!r.text.includes('href="javascript:'));
  assert.ok(r.text.includes('needs attention'));
});

test('no page shows a token or the password hash, and the admin code never touches oauth_tokens', async () => {
  const { cookie } = await login();
  db.prepare("INSERT OR REPLACE INTO oauth_tokens (provider, client_id, access_token, refresh_token, expires_at, updated_at) VALUES ('higgsfield','MARKER_CLIENT','MARKER_ACCESS','MARKER_REFRESH','x','x')").run();
  process.env.BRIDGE_API_KEY = 'MARKER_ENV_BRIDGE_KEY';
  const [, , , , salt, key] = kvGet(db, 'admin_password')!.split('$');
  for (const path of ['/overview', '/settings', '/posts', '/music', '/models', '/prompts', '/prompts/edit?key=ugc', '/prompts/history?key=ugc', '/activity', '/history', '/login']) {
    const r = await req('GET', path, { cookie });
    for (const m of ['MARKER_', salt, key, 'scrypt$']) assert.ok(!r.text.includes(m), `${path} shows ${m}`);
  }
  delete process.env.BRIDGE_API_KEY;
  for (const f of readdirSync(join(import.meta.dirname, '../src/admin'))) assert.ok(!/oauth_tokens/.test(readFileSync(join(import.meta.dirname, '../src/admin', f), 'utf8')), f);
});

test('settings: switching the clip preset does not carry the old preset caps over as overrides', async () => {
  const { cookie } = await login();
  const form = formOf((await req('GET', '/settings', { cookie })).text, '/settings/preview');
  const other = Object.keys((await import('../config/pipeline.config.ts')).default.tiers.t2Presets).find((k) => k !== form.get('tiers.t2Preset'))!;
  form.set('tiers.t2Preset', other);
  const diff = await req('POST', '/settings/preview', { cookie, form });
  assert.equal(diff.status, 200, diff.text);
  assert.ok(diff.text.includes('tiers.t2Preset'));
  assert.ok(!diff.text.includes('tiers.t2.maxCredits') && !diff.text.includes('tiers.t2.keepCredits'), 'old caps carried over');
});

test('settings: unchanged form means no changes; a bad value is refused inline; a good one saves a version, pointer and audit together', async () => {
  const { cookie, csrf } = await login();
  const page = await req('GET', '/settings', { cookie });
  for (const stage of ['Schedule and timing', 'Platforms', 'Concept writing', 'Claim checks', 'Video generation', 'Frame check', 'Budget', 'Ops']) assert.ok(page.text.includes(`<legend>${stage}</legend>`), stage);
  assert.ok(page.text.includes('File default'));
  const form = formOf(page.text, '/settings/preview');
  const none = await req('POST', '/settings/preview', { cookie, form });
  assert.equal(none.status, 200);
  assert.ok(none.text.includes('No changes'));

  const bad = new URLSearchParams(form);
  bad.set('tiers.capsUsd.t2', '9999');
  const refused = await req('POST', '/settings/preview', { cookie, form: bad });
  assert.equal(refused.status, 422);
  assert.match(refused.text, /class="err"[^>]*>tiers\.capsUsd\.t2: 9999 is above the limit/);
  const nan = new URLSearchParams(form);
  nan.set('ugc.captionPx', 'big');
  const refused2 = await req('POST', '/settings/preview', { cookie, form: nan });
  assert.equal(refused2.status, 422);
  assert.match(refused2.text, /must be a number/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM config_versions').get()!.n, 0);

  const good = new URLSearchParams(form);
  good.set('ugc.captionPx', '90');
  good.set('platforms.youtube.slots', '12:30, 20:00');
  good.set('platforms.tiktok.slots', '12:30, 20:00');
  const diff = await req('POST', '/settings/preview', { cookie, form: good });
  assert.equal(diff.status, 200, diff.text);
  assert.ok(diff.text.includes('ugc.captionPx'));
  const save = formOf(diff.text, '/settings/save');
  assert.equal(save.get('csrf'), csrf);
  const saved = await req('POST', '/settings/save', { cookie, form: save });
  assert.equal(saved.status, 303);
  assert.match(String(saved.headers.location), /^\/settings\?saved=1$/);
  assert.equal(kvGet(db, 'config_active'), '1');
  assert.deepEqual(JSON.parse((db.prepare('SELECT overrides_json FROM config_versions WHERE id = 1').get() as { overrides_json: string }).overrides_json), { 'ugc.captionPx': 90, 'platforms.youtube.slots': ['12:30', '20:00'], 'platforms.tiktok.slots': ['12:30', '20:00'] });
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'config.save'").get());
  const after = await req('GET', '/settings?saved=1', { cookie });
  assert.ok(after.text.includes('Saved as v1. Takes effect at the next tick'));
  assert.ok(after.text.includes('value="90"'));

  // A stale base_id is refused.
  const stale = new URLSearchParams(save);
  const again = await req('POST', '/settings/save', { cookie, form: stale });
  assert.equal(again.status, 422);
  assert.match(again.text, /changed since/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM config_versions').get()!.n, 1);

  // A second version, then rollback to the first and back to the file.
  const p2 = formOf((await req('GET', '/settings', { cookie })).text, '/settings/preview');
  p2.set('ugc.captionPx', '100');
  const d2 = await req('POST', '/settings/preview', { cookie, form: p2 });
  assert.equal((await req('POST', '/settings/save', { cookie, form: formOf(d2.text, '/settings/save') })).status, 303);
  assert.equal(kvGet(db, 'config_active'), '2');
  assert.equal((await req('POST', '/history/activate', { cookie, form: { csrf, id: '1' } })).status, 303);
  assert.equal(kvGet(db, 'config_active'), '1');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'config.activate'").get());
  const hist = await req('GET', '/history?view=1', { cookie });
  assert.ok(hist.text.includes('ugc.captionPx') && hist.text.includes('config.save'));
  assert.equal((await req('POST', '/history/activate', { cookie, form: { csrf, id: '' } })).status, 303);
  assert.equal(kvGet(db, 'config_active'), undefined);
});

test('going public needs the confirmation', async () => {
  const { cookie } = await login();
  const form = formOf((await req('GET', '/settings', { cookie })).text, '/settings/preview');
  form.set('platforms.youtube.visibility', 'public');
  const diff = await req('POST', '/settings/preview', { cookie, form });
  assert.ok(diff.text.includes('confirm_public'));
  const save = formOf(diff.text, '/settings/save');
  const no = await req('POST', '/settings/save', { cookie, form: save });
  assert.equal(no.status, 422);
  assert.equal(kvGet(db, 'config_active'), undefined);
  save.set('confirm_public', '1');
  assert.equal((await req('POST', '/settings/save', { cookie, form: save })).status, 303);
  const id = kvGet(db, 'config_active')!;
  assert.ok(id);
  const csrf = save.get('csrf')!;
  await req('POST', '/history/activate', { cookie, form: { csrf, id: '' } });
});

test('prompts: save a version, see it in history, activate another, use the file', async () => {
  const { cookie, csrf } = await login();
  const edit = await req('GET', '/prompts/edit?key=ugc', { cookie });
  assert.equal(edit.status, 200);
  const form = formOf(edit.text, '/prompts/preview');
  form.set('body', form.get('body') + '\nAlways mention the weather.');
  const prev = await req('POST', '/prompts/preview', { cookie, form });
  assert.equal(prev.status, 200, prev.text);
  assert.match(prev.text, /about \d+ tokens/i);
  assert.ok(prev.text.includes('+ Always mention the weather.'));
  const save = formOf(prev.text, '/prompts/save');
  const done = await req('POST', '/prompts/save', { cookie, form: save });
  assert.equal(done.status, 303);
  assert.equal(kvGet(db, 'text_active:ugc'), '1');
  const audited = db.prepare("SELECT detail_json FROM audit WHERE action = 'text.save'").get() as { detail_json: string };
  assert.ok(!audited.detail_json.includes('weather'));
  assert.equal((await req('POST', '/prompts/save', { cookie, form: save })).status, 422); // stale base_id

  const hist = await req('GET', '/prompts/history?key=ugc&view=1', { cookie });
  assert.ok(hist.text.includes('v1') && hist.text.includes('active'));
  assert.equal((await req('POST', '/prompts/activate', { cookie, form: { csrf, key: 'ugc', id: '' } })).status, 303);
  assert.equal(kvGet(db, 'text_active:ugc'), undefined);
  assert.equal((await req('POST', '/prompts/activate', { cookie, form: { csrf, key: 'ugc', id: '1' } })).status, 303);
  assert.equal(kvGet(db, 'text_active:ugc'), '1');
  assert.equal((await req('POST', '/prompts/activate', { cookie, form: { csrf, key: 'claims', id: '' } })).status, 404);
  assert.equal((await req('GET', '/prompts/edit?key=claims', { cookie })).status, 404);
  assert.equal((await req('GET', '/prompts/edit?key=../../.env', { cookie })).status, 404);
  const empty = new URLSearchParams(form);
  empty.set('body', '');
  assert.equal((await req('POST', '/prompts/preview', { cookie, form: empty })).status, 422);
  await req('POST', '/prompts/activate', { cookie, form: { csrf, key: 'ugc', id: '' } });
});

test('a previewed writer prompt does not stay in the process: "use file" shows the file text again', async () => {
  seedBrief(db);
  const { cookie, csrf } = await login();
  const form = formOf((await req('GET', '/prompts/edit?key=copy', { cookie })).text, '/prompts/preview');
  form.set('body', form.get('body') + '\nSTALEMARKER one.');
  const save = formOf((await req('POST', '/prompts/preview', { cookie, form })).text, '/prompts/save');
  assert.equal((await req('POST', '/prompts/save', { cookie, form: save })).status, 303);
  form.set('body', form.get('body') + ' two.');
  assert.equal((await req('POST', '/prompts/preview', { cookie, form })).status, 200);
  assert.equal((await req('POST', '/prompts/activate', { cookie, form: { csrf, key: 'copy', id: '' } })).status, 303);
  assert.doesNotMatch((await req('GET', '/prompts/edit?key=copy', { cookie })).text, /STALEMARKER/);
  assert.doesNotMatch(promptText('copy'), /STALEMARKER/); // the admin process map is not left holding a version
});

test('html tag escapes values and keeps its own output; the diff marks changes', () => {
  assert.equal(html`<p>${'<b>&"\''}</p>`.toString(), '<p>&lt;b&gt;&amp;&quot;&#39;</p>');
  assert.equal(html`<ul>${['<a>', html`<i>x</i>`]}</ul>`.toString(), '<ul>&lt;a&gt;<i>x</i></ul>');
  assert.equal(esc(null), 'null');
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd').map((d) => d.op + d.text), [' a', '-b', ' c', '+d']);
  assert.deepEqual(lineDiff('', 'x').map((d) => d.op + d.text), ['+x']);
  const long = Array.from({ length: 10 }, (_, i) => 'l' + i).join('\n');
  assert.deepEqual(foldDiff(lineDiff(long, long + '\nz')).map((d) => d.op + d.text), [' ... 8 unchanged lines', ' l8', ' l9', '+z']);
});

test('the shared logger never receives request bodies', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/admin/server.ts'), 'utf8');
  assert.ok(!/log\.\w+\([^)]*(form|body|cookie)/.test(src));
});
