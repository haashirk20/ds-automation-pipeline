import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { env } from '../config/index.ts';
import { audit } from '../config/overrides.ts';
import { kvSet, openDb, type Db } from '../db/index.ts';
import { log } from '../ops/log.ts';
import { clearLockout, hashPassword, MIN_PASSWORD } from './auth.ts';
import { makeServer } from './server.ts';

export type ServeOpts = { db?: Db; port?: number; host?: string; now: () => Date; hosts?: string[] };

// Listens and resolves with the server (tests use this). `serve` below never resolves until the server closes.
export async function startAdmin(o: ServeOpts): Promise<{ server: Server; port: number; db: Db }> {
  const db = o.db ?? openDb(env.dataDir());
  const hosts = o.hosts ?? (process.env.ADMIN_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const server = makeServer(db, { now: o.now!, hosts });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 8080, o.host ?? '0.0.0.0', resolve);
  });
  return { server, port: (server.address() as AddressInfo).port, db };
}

export async function serve(o: ServeOpts): Promise<void> {
  const { server, port } = await startAdmin(o);
  log.info('admin listening', { port });
  await new Promise<void>((resolve) => {
    server.once('close', resolve);
    const stop = () => {
      server.close();
      server.closeAllConnections();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function readStdinLine(): Promise<string> {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.split('\n')[0].replace(/\r$/, '');
}

// TTY: raw mode, nothing echoed. Not a TTY: the first line of stdin.
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readStdinLine();
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          return resolve(buf);
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

export type PasswordOpts = { db?: Db; now: () => Date; read?: (prompt: string) => Promise<string> };

// Sets the single admin password: all sessions end, the lockout clears, one audit row is written. The password is never printed.
export async function setPassword(o: PasswordOpts): Promise<void> {
  const read = o.read ?? readSecret;
  const pw = await read('New admin password: ');
  if (pw.length < MIN_PASSWORD) throw new Error(`the password must be at least ${MIN_PASSWORD} characters`);
  if (process.stdin.isTTY && !o.read && (await read('Repeat it: ')) !== pw) throw new Error('the two entries differ');
  const db = o.db ?? openDb(env.dataDir());
  const now = o.now!();
  db.exec('BEGIN IMMEDIATE');
  try {
    kvSet(db, 'admin_password', hashPassword(pw));
    db.prepare('DELETE FROM admin_sessions').run();
    clearLockout(db);
    audit(db, 'cli', 'password.set', 'admin', {}, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log('Admin password set. All sessions ended.');
}
