import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import raw from '../config/pipeline.config.ts';
import { parseConfig } from '../src/config/index.ts';
import { McpAuthError, type McpSession } from '../src/router/mcp.ts';
import { higgsfieldProvider } from '../src/router/higgsfield.ts';
import type { ClipJob } from '../src/router/index.ts';
import { fresh } from './helpers.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const cfgFor = (model = 'seedance_2_0') => parseConfig({ ...raw, tiers: { ...raw.tiers, t2: { ...raw.tiers.t2, model } } });
const signedIn = () => {
  const db = fresh();
  db.prepare("INSERT INTO oauth_tokens (provider, client_id, access_token, refresh_token, expires_at, updated_at) VALUES ('higgsfield','c','AT1','RT1',NULL,?)").run(NOW.toISOString());
  return db;
};
const img = () => { const p = join(mkdtempSync(join(tmpdir(), 'img-')), 'a.jpg'); writeFileSync(p, 'jpegbytes'); return p; };
const job = (o: Partial<ClipJob> = {}): ClipJob => ({ images: [img()], prompt: 'whole', shots: [{ prompt: 's1', seconds: 5 }, { prompt: 's2', seconds: 10 }], seconds: 15, signal: new AbortController().signal, ...o });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

// Scripted session: handlers by tool name; the call log is shared across sessions.
function rig(handlers: Record<string, (args: any, n: number) => unknown>, f?: typeof fetch) {
  const calls: { name: string; args: any; token: string }[] = [];
  const sleeps: number[] = [];
  const open = async (token: string): Promise<McpSession> => ({
    call: async (name, args) => {
      calls.push({ name, args, token });
      return handlers[name](args, calls.filter((c) => c.name === name).length);
    },
  });
  return { calls, sleeps, deps: { now: () => NOW, open, sleep: async (ms: number) => { sleeps.push(ms); }, fetch: f } };
}
const quote = (credits: number) => ({ cost: { credits, credits_exact: credits } });

test('check: refuses a quote above maxCredits and a low balance; passes otherwise; asks with get_cost and no medias', async () => {
  const c = cfgFor();
  const run = (balance: number, q: number) => {
    const r = rig({ balance: () => ({ credits: balance }), generate_video: () => quote(q) });
    return { r, p: higgsfieldProvider(signedIn(), c, r.deps).check!(job()) };
  };
  await assert.rejects(run(1000, 41).p, /41.*maxCredits 40/);
  await assert.rejects(run(330, 37.5).p, /330.*37.5.*keepCredits 300/);
  const ok = run(1000, 37.5);
  await ok.p;
  const g = ok.r.calls.find((x) => x.name === 'generate_video')!.args.params;
  assert.equal(g.get_cost, true);
  assert.equal(g.use_unlim, false);
  assert.equal(g.medias, undefined);
  assert.equal(g.mode, 'fast');
  assert.equal(g.multi_prompt, undefined);
});

test('submit: uploads, confirms, one generate_video with use_unlim false; kling gets multi_prompt', async () => {
  for (const model of ['seedance_2_0', 'kling_o3_image_reference']) {
    const puts: { url: string; type: string; body: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      puts.push({ url, type: (init.headers as any)['content-type'], body: await new Response(init.body as Blob).text() });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const r = rig({
      balance: () => ({ credits: 1000 }),
      media_upload: (a) => ({ uploads: [{ upload_url: 'https://up.example/put', media_id: 'm1', content_type: a.files[0].content_type }] }),
      media_confirm: () => ({ results: [{ media_id: 'm1', status: 'uploaded' }] }),
      generate_video: () => ({ results: [{ id: 'job-9', status: 'pending' }] }),
    }, f);
    const out = await higgsfieldProvider(signedIn(), cfgFor(model), r.deps).submit(job());
    assert.deepEqual(out, { jobId: 'job-9' });
    assert.deepEqual(r.calls.map((c) => c.name), ['balance', 'media_upload', 'media_confirm', 'generate_video']);
    assert.deepEqual(puts, [{ url: 'https://up.example/put', type: 'image/jpeg', body: 'jpegbytes' }]);
    assert.deepEqual(r.calls[2].args, { type: 'image', media_ids: ['m1'] });
    const p = r.calls[3].args.params;
    assert.equal(p.use_unlim, false);
    assert.equal(p.get_cost, undefined);
    assert.equal(p.aspect_ratio, '9:16');
    assert.equal(p.duration, 15);
    assert.deepEqual(p.medias, [{ role: 'image_references', value: 'm1' }]);
    assert.equal(p.prompt, 'whole');
    if (model.startsWith('kling')) {
      assert.equal(p.multi_shots, true);
      assert.deepEqual(p.multi_prompt, [{ prompt: 's1', duration: 5 }, { prompt: 's2', duration: 10 }]);
    } else assert.equal(p.multi_prompt, undefined);
  }
});

test('submit: an unlim_choice or empty results answer throws', async () => {
  for (const answer of [{ unlim_choice: { question: 'use unlim?' } }, { results: [] }]) {
    const r = rig({
      balance: () => ({}), media_upload: () => ({ uploads: [{ upload_url: 'https://up.example/p', media_id: 'm' }] }), media_confirm: () => ({}), generate_video: () => answer,
    }, (async () => new Response(null, { status: 200 })) as never);
    await assert.rejects(higgsfieldProvider(signedIn(), cfgFor(), r.deps).submit(job()), /did not return a job/);
  }
});

test('fetch: polls until completed, sleeps between polls, downloads; foreign host and http are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const f = (async (url: string) => new Response('VIDEO')) as unknown as typeof fetch;
  let polls = 0;
  const r = rig({ jobs_wait: () => (++polls < 3 ? { jobs: [{ status: 'in_progress' }], all_terminal: false, poll_after_seconds: 10 } : { jobs: [{ status: 'completed', result_url: 'https://d1.cloudfront.net/v.mp4' }], all_terminal: true }) }, f);
  const out = join(dir, 'v.mp4');
  await higgsfieldProvider(signedIn(), cfgFor(), r.deps).fetch('j', out, new AbortController().signal);
  assert.equal(readFileSync(out, 'utf8'), 'VIDEO');
  assert.deepEqual(r.sleeps, [10000, 10000]);
  assert.deepEqual(r.calls[0].args, { jobs: [{ index: 0, job_id: 'j' }], timeout_seconds: 15 });
  for (const url of ['https://evil.example.com/v.mp4', 'http://d1.cloudfront.net/v.mp4', 'https://cloudfront.net.evil.com/v.mp4']) {
    const r2 = rig({ jobs_wait: () => ({ jobs: [{ status: 'completed', result_url: url }], all_terminal: true }) }, f);
    await assert.rejects(higgsfieldProvider(signedIn(), cfgFor(), r2.deps).fetch('j', join(dir, 'x.mp4'), new AbortController().signal), /not allowed/);
  }
  const r3 = rig({ jobs_wait: () => ({ jobs: [{ status: 'failed' }], all_terminal: true }) });
  await assert.rejects(higgsfieldProvider(signedIn(), cfgFor(), r3.deps).fetch('j', join(dir, 'y.mp4'), new AbortController().signal), /ended as failed/);
});

test('fetch: a 401 mid-way refreshes once and retries once with the new token', async () => {
  const db = signedIn();
  const net = (async (url: string) => {
    if (url.endsWith('/oauth-protected-resource/mcp')) return json({ authorization_servers: ['https://clerk.higgsfield.ai'] });
    if (url.endsWith('/oauth-authorization-server')) return json({ issuer: 'https://clerk.higgsfield.ai', authorization_endpoint: 'https://clerk.higgsfield.ai/a', token_endpoint: 'https://clerk.higgsfield.ai/t', registration_endpoint: 'https://clerk.higgsfield.ai/r' });
    if (url === 'https://clerk.higgsfield.ai/t') return json({ access_token: 'AT2' });
    return new Response('VIDEO');
  }) as unknown as typeof fetch;
  const r = rig({ jobs_wait: (_a, n) => { if (n === 1) throw new McpAuthError('401'); return { jobs: [{ status: 'completed', result_url: 'https://x.higgsfield.ai/v.mp4' }], all_terminal: true }; } }, net);
  const out = join(mkdtempSync(join(tmpdir(), 'dl-')), 'v.mp4');
  await higgsfieldProvider(db, cfgFor(), r.deps).fetch('j', out, new AbortController().signal);
  assert.deepEqual(r.calls.map((c) => c.token), ['AT1', 'AT2']);
});

test('submit: a 401 on the cheap balance call refreshes first; generate_video is sent once, never retried', async () => {
  const db = signedIn();
  const net = (async (url: string) => {
    if (url.endsWith('/oauth-protected-resource/mcp')) return json({ authorization_servers: ['https://clerk.higgsfield.ai'] });
    if (url.endsWith('/oauth-authorization-server')) return json({ issuer: 'https://clerk.higgsfield.ai', authorization_endpoint: 'https://clerk.higgsfield.ai/a', token_endpoint: 'https://clerk.higgsfield.ai/t', registration_endpoint: 'https://clerk.higgsfield.ai/r' });
    if (url === 'https://clerk.higgsfield.ai/t') return json({ access_token: 'AT2' });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const r = rig({
    balance: (_a, n) => { if (n === 1) throw new McpAuthError('401'); return {}; },
    media_upload: () => ({ uploads: [{ upload_url: 'https://up.example/p', media_id: 'm' }] }), media_confirm: () => ({}),
    generate_video: () => { throw new McpAuthError('401'); },
  }, net);
  await assert.rejects(higgsfieldProvider(db, cfgFor(), r.deps).submit(job()), McpAuthError);
  assert.equal(r.calls.filter((c) => c.name === 'generate_video').length, 1);
  assert.equal(r.calls.find((c) => c.name === 'generate_video')!.token, 'AT2');
});
