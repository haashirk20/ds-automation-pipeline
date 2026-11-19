import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { env, type Config, type PlatformName } from '../config/index.ts';
import { CAPTION_STYLES } from '../../templates/caption-style.ts';
import { Script, TEMPLATES, type Brief, type Edl, type Platform } from '../contracts.ts';
import { assembleEdl, ScriptTooLongError, ttsLines, type AssembleInput } from '../creative/assemble.ts';
import { CopyRejectedError, aboutScript, copyProblems, fallbackCopy, writeCopy, type CopyAbout, type PlatformCopy } from '../creative/copy.ts';
import { checkScript } from '../creative/claims.ts';
import { pickHook, refillHooks, type Hook } from '../creative/hooks.ts';
import { writeScript } from '../creative/script.ts';
import { writeConcept } from '../creative/ugc.ts';
import type { Db } from '../db/index.ts';
import { LlmCapError, LlmRefusalError, RetryableLlmError } from '../llm/client.ts';
import { makeBed } from '../music/index.ts';
import { alert } from '../ops/alert.ts';
import { log, scrub } from '../ops/log.ts';
import { captionStyleOk, clipHasSound, runQa } from '../qa/index.ts';
import { checkClip } from '../qa/vision.ts';
import { enabledPlatforms } from '../scheduler/planner.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import { ensureIngest, runIngest } from '../shopify/index.ts';
import { NoBriefError, alertStaleSelection, pickBrief } from '../shopify/catalog.ts';

export { alertStaleSelection, ensureIngest, NoBriefError, pickBrief };
import { synthesize } from '../tts/index.ts';
import { slotTierDef } from '../config/models.ts';
import { chooseTier, clipProviders, generateClip, rejectClip, type ClipProvider } from '../router/index.ts';
import { ClipPendingError } from '../router/errors.ts';
import { ff } from './ffmpeg.ts';
import { probeVideo } from './probe.ts';
import { renderEdl, renderUgc } from './render.ts';
import { produceUgc } from './produce-ugc.ts';

// Paths come only from slot id and platform; the result must stay inside OUT_DIR.
export function safeDir(root: string, localDate: string, slotId: string): string {
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
  ingest: (now: Date, signal?: AbortSignal) => Promise<void>;
  synthesize: typeof synthesize;
  makeBed: typeof makeBed;
  render: typeof renderEdl;
  qa: typeof runQa;
  providers: Record<string, ClipProvider>;
  prepareImage: (src: string, crop: Brief['shots'][number]['crop'], out: string) => Promise<void>;
  concept: typeof writeConcept; // 'ugc' mode
  checkClip: typeof checkClip;
  renderUgc: typeof renderUgc;
  probeClip: (file: string) => Promise<{ width: number; height: number; seconds: number } | null>;
  clipSound: (file: string, seconds: number) => Promise<boolean>;
  clock?: () => Date; // the time the producer ends; the retry gap counts from it (default: `now`)
  signal?: AbortSignal; // SIGTERM from the parent: stop rendering and leave the slot for stale recovery
  ingestDeadlineMs: number;
};

// Crops the photo to its text-free rectangle (so no printed supplier text is sent out) and writes a JPEG at most 1080 wide.
async function cropToJpeg(src: string, crop: Brief['shots'][number]['crop'], out: string): Promise<void> {
  const vf = [...(crop ? [`crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`] : []), "scale='min(1080,iw)':-2"].join(',');
  await ff('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', src, '-vf', vf, '-frames:v', '1', '-q:v', '2', out]);
}

const MOTION_PROMPT = 'Slow, gentle camera push-in. Keep the person, the garment and its colour exactly as in the image. Subtle natural movement only. No text, no logos, no new objects.';

const SPEEDS = [1.0, 1.06, 1.12];
export type Slot = { id: string; local_date: string; idx: number; kind: 'planned' | 'manual'; video_model: string | null };
export const before = 'local_date < ? OR (local_date = ? AND idx < ?)'; // slots ahead of this one, in order

// Nothing was spent by the failure and it may pass by itself: the slot goes back to 'planned' and the attempt is given back.
export class DeferSlotError extends Error {
  counted = false; // true: the attempt is not given back (a repeat of an earlier deferral)
}
// Another producer owns the slot now; this one must stop writing.
export class ClaimLostError extends Error {}

// The text of each cited fact, stored in the master so a later reuse can tell that a fact was edited since.
export type FactTexts = Record<string, string>;
export const factTextsOf = (brief: Brief, ids: Iterable<string>): FactTexts =>
  Object.fromEntries([...new Set(ids)].flatMap((id) => { const f = brief.facts.find((x) => x.id === id); return f ? [[id, f.text]] : []; }));
// A stored master may be reused only when every fact it cites is still in the brief with the same text.
// A master stored before factTexts existed is never reused.
export const factsUnchanged = (brief: Brief, stored: unknown): stored is FactTexts =>
  !!stored && typeof stored === 'object' && !Array.isArray(stored) && Object.entries(stored).every(([id, t]) => brief.facts.find((f) => f.id === id)?.text === t);

// Oldest finished slot of this product, old enough that its script may run again, with its stored copy.
// A stored script must still pass every check against the current brief, and cite no edited fact.
function oldSlot(db: Db, config: Config, brief: Brief, now: Date): { hookId: number | null; script: Script; factTexts: FactTexts } | null {
  const cutoff = addDays(localDateOf(now, config.timezone), -config.hooks.noRepeatDays);
  const rows = db.prepare("SELECT hook_id, master_json FROM slots WHERE product_handle = ? AND status IN ('ready','done') AND master_json IS NOT NULL AND local_date < ? ORDER BY local_date, idx").all(brief.product.handle, cutoff) as { hook_id: number | null; master_json: string }[];
  for (const r of rows) {
    const m = JSON.parse(r.master_json);
    const parsed = Script.safeParse(m.script);
    if (!parsed.success || !factsUnchanged(brief, m.factTexts)) continue;
    const problems = checkScript(brief, parsed.data);
    if (problems.length) {
      log.warn('stored script rejected against the current brief', { problems: problems.slice(0, 3) });
      continue;
    }
    return { hookId: r.hook_id, script: parsed.data, factTexts: m.factTexts };
  }
  return null;
}

// The current and the next year in the config's time zone: the only numbers a caption may add.
export const yearsOf = (config: Config, now: Date): number[] => {
  const y = Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: config.timezone }).format(now));
  return [y, y + 1];
};

// Model copy, or a deterministic fallback from the brief when the copy call fails for any reason.
export async function getCopy(db: Db, config: Config, brief: Brief, about: CopyAbout, now: Date, slotId: string): Promise<Record<Platform, PlatformCopy>> {
  const years = yearsOf(config, now);
  try {
    return await writeCopy(db, config, brief, about, now, slotId, years);
  } catch (e) {
    log.warn('copy writer failed, using the fallback copy', { slot: slotId, error: String(e) });
    const copy = fallbackCopy(brief, about);
    const problems = copyProblems(brief, copy, years);
    if (problems.length) throw new CopyRejectedError(problems);
    return copy;
  }
}

const isOutage = (e: unknown, refusal = false) => e instanceof LlmCapError || e instanceof RetryableLlmError || (refusal && e instanceof LlmRefusalError);

// One transaction: the slot becomes 'ready' and every platform's file moves from the attempt folder into place.
// Fenced by the claim time. `<platform>.mp4` must already exist in attemptDir.
export function commitSlot(
  db: Db, slot: Slot, dir: string, attemptDir: string, token: string,
  f: { handle: string; hookId: number | null; tier: string; master: string; platforms: PlatformName[]; qaOf: Record<string, unknown>; ai: unknown; copy: Record<Platform, PlatformCopy>; hold: 'waiting' | null; heldAt: string | null; musicSha: string | null },
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare(
      `UPDATE slots SET product_handle = ?, hook_id = ?, tier = ?, master_json = ?, status = 'ready', error = NULL, updated_at = ?, hold = ?, held_at = ?,
         cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_calls WHERE slot_id = ?) + (SELECT COALESCE(SUM(quoted_usd), 0) FROM spend WHERE slot_id = ?)
       WHERE id = ? AND status = 'producing' AND claimed_at = ?`,
    ).run(f.handle, f.hookId, f.tier, f.master, token, f.hold, f.heldAt, slot.id, slot.id, slot.id, token);
    if (r.changes !== 1) throw new ClaimLostError(`claim on ${slot.id} lost`);
    for (const platform of f.platforms) {
      const tmp = path.join(attemptDir, `${platform}.mp4`);
      const final = path.join(dir, `${platform}.mp4`);
      const sha = createHash('sha256').update(readFileSync(tmp)).digest('hex');
      renameSync(tmp, final);
      db.prepare('INSERT OR REPLACE INTO renders (slot_id, platform, file_path, sha256, qa_pass, qa_json, ai_json, title, caption, created_at) VALUES (?,?,?,?,1,?,?,?,?,?)')
        .run(slot.id, platform, final, sha, JSON.stringify(f.qaOf[platform]), JSON.stringify(f.ai), f.copy[platform].title, f.copy[platform].text, token);
    }
    if (f.musicSha) db.prepare('UPDATE music_tracks SET last_used_at = ? WHERE sha256 = ?').run(token, f.musicSha);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Throws when the producer no longer owns the slot or was told to stop.
export const holdOf = (db: Db, slot: Slot, token: string, d: ProduceDeps) => () => {
  if (d.signal?.aborted) throw new Error('cancelled');
  const r = db.prepare("UPDATE slots SET updated_at = ? WHERE id = ? AND status = 'producing' AND claimed_at = ?").run(token, slot.id, token);
  if (r.changes !== 1) throw new ClaimLostError(`claim on ${slot.id} lost`);
};

// Steps 1 to 10 for one slot; throws on failure. Every write is fenced by the claim time.
async function produce(db: Db, config: Config, slot: Slot, dir: string, token: string, now: Date, d: ProduceDeps): Promise<void> {
  if (config.creative.mode === 'ugc') return produceUgc(db, config, slot, dir, token, now, d);
  const t0 = Date.now();
  const hold = holdOf(db, slot, token, d);
  await ensureIngest(db, now, d);
  const ordinal = (db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE ${before}`).get(slot.local_date, slot.local_date, slot.idx) as { n: number }).n;
  const brief = pickBrief(db, slot);
  const handle = brief.product.handle;
  await alertStaleSelection(db, slot, handle, now);
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
  let storedFacts: FactTexts | null = null;
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
    storedFacts = stored.factTexts;
    degraded = true;
    await alert(db, 'degraded', slot.id, `${slot.id} reuses a stored script: the model is unavailable or no hook is free`, now);
  }
  hold();

  // Tier: some slots open with one AI clip made from the hook photo. Any failure leaves the slot at tier 0.
  const tier = await chooseTier(db, config, d.providers, slot.id, now);
  let clip: AssembleInput['clip'] = null;
  if (tier !== 't0') {
    const hookShot = (id: string) => brief.shots.find((x) => x.id === id)!;
    const first = hookShot(script.beats[0].shotIds[0]);
    const shot = /not our product/i.test(first.note) ? hookShot(script.beats[1].shotIds[0]) : first;
    const jpg = path.join(work, 'clip-src.jpg');
    const out = path.join(path.resolve(env.dataDir()), 'clips', slot.id.replace('#', '-') + '.mp4');
    try {
      await d.prepareImage(path.resolve(env.dataDir(), shot.file), shot.crop, jpg);
      const ok = await generateClip(db, config, d.providers, { slotId: slot.id, tier, images: [jpg], prompt: MOTION_PROMPT, shots: [], outFile: out, signal: d.signal ?? new AbortController().signal }, now);
      const info = ok ? await d.probeClip(out) : null;
      if (ok && info && info.seconds >= 2 && Math.min(info.width, info.height) >= 480) clip = { src: out, width: info.width, height: info.height };
      else if (ok) rejectClip(db, slot.id, now, 'clip failed the size or length check');
    } catch (e) {
      if (d.signal?.aborted || e instanceof ClaimLostError || e instanceof ClipPendingError) throw e;
      log.warn('clip step failed, using tier 0', { slot: slot.id, error: String(e) });
    }
  }
  hold();

  // Variant, music, voice.
  const prev = db.prepare(`SELECT master_json FROM slots WHERE master_json IS NOT NULL AND master_json NOT LIKE '%"mode":"ugc"%' AND (${before}) ORDER BY local_date DESC, idx DESC LIMIT 1`).get(slot.local_date, slot.local_date, slot.idx) as { master_json: string } | undefined;
  const prevTemplate: string | null = prev ? JSON.parse(prev.master_json).variant?.template ?? null : null;
  const variant = chooseVariant(slot.id, ordinal, prevTemplate, config.creative.voices);
  const voiceWav = path.join(work, 'voice.wav');
  const bedWav = path.join(work, 'bed.wav');
  const music = config.creative.music.enabled;
  if (music) await d.makeBed({ seed: variant.musicSeed, durationSec: 16, outWav: bedWav });
  const inputFor = (s: Script, v: Variant, tts: AssembleInput['tts']): AssembleInput => ({
    slotId: slot.id, brief, script: s, template: v.template, palette: v.palette, tts, voiceSrc: voiceWav, musicSrc: music ? bedWav : null,
    musicGainDb: config.creative.music.gainDb, dataDir: path.resolve(env.dataDir()), ai: { visuals: !!clip, voice: true, music: false }, clip,
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
  const copy = await getCopy(db, config, brief, aboutScript(script), now, slot.id);
  hold();

  // Claim confirmed and everything passed: move the files into place and flip the slot, in one transaction.
  // A reused script keeps the facts it was checked against; a fresh one cites its beats' and its hook's facts.
  const factTexts = storedFacts ?? factTextsOf(brief, [...script.beats.flatMap((b) => b.factIds), ...(hook?.factIds ?? [])]);
  commitSlot(db, slot, dir, attemptDir, token, { handle, hookId, tier: clip ? tier : 't0', master: JSON.stringify({ script, edl, variant: variantUsed, factTexts }), platforms, qaOf, ai: edl.ai, copy, hold: null, heldAt: null, musicSha: null });
  log.info('slot produced', { slot: slot.id, seconds: Math.round((Date.now() - t0) / 100) / 10, degraded });
}

export async function produceSlot(db: Db, config: Config, slotId: string, now: Date, deps: Partial<ProduceDeps> = {}): Promise<void> {
  const ts = now.toISOString();
  // Atomic claim: only one caller moves the slot out of 'planned'. The claim time fences every later write.
  const claim = db.prepare("UPDATE slots SET status = 'producing', attempt = attempt + 1, updated_at = ?, claimed_at = ? WHERE id = ? AND status = 'planned'").run(ts, ts, slotId);
  if (claim.changes !== 1) return;
  // `at` is the time written to updated_at: the claim time, or for a wait the end of the attempt.
  const fenced = (status: string, error: string | null, attempt = 0, at = ts) =>
    db.prepare("UPDATE slots SET status = ?, error = ?, attempt = attempt + ?, claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'producing' AND claimed_at = ?").run(status, error, attempt, at, slotId, ts).changes === 1;
  const d: ProduceDeps = { ingest: async (n, signal) => { await runIngest(db, config, n, { print: false, signal }); }, synthesize, makeBed, render: renderEdl, qa: runQa, concept: writeConcept, checkClip, renderUgc, ingestDeadlineMs: 5 * 60000, providers: clipProviders(db, config, () => now), prepareImage: cropToJpeg, probeClip: probeVideo, clipSound: clipHasSound, ...deps };
  try {
    const slot = db.prepare('SELECT id, local_date, idx, kind, video_model FROM slots WHERE id = ?').get(slotId) as Slot;
    // The slot's own video model replaces tier 2 for this run. An unknown, removed or malformed one fails only this slot.
    const def = slotTierDef(db, config, slot.video_model);
    const cfg = def ? { ...config, tiers: { ...config.tiers, t2: def } } : config;
    if (def && !deps.providers) d.providers = clipProviders(db, cfg, () => now);
    await produce(db, cfg, slot, safeDir(env.outDir(), slot.local_date, slotId), ts, now, d);
  } catch (e) {
    if (d.signal?.aborted) throw e; // cancelled: the slot stays 'producing' and stale recovery takes it
    if (e instanceof ClaimLostError) return log.warn('claim lost, producer stopped', { slot: slotId });
    const ended = () => (d.clock?.() ?? now).toISOString();
    if (e instanceof NoBriefError) {
      if (fenced('planned', null, -1, ended())) await alert(db, 'ingest_failed', 'no-brief', `${slotId} waits: ${e.message}`, now);
      return;
    }
    const text = scrub(String(e));
    const counted = e instanceof DeferSlotError && e.counted;
    const tries = (db.prepare('SELECT attempt FROM slots WHERE id = ?').get(slotId) as { attempt: number }).attempt;
    if ((e instanceof DeferSlotError || e instanceof ClipPendingError) && !(counted && tries >= config.render.maxAttempts)) {
      if (fenced('planned', text, counted ? 0 : -1, ended())) await alert(db, 'degraded', `${slotId}:wait`, `${slotId} waits and will be tried again: ${text}`, now);
      return;
    }
    const attempt = tries;
    const paid = db.prepare("SELECT 1 FROM spend WHERE slot_id = ? AND state IN ('submitted','succeeded')").get(slotId);
    if (paid && attempt < config.render.maxAttempts && fenced('planned', text, 0, ended())) return log.warn('slot will be tried again, the paid clip is kept', { slot: slotId, error: text });
    if (fenced('failed', text)) await alert(db, 'produce_failed', slotId, `produce failed for ${slotId}: ${text}`, now);
  }
}
