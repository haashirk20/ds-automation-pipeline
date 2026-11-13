import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { env, type Config, type PlatformName } from '../config/index.ts';
import { CAPTION_STYLES } from '../../templates/caption-style.ts';
import { Script, TEMPLATES, type Brief, type Edl, type Platform } from '../contracts.ts';
import { assembleEdl, ScriptTooLongError, ttsLines, type AssembleInput } from '../creative/assemble.ts';
import { CopyRejectedError, copyProblems, fallbackCopy, writeCopy, type PlatformCopy } from '../creative/copy.ts';
import { checkScript } from '../creative/claims.ts';
import { pickHook, refillHooks, type Hook } from '../creative/hooks.ts';
import { writeScript } from '../creative/script.ts';
import { kvGet, kvSet, type Db } from '../db/index.ts';
import { LlmCapError, LlmRefusalError, RetryableLlmError } from '../llm/client.ts';
import { makeBed } from '../music/index.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { captionStyleOk, runQa } from '../qa/index.ts';
import { enabledPlatforms } from '../scheduler/planner.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import { listBriefs, runIngest } from '../shopify/index.ts';
import { synthesize } from '../tts/index.ts';
import { renderEdl } from './render.ts';

// Paths come only from slot id and platform; the result must stay inside OUT_DIR.
function safeDir(root: string, localDate: string, slotId: string): string {
  const base = path.resolve(root);
  const dir = path.resolve(base, localDate, slotId.replace('#', '-'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{4}-\d{2}-\d{2}#\d+$/.test(slotId) || !dir.startsWith(base + path.sep)) throw new Error(`unsafe render path for ${slotId}`);
  return dir;
}

// Warm cream, deep brown, red, olive and gold: the product's colours. Light backgrounds go with the
// light template, dark with the dark ones; ink and plate keep captions readable.
type Palette = Edl['palette'];
export const PALETTES: Record<Edl['template'], Palette[]> = {
  'kinetic-bold': [
    { bg: '#1F1412', ink: '#FFFFFF', accent: '#E3B23C', plate: '#000000' },
    { bg: '#2A1A12', ink: '#FFF6E6', accent: '#D94A3A', plate: '#000000' },
    { bg: '#26301A', ink: '#FFF6E6', accent: '#E3B23C', plate: '#000000' },
  ],
  'cozy-soft': [
    { bg: '#F4E9DC', ink: '#3A2A20', accent: '#B5503C', plate: '#FFFFFF' },
    { bg: '#F7EEDD', ink: '#2E2218', accent: '#6E7230', plate: '#FFFFFF' },
    { bg: '#FBF1DF', ink: '#3A2A20', accent: '#C0392B', plate: '#FFFFFF' },
  ],
  'gift-guide': [
    { bg: '#1F3B2C', ink: '#FFF8EC', accent: '#D9A441', plate: '#12241B' },
    { bg: '#3B4A22', ink: '#FFF8EC', accent: '#D9A441', plate: '#222B12' },
    { bg: '#5A1F1A', ink: '#FFF8EC', accent: '#E8B84A', plate: '#2E100D' },
  ],
};

export type Variant = { template: Edl['template']; palette: Palette; voice: string; musicSeed: number };

const hash = (s: string) => createHash('sha256').update(s).digest().readUInt32BE(0);

// Pure: the same slot id always gives the same variant. The template never equals the previous
// slot's; `retry` moves on to the next candidate.
export function chooseVariant(slotId: string, ordinal: number, prevTemplate: string | null, voices: string[], retry = 0): Variant {
  const h = hash(slotId);
  const options = TEMPLATES.filter((t) => t !== prevTemplate);
  const template = options[(h + retry) % options.length];
  const palettes = PALETTES[template];
  return { template, palette: palettes[(h >>> 8) % palettes.length], voice: voices[ordinal % voices.length], musicSeed: h % 1_000_000 };
}

// Seams for tests; production uses the real modules.
export type ProduceDeps = {
  ingest: (now: Date) => Promise<void>;
  synthesize: typeof synthesize;
  makeBed: typeof makeBed;
  render: typeof renderEdl;
  qa: typeof runQa;
  signal?: AbortSignal; // SIGTERM from the parent: stop rendering and leave the slot for stale recovery
  ingestDeadlineMs: number;
};

const SPEEDS = [1.0, 1.06, 1.12];
const DAY_MS = 24 * 3600 * 1000;
type Slot = { id: string; local_date: string; idx: number };
const before = 'local_date < ? OR (local_date = ? AND idx < ?)'; // slots ahead of this one, in order

// The store could not be read and there is no stored brief: the slot goes back to 'planned'.
export class NoBriefError extends Error {}
// Another producer owns the slot now; this one must stop writing.
export class ClaimLostError extends Error {}

// Daily, under an overall deadline. A failure alerts and keeps the stored brief; retry in an hour.
async function ensureIngest(db: Db, now: Date, d: ProduceDeps): Promise<void> {
  const last = kvGet(db, 'ingest_at');
  if (last && now.getTime() - Date.parse(last) < DAY_MS) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([d.ingest(now), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('ingest deadline exceeded')), d.ingestDeadlineMs)))]);
    kvSet(db, 'ingest_at', now.toISOString());
  } catch (e) {
    kvSet(db, 'ingest_at', new Date(now.getTime() - DAY_MS + 3600_000).toISOString());
    await alert(db, 'ingest_failed', 'ingest', `ingest failed, using the stored brief: ${e}`, now);
  } finally {
    clearTimeout(timer);
  }
}

function pickBrief(db: Db, ordinal: number): Brief {
  const briefs = listBriefs(db);
  if (!briefs.length) throw new NoBriefError('no product brief and the store could not be read');
  return briefs[ordinal % briefs.length];
}

// Oldest finished slot of this product, old enough that its script may run again, with its stored copy.
// A stored script must still pass every check against the current brief.
function oldSlot(db: Db, config: Config, brief: Brief, now: Date): { hookId: number | null; script: Script } | null {
  const cutoff = addDays(localDateOf(now, config.timezone), -config.hooks.noRepeatDays);
  const rows = db.prepare("SELECT hook_id, master_json FROM slots WHERE product_handle = ? AND status IN ('ready','done') AND master_json IS NOT NULL AND local_date < ? ORDER BY local_date, idx").all(brief.product.handle, cutoff) as { hook_id: number | null; master_json: string }[];
  for (const r of rows) {
    const parsed = Script.safeParse(JSON.parse(r.master_json).script);
    if (!parsed.success) continue;
    const problems = checkScript(brief, parsed.data);
    if (problems.length) {
      log.warn('stored script rejected against the current brief', { problems: problems.slice(0, 3) });
      continue;
    }
    return { hookId: r.hook_id, script: parsed.data };
  }
  return null;
}

// Model copy, or a deterministic fallback from the brief when the copy call fails for any reason.
async function getCopy(db: Db, config: Config, brief: Brief, script: Script, now: Date, slotId: string): Promise<Record<Platform, PlatformCopy>> {
  try {
    return await writeCopy(db, config, brief, script, now, slotId);
  } catch (e) {
    log.warn('copy writer failed, using the fallback copy', { slot: slotId, error: String(e) });
    const copy = fallbackCopy(brief, script);
    const problems = copyProblems(brief, copy);
    if (problems.length) throw new CopyRejectedError(problems);
    return copy;
  }
}

const isOutage = (e: unknown, refusal = false) => e instanceof LlmCapError || e instanceof RetryableLlmError || (refusal && e instanceof LlmRefusalError);

// Steps 1 to 10 for one slot; throws on failure. Every write is fenced by the claim time.
async function produce(db: Db, config: Config, slot: Slot, dir: string, token: string, now: Date, d: ProduceDeps): Promise<void> {
  const t0 = Date.now();
  // Throws when this producer no longer owns the slot or was told to stop.
  const hold = () => {
    if (d.signal?.aborted) throw new Error('cancelled');
    const r = db.prepare("UPDATE slots SET updated_at = ? WHERE id = ? AND status = 'producing' AND claimed_at = ?").run(token, slot.id, token);
    if (r.changes !== 1) throw new ClaimLostError(`claim on ${slot.id} lost`);
  };
  await ensureIngest(db, now, d);
  const ordinal = (db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE ${before}`).get(slot.local_date, slot.local_date, slot.idx) as { n: number }).n;
  const brief = pickBrief(db, ordinal);
  const handle = brief.product.handle;
  const work = path.join(dir, `attempt-${Date.parse(token)}`, 'work');
  mkdirSync(work, { recursive: true });
  const attemptDir = path.dirname(work);

  // Hook and script, or the degraded path when the model is unavailable.
  try {
    await refillHooks(db, config, brief, now);
  } catch (e) {
    log.warn('hook refill skipped', { slot: slot.id, error: String(e) }); // a failed refill never fails a slot
  }
  hold();
  const hook: Hook | null = pickHook(db, config, handle, now);
  let script: Script | null = null;
  let hookId: number | null = hook?.id ?? null;
  let degraded = false;
  if (hook) {
    try {
      script = await writeScript(db, config, brief, hook, now, slot.id);
    } catch (e) {
      if (!isOutage(e, true)) throw e;
      log.warn('script writer unavailable', { slot: slot.id, error: String(e) });
    }
  }
  if (!script) {
    const stored = oldSlot(db, config, brief, now);
    if (!stored) throw new Error('no hook or script available and no usable old slot to reuse');
    ({ script, hookId } = stored);
    degraded = true;
    await alert(db, 'degraded', slot.id, `${slot.id} reuses a stored script: the model is unavailable or no hook is free`, now);
  }
  hold();

  // Variant, music, voice.
  const prev = db.prepare(`SELECT master_json FROM slots WHERE master_json IS NOT NULL AND (${before}) ORDER BY local_date DESC, idx DESC LIMIT 1`).get(slot.local_date, slot.local_date, slot.idx) as { master_json: string } | undefined;
  const prevTemplate: string | null = prev ? JSON.parse(prev.master_json).variant?.template ?? null : null;
  const variant = chooseVariant(slot.id, ordinal, prevTemplate, config.creative.voices);
  const voiceWav = path.join(work, 'voice.wav');
  const bedWav = path.join(work, 'bed.wav');
  const music = config.creative.music.enabled;
  if (music) await d.makeBed({ seed: variant.musicSeed, durationSec: 16, outWav: bedWav });
  const inputFor = (s: Script, v: Variant, tts: AssembleInput['tts']): AssembleInput => ({
    slotId: slot.id, brief, script: s, template: v.template, palette: v.palette, tts, voiceSrc: voiceWav, musicSrc: music ? bedWav : null,
    musicGainDb: config.creative.music.gainDb, dataDir: path.resolve(env.dataDir()), ai: { visuals: false, voice: true, music: false },
  });
  // Slows the voice a little at a time until the script fits; null when it never does.
  const fit = async (s: Script): Promise<AssembleInput | null> => {
    for (const speed of SPEEDS) {
      const tts = await d.synthesize({ lines: ttsLines(s), voice: variant.voice, speed, gapMs: 180, outWav: voiceWav });
      try {
        const i = inputFor(s, variant, tts);
        assembleEdl(i); // throws ScriptTooLongError when the voice runs past the limit
        return i;
      } catch (e) {
        if (!(e instanceof ScriptTooLongError)) throw e;
      }
    }
    return null;
  };
  let input = await fit(script);
  if (!input && hook && !degraded) {
    script = await writeScript(db, config, brief, hook, now, slot.id); // once more; a failure here fails the slot
    input = await fit(script);
  }
  if (!input) throw new Error('script does not fit 15 seconds even at the fastest voice speed');

  // Renders go to a per-attempt folder. If a platform fails QA, the whole slot is rendered once more with the next template.
  const platforms = enabledPlatforms(config) as PlatformName[];
  let failed: string[] = [];
  let edl!: Edl;
  let variantUsed = variant;
  const qaOf = {} as Record<string, unknown>;
  for (let retry = 0; retry < 2; retry++) {
    variantUsed = chooseVariant(slot.id, ordinal, prevTemplate, config.creative.voices, retry); // only the template and palette change
    edl = assembleEdl({ ...input, template: variantUsed.template, palette: variantUsed.palette });
    const styleOk = captionStyleOk(CAPTION_STYLES[variantUsed.template]);
    failed = [];
    for (const platform of platforms) {
      hold();
      const file = path.join(attemptDir, `${platform}.mp4`);
      await d.render({ edl, platform, config, outFile: file, signal: d.signal });
      const qa = await d.qa(file);
      qaOf[platform] = qa;
      const bad = [...qa.checks.filter((c) => !c.pass).map((c) => c.name), ...(styleOk ? [] : ['caption style'])];
      if (bad.length) failed.push(`${platform}: ${bad.join(', ')}`);
    }
    if (!failed.length) break;
    log.warn('qa failed, trying the next template', { slot: slot.id, template: variantUsed.template, failed });
  }
  if (failed.length) throw new Error(`QA failed after two templates: ${failed.join('; ')}`);

  // Copy: a stored script keeps the copy fallback below; a fresh one gets model copy, or the fallback when the model is down.
  hold();
  const copy = await getCopy(db, config, brief, script, now, slot.id);
  hold();

  // Claim confirmed and everything passed: move the files into place and flip the slot, in one transaction.
  const master = JSON.stringify({ script, edl, variant: variantUsed });
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare(
      `UPDATE slots SET product_handle = ?, hook_id = ?, tier = 't0', master_json = ?, status = 'ready', error = NULL, updated_at = ?,
         cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_calls WHERE slot_id = ?)
       WHERE id = ? AND status = 'producing' AND claimed_at = ?`,
    ).run(handle, hookId, master, token, slot.id, slot.id, token);
    if (r.changes !== 1) throw new ClaimLostError(`claim on ${slot.id} lost`);
    for (const platform of platforms) {
      const tmp = path.join(attemptDir, `${platform}.mp4`);
      const final = path.join(dir, `${platform}.mp4`);
      const sha = createHash('sha256').update(readFileSync(tmp)).digest('hex');
      renameSync(tmp, final);
      db.prepare('INSERT OR REPLACE INTO renders (slot_id, platform, file_path, sha256, qa_pass, qa_json, ai_json, title, caption, created_at) VALUES (?,?,?,?,1,?,?,?,?,?)')
        .run(slot.id, platform, final, sha, JSON.stringify(qaOf[platform]), JSON.stringify(edl.ai), copy[platform].title, copy[platform].text, token);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  log.info('slot produced', { slot: slot.id, seconds: Math.round((Date.now() - t0) / 100) / 10, degraded });
}

export async function produceSlot(db: Db, config: Config, slotId: string, now: Date, deps: Partial<ProduceDeps> = {}): Promise<void> {
  const ts = now.toISOString();
  // Atomic claim: only one caller moves the slot out of 'planned'. The claim time fences every later write.
  const claim = db.prepare("UPDATE slots SET status = 'producing', attempt = attempt + 1, updated_at = ?, claimed_at = ? WHERE id = ? AND status = 'planned'").run(ts, ts, slotId);
  if (claim.changes !== 1) return;
  const fenced = (status: string, error: string | null, attempt = 0) =>
    db.prepare("UPDATE slots SET status = ?, error = ?, attempt = attempt + ?, claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'producing' AND claimed_at = ?").run(status, error, attempt, ts, slotId, ts).changes === 1;
  const d: ProduceDeps = { ingest: (n) => runIngest(db, config, n, { print: false }), synthesize, makeBed, render: renderEdl, qa: runQa, ingestDeadlineMs: 5 * 60000, ...deps };
  try {
    const slot = db.prepare('SELECT id, local_date, idx FROM slots WHERE id = ?').get(slotId) as Slot;
    await produce(db, config, slot, safeDir(env.outDir(), slot.local_date, slotId), ts, now, d);
  } catch (e) {
    if (d.signal?.aborted) throw e; // cancelled: the slot stays 'producing' and stale recovery takes it
    if (e instanceof ClaimLostError) return log.warn('claim lost, producer stopped', { slot: slotId });
    if (e instanceof NoBriefError) {
      if (fenced('planned', null, -1)) await alert(db, 'ingest_failed', 'no-brief', `${slotId} waits: ${e.message}`, now);
      return;
    }
    if (fenced('failed', String(e))) await alert(db, 'produce_failed', slotId, `produce failed for ${slotId}: ${e}`, now);
  }
}
