import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import type { Db } from '../db/index.ts';
import { log } from '../ops/log.ts';
import { openMcp } from './mcp.ts';

export const MCP_URL = 'https://mcp.higgsfield.ai/mcp';
const RESOURCE_META = 'https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const SCOPE = 'openid email offline_access';
const PROVIDER = 'higgsfield';

export class NeedsSignInError extends Error {}

export type AuthIo = {
  fetch: typeof fetch;
  print: (s: string) => void;
  // Resolves with the full redirect URL, from the local listener or a line pasted on stdin.
  waitForRedirect: (signal: AbortSignal) => Promise<string>;
  open: typeof openMcp;
};

type Meta = { issuer: string; authorize: string; token: string; register: string };
type Row = { client_id: string; access_token: string; refresh_token: string | null; expires_at: string | null };

const b64u = (b: Buffer) => b.toString('base64url');
// Codes and tokens are sent to these endpoints, so each must be https on Higgsfield's own domain.
const https = (u: unknown, what: string): string => {
  if (typeof u !== 'string' || !u.startsWith('https://') || !/(^|\.)higgsfield\.ai$/.test(new URL(u).hostname)) throw new Error(`${what} is not an https URL on higgsfield.ai`);
  return u;
};

async function getJson(f: typeof fetch, url: string): Promise<any> {
  const r = await f(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GET ${url} answered ${r.status}`);
  return r.json();
}

async function discover(f: typeof fetch): Promise<Meta> {
  const res = await getJson(f, RESOURCE_META);
  const issuer = https(res.authorization_servers?.[0], 'authorization server').replace(/\/$/, '');
  const m = await getJson(f, `${issuer}/.well-known/oauth-authorization-server`);
  if (String(m.issuer ?? '').replace(/\/$/, '') !== issuer) throw new Error('authorization server metadata names a different issuer');
  return { issuer, authorize: https(m.authorization_endpoint, 'authorization_endpoint'), token: https(m.token_endpoint, 'token_endpoint'), register: https(m.registration_endpoint, 'registration_endpoint') };
}

const row = (db: Db) => db.prepare('SELECT client_id, access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?').get(PROVIDER) as Row | undefined;

function store(db: Db, now: Date, clientId: string, t: any, old?: Row) {
  if (typeof t?.access_token !== 'string' || !t.access_token) throw new Error('token response has no access_token');
  const refresh = typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : old?.refresh_token ?? null; // keep the old one when none comes back
  const exp = typeof t.expires_in === 'number' ? new Date(now.getTime() + t.expires_in * 1000).toISOString() : null;
  db.prepare('INSERT INTO oauth_tokens (provider, client_id, access_token, refresh_token, expires_at, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET client_id = excluded.client_id, access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at')
    .run(PROVIDER, clientId, t.access_token, refresh, exp, now.toISOString());
}

async function tokenRequest(f: typeof fetch, url: string, form: Record<string, string>): Promise<any> {
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw Object.assign(new Error(`token endpoint answered ${r.status}`), { status: r.status }); // the body can echo secrets: not included
  return r.json();
}

export function defaultIo(): AuthIo {
  return {
    fetch, open: openMcp, print: (s) => console.log(s),
    waitForRedirect: (signal) => new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: process.stdin });
      const server = createServer((req, res) => {
        if (!req.url?.startsWith('/callback')) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', 'text/plain');
        res.end('You can close this tab.');
        end(() => resolve('http://127.0.0.1:53682' + req.url));
      });
      const end = (f: () => void) => { rl.close(); server.close(); server.closeAllConnections(); signal.removeEventListener('abort', onAbort); f(); };
      const onAbort = () => end(() => reject(new Error('timed out waiting for sign-in')));
      signal.addEventListener('abort', onAbort);
      rl.on('line', (l) => l.trim() && end(() => resolve(l.trim())));
      server.on('error', (e) => log.warn('callback listener failed; paste the redirect URL instead', { error: String(e) }));
      server.listen(53682, '127.0.0.1');
    }),
  };
}

export async function authorize(db: Db, now: Date, io: AuthIo = defaultIo()): Promise<void> {
  const meta = await discover(io.fetch);
  let clientId = row(db)?.client_id;
  if (!clientId) {
    const r = await io.fetch(meta.register, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ client_name: 'ad-pipeline', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE }),
    });
    if (!r.ok) throw new Error(`client registration answered ${r.status}`);
    clientId = ((await r.json()) as { client_id?: string }).client_id;
    if (!clientId) throw new Error('registration returned no client_id');
  }
  const state = b64u(randomBytes(32));
  const verifier = b64u(randomBytes(32));
  const u = new URL(meta.authorize);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: SCOPE, state, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: MCP_URL })) u.searchParams.set(k, v);
  io.print('Open this URL in a browser and sign in. If the browser cannot reach this machine, paste the full URL it ends up on here and press Enter:\n' + u.href);

  const redirect = new URL(await io.waitForRedirect(AbortSignal.timeout(10 * 60_000)));
  const q = redirect.searchParams;
  if (q.get('error')) throw new Error('sign-in refused: ' + q.get('error'));
  if (q.get('state') !== state) throw new Error('sign-in rejected: state does not match');
  const iss = q.get('iss');
  if (iss && iss.replace(/\/$/, '') !== meta.issuer) throw new Error('sign-in rejected: issuer does not match');
  const code = q.get('code');
  if (!code) throw new Error('redirect carries no code');

  const t = await tokenRequest(io.fetch, meta.token, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: MCP_URL });
  store(db, now, clientId, t, row(db));
  const s = await io.open({ url: MCP_URL, token: row(db)!.access_token, fetch: io.fetch, signal: AbortSignal.timeout(30_000) });
  const b = (await s.call('balance', {})) as { credits: number; subscription_plan_type: string };
  io.print(`signed in: plan ${b.subscription_plan_type}, ${b.credits} credits`);
}

export const accessToken = (db: Db): string | null => row(db)?.access_token || null;

// shortcut: no lock around refresh, because only one producer runs at a time. Add one (a row lock or a kv claim)
// before running two producers, or a rotated refresh token could be used twice and revoke the session.
export async function refresh(db: Db, now: Date, f: typeof fetch = fetch): Promise<string> {
  const old = row(db);
  if (!old?.refresh_token) throw new NeedsSignInError('no refresh token stored');
  try {
    const meta = await discover(f);
    const t = await tokenRequest(f, meta.token, { grant_type: 'refresh_token', client_id: old.client_id, refresh_token: old.refresh_token, resource: MCP_URL });
    store(db, now, old.client_id, t, old);
    return row(db)!.access_token;
  } catch (e) {
    // Only a refusal by the authorization server means a new sign-in. An outage is an ordinary failure and is retried later.
    const status = (e as { status?: number }).status;
    if (status === 400 || status === 401 || status === 403) throw new NeedsSignInError(`refresh refused (HTTP ${status})`);
    throw e;
  }
}

export function higgsfieldStatus(db: Db, now: Date): string {
  const r = row(db);
  if (!r?.access_token) return 'not signed in';
  const exp = r.expires_at ? `expires in ${Math.round((Date.parse(r.expires_at) - now.getTime()) / 60000)} min` : 'expiry unknown';
  return `signed in, access token ${exp}, refresh token ${r.refresh_token ? 'present' : 'absent'}`;
}
