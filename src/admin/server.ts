import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { audit } from '../config/overrides.ts';
import { kvGet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { clearCookie, clearLockout, cookieOf, COOKIE, createSession, destroySession, getSession, hostAllowed, isLocked, loginFailed, safeEqual, sessionCookie, verifyPassword } from './auth.ts';
import * as media from './media.ts';
import * as models from './models.ts';
import * as music from './music.ts';
import * as pages from './pages.ts';
import * as posts from './posts.ts';
import type { Ctx, Res } from './pages.ts';
import { CSS } from './style.ts';

const MAX_BODY = 256 * 1024;
const MAX_PASSWORD = 1024;

// Fixed on every response. There is no CORS.
const HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  // Not no-referrer: under that policy browsers send 'Origin: null' on form POSTs and the Origin check refuses every login.
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

type Route = { auth: boolean; h: (c: Ctx) => Res | Promise<Res> };
const ROUTES: Record<string, Route> = {
  'GET /': { auth: true, h: pages.overviewPage },
  'GET /overview': { auth: true, h: pages.overviewPage },
  'GET /settings': { auth: true, h: pages.settingsPage },
  'POST /settings/preview': { auth: true, h: pages.settingsPreview },
  'POST /settings/save': { auth: true, h: pages.settingsSave },
  'GET /posts': { auth: true, h: posts.postsPage },
  'POST /posts/new': { auth: true, h: posts.postNew },
  'POST /posts/approve': { auth: true, h: posts.postApprove },
  'POST /posts/discard': { auth: true, h: posts.postDiscard },
  'GET /media/render': { auth: true, h: media.mediaRender },
  'GET /media/music': { auth: true, h: media.mediaMusic },
  'GET /music': { auth: true, h: (c) => music.musicPage(c) },
  'POST /music/upload': { auth: true, h: () => pages.notFound(null) }, // handled before the body is read
  'POST /music/select': { auth: true, h: music.musicSelect },
  'POST /music/delete': { auth: true, h: music.musicDelete },
  'GET /models': { auth: true, h: (c) => models.modelsPage(c) },
  'POST /models/add': { auth: true, h: models.modelAdd },
  'POST /models/remove': { auth: true, h: models.modelRemove },
  'GET /prompts': { auth: true, h: pages.promptsPage },
  'GET /prompts/view': { auth: true, h: pages.promptView },
  'GET /prompts/edit': { auth: true, h: (c) => pages.promptEdit(c) },
  'POST /prompts/preview': { auth: true, h: pages.promptPreview },
  'POST /prompts/save': { auth: true, h: pages.promptSave },
  'GET /prompts/history': { auth: true, h: pages.promptHistory },
  'POST /prompts/activate': { auth: true, h: pages.promptActivate },
  'GET /activity': { auth: true, h: pages.activityPage },
  'GET /history': { auth: true, h: pages.historyPage },
  'POST /history/activate': { auth: true, h: pages.historyActivate },
};

export type AdminOpts = { now: () => Date; hosts: string[] };

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const plain = (status: number, text: string): Res => ({ status, body: text, type: 'text/plain; charset=utf-8' });

async function handle(db: Db, opts: AdminOpts, req: IncomingMessage): Promise<Res> {
  const host = req.headers.host;
  // DNS rebinding: only the loopback names and ADMIN_HOSTS are served.
  if (!hostAllowed(host, opts.hosts)) return plain(421, 'Misdirected request');
  const method = req.method ?? '';
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (method !== 'GET' && method !== 'POST') return { ...plain(405, 'Method not allowed'), headers: { allow: 'GET, POST' } };
  const now = opts.now();

  if (method === 'GET' && path === '/style.css') return { status: 200, body: CSS, type: 'text/css; charset=utf-8' };
  if (method === 'GET' && path === '/healthz') {
    try {
      db.prepare('SELECT 1').get();
      return plain(200, 'ok');
    } catch {
      return plain(503, 'database unavailable');
    }
  }
  const isLogin = path === '/login';
  const isLogout = method === 'POST' && path === '/logout';
  const route = ROUTES[`${method} ${path}`];
  if (!route && !(isLogin && (method === 'GET' || method === 'POST')) && !isLogout) return pages.notFound(null);

  const sameOrigin = (): boolean => {
    if (req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return false;
    const sfs = req.headers['sec-fetch-site'];
    return sfs === undefined || sfs === 'same-origin';
  };

  // The one multipart route. The session is checked before any body is read; the csrf field is checked after parsing.
  if (method === 'POST' && path === '/music/upload') {
    const s = getSession(db, cookieOf(req.headers.cookie, COOKIE), now);
    const close = (r: Res): Res => ({ ...r, headers: { ...r.headers, connection: 'close' } }); // the body is not read, so the connection must not be reused
    if (!s) return close(pages.redirect('/login'));
    if (!sameOrigin()) return close(plain(403, 'Forbidden'));
    const r = await music.uploadMusic({ db, now, method, path, query: url.searchParams, form: new URLSearchParams(), csrf: s.csrf, range: null }, req);
    return r.status === 303 || r.status === 403 ? close(r) : r;
  }

  let form = new URLSearchParams();
  if (method === 'POST') {
    const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/x-www-form-urlencoded') return plain(415, 'Unsupported media type');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return plain(413, 'Request too large');
    // CSRF: same-origin only. The session cookie is SameSite=Strict as well.
    if (!sameOrigin()) return plain(403, 'Forbidden');
    const body = await readBody(req);
    if (body === null) return plain(413, 'Request too large');
    form = new URLSearchParams(body);
  }

  if (isLogin) return method === 'GET' ? pages.loginPage(null, !!kvGet(db, 'admin_password')) : login(db, form, now, req.headers.origin === `https://${host}`);

  const session = getSession(db, cookieOf(req.headers.cookie, COOKIE), now);
  if (!session) return pages.redirect('/login');
  if (method === 'POST') {
    if (!safeEqual(form.get('csrf') ?? '', session.csrf)) return plain(403, 'Forbidden');
    if (isLogout) {
      destroySession(db, session.sha);
      audit(db, 'admin', 'logout', 'session', {}, now);
      return { status: 303, headers: { location: '/login', 'set-cookie': clearCookie() } };
    }
  }
  return route!.h({ db, now, method, path, query: url.searchParams, form, csrf: session.csrf, range: (req.headers.range as string | undefined) ?? null });
}

// secure: the login came with an https Origin (Tailscale serve); the Origin header is the only signal trusted.
async function login(db: Db, form: URLSearchParams, now: Date, secure: boolean): Promise<Res> {
  // While locked, or with no password set, scrypt does not run.
  if (isLocked(db, now)) return { ...pages.loginPage('Too many failed attempts. Try again in 15 minutes.', true), status: 429 };
  const stored = kvGet(db, 'admin_password');
  if (!stored) return { ...pages.loginPage(null, false), status: 401 };
  const pw = form.get('password') ?? '';
  if (pw.length <= MAX_PASSWORD && verifyPassword(stored, pw)) {
    clearLockout(db);
    const s = createSession(db, now);
    audit(db, 'admin', 'login', 'session', {}, now);
    log.info('admin login', { ok: true });
    return { status: 303, headers: { location: '/overview', 'set-cookie': sessionCookie(s.token, secure) } };
  }
  audit(db, 'admin', 'login.failed', 'session', {}, now);
  log.warn('admin login', { ok: false });
  if (loginFailed(db, now)) {
    audit(db, 'admin', 'login.lockout', 'session', {}, now);
    log.warn('admin login locked', {});
    await alert(db, 'admin_lockout', 'admin', 'Admin login locked for 15 minutes after 5 failed attempts.', now);
  }
  return { ...pages.loginPage('Wrong password.', true), status: 401 };
}

function send(res: ServerResponse, r: Res): void {
  const headers: Record<string, string | string[]> = { ...HEADERS, 'content-type': r.type ?? 'text/html; charset=utf-8', ...r.headers };
  if (r.file) {
    headers['content-type'] = r.file.type;
    headers['content-length'] = String(r.file.end - r.file.start + 1);
    res.writeHead(r.status, headers);
    createReadStream(r.file.path, { start: r.file.start, end: r.file.end }).on('error', () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(r.status, headers);
  res.end(r.body === undefined ? '' : String(r.body));
}

export function makeServer(db: Db, opts: AdminOpts): Server {
  const server = createServer((req, res) => {
    const t0 = performance.now();
    handle(db, opts, req)
      .catch((e): Res => {
        log.error('admin request failed', { error: e instanceof Error ? e.name : 'error' });
        return plain(500, 'Internal error');
      })
      .then((r) => {
        try { send(res, r); } catch (e) { log.error('admin response failed', { error: e instanceof Error ? e.name : 'error' }); res.destroy(); }
        // Method, path without the query, status and duration. Never cookies, bodies or texts.
        log.info('admin request', { method: req.method, path: (req.url ?? '').split('?')[0], status: r.status, ms: Math.round(performance.now() - t0) });
      });
  });
  server.maxConnections = 64;
  server.requestTimeout = 180_000; // a 40 MB upload on a slow tunnel
  server.headersTimeout = 15_000;
  return server;
}
