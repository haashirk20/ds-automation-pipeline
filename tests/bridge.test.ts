import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAccounts } from '../src/publish/bridge.ts';
import { makePublishers } from '../src/publish/bridge.ts';
import { AmbiguousError, PermanentError, RetryableError } from '../src/publish/types.ts';
import { AI_LINE } from '../src/contracts.ts';
import { config } from './helpers.ts';

const KEY = 'zk_live_supersecretkey123';
const NOW = new Date('2026-11-13T12:00:00Z');
const file = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'v.mp4');
writeFileSync(file, 'video');
process.env.BRIDGE_API_KEY = KEY;

type Req = { method: string; path: string; headers: Record<string, string>; body: any; redirect?: string };
const ACCOUNTS = { accounts: [
  { _id: 'a-yt', platform: 'youtube', username: 'ShopGiftwell', isActive: true },
  { _id: 'a-tt', platform: 'tiktok', username: 'merrymarts', isActive: true },
  { _id: 'a-ig', platform: 'instagram', username: '@shopgiftwellgifts', isActive: true },
  { _id: 'a-fb', platform: 'facebook', username: 'x', displayName: 'Merry Marts', isActive: true },
  { _id: 'a-old', platform: 'youtube', username: 'gone', isActive: false },
] };
const INFO = { privacyLevels: [{ value: 'SELF_ONLY' }, { value: 'PUBLIC_TO_EVERYONE' }], postingLimits: { interactionSettings: { allow_comment: { enabled: true }, allow_duet: { enabled: false }, allow_stitch: { enabled: true } } } };
const post = (platform: string, status: string, extra = {}) => ({ post: { _id: 'post1', status, platforms: [{ platform, status, platformPostUrl: 'https://p/1', ...extra }] } });

function rig(handlers: { presign?: unknown; post?: (r: Req, n: number) => Response; get?: (r: Req, n: number) => Response; info?: Response } = {}) {
  const reqs: Req[] = [];
  const events: string[] = [];
  let nPost = 0, nGet = 0;
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const path = u.startsWith('https://zernio.com/api/v1') ? u.slice('https://zernio.com/api/v1'.length) : u;
    const r: Req = { method: init.method ?? 'GET', path, headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, redirect: init.redirect };
    reqs.push(r);
    events.push(`${r.method} ${path.split('?')[0]}`);
    if (path === '/accounts') return Response.json(ACCOUNTS);
    if (path.includes('/tiktok/creator-info')) return handlers.info ?? Response.json(INFO);
    if (path === '/media/presign') return Response.json(handlers.presign ?? { uploadUrl: 'https://storage.example/up?sig=1', publicUrl: 'https://cdn.example/v.mp4', key: 'k', expiresIn: 3600 });
    if (u.startsWith('https://storage.example/')) return new Response('', { status: 200 });
    if (path === '/posts') return handlers.post ? handlers.post(r, nPost++) : Response.json(post(platformOf(r), 'published'), { status: 201 });
    if (path.startsWith('/posts/')) return handlers.get ? handlers.get(r, nGet++) : Response.json(post('youtube', 'published'));
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, reqs, events };
}
const platformOf = (r: Req) => r.body.platforms[0].platform as string;

function run(name: string, h: ReturnType<typeof rig>, over: Record<string, unknown> = {}, sleep: (ms: number, s: AbortSignal) => Promise<void> = async () => {}) {
  const saved: unknown[] = [];
  const pubs = makePublishers(config, { fetch: h.f, now: () => NOW, sleep });
  const input = {
    filePath: file, title: 'T', caption: 'cap', aiDisclosure: true, visibility: 'private' as 'public' | 'private', idempotencyKey: `slot:${name}`,
    handle: null as unknown, saveHandle: (x: unknown) => { saved.push(x); h.events.push('save'); }, signal: new AbortController().signal, ...over,
  };
  return { saved, input, done: pubs[name].publish(input) };
}

test('fresh publish per platform: request order, key, body, handle saved before POST', async () => {
  for (const [name, check] of [
    ['youtube', (b: any) => assert.deepEqual(b.platforms[0].platformSpecificData, { title: 'T', visibility: 'private', madeForKids: false, containsSyntheticMedia: true })],
    ['tiktok', (b: any) => {
      assert.deepEqual(b.tiktokSettings, { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: true, content_preview_confirmed: true, express_consent_given: true, video_made_with_ai: true, draft: true });
    }],
    ['facebook', (b: any) => { assert.deepEqual(b.platforms[0].platformSpecificData, { contentType: 'reel', title: 'T' }); assert.deepEqual(b.facebookSettings, { draft: true }); }],
    ['instagram', (b: any) => { assert.equal(b.platforms[0].platformSpecificData, undefined); assert.equal(b.tiktokSettings, undefined); }],
  ] as const) {
    const vis = name === 'instagram' ? 'public' : 'private';
    const h = rig({ post: (r) => Response.json(post(name, 'published'), { status: 201 }) });
    const r = run(name, h, { visibility: vis });
    assert.deepEqual(await r.done, { postId: 'post1', postUrl: 'https://p/1' });
    const want = ['GET /accounts', ...(name === 'tiktok' ? ['GET /accounts/a-tt/tiktok/creator-info'] : []), 'POST /media/presign', 'PUT https://storage.example/up', 'save', 'POST /posts', 'save'];
    assert.deepEqual(h.events.map((e) => e.replace('?sig=1', '')), want, name);
    const p = h.reqs.find((x) => x.path === '/posts')!;
    assert.equal(p.headers['Idempotency-Key'], `slot:${name}`);
    assert.equal(p.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(p.body.mediaItems, [{ type: 'video', url: 'https://cdn.example/v.mp4' }]);
    assert.equal(p.body.publishNow, true);
    assert.equal(p.body.content, name === 'facebook' || name === 'instagram' ? 'cap' + AI_LINE : 'cap');
    check(p.body);
    const put = h.reqs.find((x) => x.method === 'PUT')!;
    assert.equal(put.headers.authorization, undefined);
    assert.equal(put.headers['content-type'], 'video/mp4');
    assert.deepEqual(r.saved, [{ mediaUrl: 'https://cdn.example/v.mp4', at: NOW.toISOString() }, { mediaUrl: 'https://cdn.example/v.mp4', at: NOW.toISOString(), postId: 'post1' }]);
  }
});

test('tiktok public adds brand_organic; null post url is still success; youtube title is cut to 100', async () => {
  const h = rig({ post: () => Response.json({ post: { _id: 'p', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: null }] } }, { status: 201 }) });
  const r = run('tiktok', h, { visibility: 'public' });
  assert.deepEqual(await r.done, { postId: 'p', postUrl: null });
  const s = h.reqs.find((x) => x.path === '/posts')!.body.tiktokSettings;
  assert.equal(s.privacy_level, 'PUBLIC_TO_EVERYONE');
  assert.equal(s.commercialContentType, 'brand_organic');
  const h2 = rig();
  await run('youtube', h2, { title: 'x'.repeat(150) }).done;
  assert.equal(h2.reqs.find((x) => x.path === '/posts')!.body.platforms[0].platformSpecificData.title.length, 100);
});

test('handle with postId: GET only, no POST, no upload', async () => {
  const h = rig({ get: () => Response.json(post('youtube', 'published')) });
  const r = run('youtube', h, { handle: { mediaUrl: 'm', at: NOW.toISOString(), postId: 'post1' } });
  assert.equal((await r.done).postId, 'post1');
  assert.deepEqual(h.events, ['GET /posts/post1']);
  assert.equal(r.saved.length, 0);
});

test('handle without postId re-POSTs with the same key and stored mediaUrl; no new upload', async () => {
  const h = rig({ post: () => Response.json(post('youtube', 'published'), { status: 200 }) });
  const at = new Date(NOW.getTime() - 3600_000).toISOString();
  const r = run('youtube', h, { handle: { mediaUrl: 'https://cdn.example/old.mp4', at } });
  await r.done;
  assert.ok(!h.events.some((e) => e.includes('presign') || e.startsWith('PUT')));
  const p = h.reqs.find((x) => x.path === '/posts')!;
  assert.equal(p.headers['Idempotency-Key'], 'slot:youtube');
  assert.equal(p.body.mediaItems[0].url, 'https://cdn.example/old.mp4');
  assert.deepEqual(r.saved, [{ mediaUrl: 'https://cdn.example/old.mp4', at, postId: 'post1' }]);
});

test('a handle over 23 hours old without postId is ambiguous and makes no request', async () => {
  const h = rig();
  const at = new Date(NOW.getTime() - 24 * 3600_000).toISOString();
  await assert.rejects(run('youtube', h, { handle: { mediaUrl: 'm', at } }).done, AmbiguousError);
  assert.equal(h.reqs.length, 0);
});

test('409 with existingPostId is saved and resolved by GET', async () => {
  const h = rig({ post: () => Response.json({ error: 'dup', details: { existingPostId: 'old9' } }, { status: 409 }), get: () => Response.json({ post: { _id: 'old9', platforms: [{ platform: 'youtube', status: 'published', platformPostUrl: 'u9' }] } }) });
  const r = run('youtube', h);
  assert.deepEqual(await r.done, { postId: 'old9', postUrl: 'u9' });
  assert.deepEqual(r.saved.at(-1), { mediaUrl: 'https://cdn.example/v.mp4', at: NOW.toISOString(), postId: 'old9' });
  assert.equal(h.events.at(-1), 'GET /posts/old9');
});

test('error mapping: 207 failed permanent; 500, 409 conflict, 429 and network retryable; 400 permanent', async () => {
  const fail = Response.json(post('youtube', 'failed', { errorMessage: 'quota' }), { status: 207 });
  await assert.rejects(run('youtube', rig({ post: () => fail.clone() })).done, (e) => e instanceof PermanentError && /quota/.test(e.message));
  for (const [status, body] of [[500, {}], [503, {}], [429, {}], [409, { code: 'idempotency_conflict' }]] as const) {
    await assert.rejects(run('youtube', rig({ post: () => Response.json(body, { status }) })).done, RetryableError, String(status));
  }
  await assert.rejects(run('youtube', rig({ post: () => Response.json({ error: 'bad body' }, { status: 400 }) })).done, (e) => e instanceof PermanentError && /bad body/.test(e.message));
  const h = rig();
  const netFail = ((u: string, i: RequestInit) => (String(u).endsWith('/posts') ? Promise.reject(new TypeError('fetch failed')) : h.f(u, i))) as unknown as typeof fetch;
  await assert.rejects(run('youtube', { ...h, f: netFail }).done, RetryableError);
});

test('instagram private and unavailable tiktok privacy are permanent; no account is permanent', async () => {
  const h = rig();
  await assert.rejects(run('instagram', h).done, (e) => e instanceof PermanentError && /no private mode/.test(e.message));
  assert.equal(h.reqs.length, 0);
  const t = rig({ info: Response.json({ privacyLevels: [{ value: 'SELF_ONLY' }], postingLimits: {} }) });
  await assert.rejects(run('tiktok', t, { visibility: 'public' }).done, (e) => e instanceof PermanentError && /PUBLIC_TO_EVERYONE.*offered: SELF_ONLY/.test(e.message));
  assert.ok(!t.events.includes('POST /posts') && !t.events.includes('save'));
  const g = rig();
  const cfg = structuredClone(config);
  cfg.platforms.youtube.handle = 'nobody';
  const pubs = makePublishers(cfg, { fetch: g.f, now: () => NOW });
  await assert.rejects(pubs.youtube.publish({ filePath: file, title: 't', caption: 'c', aiDisclosure: false, visibility: 'private', idempotencyKey: 'k', handle: null, saveHandle() {}, signal: new AbortController().signal }), (e) => e instanceof PermanentError && /youtube.*nobody/.test(e.message));
});

test('publishing then published on poll; abort during poll is retryable', async () => {
  let n = 0;
  const waits: number[] = [];
  const h = rig({ post: () => Response.json(post('youtube', 'publishing'), { status: 201 }), get: () => Response.json(post('youtube', n++ < 1 ? 'publishing' : 'published')) });
  const r = run('youtube', h, {}, async (ms: number) => { waits.push(ms); });
  assert.equal((await r.done).postUrl, 'https://p/1');
  assert.deepEqual(waits, [10_000, 10_000]);

  const ac = new AbortController();
  const h2 = rig({ post: () => Response.json(post('youtube', 'pending'), { status: 201 }) });
  const r2 = run('youtube', h2, { signal: ac.signal }, async () => ac.abort());
  await assert.rejects(r2.done, (e) => e instanceof RetryableError && /still publishing/.test(e.message));
  assert.equal(r2.saved.at(-1) && (r2.saved.at(-1) as any).postId, 'post1');
});

test('no error message contains the key', async () => {
  const cases = [
    run('youtube', rig({ post: () => Response.json({ error: 'bad' }, { status: 401 }) })).done,
    run('youtube', rig({ post: () => Response.json({}, { status: 500 }) })).done,
    run('instagram', rig()).done,
  ];
  for (const c of cases) await c.then(() => assert.fail('should reject'), (e: Error) => assert.ok(!e.message.includes(KEY) && !/bearer/i.test(e.message)));
});

test('tiktok private is an inbox draft, also for a business account that is offered only the public level', async () => {
  const h = rig({ info: Response.json({ privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE' }], postingLimits: {} }) });
  await run('tiktok', h, { visibility: 'private' }).done;
  const s = h.reqs.find((x) => x.path === '/posts')!.body.tiktokSettings;
  assert.equal(s.draft, true);
  assert.equal(s.privacy_level, 'PUBLIC_TO_EVERYONE');
  assert.equal(s.commercialContentType, undefined);
});

test('the AI line is added to Facebook and Instagram captions only when aiDisclosure is true', async () => {
  for (const name of ['facebook', 'instagram', 'youtube', 'tiktok']) {
    for (const ai of [true, false]) {
      const h = rig({ post: () => Response.json(post(name, 'published'), { status: 201 }) });
      await run(name, h, { aiDisclosure: ai, visibility: 'public' }).done;
      const content = h.reqs.find((x) => x.path === '/posts')!.body.content;
      assert.equal(content, ai && (name === 'facebook' || name === 'instagram') ? 'cap' + AI_LINE : 'cap', `${name} ${ai}`);
    }
  }
});

test('requests to the bridge refuse redirects', async () => {
  const h = rig();
  await run('youtube', h).done;
  for (const r of h.reqs.filter((x) => x.path.startsWith('/'))) assert.equal(r.redirect, 'error', r.path);
});

test('listAccounts refuses redirects while it carries the key', async () => {
  const h = rig();
  await listAccounts(h.f, 'k', new AbortController().signal);
  assert.equal(h.reqs.find((x) => x.path === '/accounts')!.redirect, 'error');
});

test('a presign answer without a usable https URL is permanent and saves no handle', async () => {
  for (const presign of [{ uploadUrl: 'https://storage.example/up' }, { uploadUrl: 'http://storage.example/up', publicUrl: 'https://cdn.example/v.mp4' }]) {
    const h = rig({ presign });
    const r = run('youtube', h);
    await assert.rejects(r.done, (e) => e instanceof PermanentError && /no usable URL/.test(e.message));
    assert.equal(r.saved.length, 0);
    assert.ok(!h.events.some((e) => e.startsWith('PUT')));
  }
});

test('a post that stays publishing past the poll limit is retryable and its id is saved', async () => {
  const waits: number[] = [];
  const h = rig({ post: () => Response.json(post('youtube', 'publishing'), { status: 201 }), get: () => Response.json(post('youtube', 'publishing')) });
  const r = run('youtube', h, {}, async (ms: number) => { waits.push(ms); });
  await assert.rejects(r.done, (e) => e instanceof RetryableError && /still publishing/.test(e.message));
  assert.equal(waits.length, 9);
  assert.equal((r.saved.at(-1) as any).postId, 'post1');
});

test('reading a stored post: 404 is ambiguous, 503 retryable, cancelled permanent', async () => {
  const handle = { mediaUrl: 'm', at: NOW.toISOString(), postId: 'post1' };
  await assert.rejects(run('youtube', rig({ get: () => Response.json({ error: 'nope' }, { status: 404 }) }), { handle }).done, (e) => e instanceof AmbiguousError && /post1.*cannot be read: HTTP 404/.test(e.message));
  await assert.rejects(run('youtube', rig({ get: () => Response.json({}, { status: 503 }) }), { handle }).done, RetryableError);
  await assert.rejects(run('youtube', rig({ get: () => Response.json(post('youtube', 'cancelled')) }), { handle }).done, PermanentError);
});
