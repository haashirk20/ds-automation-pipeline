import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { audit } from '../config/overrides.ts';
import { kvGet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { clearCookie, clearLockout, cookieOf, COOKIE, createSession, destroySession, getSession, hostAllowed, isLocked, loginFailed, safeEqual, safeNext, sessionCookie, verifyPassword } from './auth.ts';
import * as factory from './factory.ts';
import * as media from './media.ts';
import * as models from './models.ts';
import * as music from './music.ts';
import * as pages from './pages.ts';
import * as posts from './posts.ts';
import * as products from './products.ts';
import * as town from './town.ts';
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

// `back` is the page to return to (see `back` in handle()), for buttons that sit on several pages.
type Route = { h: (c: Ctx, back: string) => Res | Promise<Res> };
const ROUTES: Record<string, Route> = {
  'GET /': { h: pages.overviewPage },
  'GET /overview': { h: pages.overviewPage },
  'GET /factory': { h: factory.factoryPage },
  'GET /town': { h: town.townPage },
  'GET /town.json': { h: town.townJson },
  'GET /factory.json': { h: factory.factoryJson },
  'GET /settings': { h: pages.settingsPage },
  'POST /settings/preview': { h: (c) => pages.settingsPreview(c) },
  'POST /settings/edit': { h: pages.settingsEdit },
  'POST /settings/save': { h: pages.settingsSave },
  'GET /products': { h: (c) => products.productsPage(c) },
  'GET /products/new': { h: (c) => products.productForm(c) },
  'GET /products/edit': { h: (c) => products.productForm(c) },
  'POST /products/save': { h: () => pages.notFound(null) }, // multipart, handled before the body is read
  'POST /products/select': { h: products.productsSelect },
  'POST /products/delete': { h: products.productsDelete },
  'POST /products/sync': { h: products.productsSync },
  'POST /brand/logo': { h: () => pages.notFound(null) }, // multipart
  'POST /brand/logo/reset': { h: products.logoReset },
  'GET /media/photo': { h: products.mediaPhoto },
  'GET /media/logo': { h: (c) => products.mediaLogo(c) },
  'GET /posts': { h: posts.postsPage },
  'POST /posts/new': { h: posts.postNew },
  'POST /posts/approve': { h: posts.postApprove },
  'POST /posts/discard': { h: posts.postDiscard },
  'GET /media/render': { h: media.mediaRender },
  'GET /media/music': { h: media.mediaMusic },
  'GET /music': { h: (c) => music.musicPage(c) },
  'POST /music/upload': { h: () => pages.notFound(null) }, // handled before the body is read
  'POST /music/select': { h: music.musicSelect },
  'POST /music/delete': { h: music.musicDelete },
  'GET /models': { h: (c) => models.modelsPage(c) },
  'POST /models/add': { h: models.modelAdd },
  'POST /models/remove': { h: models.modelRemove },
  'GET /prompts': { h: pages.promptsPage },
  'GET /prompts/view': { h: pages.promptView },
  'GET /prompts/edit': { h: (c) => pages.promptEdit(c) },
  'POST /prompts/preview': { h: pages.promptPreview },
  'POST /prompts/back': { h: pages.promptBack },
  'POST /prompts/save': { h: pages.promptSave },
  'GET /prompts/history': { h: pages.promptHistory },
  'POST /prompts/activate': { h: pages.promptActivate },
  'GET /activity': { h: pages.activityPage },
  'GET /history': { h: pages.historyPage },
  'POST /history/activate': { h: pages.historyActivate },
  'POST /auto/stop': { h: pages.autoStop },
  'POST /auto/start': { h: pages.autoStart },
};

// Multipart routes, each with its own body limit.
const MULTIPART: Record<string, { max: number; h: (c: Ctx, req: IncomingMessage) => Promise<Res> }> = {
  '/music/upload': { max: music.MAX_BODY, h: music.uploadMusic },
  '/products/save': { max: products.MAX_PRODUCT_BODY, h: products.productSave },
  '/brand/logo': { max: products.MAX_LOGO_BODY, h: products.logoUpload },
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
const SESSION_ENDED = 'Your session ended. Sign in again; your change was not saved.';

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
  if (method === 'GET' && path === '/factory.css') return { status: 200, body: factory.FACTORY_CSS, type: 'text/css; charset=utf-8' };
  if (method === 'GET' && path === '/factory.js') return { status: 200, body: factory.FACTORY_JS, type: 'text/javascript; charset=utf-8' };
  if (method === 'GET' && path === '/town.js') return { status: 200, body: town.TOWN_JS, type: 'text/javascript; charset=utf-8' };
  if (method === 'GET' && path === '/town.css') return { status: 200, body: town.TOWN_CSS, type: 'text/css; charset=utf-8' };
  if (method === 'GET' && path === '/favicon.ico') return { status: 204 }; // no icon; answered before any session lookup
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
  const session = getSession(db, cookieOf(req.headers.cookie, COOKIE), now);
  // With a valid session the error pages keep the menu.
  const ectx: Ctx | null = session ? { db, now, method, path, query: url.searchParams, form: new URLSearchParams(), csrf: session.csrf, range: null } : null;
  // Back to a page that can be opened with GET: the Referer if it is this site, else the parent of the posted path, else Home.
  // A POST-only address (a review or save step) is never offered.
  const back = ((): { href: string; label: string } => {
    const getable = (p: string) => !!ROUTES[`GET ${p}`];
    try {
      const r = new URL(req.headers.referer ?? '');
      if (r.host === host && getable(r.pathname)) return { href: safeNext(r.pathname + r.search) ?? r.pathname, label: 'Go back' };
    } catch { /* no referer */ }
    const parent = '/' + (path.split('/')[1] ?? '');
    const to = parent === '/brand' ? '/products' : getable(parent) ? parent : '/overview';
    return { href: to, label: to === '/overview' ? 'Go to Home' : 'Go back' };
  })();
  // Signed in: the page was simply stale. Signed out: the session ended.
  const stale = (): Res => session ? fail(403, 'Not saved', 'This page was out of date, so nothing was saved. Go back, reload, and try again.') : fail(403, 'Not saved', SESSION_ENDED, { href: '/login', label: 'Sign in' });
  const fail = (status: number, title: string, text: string, to = back): Res => pages.errorPage(ectx, status, title, text, to);
  if (!route && !(isLogin && (method === 'GET' || method === 'POST')) && !isLogout) return pages.notFound(ectx);

  const sameOrigin = (): boolean => {
    if (req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return false;
    const sfs = req.headers['sec-fetch-site'];
    return sfs === undefined || sfs === 'same-origin';
  };

  // The multipart routes. The session is checked before any body is read; the csrf field is checked after parsing.
  const upload = method === 'POST' ? MULTIPART[path] : undefined;
  if (upload) {
    const s = session;
    const close = (r: Res): Res => ({ ...r, headers: { ...r.headers, connection: 'close' } }); // the body is not read, so the connection must not be reused
    if (!s) return close(pages.redirect('/login'));
    if (!sameOrigin()) return close(stale());
    const ct = req.headers['content-type'] ?? '';
    if (!/^multipart\/form-data;\s*boundary=/i.test(ct)) return close(fail(415, 'Not saved', 'This form could not be read. Reload the page and try again.'));
    const len = req.headers['content-length'];
    if (len === undefined || !/^\d+$/.test(len)) return close(fail(411, 'Not saved', 'This form could not be read. Reload the page and try again.'));
    if (Number(len) > upload.max) return close(fail(413, 'Too large', 'That is too large to send. Choose a smaller file and try again.'));
    const r = await upload.h({ db, now, method, path, query: url.searchParams, form: new URLSearchParams(), csrf: s.csrf, range: null }, req);
    return r.status === 303 || r.status === 403 ? close(r) : r;
  }

  let form = new URLSearchParams();
  if (method === 'POST') {
    const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/x-www-form-urlencoded') return fail(415, 'Not saved', 'This form could not be read. Reload the page and try again.');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return fail(413, 'Too large', 'That is too large to send. Shorten it and try again.');
    // CSRF: same-origin only. The session cookie is SameSite=Strict as well.
    if (!sameOrigin()) return stale();
    const body = await readBody(req);
    if (body === null) return fail(413, 'Too large', 'That is too large to send. Shorten it and try again.');
    form = new URLSearchParams(body);
  }

  if (isLogin) {
    if (method === 'POST') return login(db, form, now, req.headers.origin === `https://${host}`);
    if (session) return pages.redirect('/overview');
    return pages.loginPage(null, !!kvGet(db, 'admin_password'), { next: safeNext(url.searchParams.get('next')) ?? undefined, out: url.searchParams.get('msg') === 'out' });
  }

  if (!session) {
    // A page the owner asked for comes back after sign-in. Data and media URLs do not.
    const wants = method === 'GET' && !path.endsWith('.json') && !path.startsWith('/media/') ? safeNext(path + url.search) : null;
    return pages.redirect(wants ? `/login?next=${encodeURIComponent(wants)}` : '/login');
  }
  if (method === 'POST') {
    if (!safeEqual(form.get('csrf') ?? '', session.csrf)) return stale();
    if (isLogout) {
      destroySession(db, session.sha);
      audit(db, 'admin', 'logout', 'session', {}, now);
      return { status: 303, headers: { location: '/login?msg=out', 'set-cookie': clearCookie() } };
    }
  }
  return route!.h({ db, now, method, path, query: url.searchParams, form, csrf: session.csrf, range: (req.headers.range as string | undefined) ?? null }, back.href);
}

// secure: the login came with an https Origin (Tailscale serve); the Origin header is the only signal trusted.
async function login(db: Db, form: URLSearchParams, now: Date, secure: boolean): Promise<Res> {
  // While locked, or with no password set, scrypt does not run.
  const next = safeNext(form.get('next')) ?? undefined;
  if (isLocked(db, now)) return { ...pages.loginPage('Too many failed attempts. Try again in 15 minutes.', true, { next }), status: 429 };
  const stored = kvGet(db, 'admin_password');
  if (!stored) return { ...pages.loginPage(null, false, { next }), status: 401 };
  const pw = form.get('password') ?? '';
  if (pw.length <= MAX_PASSWORD && verifyPassword(stored, pw)) {
    clearLockout(db);
    const s = createSession(db, now);
    audit(db, 'admin', 'login', 'session', {}, now);
    log.info('admin login', { ok: true });
    return { status: 303, headers: { location: next ?? '/overview', 'set-cookie': sessionCookie(s.token, secure) } };
  }
  audit(db, 'admin', 'login.failed', 'session', {}, now);
  log.warn('admin login', { ok: false });
  if (loginFailed(db, now)) {
    audit(db, 'admin', 'login.lockout', 'session', {}, now);
    log.warn('admin login locked', {});
    await alert(db, 'admin_lockout', 'admin', 'Admin login locked for 15 minutes after 5 failed attempts.', now);
  }
  return { ...pages.loginPage('Wrong password.', true, { next }), status: 401 };
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
        return pages.errorPage(null, 500, 'Something went wrong', 'Something went wrong on our side. Try again in a minute. If it keeps happening, ask for help.');
      })
      .then((r) => {
        try { send(res, r); } catch (e) { log.error('admin response failed', { error: e instanceof Error ? e.name : 'error' }); res.destroy(); }
        // Method, path without the query, status and duration. Never cookies, bodies or texts.
        log.info('admin request', { method: req.method, path: (req.url ?? '').split('?')[0], status: r.status, ms: Math.round(performance.now() - t0) });
      });
  });
  server.maxConnections = 64;
  server.requestTimeout = 300_000; // a 64 MB photo upload on a slow tunnel
  server.headersTimeout = 15_000;
  return server;
}
