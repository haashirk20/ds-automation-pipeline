import { spawn } from 'node:child_process';
import { env, type Config } from '../config/index.ts';
import { resolveConfig } from '../config/overrides.ts';
import { autoPaused, kvSet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { housekeepingDaily } from '../ops/housekeeping.ts';
import { log } from '../ops/log.ts';
import { snapshotDaily } from '../ops/snapshot.ts';
import { summaryDaily } from '../ops/summary.ts';
import { publishDue } from '../publish/index.ts';
import { ensureIngest } from '../shopify/index.ts';
import type { Publisher } from '../publish/types.ts';
import { holdsTick } from './holds.ts';
import { planDay } from './planner.ts';
import { addDays, localDateOf, localHHMM } from './time.ts';

// Resolves when the producer for one slot has exited, however it exited.
export type Spawn = (slotId: string, now: Date) => Promise<void>;
export type Producer = { busy(): boolean; start(slotId: string, now: Date): Promise<void> };
// `ingest` refreshes the stored catalogue at most hourly. The tick starts it and does not wait, so a slow store read
// never delays a post or the heartbeat.
// With `rebuild`, run() reads the config again before every tick and rebuilds the publishers from it.
// `clock` stamps publish claims and results; without it they use the tick start.
export type Deps = { db: Db; config: Config; publishers: Record<string, Publisher>; producer: Producer; wait?: boolean; clock?: () => Date; rebuild?: (config: Config) => Record<string, Publisher>; ingest?: (config: Config, now: Date, signal: AbortSignal) => Promise<void> };

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
// `clock` is the clock override, if any: the child gets --now read from it when it starts, never the tick start,
// so a later child in run --once does not run behind and take a slot another producer still holds.
export const produceArgv = (slotId: string, clock?: () => Date): string[] => [process.argv[1], ...(clock ? ['--now', clock().toISOString()] : []), 'produce', '--slot', slotId];

export function childSpawn(config: Config, opts: { timeoutMs?: number; graceMs?: number; clock?: () => Date; argv?: (slotId: string) => string[] } = {}): Spawn {
  const timeoutMs = opts.timeoutMs ?? config.render.produceTimeoutMinutes * 60000;
  const graceMs = opts.graceMs ?? 20_000;
  const argv = opts.argv ?? ((slotId) => produceArgv(slotId, opts.clock));
  return (slotId) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, argv(slotId), { stdio: 'inherit', env: process.env, detached: true });
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

// A slot the producer put back to 'planned' with an error waits this long before it starts again.
const RETRY_GAP_MINUTES = 10;

// The store read the tick started, if it is still running: never two at once.
let ingesting: Promise<void> | null = null;

const hasSlots = (db: Db, date: string) => !!db.prepare("SELECT 1 FROM slots WHERE local_date = ? AND kind = 'planned'").get(date);

export async function tick(deps: Deps, now: Date): Promise<void> {
  const { db, config } = deps;
  kvSet(db, 'heartbeat', now.toISOString()); // a tick that publishes can take minutes; health must still see the loop alive
  const today = localDateOf(now, config.timezone);
  const tomorrow = addDays(today, 1);
  // D-45: the owner stopped daily posts. Nothing new is planned and no daily post is produced; manual videos still are.
  const paused = !!autoPaused(db);
  if (!paused && localHHMM(now, config.timezone) >= config.produceAt && !hasSlots(db, tomorrow)) planDay(db, config, tomorrow, now);
  if (!paused && !hasSlots(db, today)) planDay(db, config, today, now);

  const cutoff = new Date(now.getTime() - config.render.produceTimeoutMinutes * 60000).toISOString();
  const stuck = db.prepare("SELECT id, attempt FROM slots WHERE status = 'producing' AND updated_at < ?").all(cutoff) as { id: string; attempt: number }[];
  for (const s of stuck) {
    const retry = s.attempt < config.render.maxAttempts;
    const moved = db.prepare("UPDATE slots SET status = ?, error = ?, claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'producing' AND updated_at < ?").run(retry ? 'planned' : 'failed', 'produce timed out', now.toISOString(), s.id, cutoff).changes === 1;
    if (moved && !retry) await alert(db, 'produce_failed', s.id, `produce timed out for ${s.id}`, now);
  }

  // Only slots that still have something to publish in time are worth producing.
  const lateBefore = new Date(now.getTime() - config.publish.maxLatenessMinutes * 60000).toISOString();
  const retryAfter = new Date(now.getTime() - RETRY_GAP_MINUTES * 60000).toISOString();
  const planned: { id: string; kind: string }[] = [];
  for (const { id, kind, error, updated_at } of db.prepare("SELECT id, kind, error, updated_at FROM slots WHERE status = 'planned' ORDER BY kind = 'manual' DESC, id").all() as { id: string; kind: string; error: string | null; updated_at: string }[]) {
    const held = paused && kind === 'planned';
    const open = db.prepare("SELECT platform FROM publications WHERE slot_id = ? AND state = 'pending' AND scheduled_at >= ?").all(id, lateBefore) as { platform: string }[];
    if (open.length) {
      // Every platform switched off (paused): leave the slot planned and spend nothing; turning one back on in time resumes it.
      const off = !open.some((o) => (config.platforms as Record<string, { enabled: boolean }>)[o.platform]?.enabled);
      if (!off && !held && (error === null || updated_at <= retryAfter)) planned.push({ id, kind });
    } else {
      // Past lateness while daily posts are stopped, or with every pending row on a platform that is switched off: failed quietly as 'paused'.
      const rows = db.prepare("SELECT platform FROM publications WHERE slot_id = ? AND state = 'pending'").all(id) as { platform: string }[];
      const quiet = held || (rows.length > 0 && rows.every((o) => !(config.platforms as Record<string, { enabled: boolean }>)[o.platform]?.enabled));
      db.prepare("UPDATE slots SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'planned'").run(quiet ? 'paused' : 'too late', now.toISOString(), id);
      if (quiet) continue;
      await alert(db, 'produce_failed', id, `${id} was not produced: too late`, now);
    }
  }
  // Production runs in a child process so publishing continues meanwhile. `wait` (run --once) drains every planned slot first.
  // Stop is read again right before each paid start, so pressing it during this tick prevents the spawn (D-45).
  const mayStart = (s: { kind: string }) => s.kind !== 'planned' || !autoPaused(db);
  if (deps.wait) for (const s of planned) { if (mayStart(s)) await deps.producer.start(s.id, now); }
  else if (planned.length && !deps.producer.busy() && mayStart(planned[0])) void deps.producer.start(planned[0].id, now);

  await holdsTick(db, config, now);
  await publishDue(db, config, deps.publishers, now, deps.clock);
  await snapshotDaily(db, config, now);
  await housekeepingDaily(db, config, now);
  await summaryDaily(db, config, now);
  if (deps.ingest && !ingesting) {
    const read = deps.ingest;
    ingesting = ensureIngest(db, now, { ingest: (n, signal) => read(config, n, signal), ingestDeadlineMs: 5 * 60000 })
      .catch((e) => log.error('ingest failed', { error: String(e) }))
      .finally(() => (ingesting = null));
  }
  if (deps.wait && ingesting) await ingesting; // run --once finishes its read before the process exits

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
    // Not armed for run --once: that tick waits for every producer, and each has its own timeout.
    const dog = once ? undefined : setTimeout(() => {
      log.error('watchdog: tick exceeded limit, exiting', { minutes: deps.config.watchdogMinutes });
      process.exit(1);
    }, deps.config.watchdogMinutes * 60000);
    try {
      let d = deps;
      if (deps.rebuild) {
        const r = await resolveConfig(deps.db, now);
        d = { ...deps, config: r.config, publishers: deps.rebuild(r.config) };
        const prompts = Object.fromEntries((deps.db.prepare("SELECT substr(key, 13) AS k, value FROM kv WHERE key LIKE 'text_active:%'").all() as { k: string; value: string }[]).map((x) => [x.k, Number(x.value)]));
        kvSet(deps.db, 'pipeline_state', JSON.stringify({ dryRun: env.dryRun(), configVersion: r.version, promptVersions: prompts, tickAt: now.toISOString() }));
      }
      await tick(d, now);
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
