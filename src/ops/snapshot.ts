import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { env, type Config } from '../config/index.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { localDateOf, localHHMM } from '../scheduler/time.ts';
import { alert } from './alert.ts';
import { log } from './log.ts';

// Writes a consistent copy of the database for the backup container (see DECISIONS D-14):
// <DATA_DIR>/backup/pipeline.db, then the `ready` marker holding the snapshot time.
export function writeSnapshot(db: Db, now: Date): void {
  const dir = path.join(path.resolve(env.dataDir()), 'backup');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = path.join(dir, 'pipeline.db.tmp');
  rmSync(tmp, { force: true }); // VACUUM INTO refuses an existing file
  db.prepare('VACUUM INTO ?').run(tmp);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path.join(dir, 'pipeline.db'));
  const marker = path.join(dir, 'ready.tmp');
  writeFileSync(marker, now.toISOString(), { mode: 0o600 });
  renameSync(marker, path.join(dir, 'ready'));
}

// Once a day after config.ops.snapshotAt. A failure alerts and never stops the tick.
export async function snapshotDaily(db: Db, config: Config, now: Date): Promise<void> {
  const today = localDateOf(now, config.timezone);
  if (localHHMM(now, config.timezone) < config.ops.snapshotAt || kvGet(db, 'snapshot_at') === today) return;
  try {
    writeSnapshot(db, now);
    kvSet(db, 'snapshot_at', today);
    log.info('snapshot written');
  } catch (e) {
    log.error('snapshot failed', { error: String(e) });
    await alert(db, 'snapshot_failed', today, `database snapshot failed: ${e}`, now);
  }
}

// After a backed-up database is copied into place: anything that may already have been posted since
// the snapshot must be checked by hand. Returns how many publications it held back.
export async function afterRestore(db: Db, now: Date): Promise<number> {
  const n = Number(db.prepare("UPDATE publications SET state = 'needs_attention', error = 'restored from backup: check the platform before posting again' WHERE state IN ('pending','uploading') AND scheduled_at <= ?").run(now.toISOString()).changes);
  await alert(db, 'restored', now.toISOString(), `database restored from backup: ${n} publication(s) set to needs_attention, check each platform before posting again`, now);
  return n;
}
