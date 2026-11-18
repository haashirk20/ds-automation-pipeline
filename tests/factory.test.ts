import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { type Db } from '../src/db/index.ts';
import { startAdmin, setPassword } from '../src/admin/index.ts';
import { factoryState, stageOf, FACTORY_JS } from '../src/admin/factory.ts';
import { fresh } from './helpers.ts';

const PW = 'correct horse battery';
const NOW = new Date('2026-11-17T17:20:00Z');
let db: Db;
let server: Server;
let port: number;

type R = { status: number; headers: Record<string, string | string[] | undefined>; text: string };
function req(method: string, path: string, cookie?: string, form?: Record<string, string>): Promise<R> {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (method === 'POST') {
    headers.origin = `http://${headers.host}`;
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-length'] = String(Buffer.byteLength(body));
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

async function login(): Promise<string> {
  const r = await req('POST', '/login', undefined, { username: 'admin', password: PW });
  assert.equal(r.status, 303);
  return String(([] as string[]).concat(r.headers['set-cookie'] ?? [])[0]).split(';')[0];
}

const slot = (id: string, status: string, extra: Record<string, string | null> = {}) => {
  const ts = NOW.toISOString();
  db.prepare('INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, claimed_at, master_json, hold, kind) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    id, id.slice(0, 10), Number(id.split('#')[1]), status, ts, ts, extra.claimed_at ?? null, extra.master_json ?? null, extra.hold ?? null, extra.kind ?? 'planned');
};
const pub = (id: string, platform: string, state: string) =>
  db.prepare('INSERT INTO publications (slot_id, platform, scheduled_at, state, published_at) VALUES (?,?,?,?,?)').run(id, platform, NOW.toISOString(), state, state === 'published' ? NOW.toISOString() : null);
const llm = (id: string, purpose: string) =>
  db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, slot_id) VALUES (?,?,'m',0,0,0,0,0,?)").run(NOW.toISOString(), purpose, id);

before(async () => {
  db = fresh();
  ({ server, port } = await startAdmin({ db, port: 0, host: '127.0.0.1', now: () => NOW }));
  await setPassword({ db, now: () => NOW, read: async () => PW });
});
after(() => {
  server.close();
  server.closeAllConnections();
});

test('stageOf follows a slot down the line', () => {
  const none = new Set<string>();
  const p = (s: string) => [{ p: 'youtube', s }];
  assert.equal(stageOf({ status: 'planned', hold: null, master_json: null }, none, [], []), 'dock');
  assert.equal(stageOf({ status: 'producing', hold: null, master_json: null }, new Set(['ugc', 'claims']), [], []), 'design');
  assert.equal(stageOf({ status: 'producing', hold: null, master_json: '{}' }, none, ['submitted'], []), 'foundry');
  assert.equal(stageOf({ status: 'producing', hold: null, master_json: '{}' }, none, ['failed', 'succeeded'], []), 'inspect');
  assert.equal(stageOf({ status: 'producing', hold: null, master_json: '{}' }, new Set(['vision']), ['succeeded'], []), 'paint');
  assert.equal(stageOf({ status: 'producing', hold: null, master_json: '{}' }, new Set(['vision', 'copy']), ['succeeded'], []), 'label');
  assert.equal(stageOf({ status: 'ready', hold: 'waiting', master_json: '{}' }, none, [], p('pending')), 'gate');
  assert.equal(stageOf({ status: 'ready', hold: 'approved', master_json: '{}' }, none, [], p('pending')), 'shipping');
  assert.equal(stageOf({ status: 'done', hold: null, master_json: '{}' }, none, [], p('published')), 'shipped');
  assert.equal(stageOf({ status: 'done', hold: 'discarded', master_json: '{}' }, none, [], p('skipped')), 'scrap');
  assert.equal(stageOf({ status: 'done', hold: null, master_json: '{}' }, none, [], p('skipped')), 'scrap');
  assert.equal(stageOf({ status: 'failed', hold: null, master_json: null }, none, [], []), 'scrap');
});

test('factoryState reads stages, counts and only model calls since the claim', async () => {
  slot('2026-11-17#1', 'producing', { claimed_at: '2026-11-17T17:00:00.000Z', master_json: JSON.stringify({ mode: 'ugc', concept: { caption: 'Warm <b>hands</b>' } }) });
  llm('2026-11-17#1', 'vision');
  db.prepare("UPDATE llm_calls SET ts = '2026-11-17T16:00:00.000Z' WHERE slot_id = '2026-11-17#1'").run(); // an earlier attempt
  slot('2026-11-17#2', 'ready', { hold: null });
  pub('2026-11-17#2', 'youtube', 'uploading');
  pub('2026-11-17#2', 'tiktok', 'published');
  const st = await factoryState(db, NOW);
  const s1 = st.slots.find((s) => s.id === '2026-11-17#1')!;
  assert.equal(s1.stage, 'foundry'); // the vision call belongs to the old attempt
  assert.equal(s1.caption, 'Warm <b>hands</b>');
  assert.equal(st.slots.find((s) => s.id === '2026-11-17#2')!.stage, 'shipping');
  assert.equal(st.uploading.youtube, 1);
  assert.equal(st.published.tiktok, 1);
  assert.equal(st.published.facebook, 0);
});

test('the factory page needs a session, allows one same-origin script and escapes data', async () => {
  assert.equal((await req('GET', '/factory')).status, 303);
  assert.equal((await req('GET', '/factory.json')).status, 303);
  slot('2026-11-17#3', 'planned');
  db.prepare("UPDATE slots SET master_json = ? WHERE id = '2026-11-17#3'").run(JSON.stringify({ concept: { caption: '"><script>alert(1)</script>' } }));
  const cookie = await login();
  const r = await req('GET', '/factory', cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-security-policy'], "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.deepEqual([...r.text.matchAll(/<script[^>]*>/gi)].map((m) => m[0]), ['<script src="/factory.js" defer>']);
  assert.ok(!r.text.includes('"><script>alert'));
  assert.ok(!/ style="|<style/i.test(r.text));
  assert.match(r.text, /data-station="foundry"/);
  assert.match(r.text, /<canvas id="factory" class="fx" width="544" height="320"/);
  assert.ok(!/<img|\.png|\.gif/i.test(r.text)); // every sprite is drawn by the script
  const j = await req('GET', '/factory.json', cookie);
  assert.match(String(j.headers['content-type']), /application\/json/);
  assert.equal(j.headers['content-security-policy'], "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.ok(JSON.parse(j.text).slots.some((s: { id: string; stage: string }) => s.id === '2026-11-17#3' && s.stage === 'dock'));
  const js = await req('GET', '/factory.js');
  assert.equal(js.status, 200);
  assert.match(String(js.headers['content-type']), /javascript/);
  assert.equal((await req('GET', '/factory.css')).status, 200);
});

test('the factory script never builds markup from strings or calls another origin', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(FACTORY_JS));
  for (const m of FACTORY_JS.matchAll(/fetch\(([^,)]+)/g)) assert.equal(m[1], "'/factory.json'");
});
