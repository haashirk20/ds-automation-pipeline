import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { env, type Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log, scrub } from '../ops/log.ts';

export type ClipProvider = {
  name: string;
  configured(): boolean;
  submit(job: { imagePath: string; prompt: string; seconds: number; signal: AbortSignal }): Promise<{ jobId: string }>;
  // Waits for the job and writes the video to outFile.
  fetch(jobId: string, outFile: string, signal: AbortSignal): Promise<void>;
};
export type Tier = 't0' | 't1' | 't2';
export type PaidTier = 't1' | 't2';

// Test and dry-run stand-in. Offered only when CLIP_STUB_FILE is set, so it cannot be picked by accident.
const fake: ClipProvider = {
  name: 'fake',
  configured: () => {
    const f = env.clipStubFile();
    return !!f && existsSync(f);
  },
  submit: async () => ({ jobId: 'fake-' + randomBytes(4).toString('hex') }),
  fetch: async (_id, outFile) => copyFileSync(env.clipStubFile()!, outFile),
};

// 'fal' and 'higgsfield' are not implemented yet, so by default every slot is tier 0.
export function clipProviders(): Record<string, ClipProvider> {
  return env.clipStubFile() ? { fake } : {};
}

// All rows of the tier created this UTC month, whatever their state, at the quoted price.
export function monthSpendUsd(db: Db, tier: string, now: Date): number {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const r = db.prepare('SELECT COALESCE(SUM(quoted_usd), 0) AS s FROM spend WHERE tier = ? AND created_at >= ? AND created_at < ?').get(tier, from.toISOString(), to.toISOString()) as { s: number };
  return r.s;
}

export async function chooseTier(db: Db, config: Config, providers: Record<string, ClipProvider>, slotId: string, now: Date): Promise<Tier> {
  const { mix } = config.tiers;
  const u = createHash('sha256').update('tier:' + slotId).digest().readUInt32BE(0) / 2 ** 32;
  const drawn: Tier = u < mix.t0 ? 't0' : u < mix.t0 + mix.t1 ? 't1' : 't2';
  if (drawn === 't0') return 't0';
  const t = config.tiers[drawn];
  if (!providers[t.provider]?.configured()) return 't0';
  if (monthSpendUsd(db, drawn, now) + t.usdPerClip > config.tiers.capsUsd[drawn]) {
    const key = `${drawn}:${now.toISOString().slice(0, 7)}`;
    if (!db.prepare("SELECT 1 FROM events WHERE kind = 'budget_cap' AND key = ?").get(key)) {
      await alert(db, 'budget_cap', key, `${drawn} monthly cap of $${config.tiers.capsUsd[drawn]} reached: slots fall back to tier 0 until next month`, now);
    }
    return 't0';
  }
  return drawn;
}

type Row = { id: number; state: string; job_id: string | null; file_path: string | null; provider: string };
const setState = (db: Db, id: number, state: string, now: Date, f: { job_id?: string; file_path?: string; error?: string } = {}) =>
  db.prepare('UPDATE spend SET state = ?, job_id = COALESCE(?, job_id), file_path = COALESCE(?, file_path), error = ?, updated_at = ? WHERE id = ?')
    .run(state, f.job_id ?? null, f.file_path ?? null, f.error ?? null, now.toISOString(), id);

// A clip that came back but failed the checks: it still counts at its quoted price.
export const rejectClip = (db: Db, slotId: string, now: Date, why: string) =>
  db.prepare("UPDATE spend SET state = 'rejected', error = ?, updated_at = ? WHERE slot_id = ? AND state = 'succeeded'").run(scrub(why).slice(0, 300), now.toISOString(), slotId);

// Gets one clip for the slot into outFile. Never submits a second job for one already submitted.
export async function generateClip(
  db: Db, config: Config, providers: Record<string, ClipProvider>,
  job: { slotId: string; tier: PaidTier; imagePath: string; prompt: string; outFile: string; signal: AbortSignal }, now: Date,
): Promise<boolean> {
  const t = config.tiers[job.tier];
  const rows = db.prepare('SELECT id, state, job_id, file_path, provider FROM spend WHERE slot_id = ? ORDER BY id').all(job.slotId) as Row[];
  mkdirSync(path.dirname(job.outFile), { recursive: true });
  const tmp = job.outFile + '.part';
  const finish = (id: number) => {
    renameSync(tmp, job.outFile);
    setState(db, id, 'succeeded', now, { file_path: job.outFile });
    return true;
  };
  const fail = (id: number, e: unknown) => {
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
    setState(db, id, 'failed', now, { error: scrub(String(e)).slice(0, 300) });
    log.warn('clip job failed', { slot: job.slotId });
    return false;
  };

  // (a) already done
  const done = rows.find((r) => r.state === 'succeeded' && r.file_path && existsSync(r.file_path));
  if (done) {
    if (done.file_path !== job.outFile) copyFileSync(done.file_path!, job.outFile);
    return true;
  }
  // (b) submitted earlier: fetch that job, never submit again
  const sub = rows.find((r) => r.state === 'submitted' && r.job_id);
  if (sub) {
    const p = providers[sub.provider];
    if (!p?.configured()) return false; // leave the row; the job may still finish
    try {
      await p.fetch(sub.job_id!, tmp, job.signal);
      return finish(sub.id);
    } catch (e) {
      return fail(sub.id, e);
    }
  }
  // A 'reserved' row means a crash between reserving and storing the job id. Whether the job exists is unknown, so it is never re-submitted.
  const stale = rows.filter((r) => r.state === 'reserved');
  for (const r of stale) setState(db, r.id, 'failed', now, { error: 'crashed before the job id was stored' });
  if (stale.length) return false;
  // (c) new job
  if (rows.length >= config.tiers.maxJobsPerSlot) return false;
  const p = providers[t.provider];
  if (!p?.configured()) return false;
  if (monthSpendUsd(db, job.tier, now) + t.usdPerClip > config.tiers.capsUsd[job.tier]) return false;
  const id = Number(db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES (?,?,?,?, 'reserved', ?,?,?)")
    .run(job.slotId, job.tier, p.name, t.model, t.usdPerClip, now.toISOString(), now.toISOString()).lastInsertRowid);
  try {
    const { jobId } = await p.submit({ imagePath: job.imagePath, prompt: job.prompt, seconds: config.tiers.clipSeconds, signal: job.signal });
    setState(db, id, 'submitted', now, { job_id: jobId }); // before waiting
    await p.fetch(jobId, tmp, job.signal);
    return finish(id);
  } catch (e) {
    return fail(id, e);
  }
}
