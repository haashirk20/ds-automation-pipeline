import { openAsBlob, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import type { ClipJob, ClipProvider } from './index.ts';
import { JobEndedError } from './errors.ts';
import { MCP_URL, NeedsSignInError, accessToken, refresh } from './higgsfield-auth.ts';
import { McpAuthError, openMcp, type McpSession } from './mcp.ts';

export type HiggsDeps = {
  now: () => Date;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  open?: (token: string, signal?: AbortSignal) => Promise<McpSession>;
  pollMs?: number; // test seam: how long one fetch may poll
};

const POLL_MS = 25 * 60_000; // one fetch polls for this long, then the slot's next try polls again
const MAX_VIDEO = 300 * 1024 * 1024;
const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const IMAGE_MS = 2 * 60_000;
const VIDEO_MS = 10 * 60_000;
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

  // The quote must be a number above zero and the answer must not hold a started job. Anything else stops clips.
  const priced = (g: Gen): number => {
    const q = g.cost?.credits_exact ?? g.cost?.credits;
    if (g.results?.length || typeof q !== 'number' || !Number.isFinite(q) || q <= 0) throw new Error('the quote call did not return a quote: clips are stopped');
    return q;
  };
  const balanceOf = (b: { credits?: unknown }): number => {
    if (typeof b.credits !== 'number' || !Number.isFinite(b.credits)) throw new Error('Higgsfield returned no valid balance');
    return b.credits;
  };
  const keep = t.keepCredits ?? 0;

  const limits = (credits: number, quote: number) => {
    if (t.maxCredits !== undefined && quote > t.maxCredits) throw new Error(`quote ${quote} credits is above maxCredits ${t.maxCredits}`);
    if (credits - quote < keep) throw new Error(`balance ${credits} credits minus quote ${quote} would leave fewer than keepCredits ${keep}`);
  };

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
      const credits = balanceOf(await c.call('balance', {}));
      // shortcut: if the server starts a job on a quote call, this repeats once per slot until the owner acts on the alert, bounded by keepCredits; add a stop flag if it ever happens
      const quote = priced((await c.call('generate_video', { params: params(job, { get_cost: true }) })) as Gen);
      limits(credits, quote);
    },

    async submit(job) {
      const c = await connect(job.signal);
      const credits = balanceOf(await c.call('balance', {})); // also proves the token works, so the paid call below is sent once with a good one
      const files = job.images.map((p) => ({ filename: path.basename(p), content_type: TYPES[path.extname(p).toLowerCase()] ?? '' }));
      const bad = files.find((x) => !x.content_type);
      if (bad) throw new Error('unsupported image type: ' + bad.filename);
      const up = (await c.call('media_upload', { files })) as { uploads?: { upload_url: string; media_id: string; content_type?: string }[] };
      if (up.uploads?.length !== files.length) throw new Error('media_upload returned the wrong number of uploads');
      for (const [i, u] of up.uploads.entries()) {
        if (!u.upload_url?.startsWith('https://')) throw new Error('upload URL is not https');
        const r = await f(u.upload_url, { method: 'PUT', headers: { 'content-type': files[i].content_type }, body: await openAsBlob(job.images[i]), signal: AbortSignal.any([job.signal, AbortSignal.timeout(IMAGE_MS)]) });
        if (!r.ok) throw new Error(`image upload answered ${r.status}`);
      }
      await c.call('media_confirm', { type: 'image', media_ids: up.uploads.map((u) => u.media_id) });
      const exact = params(job, { medias: up.uploads.map((u) => ({ role: 'image_references', value: u.media_id })) });
      limits(credits, priced((await c.call('generate_video', { params: { ...exact, get_cost: true } })) as Gen)); // the request as it is sent, images included
      const g = (await c.call('generate_video', { params: exact }, true)) as Gen;
      const id = g.results?.[0]?.id;
      if (!id || typeof id !== 'string') throw new Error('generate_video did not return a job: ' + JSON.stringify(g).slice(0, 200));
      return { jobId: id };
    },

    async fetch(jobId, outFile, signal) {
      const c = await connect(signal);
      let wait = 10;
      const polling = AbortSignal.any([signal, AbortSignal.timeout(deps.pollMs ?? POLL_MS)]);
      while (!polling.aborted) {
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        const r = (await c.call('jobs_wait', { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 15 })) as { jobs?: { status?: string; result_url?: string }[]; all_terminal?: boolean; poll_after_seconds?: number };
        const j = r.jobs?.[0];
        if (j?.status === 'completed') {
          if (!j.result_url) throw new JobEndedError('completed job has no result_url');
          return download(j.result_url, outFile, signal);
        }
        if (r.all_terminal) throw new JobEndedError(`Higgsfield job ended as ${j?.status ?? 'unknown'}`);
        const w = r.poll_after_seconds;
        if (typeof w === 'number' && Number.isFinite(w)) wait = Math.min(60, Math.max(5, w));
        await sleep(wait * 1000, polling);
      }
      throw new Error('Higgsfield job still running after 25 minutes');
    },
  };

  async function download(url: string, outFile: string, signal: AbortSignal) {
    let u: URL;
    try { u = new URL(url); } catch { throw new JobEndedError('result URL is not a URL'); }
    if (u.protocol !== 'https:' || !/(^|\.)(cloudfront\.net|higgsfield\.ai)$/.test(u.hostname)) throw new JobEndedError('result URL host not allowed: ' + u.hostname);
    const r = await f(u.href, { signal: AbortSignal.any([signal, AbortSignal.timeout(VIDEO_MS)]), redirect: 'error' });
    if (!r.ok || !r.body) throw new Error(`video download answered ${r.status}`);
    let n = 0;
    await pipeline(Readable.fromWeb(r.body as never), new Transform({ transform(chunk, _e, cb) { n += chunk.length; cb(n > MAX_VIDEO ? new JobEndedError('video larger than 300 MB') : null, chunk); } }), createWriteStream(outFile), { signal });
  }
}
