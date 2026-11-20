import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { kvSet, type Db } from '../src/db/index.ts';
import { startAdmin, setPassword } from '../src/admin/index.ts';
import { townState, TOWN_JS } from '../src/admin/town.ts';
import { fresh, seedBrief } from './helpers.ts';

const PW = 'correct horse battery';
const NOW = new Date('2026-11-18T17:20:00Z');
let db: Db;
let server: Server;
let port: number;

function send(method: string, p: string, o: { cookie?: string; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (method === 'POST') { headers.origin = `http://${headers.host}`; headers['content-type'] = 'application/x-www-form-urlencoded'; }
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

before(async () => {
  db = fresh();
  ({ server, port } = await startAdmin({ db, port: 0, host: '127.0.0.1', now: () => NOW }));
  await setPassword({ db, now: () => NOW, read: async () => PW });
});
after(() => {
  server.close();
  server.closeAllConnections();
});

test('the quest log asks for what needs the owner, in order of urgency', async () => {
  let s = await townState(db, NOW);
  assert.deepEqual(s.quests.map((q) => q.href), ['/products', '/factory']); // no products, never ticked
  seedBrief(db);
  kvSet(db, 'heartbeat', NOW.toISOString());
  const ts = NOW.toISOString();
  db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, hold, held_at, kind) VALUES ('2026-11-18#101','2026-11-18',101,'ready',?,?,'waiting',?,'manual')").run(ts, ts, ts);
  s = await townState(db, NOW);
  assert.equal(s.alive, true);
  assert.equal(s.waiting, 1);
  assert.deepEqual(s.quests.map((q) => q.href), ['/posts']);
  assert.match(s.quests[0].text, /Decide on 1 video at the post office/);
  db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, error) VALUES ('2026-11-18#1','2026-11-18',1,'failed',?,?,'frame check failed')").run(ts, ts);
  s = await townState(db, NOW);
  assert.ok(s.chat.some((c) => c.kind === 'scrap' && c.text.includes('frame check failed')));
});

test('the town page and its data need a session', async () => {
  assert.equal((await send('GET', '/town')).status, 303);
  assert.equal((await send('GET', '/town.json')).status, 303);
  const r = await send('POST', '/login', { body: new URLSearchParams({ username: 'admin', password: PW }).toString() });
  const cookie = String(([] as string[]).concat(r.headers['set-cookie'] ?? [])[0]).split(';')[0];
  const page = await send('GET', '/town', { cookie });
  assert.equal(page.headers['content-security-policy'], "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.deepEqual([...page.text.matchAll(/<script[^>]*>/gi)].map((m) => m[0]), ['<script src="/town.js" defer>']);
  assert.ok(page.text.includes('href="/pixel.css"'));
  assert.equal(page.status, 200);
  for (const href of ['/factory', '/products', '/posts', '/settings', '/music', '/models', '/prompts', '/activity', '/history']) assert.ok(page.text.includes(`href="${href}"`), href);
  const j = await send('GET', '/town.json', { cookie });
  assert.match(String(j.headers['content-type']), /application\/json/);
  assert.ok(Array.isArray(JSON.parse(j.text).quests));
  assert.equal((await send('GET', '/town.js')).status, 200);
  assert.equal((await send('GET', '/town.css')).status, 200);
});

test('the town script never builds markup from strings and fetches only /town.json', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(TOWN_JS));
  const calls = [...TOWN_JS.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["'/town.json'"]);
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(TOWN_JS));
});
