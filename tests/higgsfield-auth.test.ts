import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NeedsSignInError, accessToken, authorize, higgsfieldStatus, refresh, type AuthIo } from '../src/router/higgsfield-auth.ts';
import { fresh } from './helpers.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const ISS = 'https://clerk.higgsfield.ai';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

// Fake server for metadata, registration and the token endpoint.
function net(tokenReplies: (() => Response)[] = []) {
  const reqs: { url: string; body?: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    reqs.push({ url, body: init?.body?.toString() });
    if (url.endsWith('/oauth-protected-resource/mcp')) return json({ resource: 'https://mcp.higgsfield.ai/mcp', authorization_servers: [ISS] });
    if (url === ISS + '/.well-known/oauth-authorization-server') return json({ issuer: ISS, authorization_endpoint: ISS + '/oauth/authorize', token_endpoint: ISS + '/oauth/token', registration_endpoint: ISS + '/oauth/register' });
    if (url.endsWith('/oauth/register')) return json({ client_id: 'cid-1' }, 201);
    if (url.endsWith('/oauth/token')) return tokenReplies.shift()!();
    throw new Error('unexpected ' + url);
  }) as unknown as typeof fetch;
  return { f, reqs };
}

function io(f: typeof fetch, redirect: (authUrl: URL) => string, printed: string[] = []): AuthIo {
  return {
    fetch: f, print: (s) => printed.push(s),
    waitForRedirect: async () => redirect(new URL(printed.find((p) => p.includes('/oauth/authorize'))!.split('\n').pop()!)),
    open: (async () => ({ call: async () => ({ credits: 10, subscription_plan_type: 'ultra' }) })) as never,
  };
}
const ok = (u: URL) => `http://127.0.0.1:53682/callback?code=abc&state=${u.searchParams.get('state')}&iss=${encodeURIComponent(ISS)}`;
const tok = (o: object) => () => json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, ...o });

test('authorize: URL has PKCE S256 and state; code exchange has the right shape; tokens stored', async () => {
  const db = fresh();
  const { f, reqs } = net([tok({})]);
  const printed: string[] = [];
  await authorize(db, NOW, io(f, ok, printed));
  const u = new URL(printed[0].split('\n').pop()!);
  const q = u.searchParams;
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), 'cid-1');
  assert.equal(q.get('resource'), 'https://mcp.higgsfield.ai/mcp');
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:53682/callback');
  assert.ok(q.get('state')!.length >= 43);
  const ex = new URLSearchParams(reqs.find((r) => r.url.endsWith('/oauth/token'))!.body);
  assert.equal(ex.get('grant_type'), 'authorization_code');
  assert.equal(ex.get('code'), 'abc');
  assert.equal(ex.get('client_id'), 'cid-1');
  assert.equal(ex.get('redirect_uri'), 'http://127.0.0.1:53682/callback');
  assert.equal(ex.get('resource'), 'https://mcp.higgsfield.ai/mcp');
  assert.equal(createHash('sha256').update(ex.get('code_verifier')!).digest('base64url'), q.get('code_challenge'));
  assert.equal(accessToken(db), 'AT1');
  assert.equal(printed.at(-1), 'signed in: plan ultra, 10 credits');
  assert.equal(higgsfieldStatus(db, NOW), 'signed in, access token expires in 60 min, refresh token present');
  // a second sign-in reuses the stored client
  const n = net([tok({})]);
  await authorize(db, NOW, io(n.f, ok));
  assert.ok(!n.reqs.some((r) => r.url.endsWith('/oauth/register')));
});

test('authorize: wrong state, issuer mismatch and error parameter are rejected, nothing stored; a pasted URL works', async () => {
  const db = fresh();
  const bad = (suffix: (u: URL) => string) => authorize(db, NOW, io(net([tok({})]).f, suffix));
  await assert.rejects(bad(() => 'http://127.0.0.1:53682/callback?code=abc&state=nope'), /state/);
  await assert.rejects(bad((u) => `http://127.0.0.1:53682/callback?code=abc&state=${u.searchParams.get('state')}&iss=https%3A%2F%2Fevil.example`), /issuer/);
  await assert.rejects(bad((u) => `http://127.0.0.1:53682/callback?error=access_denied&state=${u.searchParams.get('state')}`), /access_denied/);
  assert.equal(accessToken(db), null);
  assert.equal(higgsfieldStatus(db, NOW), 'not signed in');
  await authorize(db, NOW, io(net([tok({})]).f, (u) => `  ${ok(u)}  \n`.trim())); // as pasted on stdin
  assert.equal(accessToken(db), 'AT1');
});

test('refresh: stores a rotated refresh token, keeps the old one when none returns, failure throws and keeps the row', async () => {
  const db = fresh();
  await authorize(db, NOW, io(net([tok({})]).f, ok));
  const later = new Date(NOW.getTime() + 7200_000);
  const r1 = net([tok({ access_token: 'AT2', refresh_token: 'RT2' })]);
  assert.equal(await refresh(db, later, r1.f), 'AT2');
  assert.match(r1.reqs.at(-1)!.body!, /grant_type=refresh_token/);
  assert.match(r1.reqs.at(-1)!.body!, /refresh_token=RT1/);
  assert.equal(await refresh(db, later, net([() => json({ access_token: 'AT3', expires_in: 60 })]).f), 'AT3');
  const r3 = net([() => json({ error: 'invalid_grant', refresh_token: 'LEAK' }, 400), tok({})]);
  await assert.rejects(refresh(db, later, r3.f), (e: Error) => e instanceof NeedsSignInError && !e.message.includes('LEAK'));
  assert.equal(accessToken(db), 'AT3');
  await refresh(db, later, r3.f);
  assert.match(r3.reqs.at(-1)!.body!, /refresh_token=RT2/); // RT2 survived the response that had none
});

test('auth: no token appears in log lines or errors', async () => {
  const db = fresh();
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => { lines.push(String(s)); return true; }) as never;
  try {
    await authorize(db, NOW, io(net([tok({})]).f, ok));
    const e = await refresh(db, NOW, net([() => json({ error: 'x', access_token: 'SECRETAT' }, 400)]).f).catch((x: Error) => x);
    assert.ok(!(e as Error).message.includes('SECRETAT'));
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(!lines.join('').includes('AT1') && !lines.join('').includes('RT1'));
});

test('discovery refuses an endpoint off higgsfield.ai; a refresh outage is not reported as a sign-in problem', async () => {
  const db = fresh();
  const evil = (async (url: string) =>
    url.endsWith('/oauth-protected-resource/mcp')
      ? json({ authorization_servers: [ISS] })
      : json({ issuer: ISS, authorization_endpoint: ISS + '/oauth/authorize', token_endpoint: 'https://evil.example/token', registration_endpoint: ISS + '/oauth/register' })) as unknown as typeof fetch;
  await assert.rejects(authorize(db, NOW, io(evil, ok)), /token_endpoint is not an https URL on higgsfield\.ai/);
  await authorize(db, NOW, io(net([tok({})]).f, ok));
  await assert.rejects(refresh(db, NOW, net([() => json({}, 503)]).f), (e: Error) => !(e instanceof NeedsSignInError) && /503/.test(e.message));
  assert.equal(accessToken(db), 'AT1');
});
