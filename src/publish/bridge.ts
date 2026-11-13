import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { env } from '../config/index.ts';
import { AmbiguousError, PermanentError, RetryableError, type Publisher } from './types.ts';

// Every platform publishes through the hosted bridge (Zernio); see docs/PLATFORMS.md.
const BASE = 'https://zernio.com/api/v1';
const POLL_MS = 10_000;
const KEY_TTL_MS = 23 * 3600_000; // the bridge forgets an Idempotency-Key after 24 h
const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type BridgeDeps = {
  fetch: typeof fetch;
  now: () => Date; // supplied by cli.ts
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

export const abortableSleep: BridgeDeps['sleep'] = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

type Handle = { mediaUrl: string; at: string; postId?: string };
type Account = { _id: string; platform: string; username?: string; displayName?: string; isActive?: boolean };
type Post = { _id: string; status?: string; platforms?: { platform: string; status?: string; platformPostUrl?: string | null; errorMessage?: string | null }[] };
type Res = { status: number; body: any };
type PlatformConfig = { handle: string };

const norm = (s: string | undefined) => (s ?? '').trim().replace(/^@/, '').toLowerCase();

export async function listAccounts(f: typeof fetch, key: string, signal: AbortSignal): Promise<Account[]> {
  const res = await f(`${BASE}/accounts`, { headers: { authorization: `Bearer ${key}` }, signal });
  if (!res.ok) throw new Error(`bridge GET /accounts: HTTP ${res.status}`);
  return ((await res.json()) as { accounts?: Account[] }).accounts ?? [];
}

export function findAccount(accounts: Account[], platform: string, handle: string): Account | undefined {
  const want = norm(handle);
  return accounts.find((a) => a.platform === platform && a.isActive !== false && (norm(a.username) === want || (platform === 'facebook' && norm(a.displayName) === want)));
}

export function makeBridgePublisher(platform: string, cfg: PlatformConfig, deps: BridgeDeps): Publisher {
  return {
    platform,
    async publish(input) {
      const { signal } = input;
      const key = env.bridgeKey();
      if (!key) throw new PermanentError('BRIDGE_API_KEY is not set');
      if (platform === 'instagram' && input.visibility === 'private') throw new PermanentError('instagram has no private mode; set its visibility to public or disable it');

      // The key never appears in an error: messages carry only the method, path, status and the bridge's own text.
      async function call(method: string, path: string, init: { json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
        let res: Response;
        try {
          res = await deps.fetch(BASE + path, {
            method,
            headers: { authorization: `Bearer ${key}`, ...(init.json ? { 'content-type': 'application/json' } : {}), ...init.headers },
            body: init.json ? JSON.stringify(init.json) : undefined,
            signal: AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)]),
          });
        } catch {
          throw new RetryableError(`bridge ${method} ${path}: no response (network error, timeout or abort)`);
        }
        const body = await res.json().catch(() => ({}));
        return { status: res.status, body };
      }
      const reason = (r: Res) => String(r.body?.error ?? r.body?.message ?? 'no message');
      // Throws for anything that is not 2xx; the caller handles the 409 cases it expects first.
      function ok(method: string, path: string, r: Res): Res {
        if (r.status >= 200 && r.status < 300) return r;
        const msg = `bridge ${method} ${path}: HTTP ${r.status}: ${reason(r)}`;
        if (r.status === 429 || r.status >= 500 || r.body?.code === 'idempotency_conflict') throw new RetryableError(msg);
        throw new PermanentError(msg);
      }

      const handle = parseHandle(input.handle);
      async function resolve(postId: string, first?: Post): Promise<{ postId: string; postUrl: string | null }> {
        let post = first;
        for (;;) {
          if (!post) {
            if (signal.aborted) throw new RetryableError('still publishing');
            post = ok('GET', `/posts/${postId}`, await call('GET', `/posts/${encodeURIComponent(postId)}`)).body.post as Post;
          }
          const entry = post.platforms?.find((p) => p.platform === platform);
          const status = entry?.status ?? post.status;
          if (status === 'published') return { postId, postUrl: entry?.platformPostUrl ?? null };
          if (status === 'failed') throw new PermanentError(`bridge: ${platform} publish failed: ${entry?.errorMessage ?? 'no message'}`);
          post = undefined;
          await deps.sleep(POLL_MS, signal);
          if (signal.aborted) throw new RetryableError('still publishing');
        }
      }

      if (handle?.postId) return resolve(handle.postId);
      if (handle && !(deps.now().getTime() - Date.parse(handle.at) <= KEY_TTL_MS)) {
        throw new AmbiguousError('bridge: a post request was sent over 23 hours ago and its idempotency key has expired; check the platform');
      }

      // Nothing below creates a post until saveHandle has run.
      const account = findAccount(ok('GET', '/accounts', await call('GET', '/accounts')).body.accounts ?? [], platform, cfg.handle);
      if (!account) throw new PermanentError(`bridge: no active ${platform} account for handle ${cfg.handle}`);
      const body: Record<string, unknown> = { content: input.caption, publishNow: true, platforms: [{ platform, accountId: account._id }] };
      const entry = (body.platforms as { platformSpecificData?: unknown }[])[0];
      const title = input.title.slice(0, 100);
      if (platform === 'youtube') entry.platformSpecificData = { title, visibility: input.visibility, madeForKids: false, containsSyntheticMedia: input.aiDisclosure };
      else if (platform === 'facebook') {
        entry.platformSpecificData = { contentType: 'reel', title };
        if (input.visibility === 'private') body.facebookSettings = { draft: true };
      } else if (platform === 'tiktok') {
        const wanted = input.visibility === 'public' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY';
        const info = ok('GET', '/tiktok/creator-info', await call('GET', `/accounts/${encodeURIComponent(account._id)}/tiktok/creator-info?mediaType=video`)).body;
        const offered: string[] = (info.privacyLevels ?? []).map((l: { value: string }) => l.value);
        if (!offered.includes(wanted)) throw new PermanentError(`tiktok does not offer privacy level ${wanted} for this account; offered: ${offered.join(', ') || 'none'}`);
        const i = info.postingLimits?.interactionSettings ?? {};
        body.tiktokSettings = {
          privacy_level: wanted,
          allow_comment: i.allow_comment?.enabled !== false,
          allow_duet: i.allow_duet?.enabled !== false,
          allow_stitch: i.allow_stitch?.enabled !== false,
          content_preview_confirmed: true,
          express_consent_given: true,
          video_made_with_ai: input.aiDisclosure,
          ...(input.visibility === 'public' ? { commercialContentType: 'brand_organic' } : {}),
        };
      }

      let mediaUrl = handle?.mediaUrl;
      if (!mediaUrl) {
        const size = (await openAsBlob(input.filePath)).size;
        const pre = ok('POST', '/media/presign', await call('POST', '/media/presign', { json: { filename: basename(input.filePath), contentType: 'video/mp4', size } })).body;
        let put: Response;
        try {
          put = await deps.fetch(pre.uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: await openAsBlob(input.filePath), signal: AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]) });
        } catch {
          throw new RetryableError('bridge: media upload failed (network error, timeout or abort)');
        }
        if (!put.ok) throw new (put.status >= 500 || put.status === 429 ? RetryableError : PermanentError)(`bridge: media upload: HTTP ${put.status}`);
        mediaUrl = pre.publicUrl as string;
      }
      body.mediaItems = [{ type: 'video', url: mediaUrl }];
      const saved: Handle = handle ?? { mediaUrl, at: deps.now().toISOString() };
      if (!handle) input.saveHandle(saved);

      const r = await call('POST', '/posts', { json: body, headers: { 'Idempotency-Key': input.idempotencyKey } });
      const existing = r.status === 409 && r.body?.code !== 'idempotency_conflict' ? r.body?.details?.existingPostId : undefined;
      if (typeof existing === 'string') {
        input.saveHandle({ ...saved, postId: existing });
        return resolve(existing);
      }
      const post = ok('POST', '/posts', r).body.post as Post;
      input.saveHandle({ ...saved, postId: post._id });
      return resolve(post._id, post);
    },
  };
}

function parseHandle(h: unknown): Handle | null {
  if (h === null || h === undefined) return null;
  const x = h as Partial<Handle>;
  if (typeof x.mediaUrl !== 'string' || typeof x.at !== 'string') throw new AmbiguousError('bridge: stored handle is unreadable');
  return { mediaUrl: x.mediaUrl, at: x.at, postId: typeof x.postId === 'string' ? x.postId : undefined };
}
