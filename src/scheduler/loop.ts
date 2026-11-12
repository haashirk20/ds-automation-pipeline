import { spawn } from 'node:child_process';
import { env, type Config } from '../config/index.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { publishDue } from '../publish/index.ts';
import type { Publisher } from '../publish/types.ts';
import { planDay } from './planner.ts';
import { addDays, localDateOf, localHHMM } from './time.ts';

// Resolves when the producer for one slot has exited, however it exited.
export type Spawn = (slotId: string, now: Date) => Promise<void>;
export type Producer = { busy(): boolean; start(slotId: string, now: Date): Promise<void> };
export type Deps = { db: Db; config: Config; publishers: Record<string, Publisher>; producer: Producer; ingest?: (now: Date) => Promise<void>; wait?: boolean };

// One slot at a time. start() returns a promise the caller may ignore.
export function makeProducer(spawnFn: Spawn): Producer {
  let current: Promise<void> | null = null;
  return {
    busy: () => current !== null,
    start(slotId, now) {
      const p = spawnFn(slotId, now).catch((e) => log.error('producer failed', { slot: slotId, error: String(e) })).finally(() => (current = null));
      current = p;
      return p;
    },
  };
}

// Runs `produce --slot` in a child process with the same environment. The whole process group is
// killed after the timeout, so a hung Chrome goes with it; the stale-'producing' recovery does the rest.
export function childSpawn(config: Config): Spawn {
  return (slotId, now) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [process.argv[1], '--now', now.toISOString(), 'produce', '--slot', slotId], { stdio: 'inherit', env: process.env, detached: true });
      const timer = setTimeout(() => {
        log.error('produce timed out, killing', { slot: slotId });
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      }, config.render.produceTimeoutMinutes * 60000);
      child.on('error', (e) => { clearTimeout(timer); log.error('produce child failed to start', { error: String(e) }); resolve(); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) log.warn('produce child exited abnormally', { slot: slotId, code, signal });
        resolve();
      });
    });
}

const DAY_MS = 24 * 3600 * 1000;

const hasSlots = (db: Db, date: string) => !!db.prepare('SELECT 1 FROM slots WHERE local_date = ?').get(date);

export async function tick(deps: Deps, now: Date): Promise<void> {
  const { db, config } = deps;
  const today = localDateOf(now, config.timezone);
  const tomorrow = addDays(today, 1);
  if (localHHMM(now, config.timezone) >= config.produceAt && !hasSlots(db, tomorrow)) planDay(db, config, tomorrow, now);
  if (!hasSlots(db, today)) planDay(db, config, today, now);

  const cutoff = new Date(now.getTime() - config.render.produceTimeoutMinutes * 60000).toISOString();
  const stuck = db.prepare("SELECT id, attempt FROM slots WHERE status = 'producing' AND updated_at < ?").all(cutoff) as { id: string; attempt: number }[];
  for (const s of stuck) {
    const retry = s.attempt < config.render.maxAttempts;
    db.prepare('UPDATE slots SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(retry ? 'planned' : 'failed', 'produce timed out', now.toISOString(), s.id);
    if (!retry) await alert(db, 'produce_failed', s.id, `produce timed out for ${s.id}`, now);
  }

  // At most once a day. A failure keeps the stored brief and tries again in an hour.
  const last = kvGet(db, 'ingest_at');
  if (deps.ingest && (!last || now.getTime() - Date.parse(last) >= DAY_MS)) {
    try {
      await deps.ingest(now);
      kvSet(db, 'ingest_at', now.toISOString());
    } catch (e) {
      kvSet(db, 'ingest_at', new Date(now.getTime() - DAY_MS + 3600_000).toISOString());
      await alert(db, 'ingest_failed', 'ingest', `ingest failed, using the stored brief: ${e}`, now);
    }
  }

  // Production runs in a child process so publishing continues meanwhile. `wait` (run --once) drains every planned slot first.
  const planned = db.prepare("SELECT id FROM slots WHERE status = 'planned' ORDER BY id").all() as { id: string }[];
  if (deps.wait) for (const { id } of planned) await deps.producer.start(id, now);
  else if (planned.length && !deps.producer.busy()) void deps.producer.start(planned[0].id, now);

  await publishDue(db, config, deps.publishers, now);

  kvSet(db, 'heartbeat', now.toISOString());
  const url = env.healthcheckUrl();
  if (url) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      log.warn('healthcheck ping failed', { error: String(e) });
    }
  }
}

export async function run(deps: Deps, clock: () => Date, once: boolean): Promise<void> {
  for (;;) {
    const now = clock();
    // Watchdog: a hung tick makes the process exit so Docker restarts it.
    const dog = setTimeout(() => {
      log.error('watchdog: tick exceeded limit, exiting', { minutes: deps.config.watchdogMinutes });
      process.exit(1);
    }, deps.config.watchdogMinutes * 60000);
    try {
      await tick(deps, now);
    } catch (e) {
      log.error('tick failed', { error: String(e) });
      await alert(deps.db, 'tick_failed', 'tick', `tick failed: ${e}`, now);
    } finally {
      clearTimeout(dog);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
