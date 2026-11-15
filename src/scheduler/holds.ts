// Posts on demand: manual slots are made like planned ones, then wait for the owner's Post. Database only.
import { audit } from '../config/overrides.ts';
import { slotTierDef } from '../config/models.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { enabledPlatforms } from './planner.ts';
import { localDateOf } from './time.ts';

export const MANUAL_BASE = 100;

export function manualToday(db: Db, config: Config, now: Date): { made: number; inFlight: boolean } {
  const made = (db.prepare("SELECT COUNT(*) AS n FROM slots WHERE local_date = ? AND kind = 'manual'").get(localDateOf(now, config.timezone)) as { n: number }).n;
  // Any day: a post still being made across midnight blocks the next one too.
  const f = db.prepare("SELECT 1 FROM slots WHERE kind = 'manual' AND status IN ('planned','producing') LIMIT 1").get();
  return { made, inFlight: !!f };
}

// One BEGIN IMMEDIATE, so two tabs or a double click cannot both pass the checks.
export function planManual(db: Db, config: Config, now: Date, videoModel: string | null): { slotId: string } | { refused: string } {
  const platforms = enabledPlatforms(config);
  if (config.creative.mode !== 'ugc') return { refused: 'posts on demand need the ugc creative mode' };
  if (!platforms.length) return { refused: 'no platform is enabled' };
  try { slotTierDef(db, config, videoModel); } catch (e) { return { refused: String((e as Error).message) }; }
  const date = localDateOf(now, config.timezone);
  const ts = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const { made, inFlight } = manualToday(db, config, now);
    const refused = inFlight ? 'A post is already being made' : made >= config.approval.manualPerDay ? `the limit of ${config.approval.manualPerDay} posts a day is reached` : null;
    if (refused) { db.exec('ROLLBACK'); return { refused }; }
    const idx = MANUAL_BASE + 1 + made;
    const id = `${date}#${idx}`;
    db.prepare("INSERT INTO slots (id, local_date, idx, created_at, updated_at, kind, video_model) VALUES (?,?,?,?,?, 'manual', ?)").run(id, date, idx, ts, ts, videoModel);
    for (const p of platforms) db.prepare('INSERT INTO publications (slot_id, platform, scheduled_at) VALUES (?,?,?)').run(id, p, ts);
    db.exec('COMMIT');
    return { slotId: id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The compare-and-set on hold = 'waiting' is the only gate: approve and discard race, and exactly one wins.
// false = nothing to approve (the other press won); 'nothing' = held, but no row is left to post (a platform was switched off or skipped).
export function approveHold(db: Db, slotId: string, now: Date): boolean | 'nothing' {
  const ts = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare("UPDATE slots SET hold = 'approved', updated_at = ? WHERE id = ? AND status = 'ready' AND hold = 'waiting'").run(ts, slotId);
    if (r.changes !== 1) { db.exec('ROLLBACK'); return false; }
    if (db.prepare("UPDATE publications SET scheduled_at = MAX(scheduled_at, ?), next_attempt_at = NULL WHERE slot_id = ? AND state = 'pending' AND handle_json IS NULL").run(ts, slotId).changes === 0) { db.exec('ROLLBACK'); return 'nothing'; }
    const m = /^custom:(\d+)$/.exec((db.prepare('SELECT video_model FROM slots WHERE id = ?').get(slotId) as { video_model: string | null }).video_model ?? '');
    if (m) db.prepare('UPDATE video_models SET approved_at = COALESCE(approved_at, ?) WHERE id = ?').run(ts, Number(m[1]));
    audit(db, 'admin', 'post.approve', slotId, {}, now);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function endHold(db: Db, slotId: string, now: Date, hold: 'discarded' | 'expired', why: string, actor: string): boolean {
  const ts = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare("UPDATE slots SET hold = ?, updated_at = ? WHERE id = ? AND status = 'ready' AND hold = 'waiting'").run(hold, ts, slotId);
    if (r.changes !== 1) { db.exec('ROLLBACK'); return false; }
    // handle_json IS NULL: a held row was never claimed, so this can never hide a post.
    db.prepare("UPDATE publications SET state = 'skipped', error = ? WHERE slot_id = ? AND state = 'pending' AND handle_json IS NULL").run(why, slotId);
    audit(db, actor, `post.${hold === 'discarded' ? 'discard' : 'expire'}`, slotId, {}, now);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const discardHold = (db: Db, slotId: string, now: Date) => endHold(db, slotId, now, 'discarded', 'discarded by the owner', 'admin');

// Called from tick() before publishDue. The waiting alert comes from the events table, so a crash cannot lose it.
export async function holdsTick(db: Db, config: Config, now: Date): Promise<void> {
  const waiting = db.prepare("SELECT id, held_at FROM slots WHERE status = 'ready' AND hold = 'waiting' ORDER BY id").all() as { id: string; held_at: string | null }[];
  const expireBefore = now.getTime() - config.approval.expireHours * 3600_000;
  for (const s of waiting) {
    if (s.held_at && Date.parse(s.held_at) < expireBefore) {
      if (endHold(db, s.id, now, 'expired', `not approved within ${config.approval.expireHours} hours`, 'system')) await alert(db, 'hold_expired', s.id, `${s.id} was not approved within ${config.approval.expireHours} hours and was dropped`, now);
    } else if (!db.prepare("SELECT 1 FROM events WHERE kind = 'approval_waiting' AND key = ? AND (delivered = 1 OR ts > ?)").get(s.id, new Date(now.getTime() - 15 * 60000).toISOString())) { // an undelivered try is repeated only after 15 minutes
      await alert(db, 'approval_waiting', s.id, `${s.id} is ready and waits for your approval in the admin page`, now);
    }
  }
}
