import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Server } from 'node:http';
import type { Db } from '../src/db/index.ts';
import { startAdmin, setPassword } from '../src/admin/index.ts';
import { parseRange } from '../src/admin/media.ts';
import { ff } from '../src/render/ffmpeg.ts';
import { fresh } from './helpers.ts';

const PW = 'correct horse battery';
let db: Db;
let server: Server;
let port: number;
let dir: string;
const clock = new Date('2026-11-12T17:20:00Z');

type R = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; text: string };
function send(method: string, path: string, o: { headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<R> {
  const body = o.body === undefined ? undefined : Buffer.from(o.body);
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...o.headers };
  if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => { const b = Buffer.concat(parts); resolve({ status: res.statusCode!, headers: res.headers, body: b, text: b.toString('utf8') }); });
    });
    r.on('error', reject);
    r.end(body);
  });
}
const post = (path: string, cookie: string, csrf: string, form: Record<string, string>) =>
  send('POST', path, { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ csrf, ...form }).toString() });

function multipart(fields: Record<string, string>, file?: { name: string; bytes: Buffer }): { type: string; body: Buffer } {
  const b = '----t4boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: application/octet-stream\r\n\r\n`), file.bytes, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { type: `multipart/form-data; boundary=${b}`, body: Buffer.concat(parts) };
}

let cookie = '';
let csrf = '';
const upload = (file: { name: string; bytes: Buffer } | undefined, o: { fields?: Record<string, string>; cookie?: string; origin?: string | null } = {}) => {
  const m = multipart(o.fields ?? { csrf, ack: '1' }, file);
  const headers: Record<string, string> = { 'content-type': m.type, cookie: o.cookie ?? cookie };
  if (o.origin !== null) headers.origin = o.origin ?? `http://127.0.0.1:${port}`;
  return send('POST', '/music/upload', { headers, body: m.body });
};

const musicFiles = () => (existsSync(join(dir, 'data', 'music')) ? readdirSync(join(dir, 'data', 'music')).concat(existsSync(join(dir, 'data', 'music', '.incoming')) ? readdirSync(join(dir, 'data', 'music', '.incoming')).map((f) => `.incoming/${f}`) : []) : []);

// The FFmpeg build has no video source filter, so the picture is a 64x64 PNG made here.
function png(file: string) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const chunk = (t: string, d: Buffer) => {
    const td = Buffer.concat([Buffer.from(t), d]);
    let c = -1;
    for (const x of td) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const k = Buffer.alloc(4); k.writeUInt32BE((c ^ -1) >>> 0);
    return Buffer.concat([l, td, k]);
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(64, 0); ih.writeUInt32BE(64, 4); ih[8] = 8; ih[9] = 2;
  const px = Buffer.alloc(64 * 193, 80);
  for (let y = 0; y < 64; y++) px[y * 193] = 0;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
}

before(async () => {
  db = fresh();
  dir = join(process.env.DATA_DIR!, '..');
  ({ server, port } = await startAdmin({ db, port: 0, host: '127.0.0.1', now: () => clock }));
  await setPassword({ db, now: () => clock, read: async () => PW });
  const r = await send('POST', '/login', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `username=admin&password=${encodeURIComponent(PW)}` });
  cookie = String(([] as string[]).concat(r.headers['set-cookie'] as string[])[0]).split(';')[0];
  csrf = /name="csrf" value="([0-9a-f]+)"/.exec((await send('GET', '/music', { headers: { cookie } })).text)![1];
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const wavLike = Buffer.concat([Buffer.from('this is plain text, not audio. '), Buffer.alloc(2000, 97)]);

test('upload gates: session first, then Origin, csrf, content type, length', async () => {
  const before = musicFiles();
  const noSession = await upload({ name: 'a.mp3', bytes: wavLike }, { cookie: '' });
  assert.equal(noSession.status, 303);
  assert.equal(noSession.headers.location, '/login');
  assert.deepEqual(musicFiles(), before);
  assert.equal((await upload({ name: 'a.mp3', bytes: wavLike }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await upload({ name: 'a.mp3', bytes: wavLike }, { origin: null })).status, 403);
  assert.equal((await upload({ name: 'a.mp3', bytes: wavLike }, { fields: { ack: '1' } })).status, 403);
  assert.equal((await upload({ name: 'a.mp3', bytes: wavLike }, { fields: { csrf: 'wrong', ack: '1' } })).status, 403);
  assert.equal((await upload({ name: 'a.mp3', bytes: wavLike }, { fields: { csrf } })).status, 422); // no rights box
  const plain = await send('POST', '/music/upload', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', cookie }, body: 'csrf=x' });
  assert.equal(plain.status, 415);
  const m = multipart({ csrf }, undefined);
  assert.equal((await send('POST', '/settings/save', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': m.type, cookie }, body: m.body })).status, 415);
  const big = await send('POST', '/music/upload', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': m.type, cookie, 'content-length': String(41 * 1024 * 1024) }, body: Buffer.from('x') }).catch(() => null);
  if (big) assert.equal(big.status, 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM music_tracks').get()!.n, 0);
});

test('text bytes named .mp3 are refused and leave nothing behind', async () => {
  const r = await upload({ name: 'song.mp3', bytes: wavLike });
  assert.equal(r.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM music_tracks').get()!.n, 0);
  assert.deepEqual(musicFiles().filter((f) => f !== '.incoming'), []);
  // mp3-looking magic that is not an mp3: ffprobe refuses it
  const fake = await upload({ name: 'x.mp3', bytes: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 1)]) });
  assert.equal(fake.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM music_tracks').get()!.n, 0);
  assert.deepEqual(musicFiles().filter((f) => f !== '.incoming'), []);
});

test('mp3, m4a, wav and mp4 with a picture are accepted, transcoded and stored by hash', async () => {
  const work = mkdtempSync(join(tmpdir(), 'up-'));
  const sine = (d: number) => ['-f', 'lavfi', '-i', `sine=frequency=${d}:duration=8`];
  const wav = join(work, 'a.wav'), mp3 = join(work, 'a.mp3'), m4a = join(work, 'a.m4a'), mp4 = join(work, 'a.mp4');
  await ff('ffmpeg', ['-y', ...sine(300), '-c:a', 'pcm_s16le', '-f', 'wav', wav]);
  await ff('ffmpeg', ['-y', ...sine(400), '-c:a', 'libmp3lame', '-f', 'mp3', mp3]);
  await ff('ffmpeg', ['-y', ...sine(500), '-c:a', 'aac', '-f', 'mp4', m4a]);
  png(join(work, 'x.png'));
  await ff('ffmpeg', ['-y', '-loop', '1', '-framerate', '10', '-i', join(work, 'x.png'), ...sine(600), '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4]);
  for (const f of [wav, mp3, m4a, mp4]) {
    const bytes = (await import('node:fs')).readFileSync(f);
    const r = await upload({ name: `../../etc/${f.split('/').pop()}`, bytes });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    const sha = createHash('sha256').update(bytes).digest('hex');
    const row = db.prepare('SELECT * FROM music_tracks WHERE sha256 = ?').get(sha) as any;
    assert.ok(row, f);
    assert.equal(row.file, `music/${sha}.m4a`);
    assert.ok(!row.name.includes('/'), row.name);
    assert.ok(row.seconds > 7 && row.seconds < 9, String(row.seconds));
    assert.ok(Number.isFinite(row.lufs));
    assert.ok(existsSync(join(dir, 'data', 'music', `${sha}.m4a`)));
  }
  assert.deepEqual(musicFiles().filter((f) => !f.endsWith('.m4a')), ['.incoming']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM music_tracks').get()!.n, 4);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'music.upload'").get());
});

test('select, preview ranges and delete', async () => {
  const rows = db.prepare('SELECT sha256 FROM music_tracks ORDER BY sha256').all() as { sha256: string }[];
  const [a, b] = rows;
  const sel = await post('/music/select', cookie, csrf, {});
  assert.equal(sel.status, 303);
  // repeated sel fields
  const two = await send('POST', '/music/select', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', cookie }, body: `csrf=${csrf}&sel=${a.sha256}&sel=${b.sha256}&sel=nothex` });
  assert.equal(two.status, 303);
  assert.deepEqual(db.prepare('SELECT sha256 FROM music_tracks WHERE selected = 1 ORDER BY sha256').all(), [a, b]);

  const url = `/media/music?sha=${a.sha256}`;
  const size = statSync(join(dir, 'data', 'music', `${a.sha256}.m4a`)).size;
  const full = await send('GET', url, { headers: { cookie } });
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.body.length, size);
  const part = await send('GET', url, { headers: { cookie, range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 0-99/${size}`);
  assert.equal(part.body.length, 100);
  assert.equal((await send('GET', url, { headers: { cookie, range: 'bytes=-10' } })).headers['content-range'], `bytes ${size - 10}-${size - 1}/${size}`);
  const oob = await send('GET', url, { headers: { cookie, range: `bytes=${size + 5}-` } });
  assert.equal(oob.status, 416);
  assert.equal(oob.headers['content-range'], `bytes */${size}`);
  assert.equal((await send('GET', url, { headers: { range: 'bytes=0-9' } })).status, 303); // no session
  assert.equal((await send('GET', '/media/music?sha=../../etc/passwd', { headers: { cookie } })).status, 404);
  assert.equal((await send('GET', `/media/music?sha=${'0'.repeat(64)}`, { headers: { cookie } })).status, 404);

  // Enter in the select form must save, never delete: each delete is its own form, outside it, with the csrf token.
  const page = (await send('GET', '/music', { headers: { cookie } })).text;
  const selectForm = /<form method="post" action="\/music\/select">[\s\S]*?<\/form>/.exec(page)![0];
  assert.doesNotMatch(selectForm, /formaction|\/music\/delete/);
  assert.deepEqual(selectForm.match(/<button[^>]*type="submit"(?! form=)[^>]*>[^<]*/g), ['<button class="primary" type="submit">Save choices']); // the only submit owned by the form
  const del = new RegExp(`<form id="(del-\\d+)" method="post" action="/music/delete"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="sha" value="${a.sha256}"></form>`).exec(page);
  assert.ok(del, 'standalone delete form');
  assert.match(selectForm, new RegExp(`type="submit" form="${del[1]}">Yes, delete`));
  assert.equal((await post('/music/delete', cookie, csrf, { sha: a.sha256 })).status, 303);
  assert.equal(db.prepare('SELECT selected FROM music_tracks WHERE sha256 = ?').get(a.sha256)!.selected, 0);
  assert.ok(!existsSync(join(dir, 'data', 'music', `${a.sha256}.m4a`)));
  assert.equal((await send('GET', url, { headers: { cookie } })).status, 404);
});

test('parseRange', () => {
  assert.equal(parseRange(null, 100), null);
  assert.equal(parseRange('bytes=0-9,20-29', 100), null);
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-1000', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 100), null); // invalid: ignored, full file
  assert.equal(parseRange('bytes=0-5', 0), null);
});

test('/media/render: malformed id, outside OUT_DIR, and a good file with ranges', async () => {
  const out = process.env.OUT_DIR!;
  mkdirSync(join(out, '2026-11-12'), { recursive: true });
  const good = join(out, '2026-11-12', 'a.mp4');
  writeFileSync(good, Buffer.alloc(1000, 7));
  const outside = join(dir, 'secret.mp4');
  writeFileSync(outside, 'secret');
  const ts = clock.toISOString();
  for (const [id, file] of [['2026-11-12#101', good], ['2026-11-12#102', outside]] as const) {
    db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, kind) VALUES (?, '2026-11-12', ?, 'ready', ?, ?, 'manual')").run(id, Number(id.split('#')[1]), ts, ts);
    db.prepare("INSERT INTO renders (slot_id, platform, file_path, qa_pass, created_at) VALUES (?, 'youtube', ?, 1, ?)").run(id, file, ts);
  }
  const g = await send('GET', `/media/render?slot=${encodeURIComponent('2026-11-12#101')}`, { headers: { cookie, range: 'bytes=10-19' } });
  assert.equal(g.status, 206);
  assert.equal(g.headers['content-range'], 'bytes 10-19/1000');
  // A 0-byte render: 200 with an empty body, and the server keeps serving.
  const empty = join(out, '2026-11-12', 'empty.mp4');
  writeFileSync(empty, '');
  db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, kind) VALUES ('2026-11-12#190', '2026-11-12', 190, 'ready', ?, ?, 'manual')").run(ts, ts);
  db.prepare("INSERT INTO renders (slot_id, platform, file_path, qa_pass, created_at) VALUES ('2026-11-12#190', 'youtube', ?, 1, ?)").run(empty, ts);
  const z = await send('GET', `/media/render?slot=${encodeURIComponent('2026-11-12#190')}`, { headers: { cookie, range: 'bytes=0-5' } });
  assert.equal(z.status, 200);
  assert.equal(z.body.length, 0);
  assert.equal((await send('GET', `/media/render?slot=${encodeURIComponent('2026-11-12#101')}`, { headers: { cookie } })).status, 200);
  assert.equal((await send('GET', `/media/render?slot=${encodeURIComponent('2026-11-12#102')}`, { headers: { cookie } })).status, 404);
  for (const bad of ['../x', '2026-11-12', '2026-11-12%23', "2026-11-12%23101'--", '']) assert.equal((await send('GET', `/media/render?slot=${bad}`, { headers: { cookie } })).status, 404, bad);
});

test('Post and Discard: the second press is a no-op notice', async () => {
  const ts = clock.toISOString();
  const mk = (id: string, idx: number, file: string) => {
    db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, kind, hold, held_at) VALUES (?, '2026-11-12', ?, 'ready', ?, ?, 'manual', 'waiting', ?)").run(id, idx, ts, ts, ts);
    db.prepare("INSERT INTO renders (slot_id, platform, file_path, qa_pass, created_at) VALUES (?, 'youtube', ?, 1, ?)").run(id, file, ts);
    db.prepare("INSERT INTO publications (slot_id, platform, scheduled_at) VALUES (?, 'youtube', ?)").run(id, ts);
  };
  const good = join(process.env.OUT_DIR!, '2026-11-12', 'a.mp4');
  mk('2026-11-12#103', 103, good);
  mk('2026-11-12#104', 104, good);
  mk('2026-11-12#105', 105, join(process.env.OUT_DIR!, '2026-11-12', 'gone.mp4'));
  assert.match(String((await send('GET', '/posts', { headers: { cookie } })).text), /<video controls[^>]*media\/render\?slot=2026-11-12%23103/);
  const p1 = await post('/posts/approve', cookie, csrf, { slot: '2026-11-12#103' });
  assert.equal(p1.headers.location, '/posts?msg=approved');
  assert.equal((await post('/posts/approve', cookie, csrf, { slot: '2026-11-12#103' })).headers.location, '/posts?msg=noop');
  assert.equal((await post('/posts/discard', cookie, csrf, { slot: '2026-11-12#103' })).headers.location, '/posts?msg=noop');
  assert.equal(db.prepare("SELECT hold FROM slots WHERE id = '2026-11-12#103'").get()!.hold, 'approved');
  assert.equal((await post('/posts/discard', cookie, csrf, { slot: '2026-11-12#104' })).headers.location, '/posts?msg=discarded');
  assert.equal((await post('/posts/discard', cookie, csrf, { slot: '2026-11-12#104' })).headers.location, '/posts?msg=noop');
  assert.equal((await post('/posts/approve', cookie, csrf, { slot: '2026-11-12#104' })).headers.location, '/posts?msg=noop');
  assert.equal(db.prepare("SELECT state FROM publications WHERE slot_id = '2026-11-12#104'").get()!.state, 'skipped');
  assert.equal((await post('/posts/approve', cookie, csrf, { slot: '2026-11-12#105' })).headers.location, '/posts?msg=nofile');
  assert.equal(db.prepare("SELECT hold FROM slots WHERE id = '2026-11-12#105'").get()!.hold, 'waiting');
  assert.equal((await post('/posts/approve', cookie, csrf, { slot: 'x' })).headers.location, '/posts?msg=noop');
});

test('Make a post refuses a second one while one is being made', async () => {
  for (const t of ['publications', 'renders']) db.prepare(`DELETE FROM ${t} WHERE slot_id IN (SELECT id FROM slots WHERE kind = 'manual')`).run();
  db.prepare("DELETE FROM slots WHERE kind = 'manual'").run();
  const before = 0;
  const r = await post('/posts/new', cookie, csrf, { model: '' });
  assert.equal(r.status, 303);
  const again = await post('/posts/new', cookie, csrf, { model: '' });
  assert.equal(again.status, 303);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM slots WHERE kind = 'manual'").get()!.n, before + 1);
  assert.match(String(again.headers.location), /refused=/);
  assert.match((await send('GET', '/posts', { headers: { cookie } })).text, /http-equiv="refresh"/);
  assert.equal((await post('/posts/new', cookie, csrf, { model: 'custom:99' })).status, 303);
});

test('models: guardrails on add, approved customs reach Settings, remove is refused while in use', async () => {
  const add = (f: { [k: string]: string | undefined }) => post('/models/add', cookie, csrf, { name: 'Wan test', model: 'wan3_0', options: 'resolution=720p\ngenerate_audio=true', maxCredits: '60', keepCredits: '350', ...(f as Record<string, string>) });
  for (const bad of [{ options: 'prompt=hello' }, { options: 'generate_audio=false' }, { options: 'resolution=4k' }, { options: 'mode=video_edit' }, { options: 'no equals' }, { options: 'resolution=720p\nresolution=480p' }, { model: '../x' }, { maxCredits: '100000' }, { maxCredits: '' }, { keepCredits: '10' }, { name: '' }]) {
    const r = await add(bad);
    assert.equal(r.status, 422, JSON.stringify(bad));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_models').get()!.n, 0);
  const ok = await add({});
  assert.equal(ok.status, 303);
  const row = db.prepare('SELECT * FROM video_models').get() as any;
  assert.deepEqual(JSON.parse(row.params_json), { resolution: '720p', generate_audio: true });
  assert.ok(!/value="custom:1"/.test((await send('GET', '/settings', { headers: { cookie } })).text)); // not approved yet
  db.prepare('UPDATE video_models SET approved_at = ? WHERE id = 1').run(clock.toISOString());
  assert.match((await send('GET', '/settings', { headers: { cookie } })).text, /<option value="custom:1"/);
  assert.match((await send('GET', '/models', { headers: { cookie } })).text, /Wan test/);
  // a slot being made with it blocks removal
  db.prepare("INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, kind, video_model) VALUES ('2026-11-13#101', '2026-11-13', 101, 'producing', ?, ?, 'manual', 'custom:1')").run(clock.toISOString(), clock.toISOString());
  const blocked = await post('/models/remove', cookie, csrf, { id: '1' });
  assert.match(String(blocked.headers.location), /refused=/);
  assert.equal(db.prepare('SELECT removed_at FROM video_models WHERE id = 1').get()!.removed_at, null);
  db.prepare("UPDATE slots SET status = 'failed' WHERE id = '2026-11-13#101'").run();
  assert.equal((await post('/models/remove', cookie, csrf, { id: '1' })).headers.location, '/models?msg=removed');
  assert.ok(db.prepare('SELECT removed_at FROM video_models WHERE id = 1').get()!.removed_at);
  assert.match(String((await post('/models/remove', cookie, csrf, { id: '1' })).headers.location), /refused=/);
});

test('new pages need a session and send the media CSP', async () => {
  for (const p of ['/posts', '/music', '/models', '/media/music?sha=' + '0'.repeat(64)]) assert.equal((await send('GET', p)).status, 303, p);
  assert.match(String((await send('GET', '/music', { headers: { cookie } })).headers['content-security-policy']), /media-src 'self'/);
});
