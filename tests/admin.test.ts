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
import { ABSOLUTE_MS, IDLE_MS, hashPassword, safeNext, verifyPassword } from '../src/admin/auth.ts';
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
    // Repeated names (the post time grid) are appended, as a browser sends them.
    if (a('type') === 'checkbox' || a('type') === 'radio') {
      if (/\schecked/.test(i[1])) p.append(name, un(a('value') ?? 'on'));
    } else p.append(name, un(a('value') ?? ''));
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
  for (const f of ['/style.css']) {
    const css = await req('GET', f);
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /text\/css/);
  }
  assert.equal((await req('GET', '/settings.js')).status, 404); // the block editor is gone (D-41)
  assert.equal((await req('GET', '/blocks.css')).status, 404);
});

test('every response carries the security headers and no page has a script tag', async () => {
  const { cookie } = await login();
  // Only Factory has a script (D-37, D-41); it is tested in factory.test.ts.
  for (const path of ['/login', '/overview', '/settings', '/history?view=1', '/products', '/products/new', '/prompts', '/prompts/edit?key=ugc', '/prompts/history?key=ugc', '/prompts/view?key=claims', '/activity', '/history', '/posts', '/music', '/models', '/style.css', '/healthz', '/nope']) {
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
  assert.ok(!diff.text.includes('data-path="tiers.t2.maxCredits"') && !diff.text.includes('data-path="tiers.t2.keepCredits"'), 'old caps carried over');
});

test('settings: unchanged form means no changes; a bad value is refused inline; a good one saves a version, pointer and audit together', async () => {
  const { cookie, csrf } = await login();
  const page = await req('GET', '/settings', { cookie });
  for (const [id, title] of [['when', 'When videos go out'], ['where', 'Where videos go'], ['money', 'Spending limits'], ['look', 'Look and sound']]) assert.ok(page.text.includes(`id="${id}"><h2>${title}</h2>`), title);
  assert.ok(page.text.includes('<details class="card" id="advanced"><summary>Advanced</summary>'));
  assert.ok(!page.text.includes('File default') && !page.text.includes('data-blocks'));
  const form = formOf(page.text, '/settings/preview');
  const none = await req('POST', '/settings/preview', { cookie, form });
  assert.equal(none.status, 200);
  assert.ok(none.text.includes('No changes'));

  const bad = new URLSearchParams(form);
  bad.set('tiers.capsUsd.t2', '9999');
  const refused = await req('POST', '/settings/preview', { cookie, form: bad });
  assert.equal(refused.status, 422);
  assert.match(refused.text, /class="err"[^>]*>Use 0 to \d+ USD\./); // owner words, no field path
  assert.match(refused.text, /class="err-summary" role="alert"[\s\S]*href="#f-tiers-capsUsd-t2"/);
  const nan = new URLSearchParams(form);
  nan.set('ugc.captionPx', 'big');
  const refused2 = await req('POST', '/settings/preview', { cookie, form: nan });
  assert.equal(refused2.status, 422);
  assert.match(refused2.text, /Enter a number\./);
  // All problems show in one pass, and the owner's entries stay in the form.
  const many = new URLSearchParams(form);
  many.set('ugc.captionPx', '5');
  many.set('ugc.reuseAfterDays', '1');
  many.set('tiers.capsUsd.t2', '9999');
  const all = await req('POST', '/settings/preview', { cookie, form: many });
  assert.equal(all.status, 422);
  assert.match(all.text, /Fix 3 things/);
  assert.match(all.text, /Use 56 to 110 px\./);
  assert.ok(all.text.includes('value="5"') && all.text.includes('value="1"'));
  assert.match(all.text, /name="ugc\.captionPx"[^>]*min="56" max="110"/);
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
  assert.ok(after.text.includes('<strong>Saved.</strong> The factory picks up the change within a minute.'));
  assert.ok(!/v1|version 1/i.test(after.text.split('<main id="main" tabindex="-1">')[1].split('</p>')[0])); // no version number in the flash
  assert.ok(after.text.includes('value="90"'));

  // A stale base_id is refused.
  const stale = new URLSearchParams(save);
  const again = await req('POST', '/settings/save', { cookie, form: stale });
  assert.equal(again.status, 422);
  assert.match(again.text, /Someone saved Settings in another tab/);
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

test('settings: post times are one input per daily post; Post 2 without Post 1 is refused', async () => {
  const { cookie, csrf } = await login();
  const page = await req('GET', '/settings', { cookie });
  assert.equal([...page.text.matchAll(/type="time" name="platforms\.youtube\.slots"/g)].length, 2);
  assert.match(page.text, /<label class="vh" for="f-platforms-youtube-slots-1">YouTube, Post 2 time<\/label>/);
  const form = formOf(page.text, '/settings/preview');
  assert.deepEqual(form.getAll('platforms.youtube.slots'), ['12:15', '19:45']);
  const two = new URLSearchParams(form);
  for (const p of ['youtube', 'tiktok']) {
    two.delete(`platforms.${p}.slots`);
    two.append(`platforms.${p}.slots`, '12:30');
    two.append(`platforms.${p}.slots`, '20:00');
  }
  const diff = await req('POST', '/settings/preview', { cookie, form: two });
  assert.equal(diff.status, 200, diff.text);
  assert.deepEqual(JSON.parse(formOf(diff.text, '/settings/save').get('draft')!)['platforms.youtube.slots'], ['12:30', '20:00']);
  assert.match(diff.text, /<tr data-path="platforms\.youtube\.slots"><td data-label="Setting">YouTube post times<\/td>/);
  const gap = new URLSearchParams(form);
  gap.delete('platforms.youtube.slots');
  gap.append('platforms.youtube.slots', '');
  gap.append('platforms.youtube.slots', '20:00');
  const r = await req('POST', '/settings/preview', { cookie, form: gap });
  assert.equal(r.status, 422);
  assert.match(r.text, /class="err">YouTube post times: Fill in Post 1 first\./);
  assert.ok(csrf);
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
  assert.ok(hist.text.includes('Version 1') && hist.text.includes('In use'));
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

test('settings: a failed save shows the form again with the entries kept; Go back keeps them too', async () => {
  const { cookie } = await login();
  const form = formOf((await req('GET', '/settings', { cookie })).text, '/settings/preview');
  form.set('ugc.captionPx', '77');
  const diff = await req('POST', '/settings/preview', { cookie, form });
  assert.match(diff.text, /id="cp"|formaction="\/settings\/edit"/);
  const save = formOf(diff.text, '/settings/save');
  const back = await req('POST', '/settings/edit', { cookie, form: save });
  assert.equal(back.status, 200);
  assert.ok(back.text.includes('value="77"') && back.text.includes('action="/settings/preview"'));
  assert.equal((await req('POST', '/settings/save', { cookie, form: save })).status, 303);
  const again = await req('POST', '/settings/save', { cookie, form: save }); // stale base
  assert.equal(again.status, 422);
  assert.ok(again.text.includes('action="/settings/preview"') && again.text.includes('value="77"'));
  assert.match(again.text, /Not saved\. Fix 1 thing/);
  assert.ok(!again.text.includes('Back to Settings'));
  // The public-post box is required, and a missing tick brings the review page back, not a dead end.
  const pub = formOf((await req('GET', '/settings', { cookie })).text, '/settings/preview');
  pub.set('platforms.youtube.visibility', 'public');
  const review = await req('POST', '/settings/preview', { cookie, form: pub });
  assert.match(review.text, /<input id="cp"[^>]*\srequired>/);
  const no = await req('POST', '/settings/save', { cookie, form: formOf(review.text, '/settings/save') });
  assert.equal(no.status, 422);
  assert.ok(no.text.includes('id="cp"') && no.text.includes('Tick the box'));
});

test('errors are pages with the menu; 404 keeps the nav when signed in; login returns to the page asked for', async () => {
  const out = await req('GET', '/nope');
  assert.equal(out.status, 404);
  assert.ok(!out.text.includes('aria-label="Main"'));
  assert.equal(out.text.split('There is no page at this address.').length, 2);
  const { cookie, csrf } = await login();
  const nf = await req('GET', '/nope', { cookie });
  assert.equal(nf.status, 404);
  assert.ok(nf.text.includes('aria-label="Main"'));
  assert.ok(nf.text.includes('<a class="skip" href="#main">'));
  const bad = await req('POST', '/settings/save', { cookie, form: { csrf: 'x'.repeat(csrf.length) } });
  assert.equal(bad.status, 403);
  assert.ok(bad.headers['content-type']!.toString().startsWith('text/html'));
  assert.ok(bad.text.includes('This page was out of date, so nothing was saved.'));
  assert.ok(bad.text.includes('href="/settings"') && !bad.text.includes('href="/login"')); // back to a GET page, never the POST-only one
  const noSess = await req('POST', '/settings/save', { form: { csrf: 'x' }, origin: 'http://evil.example' });
  assert.equal(noSess.status, 403);
  assert.ok(noSess.text.includes('Your session ended. Sign in again; your change was not saved.'));
  const viaRef = await req('POST', '/products/select', { cookie, form: { csrf: 'x'.repeat(csrf.length) }, headers: { referer: `http://127.0.0.1:${port}/settings/preview` } });
  assert.ok(viaRef.text.includes('href="/products"'));
  assert.equal((await req('GET', '/favicon.ico')).status, 204);
  assert.equal((await req('POST', '/settings/save', { cookie, body: '{}', type: 'application/json' })).status, 415);
  // A signed-in GET /login goes home.
  assert.equal((await req('GET', '/login', { cookie })).headers.location, '/overview');
});

test('login: next is kept only for same-site paths; logout says so', async () => {
  const r = await req('GET', '/settings?x=1');
  assert.equal(r.headers.location, '/login?next=%2Fsettings%3Fx%3D1');
  const page = await req('GET', String(r.headers.location));
  assert.ok(page.text.includes('name="next" value="/settings?x=1"'));
  assert.ok(page.text.includes('<h1>Sign in</h1>') && page.text.indexOf('class="card login"') < page.text.indexOf('<h1>'));
  const ok = await req('POST', '/login', { form: { username: 'admin', password: PW, next: '/settings?x=1' } });
  assert.equal(ok.headers.location, '/settings?x=1');
  for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example', 'settings', '/a\r\nb']) {
    assert.equal((await req('POST', '/login', { form: { username: 'admin', password: PW, next: evil } })).headers.location, '/overview', evil);
  }
  const { cookie, csrf } = await login();
  const lo = await req('POST', '/logout', { cookie, form: { csrf } });
  assert.equal(lo.headers.location, '/login?msg=out');
  assert.ok((await req('GET', '/login?msg=out')).text.includes('You are signed out.'));
});

test('home: a stopped or never-started factory is said in the headline and counts as needing you', async () => {
  const { cookie } = await login();
  kvSet(db, 'heartbeat', new Date(clock.getTime() - 3600_000).toISOString());
  const stopped = await req('GET', '/overview', { cookie });
  assert.ok(stopped.text.includes('<p>The factory has stopped.</p>'));
  assert.ok(!/tile-v">Nothing</.test(stopped.text));
  kvSet(db, 'heartbeat', clock.toISOString());
  const up = await req('GET', '/overview', { cookie });
  assert.ok(up.text.includes('Factory running') && !up.text.includes('The factory has'));
});

test('activity: late means 15 minutes overdue; a manual video still being made is not late; one row per video', async () => {
  const { cookie } = await login();
  const ins = (id: string, kind: string, status: string, at: string) => {
    db.prepare("INSERT INTO slots (id, local_date, idx, kind, status, created_at, updated_at) VALUES (?, ?, 9, ?, ?, ?, ?)").run(id, kind === 'manual' ? '2026-10-02' : '2026-10-01', kind, status, at, at);
  };
  try {
    ins('late#1', 'planned', 'ready', clock.toISOString());
    ins('manual#1', 'manual', 'producing', clock.toISOString());
    const pub = db.prepare("INSERT INTO publications (slot_id, platform, state, scheduled_at) VALUES (?, ?, 'pending', ?)");
    const old = new Date(clock.getTime() - 3600_000).toISOString();
    pub.run('late#1', 'youtube', old);
    pub.run('late#1', 'tiktok', old);
    pub.run('manual#1', 'youtube', old);
    const r = await req('GET', '/activity', { cookie });
    assert.equal([...r.text.matchAll(/Late: not sent yet/g)].length, 1); // one video, one row; the manual one is still being made
    assert.match(r.text, /(TikTok, YouTube|YouTube, TikTok), Post 9/);
    assert.ok(r.text.includes('the factory is not running') || r.text.includes('on its next check'));
  } finally {
    db.prepare("DELETE FROM publications WHERE slot_id IN ('late#1','manual#1')").run();
    db.prepare("DELETE FROM slots WHERE id IN ('late#1','manual#1')").run();
  }
});

test('settings: a save after another tab saved is a conflict, also through the unticked public-confirm path', async () => {
  const { cookie } = await login();
  const page = formOf((await req('GET', '/settings', { cookie })).text, '/settings/preview');
  const a = new URLSearchParams(page);
  a.set('platforms.youtube.visibility', 'public');
  const reviewA = await req('POST', '/settings/preview', { cookie, form: a });
  const saveA = formOf(reviewA.text, '/settings/save');
  assert.equal(saveA.get('base_id'), page.get('base_id'));
  const b = new URLSearchParams(page);
  b.set('ugc.captionPx', '88');
  assert.equal((await req('POST', '/settings/save', { cookie, form: formOf((await req('POST', '/settings/preview', { cookie, form: b })).text, '/settings/save') })).status, 303);
  const before = kvGet(db, 'config_active');
  const r1 = await req('POST', '/settings/save', { cookie, form: saveA }); // no tick
  assert.equal(r1.status, 422);
  assert.match(r1.text, /Someone saved Settings in another tab/);
  assert.equal(kvGet(db, 'config_active'), before);
  saveA.set('confirm_public', '1');
  const r2 = await req('POST', '/settings/save', { cookie, form: saveA });
  assert.equal(r2.status, 422);
  assert.equal(kvGet(db, 'config_active'), before); // nothing was reverted or overwritten
});

test('safeNext accepts only same-site paths', () => {
  for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil', '/a\r\nSet-Cookie: x=1', 'javascript:alert(1)', 'https://evil.com', '/café', ' /settings', '/login', '/login?next=/x', '', null, undefined]) assert.equal(safeNext(bad), null, String(bad));
  assert.equal(safeNext('/settings?x=1'), '/settings?x=1');
  assert.equal(safeNext('/'), '/');
});

test('login with next=//evil.com goes to /overview', async () => {
  const r = await req('POST', '/login', { form: { username: 'admin', password: PW, next: '//evil.com' } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/overview');
});
