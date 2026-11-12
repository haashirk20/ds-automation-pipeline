import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Db } from '../db/index.ts';
import { env, type Config } from '../config/index.ts';
import { enabledPlatforms } from '../scheduler/planner.ts';
import { alert } from '../ops/alert.ts';

// Paths come only from slot id and platform; the result must stay inside OUT_DIR.
function safeDir(root: string, localDate: string, slotId: string): string {
  const base = resolve(root);
  const dir = resolve(base, localDate, slotId.replace('#', '-'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{4}-\d{2}-\d{2}#\d+$/.test(slotId) || !dir.startsWith(base + sep)) throw new Error(`unsafe render path for ${slotId}`);
  return dir;
}

// Phase 1 STUB: writes placeholder files. Phase 3 replaces this file with the real producer
// and moves it to a child process.
export async function produceSlot(db: Db, config: Config, slotId: string, now: Date): Promise<void> {
  const ts = now.toISOString();
  // Atomic claim: only one caller moves the slot out of 'planned'.
  const claim = db.prepare("UPDATE slots SET status = 'producing', attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'planned'").run(ts, slotId);
  if (claim.changes !== 1) return;
  const setSlot = (status: string, error: string | null) =>
    db.prepare('UPDATE slots SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, ts, slotId);
  try {
    const slot = db.prepare('SELECT local_date FROM slots WHERE id = ?').get(slotId) as { local_date: string };
    const dir = safeDir(env.outDir(), slot.local_date, slotId);
    mkdirSync(dir, { recursive: true });
    for (const platform of enabledPlatforms(config)) {
      const file = resolve(dir, `${platform}.txt`);
      writeFileSync(file, `placeholder render for ${slotId} on ${platform}\n`);
      db.prepare("INSERT OR REPLACE INTO renders (slot_id, platform, file_path, qa_pass, qa_json, created_at) VALUES (?, ?, ?, 1, '{\"stub\":true}', ?)").run(slotId, platform, file, ts);
    }
    db.prepare("UPDATE slots SET tier = 't0' WHERE id = ?").run(slotId);
    setSlot('ready', null);
  } catch (e) {
    setSlot('failed', String(e));
    await alert(db, 'produce_failed', slotId, `produce failed for ${slotId}: ${e}`, now);
  }
}
