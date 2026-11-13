import { openAsBlob, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import type { ClipJob, ClipProvider } from './index.ts';
import { MCP_URL, NeedsSignInError, accessToken, refresh } from './higgsfield-auth.ts';
import { McpAuthError, McpToolError, openMcp, type McpSession } from './mcp.ts';

export type HiggsDeps = {
  now: () => Date;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  open?: (token: string, signal?: AbortSignal) => Promise<McpSession>;
};

const MAX_POLLS = 60; // about 25 minutes: each poll is a 15 s long-poll plus the server's poll_after_seconds
const MAX_VIDEO = 300 * 1024 * 1024;
const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

type Gen = { results?: { id?: string }[]; cost?: { credits?: number; credits_exact?: number } };

export function higgsfieldProvider(db: Db, config: Config, deps: HiggsDeps): ClipProvider {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const open = deps.open ?? ((token, signal) => openMcp({ url: MCP_URL, token, fetch: f, signal }));
  // Tier 2 is the Higgsfield tier; if both tiers name it, t2 wins.
  const t = [config.tiers.t2, config.tiers.t1].find((x) => x.provider === 'higgsfield') ?? config.tiers.t2;

  // A session that refreshes the token once and retries on a 401. `once` calls are never retried.
  async function connect(signal?: AbortSignal) {
    let s!: McpSession;
    const mk = async () => {
      const tok = accessToken(db);
      if (!tok) throw new NeedsSignInError('not signed in');
      s = await open(tok, signal);
    };
    const renew = async () => { await refresh(db, deps.now(), f); await mk(); };
    try { await mk(); } catch (e) { if (!(e instanceof McpAuthError)) throw e; await renew(); }
    return {
      async call(name: string, args: unknown, once = false): Promise<any> {
        try { return await s.call(name, args); } catch (e) {
          if (once || !(e instanceof McpAuthError)) throw e;
          await renew();
          return s.call(name, args);
        }
      },
    };
  }

  const params = (job: ClipJob, extra: Record<string, unknown>) => ({
    model: t.model, prompt: job.prompt, aspect_ratio: '9:16', duration: job.seconds, use_unlim: false, ...t.params,
    ...(t.model.startsWith('kling_o3') && job.shots.length ? { multi_shots: true, multi_prompt: job.shots.map((x) => ({ prompt: x.prompt, duration: x.seconds })) } : {}),
    ...extra,
  });

  return {
    name: 'higgsfield',
    configured: () => accessToken(db) !== null,

    async check(job) {
      const c = await connect(job.signal);
      const credits = ((await c.call('balance', {})) as { credits?: number }).credits;
      const g = (await c.call('generate_video', { params: params(job, { get_cost: true }) })) as Gen;
      const quote = g.cost?.credits_exact ?? g.cost?.credits;
      if (typeof credits !== 'number' || typeof quote !== 'number') throw new Error('Higgsfield returned no balance or quote');
      if (t.maxCredits !== undefined && quote > t.maxCredits) throw new Error(`quote ${quote} credits is above maxCredits ${t.maxCredits}`);
      if (credits - quote < (t.keepCredits ?? 0)) throw new Error(`balance ${credits} credits minus quote ${quote} would leave fewer than keepCredits ${t.keepCredits ?? 0}`);
    },

    async submit(job) {
      const c = await connect(job.signal);
      await c.call('balance', {}); // proves the token works, so the paid call below is sent once with a good one
      const files = job.images.map((p) => ({ filename: path.basename(p), content_type: TYPES[path.extname(p).toLowerCase()] ?? '' }));
      const bad = files.find((x) => !x.content_type);
      if (bad) throw new Error('unsupported image type: ' + bad.filename);
      const up = (await c.call('media_upload', { files })) as { uploads?: { upload_url: string; media_id: string; content_type?: string }[] };
      if (up.uploads?.length !== files.length) throw new Error('media_upload returned the wrong number of uploads');
      for (const [i, u] of up.uploads.entries()) {
        if (!u.upload_url?.startsWith('https://')) throw new Error('upload URL is not https');
        const r = await f(u.upload_url, { method: 'PUT', headers: { 'content-type': files[i].content_type }, body: await openAsBlob(job.images[i]), signal: job.signal });
        if (!r.ok) throw new Error(`image upload answered ${r.status}`);
      }
      await c.call('media_confirm', { type: 'image', media_ids: up.uploads.map((u) => u.media_id) });
      const g = (await c.call('generate_video', { params: params(job, { medias: up.uploads.map((u) => ({ role: 'image_references', value: u.media_id })) }) }, true)) as Gen;
      const id = g.results?.[0]?.id;
      if (!id || typeof id !== 'string') throw new Error('generate_video did not return a job: ' + JSON.stringify(g).slice(0, 200));
      return { jobId: id };
    },

    async fetch(jobId, outFile, signal) {
      const c = await connect(signal);
      let wait = 10;
      for (let i = 0; i < MAX_POLLS; i++) {
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        const r = (await c.call('jobs_wait', { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 15 })) as { jobs?: { status?: string; result_url?: string }[]; all_terminal?: boolean; poll_after_seconds?: number };
        const j = r.jobs?.[0];
        if (j?.status === 'completed') {
          if (!j.result_url) throw new McpToolError('completed job has no result_url');
          return download(j.result_url, outFile, signal);
        }
        if (r.all_terminal) throw new Error(`Higgsfield job ended as ${j?.status ?? 'unknown'}`);
        wait = r.poll_after_seconds ?? wait;
        await sleep(wait * 1000, signal);
      }
      throw new Error('Higgsfield job still running after 25 minutes');
    },
  };

  async function download(url: string, outFile: string, signal: AbortSignal) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)(cloudfront\.net|higgsfield\.ai)$/.test(u.hostname)) throw new Error('result URL host not allowed: ' + u.hostname);
    const r = await f(u.href, { signal, redirect: 'error' });
    if (!r.ok || !r.body) throw new Error(`video download answered ${r.status}`);
    let n = 0;
    await pipeline(Readable.fromWeb(r.body as never), new Transform({ transform(chunk, _e, cb) { n += chunk.length; cb(n > MAX_VIDEO ? new Error('video larger than 300 MB') : null, chunk); } }), createWriteStream(outFile), { signal });
  }
}
