import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { env, type Config } from '../config/index.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { addDays, localDateOf, localHHMM } from '../scheduler/time.ts';
import { alert } from './alert.ts';
import { log } from './log.ts';

const inside = (abs: string, root: string) => abs.startsWith(root + path.sep);

// Removes one file or folder strictly inside `root`. A symlink is never followed or removed, and a
// parent that resolves outside the root (a symlinked folder) is refused. Returns whether it removed.
export function safeRemove(target: string, root: string): boolean {
  const abs = path.resolve(target);
  const r = path.resolve(root);
  if (!inside(abs, r)) throw new Error(`refusing to delete ${abs}: outside ${r}`);
  let st;
  try { st = lstatSync(abs); } catch { return false; }
  if (st.isSymbolicLink()) return false;
  const rr = realpathSync(r);
  const parent = realpathSync(path.dirname(abs));
  if (parent !== rr && !inside(parent, rr)) throw new Error(`refusing to delete ${abs}: resolves outside ${rr}`);
  rmSync(abs, { recursive: true, force: true });
  return true;
}

const slotDir = (outDir: string, date: string, id: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}#\d+$/.test(id)) return null;
  return path.join(outDir, date, id.replace('#', '-'));
};
const entries = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };

type SlotRow = { id: string; local_date: string; status: string; updated_at: string; master_json: string | null };

export function housekeeping(db: Db, config: Config, now: Date): { attempts: number; renders: number; clips: number; errors: string[] } {
  const dataDir = path.resolve(env.dataDir());
  const outDir = path.resolve(env.outDir());
  const clipsDir = path.join(dataDir, 'clips');
  const keep = config.ops.keepDays;
  const cutoffDay = addDays(localDateOf(now, config.timezone), -keep);
  const cutoffMs = now.getTime() - keep * 86400000;
  const staleClaimMs = now.getTime() - config.render.produceTimeoutMinutes * 60000;
  const out = { attempts: 0, renders: 0, clips: 0, errors: [] as string[] };
  const slots = db.prepare('SELECT id, local_date, status, updated_at, master_json FROM slots').all() as SlotRow[];
  // One bad entry must not stop the rest.
  const tryEach = (what: string, f: () => void) => { try { f(); } catch (e) { out.errors.push(`${what}: ${e}`); } };

  for (const s of slots) {
    const dir = slotDir(outDir, s.local_date, s.id);
    if (!dir) continue;
    const failedRecently = s.status === 'failed' && Date.parse(s.updated_at) > cutoffMs;
    if (!failedRecently) {
      // An attempt folder is named by its claim time; one inside the produce timeout may still have a producer.
      for (const e of entries(dir)) {
        const m = /^attempt-(\d+)$/.exec(e);
        if (m && Number(m[1]) < staleClaimMs) tryEach(`${s.id}/${e}`, () => { if (safeRemove(path.join(dir, e), outDir)) out.attempts++; });
      }
    }
    if (s.local_date <= cutoffDay) {
      tryEach(`${s.id} renders`, () => {
        const pubs = db.prepare('SELECT platform, state FROM publications WHERE slot_id = ?').all(s.id) as { platform: string; state: string }[];
        if (pubs.length && pubs.every((p) => p.state === 'published' || p.state === 'skipped')) {
          for (const p of pubs) if (/^[a-z]+$/.test(p.platform) && safeRemove(path.join(dir, `${p.platform}.mp4`), outDir)) out.renders++;
        }
      });
    }
  }

  const keepClips = new Set<string>();
  const hold = (f: unknown) => { if (typeof f === 'string' && f) keepClips.add(path.resolve(dataDir, f)); }; // old rows hold absolute paths
  for (const s of slots) {
    if (s.status !== 'ready' && s.status !== 'done') continue;
    try { hold(JSON.parse(s.master_json ?? 'null')?.clipFile); } catch { /* unreadable master: nothing to hold */ }
  }
  // A paid clip of a slot still being made is not in a master yet.
  for (const r of db.prepare("SELECT sp.file_path FROM spend sp JOIN slots s ON s.id = sp.slot_id WHERE sp.state = 'succeeded' AND s.status IN ('planned','producing')").all() as { file_path: string | null }[]) hold(r.file_path);
  for (const name of entries(clipsDir)) {
    tryEach(`clip ${name}`, () => {
      const f = path.join(clipsDir, name);
      const st = lstatSync(f);
      if (!st.isFile() || st.mtimeMs >= cutoffMs || keepClips.has(f)) return;
      if (safeRemove(f, clipsDir)) out.clips++;
    });
  }
  return out;
}

// Percent of the filesystem holding each folder that is used. `stat` is a parameter so tests can stub it.
export async function checkDisk(db: Db, config: Config, now: Date, stat: typeof statfsSync = statfsSync): Promise<void> {
  const full: string[] = [];
  for (const [name, dir] of [['DATA_DIR', env.dataDir()], ['OUT_DIR', env.outDir()]] as const) {
    try {
      const s = stat(path.resolve(dir));
      const used = s.blocks ? ((Number(s.blocks) - Number(s.bavail)) / Number(s.blocks)) * 100 : 0;
      if (used > config.ops.diskAlertPercent) full.push(`${name} ${used.toFixed(0)}% used`);
    } catch (e) {
      log.warn('disk check failed', { dir: name, error: String(e) });
    }
  }
  if (full.length) await alert(db, 'disk_full', localDateOf(now, config.timezone), `disk above ${config.ops.diskAlertPercent}%: ${full.join(', ')}`, now);
}

// Once a day, after the snapshot. The disk check always runs. Never throws.
export async function housekeepingDaily(db: Db, config: Config, now: Date, stat?: typeof statfsSync): Promise<void> {
  const today = localDateOf(now, config.timezone);
  if (localHHMM(now, config.timezone) < config.ops.snapshotAt || kvGet(db, 'housekeeping_at') === today) return;
  kvSet(db, 'housekeeping_at', today);
  let errors: string[] = [];
  try {
    const { errors: e, ...n } = housekeeping(db, config, now);
    errors = e;
    log.info('housekeeping', { ...n, errors: e.length });
  } catch (e) {
    errors = [String(e)];
  }
  try {
    if (errors.length) {
      log.error('housekeeping failed', { errors: errors.slice(0, 5) });
      await alert(db, 'housekeeping_failed', today, `housekeeping: ${errors.length} error(s), first: ${errors[0]}`, now);
    }
    await checkDisk(db, config, now, stat);
  } catch (e) {
    log.error('housekeeping alert failed', { error: String(e) });
  }
}
