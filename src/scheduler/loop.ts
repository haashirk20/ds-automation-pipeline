import { spawn } from 'node:child_process';
import { env, type Config } from '../config/index.ts';
import { kvSet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { publishDue } from '../publish/index.ts';
import type { Publisher } from '../publish/types.ts';
import { planDay } from './planner.ts';
import { addDays, localDateOf, localHHMM } from './time.ts';

// Resolves when the producer for one slot has exited, however it exited.
export type Spawn = (slotId: string, now: Date) => Promise<void>;
export type Producer = { busy(): boolean; start(slotId: string, now: Date): Promise<void> };
export type Deps = { db: Db; config: Config; publishers: Record<string, Publisher>; producer: Producer; wait?: boolean };

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

// Runs `produce --slot` in a child process with the same environment. After the timeout the child gets
// SIGTERM (it cancels its Chrome and exits); after the grace period the whole process group gets SIGKILL.
// A hung producer then leaves the slot 'producing', and the stale recovery in tick() takes it.
export function childSpawn(config: Config, opts: { timeoutMs?: number; graceMs?: number; argv?: (slotId: string, now: Date) => string[] } = {}): Spawn {
  const timeoutMs = opts.timeoutMs ?? config.render.produceTimeoutMinutes * 60000;
  const graceMs = opts.graceMs ?? 20_000;
  const argv = opts.argv ?? ((slotId, now) => [process.argv[1], '--now', now.toISOString(), 'produce', '--slot', slotId]);
  return (slotId, now) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, argv(slotId, now), { stdio: 'inherit', env: process.env, detached: true });
      const signal = (sig: NodeJS.Signals) => {
        try { process.kill(-child.pid!, sig); } catch { /* already gone */ }
      };
      let killer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        log.error('produce timed out, terminating', { slot: slotId });
        signal('SIGTERM');
        killer = setTimeout(() => signal('SIGKILL'), graceMs);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        clearTimeout(killer);
        signal('SIGKILL'); // anything the child left in its group
        resolve();
      };
      child.on('error', (e) => { log.error('produce child failed to start', { error: String(e) }); done(); });
      child.on('close', (code, sig) => {
        if (code !== 0) log.warn('produce child exited abnormally', { slot: slotId, code, signal: sig });
        done();
      });
    });
}

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
    const moved = db.prepare("UPDATE slots SET status = ?, error = ?, claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'producing' AND updated_at < ?").run(retry ? 'planned' : 'failed', 'produce timed out', now.toISOString(), s.id, cutoff).changes === 1;
    if (moved && !retry) await alert(db, 'produce_failed', s.id, `produce timed out for ${s.id}`, now);
  }

  // Only slots that still have something to publish in time are worth producing.
  const lateBefore = new Date(now.getTime() - config.publish.maxLatenessMinutes * 60000).toISOString();
  const planned: { id: string }[] = [];
  for (const { id } of db.prepare("SELECT id FROM slots WHERE status = 'planned' ORDER BY id").all() as { id: string }[]) {
    if (db.prepare("SELECT 1 FROM publications WHERE slot_id = ? AND state = 'pending' AND scheduled_at >= ?").get(id, lateBefore)) planned.push({ id });
    else {
      db.prepare("UPDATE slots SET status = 'failed', error = 'too late', updated_at = ? WHERE id = ? AND status = 'planned'").run(now.toISOString(), id);
      await alert(db, 'produce_failed', id, `${id} was not produced: too late`, now);
    }
  }
  // Production runs in a child process so publishing continues meanwhile. `wait` (run --once) drains every planned slot first.
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
