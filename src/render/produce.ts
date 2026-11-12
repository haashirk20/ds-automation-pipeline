import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { env, type Config, type PlatformName } from '../config/index.ts';
import { TEMPLATES, type Brief, type Edl, type Platform, type Script } from '../contracts.ts';
import { assembleEdl, ScriptTooLongError, ttsLines, type AssembleInput } from '../creative/assemble.ts';
import { writeCopy } from '../creative/copy.ts';
import { pickHook, refillHooks, type Hook } from '../creative/hooks.ts';
import { writeScript } from '../creative/script.ts';
import type { Db } from '../db/index.ts';
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

// The template files are .tsx, which Node cannot import, so the caption style is read from the source
// of the file that defines CAPTION_STYLE (following local imports and re-exports).
export function captionStyleOf(template: string, root = path.resolve(import.meta.dirname, '../../templates'), seen = new Set<string>()): { fontPx: number; textHex: string; plateHex: string; plateAlpha: number } {
  const file = path.join(root, `${template.replace(/\.tsx$/, '')}.tsx`);
  if (seen.has(file)) throw new Error(`CAPTION_STYLE not found for ${template}`);
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const block = /export const CAPTION_STYLE\s*=\s*\{([^}]*)\}/.exec(src)?.[1];
  if (block) {
    const get = (k: string, re: string) => new RegExp(`${k}\\s*:\\s*${re}`).exec(block)?.[1];
    const s = { fontPx: Number(get('fontPx', '(\\d+)')), textHex: get('textHex', "'(#[0-9A-Fa-f]{6})'")!, plateHex: get('plateHex', "'(#[0-9A-Fa-f]{6})'")!, plateAlpha: Number(get('plateAlpha', '([\\d.]+)')) };
    if (!s.fontPx || !s.textHex || !s.plateHex || !s.plateAlpha) throw new Error(`CAPTION_STYLE in ${file} is not a plain literal`);
    return s;
  }
  for (const m of src.matchAll(/from\s+'\.\/([\w-]+)(?:\.tsx)?'/g)) {
    try {
      return captionStyleOf(m[1], root, seen);
    } catch { /* try the next import */ }
  }
  throw new Error(`CAPTION_STYLE not found for ${template}`);
}

// Seams for tests; production uses the real modules.
export type ProduceDeps = {
  ingest: (now: Date) => Promise<void>;
  synthesize: typeof synthesize;
  makeBed: typeof makeBed;
  render: typeof renderEdl;
  qa: typeof runQa;
};

const SPEEDS = [1.0, 1.06, 1.12];
type Copy = Record<Platform, { title: string; text: string }>;
type Slot = { id: string; local_date: string; idx: number };
const before = 'local_date < ? OR (local_date = ? AND idx < ?)'; // slots ahead of this one, in order

async function pickBrief(db: Db, slot: Slot, ordinal: number, now: Date, d: ProduceDeps): Promise<Brief> {
  let briefs = listBriefs(db);
  if (!briefs.length) {
    await d.ingest(now); // throws when the store cannot be read
    briefs = listBriefs(db);
  }
  if (!briefs.length) throw new Error(`no product brief for ${slot.id}: ingest produced none`);
  return briefs[ordinal % briefs.length];
}

// Oldest finished slot of this product, old enough that its script may run again, with its stored copy.
function oldSlot(db: Db, config: Config, handle: string, now: Date): { hookId: number | null; script: Script; copy: Copy } | null {
  const cutoff = addDays(localDateOf(now, config.timezone), -config.hooks.noRepeatDays);
  const rows = db.prepare("SELECT id, hook_id, master_json FROM slots WHERE product_handle = ? AND status IN ('ready','done') AND master_json IS NOT NULL AND local_date < ? ORDER BY local_date, idx").all(handle, cutoff) as { id: string; hook_id: number | null; master_json: string }[];
  for (const r of rows) {
    const copy = {} as Copy;
    for (const x of db.prepare('SELECT platform, title, caption FROM renders WHERE slot_id = ? AND title IS NOT NULL').all(r.id) as { platform: Platform; title: string; caption: string }[]) copy[x.platform] = { title: x.title, text: x.caption };
    if (enabledPlatforms(config).every((p) => copy[p as Platform])) return { hookId: r.hook_id, script: JSON.parse(r.master_json).script, copy };
  }
  return null;
}

const isOutage = (e: unknown, refusal = false) => e instanceof LlmCapError || e instanceof RetryableLlmError || (refusal && e instanceof LlmRefusalError);

// Steps 1 to 10 for one slot; throws on failure.
async function produce(db: Db, config: Config, slot: Slot, dir: string, now: Date, d: ProduceDeps): Promise<void> {
  const t0 = Date.now();
  const ordinal = (db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE ${before}`).get(slot.local_date, slot.local_date, slot.idx) as { n: number }).n;
  const brief = await pickBrief(db, slot, ordinal, now, d);
  const handle = brief.product.handle;
  const work = path.join(dir, 'work');
  mkdirSync(work, { recursive: true });

  // Hook and script, or the degraded path when the model is unavailable.
  try {
    await refillHooks(db, config, brief, now);
  } catch (e) {
    if (!isOutage(e)) throw e;
    log.warn('hook refill skipped', { slot: slot.id, error: String(e) });
  }
  const hook: Hook | null = pickHook(db, config, handle, now);
  let script: Script | null = null;
  let hookId: number | null = hook?.id ?? null;
  let stored: ReturnType<typeof oldSlot> = null;
  if (hook) {
    try {
      script = await writeScript(db, config, brief, hook, now, slot.id);
    } catch (e) {
      if (!isOutage(e, true)) throw e;
      log.warn('script writer unavailable', { slot: slot.id, error: String(e) });
    }
  }
  if (!script) {
    stored = oldSlot(db, config, handle, now);
    if (!stored) throw new Error('no hook or script available and no old slot to reuse');
    ({ script, hookId } = stored);
    await alert(db, 'degraded', slot.id, `${slot.id} reuses a stored script: the model is unavailable or no hook is free`, now);
  }

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
  if (!input && hook && !stored) {
    script = await writeScript(db, config, brief, hook, now, slot.id); // once more; a failure here fails the slot
    input = await fit(script);
  }
  if (!input) throw new Error('script does not fit 15 seconds even at the fastest voice speed');

  // Renders. If a platform fails QA, the whole slot is rendered once more with the next template.
  const files = enabledPlatforms(config) as PlatformName[];
  let failed: string[] = [];
  for (let retry = 0; retry < 2; retry++) {
    const v = chooseVariant(slot.id, ordinal, prevTemplate, config.creative.voices, retry); // only the template and palette change
    const edl = assembleEdl({ ...input, template: v.template, palette: v.palette });
    db.prepare("UPDATE slots SET product_handle = ?, hook_id = ?, tier = 't0', master_json = ? WHERE id = ?").run(handle, hookId, JSON.stringify({ script, edl, variant: v }), slot.id);
    const style = captionStyleOf(v.template);
    failed = [];
    for (const platform of files) {
      const file = path.join(dir, `${platform}.mp4`);
      await d.render({ edl, platform, config, outFile: file });
      const qa = await d.qa(file);
      const bad = [...qa.checks.filter((c) => !c.pass).map((c) => c.name), ...(captionStyleOk(style) ? [] : ['caption style'])];
      if (bad.length) failed.push(`${platform}: ${bad.join(', ')}`);
      db.prepare('INSERT OR REPLACE INTO renders (slot_id, platform, file_path, sha256, qa_pass, qa_json, ai_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(slot.id, platform, file, createHash('sha256').update(readFileSync(file)).digest('hex'), bad.length ? 0 : 1, JSON.stringify(qa), JSON.stringify(edl.ai), now.toISOString());
    }
    if (!failed.length) break;
    log.warn('qa failed, trying the next template', { slot: slot.id, template: v.template, failed });
  }
  if (failed.length) throw new Error(`QA failed after two templates: ${failed.join('; ')}`);

  // Copy.
  const copy: Copy = stored ? stored.copy : await writeCopy(db, config, brief, script, now, slot.id);
  for (const p of files) db.prepare('UPDATE renders SET title = ?, caption = ? WHERE slot_id = ? AND platform = ?').run(copy[p].title, copy[p].text, slot.id, p);
  db.prepare('UPDATE slots SET cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_calls WHERE slot_id = ?) WHERE id = ?').run(slot.id, slot.id);
  log.info('slot produced', { slot: slot.id, seconds: Math.round((Date.now() - t0) / 100) / 10, degraded: !!stored });
}

export async function produceSlot(db: Db, config: Config, slotId: string, now: Date, deps: Partial<ProduceDeps> = {}): Promise<void> {
  const ts = now.toISOString();
  // Atomic claim: only one caller moves the slot out of 'planned'.
  const claim = db.prepare("UPDATE slots SET status = 'producing', attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'planned'").run(ts, slotId);
  if (claim.changes !== 1) return;
  const setSlot = (status: string, error: string | null) =>
    db.prepare('UPDATE slots SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, ts, slotId);
  const d: ProduceDeps = { ingest: (n) => runIngest(db, config, n, { print: false }), synthesize, makeBed, render: renderEdl, qa: runQa, ...deps };
  try {
    const slot = db.prepare('SELECT id, local_date, idx FROM slots WHERE id = ?').get(slotId) as Slot;
    await produce(db, config, slot, safeDir(env.outDir(), slot.local_date, slotId), now, d);
    setSlot('ready', null);
  } catch (e) {
    setSlot('failed', String(e));
    await alert(db, 'produce_failed', slotId, `produce failed for ${slotId}: ${e}`, now);
  }
}
