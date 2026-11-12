import { env, type Config } from '../config/index.ts';
import { kvSet, type Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { publishDue } from '../publish/index.ts';
import type { Publisher } from '../publish/types.ts';
import { produceSlot } from '../render/produce.ts';
import { planDay } from './planner.ts';
import { addDays, localDateOf, localHHMM } from './time.ts';

export type Deps = { db: Db; config: Config; publishers: Record<string, Publisher> };

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

  const planned = db.prepare("SELECT id FROM slots WHERE status = 'planned' ORDER BY id").all() as { id: string }[];
  for (const { id } of planned) await produceSlot(db, config, id, now);

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
