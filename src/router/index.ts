import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { env, type Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { alert } from '../ops/alert.ts';
import { log, scrub } from '../ops/log.ts';
import { ClipPendingError, JobEndedError } from './errors.ts';
import { NeedsSignInError } from './higgsfield-auth.ts';
import { higgsfieldProvider } from './higgsfield.ts';

export type ClipJob = {
  images: string[]; // local reference images, the product first
  prompt: string; // the whole video as one prompt
  shots: { prompt: string; seconds: number }[]; // the same story shot by shot, for models that take shots; may be empty
  seconds: number;
  signal: AbortSignal;
};
export type ClipProvider = {
  name: string;
  configured(): boolean;
  // Throws when a job cannot or must not be started now. Runs before any ledger row is written.
  check?(job: ClipJob): Promise<void>;
  submit(job: ClipJob): Promise<{ jobId: string }>;
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

// 'fal' is not implemented yet. 'higgsfield' counts as configured once the owner has signed in (`auth higgsfield`).
export function clipProviders(db: Db, config: Config, now: () => Date): Record<string, ClipProvider> {
  return { higgsfield: higgsfieldProvider(db, config, { now }), ...(env.clipStubFile() ? { fake } : {}) };
}

// All rows of the tier created this UTC month, whatever their state, at the quoted price.
export function monthSpendUsd(db: Db, tier: string, now: Date): number {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const r = db.prepare('SELECT COALESCE(SUM(quoted_usd), 0) AS s FROM spend WHERE tier = ? AND created_at >= ? AND created_at < ?').get(tier, from.toISOString(), to.toISOString()) as { s: number };
  return r.s;
}

export async function chooseTier(db: Db, config: Config, providers: Record<string, ClipProvider>, slotId: string, now: Date): Promise<Tier> {
  // A job already paid for keeps its tier, so it is fetched or used even at the cap or when the provider is signed out.
  const paid = db.prepare("SELECT tier FROM spend WHERE slot_id = ? AND state IN ('submitted','succeeded') ORDER BY id DESC LIMIT 1").get(slotId) as { tier: Tier } | undefined;
  if (paid) return paid.tier;
  const { mix } = config.tiers;
  const u = createHash('sha256').update('tier:' + slotId).digest().readUInt32BE(0) / 2 ** 32;
  const drawn: Tier = u < mix.t0 ? 't0' : u < mix.t0 + mix.t1 ? 't1' : 't2';
  if (drawn === 't0') return 't0';
  const t = config.tiers[drawn];
  if (!providers[t.provider]?.configured()) return 't0';
  if (monthSpendUsd(db, drawn, now) + t.usdPerClip > config.tiers.capsUsd[drawn]) {
    const key = `${drawn}:${now.toISOString().slice(0, 7)}`;
    if (!db.prepare("SELECT 1 FROM events WHERE kind = 'budget_cap' AND key = ? AND delivered = 1").get(key)) {
      await alert(db, 'budget_cap', key, `${drawn} monthly cap of $${config.tiers.capsUsd[drawn]} reached: slots fall back to tier 0 until next month`, now);
    }
    return 't0';
  }
  return drawn;
}

type Row = { id: number; state: string; job_id: string | null; file_path: string | null; provider: string; created_at: string };
// A submitted job that has not given a file this long after it was created is given up; the slot then uses a stored clip.
export const PENDING_JOB_MAX_MS = 2 * 3600_000;
const setState = (db: Db, id: number, state: string, now: Date, f: { job_id?: string; file_path?: string; error?: string } = {}) =>
  db.prepare('UPDATE spend SET state = ?, job_id = COALESCE(?, job_id), file_path = COALESCE(?, file_path), error = ?, updated_at = ? WHERE id = ?')
    .run(state, f.job_id ?? null, f.file_path ?? null, f.error ?? null, now.toISOString(), id);

// A clip that came back but failed the checks: it still counts at its quoted price.
export const rejectClip = (db: Db, slotId: string, now: Date, why: string) =>
  db.prepare("UPDATE spend SET state = 'rejected', error = ?, updated_at = ? WHERE slot_id = ? AND state = 'succeeded'").run(scrub(why).slice(0, 300), now.toISOString(), slotId);

// Gets one clip for the slot into outFile. Never submits a second job for one already submitted.
export async function generateClip(
  db: Db, config: Config, providers: Record<string, ClipProvider>,
  job: { slotId: string; tier: PaidTier; images: string[]; prompt: string; shots: ClipJob['shots']; outFile: string; signal: AbortSignal }, now: Date,
): Promise<boolean> {
  const t = config.tiers[job.tier];
  const rows = db.prepare('SELECT id, state, job_id, file_path, provider, created_at FROM spend WHERE slot_id = ? ORDER BY id').all(job.slotId) as Row[];
  mkdirSync(path.dirname(job.outFile), { recursive: true });
  const tmp = job.outFile + '.part';
  const dataDir = path.resolve(env.dataDir());
  const finish = (id: number) => {
    renameSync(tmp, job.outFile);
    const rel = path.relative(dataDir, job.outFile);
    // Relative to DATA_DIR, so a database moved between the host and the container keeps its clips.
    setState(db, id, 'succeeded', now, { file_path: rel.startsWith('..') || path.isAbsolute(rel) ? job.outFile : rel });
    return true;
  };
  const fail = (id: number, e: unknown) => {
    if (job.signal.aborted) throw e; // cancelled: leave the row, so a submitted job is resumed next time
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
    setState(db, id, 'failed', now, { error: scrub(String(e)).slice(0, 300) });
    log.warn('clip job failed', { slot: job.slotId });
    return false;
  };

  // (a) already done
  const stored = (r: Row) => path.resolve(dataDir, r.file_path!);
  const done = rows.find((r) => r.state === 'succeeded' && r.file_path && existsSync(stored(r)));
  if (done) {
    if (stored(done) !== path.resolve(job.outFile)) copyFileSync(stored(done), job.outFile);
    return true;
  }
  // Once a day per kind. A failed delivery does not count, so it cannot hide the alert.
  const dailyAlert = async (kind: string, text: string) => {
    const day = now.toISOString().slice(0, 10);
    if (!db.prepare('SELECT 1 FROM events WHERE kind = ? AND key = ? AND delivered = 1').get(kind, day)) await alert(db, kind, day, text, now);
  };
  const signIn = (name: string) => dailyAlert('clip_sign_in', `${name} needs a sign-in: run "node src/cli.ts auth ${name}". Slots use tier 0 until then`);
  // The job exists at the provider and may be paid for: only a job that can never give a file is marked failed.
  const fetchFailed = async (r: Row, e: unknown): Promise<false> => {
    if (e instanceof JobEndedError || job.signal.aborted) return fail(r.id, e) as false;
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
    if (now.getTime() - Date.parse(r.created_at) > PENDING_JOB_MAX_MS) {
      log.warn('clip job abandoned after the time limit', { slot: job.slotId });
      return fail(r.id, new Error('the job did not finish within 2 hours')) as false;
    }
    log.warn('clip fetch interrupted; the job stays submitted', { slot: job.slotId, error: scrub(String(e)) });
    if (e instanceof NeedsSignInError) await signIn(r.provider);
    throw new ClipPendingError('clip job not fetched yet: ' + scrub(String(e)).slice(0, 200));
  };
  // (b) submitted earlier: fetch that job, never submit again
  const sub = rows.find((r) => r.state === 'submitted' && r.job_id);
  if (sub) {
    const p = providers[sub.provider];
    if (!p?.configured()) {
      await signIn(sub.provider);
      throw new ClipPendingError(`${sub.provider} is signed out; the submitted job is fetched after a sign-in`);
    }
    try {
      await p.fetch(sub.job_id!, tmp, job.signal);
      return finish(sub.id);
    } catch (e) {
      return await fetchFailed(sub, e);
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
  const cj: ClipJob = { images: job.images, prompt: job.prompt, shots: job.shots, seconds: config.tiers.clipSeconds, signal: job.signal };
  try {
    await p.check?.(cj);
  } catch (e) {
    const kind = e instanceof NeedsSignInError ? 'clip_sign_in' : 'clip_refused';
    log.warn('clip job not started', { slot: job.slotId, kind, error: scrub(String(e)) });
    if (kind === 'clip_sign_in') await signIn(p.name);
    else await dailyAlert(kind, `${p.name} clip not started (${scrub(String(e)).slice(0, 200)}): slots use tier 0`);
    return false;
  }
  const id = Number(db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES (?,?,?,?, 'reserved', ?,?,?)")
    .run(job.slotId, job.tier, p.name, t.model, t.usdPerClip, now.toISOString(), now.toISOString()).lastInsertRowid);
  let jid: string;
  try {
    const { jobId } = await p.submit(cj);
    setState(db, id, 'submitted', now, { job_id: jobId }); // before waiting
    jid = jobId;
  } catch (e) {
    return fail(id, e);
  }
  try {
    await p.fetch(jid, tmp, job.signal);
    return finish(id);
  } catch (e) {
    return await fetchFailed({ id, state: 'submitted', job_id: jid, file_path: null, provider: p.name, created_at: now.toISOString() }, e);
  }
}
