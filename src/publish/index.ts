import { autoPaused, type Db } from '../db/index.ts';
import { env, type Config } from '../config/index.ts';
import { alert } from '../ops/alert.ts';
import { log, scrub } from '../ops/log.ts';
import { Edl } from '../contracts.ts';
import { AmbiguousError, ClaimLostError, PermanentError, RetryableError, type Publisher } from './types.ts';

type Row = { slot_id: string; kind: string | null; platform: string; scheduled_at: string; attempt: number; handle_json: string | null; claimed_at: string | null; file_path: string | null; tier: string | null; title: string | null; caption: string | null; ai_json: string | null };

// The claim time is the fencing token: every write after a claim must carry it.
const COLS = new Set(['error', 'post_id', 'post_url', 'published_at', 'next_attempt_at', 'handle_json', 'claimed_at', 'attempt']);

const SELECT = `SELECT p.slot_id, s.kind, p.platform, p.scheduled_at, p.attempt, p.handle_json, p.claimed_at, r.file_path, s.tier, r.title, r.caption, r.ai_json
  FROM publications p
  LEFT JOIN slots s ON s.id = p.slot_id
  LEFT JOIN renders r ON r.slot_id = p.slot_id AND r.platform = p.platform AND r.qa_pass = 1`;

// `now` is the tick start and picks the rows. `clock` stamps each claim, publish time and backoff, since posting is serial and slow.
export async function publishDue(db: Db, config: Config, publishers: Record<string, Publisher>, now: Date, clock: () => Date = () => now): Promise<void> {
  const ts = now.toISOString();
  const platformCfg = (p: Row) => config.platforms[p.platform as keyof Config['platforms']];
  // Visuals or music made by AI always need the label; a synthetic voice only when tier0 disclosure is on.
  // Renders without an ai record fall back to the tier rule.
  const aiDisclosure = (p: Row) => {
    const ai = Edl.shape.ai.safeParse(p.ai_json ? JSON.parse(p.ai_json) : null);
    return ai.success ? ai.data.visuals || ai.data.music || (ai.data.voice && config.disclosure.tier0) : p.tier !== 't0' || config.disclosure.tier0;
  };

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
    if (!write(p, token, state, { error: scrub(error) })) return;
    await alert(db, 'publish_' + state, `${p.slot_id}/${p.platform}`, `${p.slot_id} ${p.platform} ${state}: ${error}`, now);
  };

  // p.attempt is already incremented for this claim.
  const run = async (p: Row, token: string) => {
    const ms = config.publish.timeoutMinutes * 60000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: { postId: string; postUrl: string | null };
    let hasHandle = !!p.handle_json; // a stored handle means a post request may have been sent
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
          title: p.title ?? p.slot_id,
          caption: p.caption ?? '',
          aiDisclosure: aiDisclosure(p),
          visibility: platformCfg(p).visibility,
          idempotencyKey: `${p.slot_id}:${p.platform}`,
          handle: p.handle_json ? JSON.parse(p.handle_json) : null,
          saveHandle: (x) => {
            if (!write(p, token, 'uploading', { handle_json: JSON.stringify(x) })) throw new ClaimLostError('claim lost');
            hasHandle = true;
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
        if (mins === undefined) return hasHandle ? fail(p, token, 'needs_attention', `retries exhausted, a post request may have been sent: ${msg}`) : fail(p, token, 'skipped', `retries exhausted: ${msg}`);
        write(p, token, 'pending', { next_attempt_at: new Date(clock().getTime() + mins * 60000).toISOString(), error: scrub(msg), claimed_at: null });
      } else if (e instanceof PermanentError) {
        await fail(p, token, hasHandle ? 'needs_attention' : 'skipped', hasHandle ? `a post request may have been sent: ${msg}` : msg);
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
      write(p, token, 'published', { post_id: result.postId, post_url: result.postUrl, published_at: clock().toISOString(), error: null });
    } catch (e) {
      log.error('recording success failed', { slot: p.slot_id, platform: p.platform, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const lateBefore = new Date(now.getTime() - config.publish.maxLatenessMinutes * 60000).toISOString();
  // Posting is serial: stop claiming while one more publish call could still end before the watchdog; the rest wait for the next tick.
  const outOfTime = () => clock().getTime() - now.getTime() > (config.watchdogMinutes - config.publish.timeoutMinutes - 2) * 60000;

  // Stale recovery only: a fresh 'uploading' row belongs to a live upload.
  const staleBefore = new Date(now.getTime() - config.publish.uploadTimeoutMinutes * 60000).toISOString();
  const stale = db.prepare(SELECT + " WHERE p.state = 'uploading' AND (p.claimed_at IS NULL OR p.claimed_at < ?)").all(staleBefore) as Row[];
  if (stale.length && env.dryRun()) log.info('dry-run: stale uploading rows left untouched', { count: stale.length });
  else {
    for (const p of stale) {
      if (outOfTime()) break;
      const token = clock().toISOString();
      const claim = db.prepare("UPDATE publications SET claimed_at = ?, attempt = attempt + 1 WHERE slot_id = ? AND platform = ? AND state = 'uploading' AND claimed_at IS ?")
        .run(token, p.slot_id, p.platform, p.claimed_at);
      if (claim.changes !== 1) continue;
      p.attempt += 1;
      if (p.attempt > config.publish.retryMinutes.length + 1) await fail(p, token, 'needs_attention', 'too many attempts');
      else if (p.scheduled_at < lateBefore) {
        if (p.handle_json) await fail(p, token, 'needs_attention', 'too late, upload may have started');
        else await fail(p, token, 'skipped', 'too late');
      } else if (p.handle_json) await run(p, token);
      else write(p, token, 'pending', { claimed_at: null, attempt: p.attempt - 1 }); // the due claim counts this attempt
    }
  }

  // Skip overdue rows and rows of failed slots, one alert per slot.
  const doomed = db.prepare(`SELECT p.slot_id, p.platform, p.handle_json, s.kind, s.error AS serror, CASE WHEN s.status = 'failed' THEN 'slot failed' ELSE 'too late' END AS why
    FROM publications p LEFT JOIN slots s ON s.id = p.slot_id
    WHERE p.state = 'pending' AND COALESCE(s.hold, '') != 'waiting' AND NOT (s.kind = 'manual' AND s.status IN ('planned','producing')) AND (p.scheduled_at < ? OR s.status = 'failed')`).all(lateBefore) as { slot_id: string; platform: string; handle_json: string | null; kind: string | null; serror: string | null; why: string }[];
  for (const d of doomed) {
    const state = d.handle_json ? 'needs_attention' : 'skipped';
    // Held by the owner's stop until too late (or its slot failed quietly as 'paused'): nothing was sent, so it ends quietly.
    // A slot that failed for a real reason keeps its error and alert. The stop is read live (D-45).
    const held = !d.handle_json && ((d.why === 'too late' && d.kind === 'planned' && !!autoPaused(db)) || d.serror === 'paused');
    const why = d.handle_json ? `${d.why}, a post request may have been sent` : held ? 'paused' : d.why;
    if (db.prepare("UPDATE publications SET state = ?, error = ? WHERE slot_id = ? AND platform = ? AND state = 'pending'").run(state, why, d.slot_id, d.platform).changes !== 1) continue;
    if (d.handle_json) await alert(db, 'publish_needs_attention', `${d.slot_id}/${d.platform}`, `${d.slot_id} ${d.platform} needs_attention: ${why}`, now);
    else if (held) log.info('row skipped, daily posts stopped', { slot: d.slot_id, platform: d.platform });
    else if (!config.platforms[d.platform as keyof Config['platforms']]?.enabled) log.info('row skipped, platform disabled', { slot: d.slot_id, platform: d.platform, why: d.why });
    else await alert(db, 'publish_skipped', d.slot_id, `${d.slot_id} skipped: ${d.why}`, now);
  }

  const due = db.prepare(SELECT + " WHERE s.status = 'ready' AND r.file_path IS NOT NULL AND COALESCE(s.hold, 'none') IN ('none', 'approved') AND p.state = 'pending' AND p.scheduled_at <= ? AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ?) ORDER BY p.scheduled_at, p.platform").all(ts, ts) as Row[];
  for (const p of due) {
    // D-45: while the owner has stopped daily posts, daily-post rows are not claimed; manual videos still go out.
    // A row with a stored handle (an earlier attempt that may have posted) still runs, so it is reconciled. No handle:
    // nothing was sent, so holding it is safe. Read live per row, so Stop pressed mid-tick holds the rest.
    if (p.kind === 'planned' && !p.handle_json && autoPaused(db)) continue;
    // Switched off after planning: nothing was sent for this row, so it is skipped. A row with a handle resumes.
    if (!platformCfg(p).enabled && !p.handle_json) {
      db.prepare("UPDATE publications SET state = 'skipped', error = 'platform disabled' WHERE slot_id = ? AND platform = ? AND state = 'pending' AND handle_json IS NULL").run(p.slot_id, p.platform);
      log.info('row skipped, platform disabled', { slot: p.slot_id, platform: p.platform });
      continue;
    }
    if (env.dryRun()) {
      log.info('dry-run publish', { slot: p.slot_id, platform: p.platform, title: p.title ?? p.slot_id, caption: p.caption ?? '', aiDisclosure: aiDisclosure(p), visibility: platformCfg(p).visibility, file: p.file_path });
      db.prepare("UPDATE publications SET state = 'published', dry_run = 1, post_id = 'dry-run', published_at = ? WHERE slot_id = ? AND platform = ? AND state = 'pending'").run(clock().toISOString(), p.slot_id, p.platform);
      continue;
    }
    if (outOfTime()) break;
    // Atomic claim: only one process can move the row out of 'pending'.
    const token = clock().toISOString();
    const claim = db.prepare("UPDATE publications SET state = 'uploading', attempt = attempt + 1, claimed_at = ? WHERE slot_id = ? AND platform = ? AND state = 'pending'").run(token, p.slot_id, p.platform);
    if (claim.changes !== 1) continue;
    p.attempt += 1;
    await run(p, token);
  }

  db.prepare(`UPDATE slots SET status = 'done', updated_at = ? WHERE status = 'ready' AND NOT EXISTS (
    SELECT 1 FROM publications WHERE slot_id = slots.id AND state IN ('pending','uploading'))`).run(ts);
}
