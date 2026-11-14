import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { kvGet, kvSet, type Db } from '../db/index.ts';

const N = 32768;
const R = 8;
const P = 3;
export const MIN_PASSWORD = 12;
export const COOKIE = 'aap_session';
export const IDLE_MS = 60 * 60_000;
export const ABSOLUTE_MS = 12 * 3600_000;
const TOUCH_MS = 60_000;
const FAIL_LIMIT = 5;
const WINDOW_MS = 15 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const scrypt = (pw: string, salt: Buffer, n = N, r = R, p = P) => scryptSync(pw, salt, 32, { N: n, r, p, maxmem: 128 * n * r * 2 + 128 * r * p * 2 });

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${scrypt(pw, salt).toString('base64')}`;
}

export function verifyPassword(stored: string, pw: string): boolean {
  const [alg, n, r, p, salt, key] = stored.split('$');
  const [nn, rr, pp] = [Number(n), Number(r), Number(p)];
  // Parameters come from the stored string, so they are bounded before scrypt runs.
  const ok = Number.isInteger(nn) && nn >= 2 ** 14 && nn <= 2 ** 17 && (nn & (nn - 1)) === 0 && Number.isInteger(rr) && rr >= 8 && rr <= 16 && Number.isInteger(pp) && pp >= 1 && pp <= 4;
  if (alg !== 'scrypt' || !ok || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = scrypt(pw, Buffer.from(salt, 'base64'), nn, rr, pp);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Sessions: the cookie holds 32 random bytes; the database holds only their sha256.
export function createSession(db: Db, now: Date): { token: string; csrf: string } {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(16).toString('hex');
  const ts = now.toISOString();
  db.prepare('DELETE FROM admin_sessions WHERE created_at < ?').run(new Date(now.getTime() - ABSOLUTE_MS).toISOString());
  db.prepare('INSERT INTO admin_sessions (token_sha, csrf, created_at, seen_at) VALUES (?,?,?,?)').run(sha256(token), csrf, ts, ts);
  return { token, csrf };
}

export function getSession(db: Db, token: string | undefined, now: Date): { csrf: string; sha: string } | null {
  if (!token) return null;
  const sha = sha256(token);
  const row = db.prepare('SELECT csrf, created_at, seen_at FROM admin_sessions WHERE token_sha = ?').get(sha) as { csrf: string; created_at: string; seen_at: string } | undefined;
  if (!row) return null;
  const t = now.getTime();
  if (t - Date.parse(row.created_at) >= ABSOLUTE_MS || t - Date.parse(row.seen_at) >= IDLE_MS) {
    db.prepare('DELETE FROM admin_sessions WHERE token_sha = ?').run(sha);
    return null;
  }
  if (t - Date.parse(row.seen_at) >= TOUCH_MS) db.prepare('UPDATE admin_sessions SET seen_at = ? WHERE token_sha = ?').run(now.toISOString(), sha);
  return { csrf: row.csrf, sha };
}

export const destroySession = (db: Db, sha: string) => void db.prepare('DELETE FROM admin_sessions WHERE token_sha = ?').run(sha);

export function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const c of (header ?? '').split(';')) {
    const i = c.indexOf('=');
    if (i > 0 && c.slice(0, i).trim() === name) return c.slice(i + 1).trim();
  }
  return undefined;
}

export const sessionCookie = (token: string, secure = false) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ABSOLUTE_MS / 1000}${secure ? '; Secure' : ''}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

// Global login lockout, kept in kv so `admin password` (another process) can clear it and a restart does not.
type LoginState = { fails: number[]; lockedUntil: number };
const readState = (db: Db): LoginState => {
  try {
    const s = JSON.parse(kvGet(db, 'admin_login_state') ?? '');
    if (Array.isArray(s.fails) && typeof s.lockedUntil === 'number') return s;
  } catch { /* none yet */ }
  return { fails: [], lockedUntil: 0 };
};
const writeState = (db: Db, s: LoginState) => kvSet(db, 'admin_login_state', JSON.stringify(s));

export const isLocked = (db: Db, now: Date): boolean => readState(db).lockedUntil > now.getTime();
export const clearLockout = (db: Db) => writeState(db, { fails: [], lockedUntil: 0 });

// Returns true when this failure starts a lockout.
export function loginFailed(db: Db, now: Date): boolean {
  const t = now.getTime();
  const s = readState(db);
  s.fails = [...s.fails.filter((f) => t - f < WINDOW_MS), t];
  const lock = s.fails.length >= FAIL_LIMIT;
  if (lock) {
    s.lockedUntil = t + WINDOW_MS;
    s.fails = [];
  }
  writeState(db, s);
  return lock;
}

export function hostAllowed(hostHeader: string | undefined, extra: string[]): boolean {
  if (!hostHeader) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim().toLowerCase());
  if (!m) return false;
  return ['127.0.0.1', 'localhost', '[::1]', ...extra].includes(m[1]);
}
