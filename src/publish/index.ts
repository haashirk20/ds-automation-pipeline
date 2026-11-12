import type { Db } from '../db/index.ts';
import { env, type Config } from '../config/index.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { AmbiguousError, ClaimLostError, PermanentError, RetryableError, type Publisher } from './types.ts';

type Row = { slot_id: string; platform: string; scheduled_at: string; attempt: number; handle_json: string | null; claimed_at: string | null; file_path: string | null; tier: string | null };

// The claim time is the fencing token: every write after a claim must carry it.
const COLS = new Set(['error', 'post_id', 'post_url', 'published_at', 'next_attempt_at', 'handle_json', 'claimed_at']);

const SELECT = `SELECT p.slot_id, p.platform, p.scheduled_at, p.attempt, p.handle_json, p.claimed_at, r.file_path, s.tier
  FROM publications p
  LEFT JOIN slots s ON s.id = p.slot_id
  LEFT JOIN renders r ON r.slot_id = p.slot_id AND r.platform = p.platform AND r.qa_pass = 1`;

export async function publishDue(db: Db, config: Config, publishers: Record<string, Publisher>, now: Date): Promise<void> {
  const ts = now.toISOString();
  const platformCfg = (p: Row) => config.platforms[p.platform as keyof Config['platforms']];
  const aiDisclosure = (p: Row) => p.tier !== 't0' || config.disclosure.tier0;

  // Fenced write: only succeeds while this process still owns the claim.
  const write = (p: Row, token: string, state: string, f: Record<string, unknown> = {}): boolean => {
    const cols = Object.keys(f);
    for (const c of cols) if (!COLS.has(c)) throw new Error(`bad column ${c}`);
    const r = db.prepare(`UPDATE publications SET state = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE slot_id = ? AND platform = ? AND state = 'uploading' AND claimed_at = ?`)
      .run(state, ...(Object.values(f) as never[]), p.slot_id, p.platform, token);
    if (r.changes !== 1) log.warn('claim lost, write dropped', { slot: p.slot_id, platform: p.platform });
    return r.changes === 1;
  };
  const fail = async (p: Row, token: string, state: string, error: string) => {
    if (!write(p, token, state, { error })) return;
    await alert(db, 'publish_' + state, `${p.slot_id}/${p.platform}`, `${p.slot_id} ${p.platform} ${state}: ${error}`, now);
  };

  // p.attempt is already incremented for this claim.
  const run = async (p: Row, token: string) => {
    const ms = config.publish.timeoutMinutes * 60000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: { postId: string; postUrl: string | null };
    try {
      const pub = publishers[p.platform];
      if (!pub) throw new PermanentError(`no publisher for ${p.platform}`);
      if (!p.file_path) throw p.handle_json ? new AmbiguousError('render missing, upload may have started') : new PermanentError('render missing');
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new RetryableError('publish timed out')), ms);
      });
      result = await Promise.race([
        pub.publish({
          filePath: p.file_path,
          title: p.slot_id,
          caption: '',
          aiDisclosure: aiDisclosure(p),
          visibility: platformCfg(p).visibility,
          idempotencyKey: `${p.slot_id}:${p.platform}`,
          handle: p.handle_json ? JSON.parse(p.handle_json) : null,
          saveHandle: (x) => {
            if (!write(p, token, 'uploading', { handle_json: JSON.stringify(x) })) throw new ClaimLostError('claim lost');
          },
          signal: AbortSignal.timeout(ms),
        }),
        timeout,
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ClaimLostError) return;
      if (e instanceof RetryableError) {
        const mins = config.publish.retryMinutes[p.attempt - 1];
        if (mins === undefined) return fail(p, token, 'skipped', `retries exhausted: ${msg}`);
        write(p, token, 'pending', { next_attempt_at: new Date(now.getTime() + mins * 60000).toISOString(), error: msg, claimed_at: null });
      } else if (e instanceof PermanentError) {
        await fail(p, token, 'skipped', msg);
      } else {
        // AmbiguousError or unknown: never retried automatically.
        await fail(p, token, 'needs_attention', (e instanceof AmbiguousError ? '' : 'unexpected: ') + msg);
      }
      return;
    } finally {
      clearTimeout(timer);
    }
    // Outside the classifier: a DB error here leaves the row 'uploading' with its handle for recovery.
    try {
      write(p, token, 'published', { post_id: result.postId, post_url: result.postUrl, published_at: ts, error: null });
    } catch (e) {
      log.error('recording success failed', { slot: p.slot_id, platform: p.platform, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const lateBefore = new Date(now.getTime() - config.publish.maxLatenessMinutes * 60000).toISOString();

  // Stale recovery only: a fresh 'uploading' row belongs to a live upload.
  const staleBefore = new Date(now.getTime() - config.publish.uploadTimeoutMinutes * 60000).toISOString();
  const stale = db.prepare(SELECT + " WHERE p.state = 'uploading' AND (p.claimed_at IS NULL OR p.claimed_at < ?)").all(staleBefore) as Row[];
  if (stale.length && env.dryRun()) log.info('dry-run: stale uploading rows left untouched', { count: stale.length });
  else {
    for (const p of stale) {
      const claim = db.prepare("UPDATE publications SET claimed_at = ?, attempt = attempt + 1 WHERE slot_id = ? AND platform = ? AND state = 'uploading' AND claimed_at IS ?")
        .run(ts, p.slot_id, p.platform, p.claimed_at);
      if (claim.changes !== 1) continue;
      p.attempt += 1;
      if (p.attempt > config.publish.retryMinutes.length + 1) await fail(p, ts, 'needs_attention', 'too many attempts');
      else if (p.scheduled_at < lateBefore) {
        if (p.handle_json) await fail(p, ts, 'needs_attention', 'too late, upload may have started');
        else await fail(p, ts, 'skipped', 'too late');
      } else if (p.handle_json) await run(p, ts);
      else write(p, ts, 'pending', { claimed_at: null });
    }
  }

  // Skip overdue rows and rows of failed slots, one alert per slot.
  const doomed = db.prepare(`SELECT p.slot_id, p.platform, CASE WHEN s.status = 'failed' THEN 'slot failed' ELSE 'too late' END AS why
    FROM publications p LEFT JOIN slots s ON s.id = p.slot_id
    WHERE p.state = 'pending' AND (p.scheduled_at < ? OR s.status = 'failed')`).all(lateBefore) as { slot_id: string; platform: string; why: string }[];
  for (const d of doomed) {
    db.prepare("UPDATE publications SET state = 'skipped', error = ? WHERE slot_id = ? AND platform = ? AND state = 'pending'").run(d.why, d.slot_id, d.platform);
    await alert(db, 'publish_skipped', d.slot_id, `${d.slot_id} skipped: ${d.why}`, now);
  }

  const due = db.prepare(SELECT + " WHERE s.status = 'ready' AND r.file_path IS NOT NULL AND p.state = 'pending' AND p.scheduled_at <= ? AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ?) ORDER BY p.scheduled_at, p.platform").all(ts, ts) as Row[];
  for (const p of due) {
    if (env.dryRun()) {
      log.info('dry-run publish', { slot: p.slot_id, platform: p.platform, title: p.slot_id, caption: '', aiDisclosure: aiDisclosure(p), visibility: platformCfg(p).visibility, file: p.file_path });
      db.prepare("UPDATE publications SET state = 'published', dry_run = 1, post_id = 'dry-run', published_at = ? WHERE slot_id = ? AND platform = ? AND state = 'pending'").run(ts, p.slot_id, p.platform);
      continue;
    }
    // Atomic claim: only one process can move the row out of 'pending'.
    const claim = db.prepare("UPDATE publications SET state = 'uploading', attempt = attempt + 1, claimed_at = ? WHERE slot_id = ? AND platform = ? AND state = 'pending'").run(ts, p.slot_id, p.platform);
    if (claim.changes !== 1) continue;
    p.attempt += 1;
    await run(p, ts);
  }

  db.prepare(`UPDATE slots SET status = 'done', updated_at = ? WHERE status = 'ready' AND NOT EXISTS (
    SELECT 1 FROM publications WHERE slot_id = slots.id AND state IN ('pending','uploading'))`).run(ts);
}
