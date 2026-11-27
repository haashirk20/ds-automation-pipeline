import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env, type Config } from '../config/index.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { monthSpend } from '../llm/client.ts';
import { addDays, localDateOf, localHHMM } from '../scheduler/time.ts';
import { monthSpendUsd } from '../router/index.ts';
import { alert, hasAlertChannel } from './alert.ts';
import { log } from './log.ts';

const RETRY_MS = 15 * 60000;
const MAX_CHARS = 1900; // Discord refuses 2,000
const STALE_HOURS = 26;

// Age of the backup container's last success, from <BACKUP_STATUS_DIR>/last-ok. STALE when it is older
// than 26 hours, or when it differs from the snapshot marker in DATA_DIR/backup/ready and that snapshot is over an hour old.
export function backupStatus(now: Date): string {
  const dir = env.backupStatusDir();
  if (!dir) return 'not configured';
  const read = (f: string) => { try { return readFileSync(f, 'utf8').trim(); } catch { return null; } };
  const lastOk = read(path.join(dir, 'last-ok'));
  if (lastOk === null) return 'no last-ok yet';
  const t = Date.parse(lastOk);
  if (Number.isNaN(t)) return 'last-ok unreadable';
  const ready = read(path.join(path.resolve(env.dataDir()), 'backup', 'ready'));
  const behind = ready !== null && ready !== lastOk && now.getTime() - Date.parse(ready) > 3600000;
  const h = (now.getTime() - t) / 3600000;
  let s = `last ok ${h.toFixed(1)}h ago${h > STALE_HOURS || behind ? ' (STALE)' : ''}`;
  const failed = read(path.join(dir, 'check-failed'));
  if (failed !== null) s += ` (restic check FAILED ${failed})`;
  return s;
}

// What private means per platform; the summary, doctor and admin pages all use these labels.
export const PRIVATE_LABEL: Record<string, string> = {
  youtube: 'only you can see these posts, 0 views expected',
  tiktok: 'posts go to the TikTok inbox as drafts and are not published',
  facebook: 'posts are saved as drafts in Publishing Tools and are not published',
};
const NAMES: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook' };
// One line per enabled platform that is not public. Pass the effective config so admin overrides count.
export const privateWarnings = (config: Config): string[] =>
  Object.entries(config.platforms).filter(([, p]) => p.enabled && p.visibility !== 'public').map(([k]) => `${NAMES[k] ?? k}: private (${PRIVATE_LABEL[k] ?? 'not public'})`);

type Pub = { idx: number; platform: string; state: string; post_url: string | null };

export function buildSummary(db: Db, config: Config, now: Date): string {
  const today = localDateOf(now, config.timezone);
  const yesterday = addDays(today, -1);
  const L: string[] = [`Daily summary for ${yesterday}`];

  const pubs = db.prepare('SELECT s.idx, p.platform, p.state, p.post_url FROM publications p JOIN slots s ON s.id = p.slot_id WHERE s.local_date = ? ORDER BY s.idx, p.platform').all(yesterday) as Pub[];
  L.push('Yesterday:');
  if (!pubs.length) L.push('  no publications');
  for (const p of pubs) L.push(`  #${p.idx} ${p.platform}: ${p.state}${p.post_url ? ' ' + p.post_url : ''}`);

  L.push(`Today (${today}):`);
  const slots = db.prepare('SELECT idx, status, error, master_json, kind, hold FROM slots WHERE local_date = ? ORDER BY idx').all(today) as { idx: number; status: string; error: string | null; master_json: string | null; kind: string; hold: string | null }[];
  if (!slots.length) L.push('  no slots');
  for (const s of slots) {
    let reused: string | null = null;
    try { reused = JSON.parse(s.master_json ?? 'null')?.reusedFrom ?? null; } catch { /* no master */ }
    const note = reused ? `, reused from ${reused}` : s.status === 'failed' && s.error ? `: ${s.error}` : '';
    L.push(`  #${s.idx}${s.kind === 'manual' ? ' manual' : ''} ${s.status}${s.hold === 'waiting' ? ', waiting for approval' : ''}${note}`);
  }

  const spendLine = (label: string, d: Date, caps: boolean) => {
    const of = (cap: number) => (caps ? ` of $${cap}` : '');
    return `${label}: model calls $${monthSpend(db, d).toFixed(2)}${of(config.llm.monthlyCapUsd)}, t2 $${monthSpendUsd(db, 't2', d).toFixed(2)}${of(config.tiers.capsUsd.t2)}`;
  };
  L.push(spendLine('Spend this month', now, true));
  if (today.endsWith('-01')) L.push(spendLine('Spend last month', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)), false));

  const held = db.prepare("SELECT COUNT(*) AS n, MIN(held_at) AS oldest FROM slots WHERE status = 'ready' AND hold = 'waiting'").get() as { n: number; oldest: string | null };
  if (held.n) L.push(`Waiting for approval: ${held.n} (oldest expires ${new Date(Date.parse(held.oldest!) + config.approval.expireHours * 3600_000).toISOString()})`);

  const attention = (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE state = 'needs_attention'").get() as { n: number }).n;
  const since = new Date(now.getTime() - 86400000).toISOString();
  const undelivered = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE delivered = 0 AND ts > ? AND kind != 'daily_summary'").get(since) as { n: number }).n;
  L.push(...privateWarnings(config));
  L.push(`Needs attention: ${attention}`, `Undelivered alerts, last 24h: ${undelivered}`, `Backup: ${backupStatus(now)}`);

  const text = L.join('\n');
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 3) + '...' : text;
}

// Pings the dead-man's switch once per summary, and only when a real channel delivered it: with no
// channel alert() counts a summary as delivered, and the ping would hide the missing webhook.
// Retried at most every 15 minutes until the response is ok.
async function pingDaily(db: Db, key: string, now: Date): Promise<void> {
  const url = env.healthcheckDailyUrl();
  if (!url || !hasAlertChannel() || kvGet(db, 'summary_ping') === key) return;
  const tried = kvGet(db, 'summary_ping_try');
  if (tried && now.getTime() - Date.parse(tried) < RETRY_MS) return;
  kvSet(db, 'summary_ping_try', now.toISOString());
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) kvSet(db, 'summary_ping', key);
    else log.warn('daily healthcheck ping failed', { status: r.status });
  } catch (e) { log.warn('daily healthcheck ping failed', { error: String(e) }); }
}

// After local summaryAt, once per day for yesterday. A failed send is tried again after 15 minutes.
// The dead-man's switch is pinged only after a delivered summary (D-15). Never throws.
export async function summaryDaily(db: Db, config: Config, now: Date): Promise<void> {
  try {
    if (localHHMM(now, config.timezone) < config.ops.summaryAt) return;
    const key = addDays(localDateOf(now, config.timezone), -1);
    const state = () => db.prepare("SELECT MAX(delivered) AS ok, MAX(ts) AS ts FROM events WHERE kind = 'daily_summary' AND key = ?").get(key) as { ok: number | null; ts: string | null };
    const last = state();
    if (last.ok !== 1) {
      if (last.ts && now.getTime() - Date.parse(last.ts) < RETRY_MS) return;
      await alert(db, 'daily_summary', key, buildSummary(db, config, now), now);
      if (state().ok !== 1) return;
    }
    await pingDaily(db, key, now);
  } catch (e) {
    log.error('daily summary failed', { error: String(e) });
  }
}
