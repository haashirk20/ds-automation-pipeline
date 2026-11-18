// The 'ugc' producer: one AI-generated scene with a caption on top. Same claim fencing as the ad path.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { env, type Config, type PlatformName } from '../config/index.ts';
import { UgcConcept, type Brief } from '../contracts.ts';
import { aboutConcept } from '../creative/copy.ts';
import { buildClipPrompt, conceptProblems, productLook } from '../creative/ugc.ts';
import type { Db } from '../db/index.ts';
import { RetryableLlmError } from '../llm/client.ts';
import { alert } from '../ops/alert.ts';
import { log } from '../ops/log.ts';
import { enabledPlatforms } from '../scheduler/planner.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import { pickTrack, musicGainDb } from '../music/tracks.ts';
import { chooseTier, generateClip, rejectClip } from '../router/index.ts';
import { ClipPendingError } from '../router/errors.ts';
import { ClaimLostError, DeferSlotError, before, commitSlot, ensureIngest, getCopy, holdOf, pickBrief, yearsOf, type ProduceDeps, type Slot } from './produce.ts';
import { assertInside } from './render.ts';
import { brandLogoFile } from '../shopify/catalog.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RECENT = 20;

type Rendered = { concept: UgcConcept; clipFile: string; file: string; qa: unknown };

const storedConcept = (json: string | null): UgcConcept | null => {
  if (!json) return null;
  const m = JSON.parse(json);
  const c = m?.mode === 'ugc' ? UgcConcept.safeParse(m.concept) : null;
  return c?.success ? c.data : null;
};

// A finished clip of this product that is old enough to post again, with the concept it was made from.
// The oldest last use wins, then the path. `localDate` is the day of the slot being produced.
// A stored concept must still pass every check against the current brief: its spoken line is in the clip and cannot change.
export function pickStoredClip(db: Db, config: Config, brief: Brief, now: Date, localDate = localDateOf(now, config.timezone)): { clipFile: string; concept: UgcConcept; slotId: string } | null {
  const rows = db.prepare("SELECT id, local_date, master_json FROM slots WHERE status IN ('ready','done') AND (hold IS NULL OR hold = 'approved') AND product_handle = ? AND master_json IS NOT NULL ORDER BY local_date, idx").all(brief.product.handle) as { id: string; local_date: string; master_json: string }[];
  const dataDir = path.resolve(env.dataDir());
  const years = yearsOf(config, now);
  const byFile = new Map<string, { lastUse: string; concept: UgcConcept; slotId: string }>();
  for (const r of rows) {
    const concept = storedConcept(r.master_json);
    const stored: unknown = concept && JSON.parse(r.master_json).clipFile;
    if (!concept || typeof stored !== 'string') continue;
    const clipFile = path.resolve(dataDir, stored); // an old absolute value stays as it is
    try { assertInside(clipFile, path.join(dataDir, 'clips')); } catch { continue; } // the value comes from the database
    if (!existsSync(clipFile) || conceptProblems(brief, concept, config.tiers.clipSeconds, [], years).length) continue;
    byFile.set(clipFile, { lastUse: r.local_date, concept, slotId: r.id }); // rows are in order, so the last write is the latest use
  }
  const cutoff = addDays(localDate, -config.ugc.reuseAfterDays);
  const eligible = [...byFile].filter(([, v]) => v.lastUse <= cutoff).sort(([fa, a], [fb, b]) => a.lastUse.localeCompare(b.lastUse) || fa.localeCompare(fb));
  return eligible.length ? { clipFile: eligible[0][0], concept: eligible[0][1].concept, slotId: eligible[0][1].slotId } : null;
}

export async function produceUgc(db: Db, config: Config, slot: Slot, dir: string, token: string, now: Date, d: ProduceDeps): Promise<void> {
  const t0 = Date.now();
  const hold = holdOf(db, slot, token, d);
  await ensureIngest(db, now, d);
  const ordinal = (db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE ${before}`).get(slot.local_date, slot.local_date, slot.idx) as { n: number }).n;
  const brief = pickBrief(db, ordinal);
  const handle = brief.product.handle;
  const work = path.join(dir, `attempt-${Date.parse(token)}`, 'work');
  mkdirSync(work, { recursive: true });
  const attemptDir = path.dirname(work);
  const signal = d.signal ?? new AbortController().signal;
  const clipFile = path.join(path.resolve(env.dataDir()), 'clips', slot.id.replace('#', '-') + '.mp4');
  const ugcOut = path.join(attemptDir, 'ugc.mp4');
  hold();

  // One pick per run: the least recently used ticked track.
  const track = pickTrack(db);
  // Render and check one clip; null when QA fails.
  let mixed = false; // the last render is the one committed
  const render = async (clip: string, caption: string, line: string, firstShotSeconds: number) => {
    let music = null;
    mixed = false;
    if (track && existsSync(track.file)) music = { file: track.file, gainDb: musicGainDb(track, config.ugc.music.volumeDb), duckDb: config.ugc.music.duckDb, duckUntilMs: line.trim() ? firstShotSeconds * 1000 + 250 : 0 }, mixed = true;
    else if (track) log.warn('music file is gone, rendering without music', { slot: slot.id, track: track.sha256 }); // a deleted track never uses up an attempt
    await d.renderUgc({ clip, caption, config, outFile: ugcOut, music, signal: d.signal });
    const qa = await d.qa(ugcOut);
    return qa.pass ? qa : null;
  };

  const tier = await chooseTier(db, config, d.providers, slot.id, now, slot.kind === 'manual' ? 't2' : undefined);
  hold();
  let made: Rendered | null = null;
  let why = 'tier 0 was chosen'; // why no new clip was made, for the owner
  let outage = false;
  // A newest-first list, so the concept writer avoids what the last slots and the rejected attempts used.
  const recent = (db.prepare("SELECT master_json FROM slots WHERE id != ? AND master_json LIKE '%\"mode\":\"ugc\"%' ORDER BY local_date DESC, idx DESC LIMIT ?").all(slot.id, RECENT) as { master_json: string }[])
    .flatMap((r) => { const c = storedConcept(r.master_json); return c ? [{ caption: c.caption, setting: c.setting }] : []; });
  if (tier !== 't0') {
    for (let attempt = 0; attempt < config.tiers.maxJobsPerSlot && !made; attempt++) {
      // A job in the ledger belongs to the concept stored in the row: resume with it and do not write a new one.
      const row = db.prepare('SELECT master_json FROM slots WHERE id = ?').get(slot.id) as { master_json: string | null };
      const jobMade = db.prepare("SELECT 1 FROM spend WHERE slot_id = ? AND state IN ('submitted','succeeded')").get(slot.id);
      let found = jobMade ? storedConcept(row.master_json) : null;
      if (!found) {
        try {
          found = await d.concept(db, config, brief, recent.slice(0, RECENT), now, slot.id);
        } catch (e) {
          if (d.signal?.aborted) throw e;
          log.warn('concept writer failed, no new clip', { slot: slot.id, error: String(e) });
          why = 'the concept writer failed';
          outage = e instanceof RetryableLlmError;
          break;
        }
        hold();
        // Before the paid job, so a crash leaves the concept the job was made from.
        const r = db.prepare("UPDATE slots SET master_json = ?, updated_at = ? WHERE id = ? AND status = 'producing' AND claimed_at = ?").run(JSON.stringify({ mode: 'ugc', concept: found }), token, slot.id, token);
        if (r.changes !== 1) throw new ClaimLostError(`claim on ${slot.id} lost`);
      }
      const concept: UgcConcept = found;
      const reject = (why: string) => {
        rejectClip(db, slot.id, now, why);
        recent.unshift({ caption: concept.caption, setting: concept.setting });
      };

      // Reference images: the product in the concept's colour, then the logo.
      const colour = brief.shots.filter((s) => s.variant?.toLowerCase() === concept.color.toLowerCase());
      const refShots = (colour.length ? [...colour.filter((s) => s.kind === 'product'), ...colour.filter((s) => s.kind !== 'product')] : [brief.shots.find((s) => s.kind === 'product') ?? brief.shots[0]]).slice(0, 2);
      const images: string[] = [];
      let ok = false;
      try {
        for (const [i, s] of refShots.entries()) {
          const jpg = path.join(work, `ref-${i}.jpg`);
          await d.prepareImage(path.resolve(env.dataDir(), s.file), s.crop, jpg);
          images.push(jpg);
        }
        const logoFile = brandLogoFile(db, config, ROOT);
        const logo = !!logoFile && existsSync(logoFile);
        if (logo) images.push(logoFile!);
        const { prompt, shots } = buildClipPrompt(brief, concept, refShots.map((s) => s.note), { look: productLook(handle), brand: brief.shop.name, logo });
        hold();
        ok = await generateClip(db, config, d.providers, { slotId: slot.id, tier, images, prompt, shots, outFile: clipFile, signal }, now);
      } catch (e) {
        if (d.signal?.aborted || e instanceof ClaimLostError || e instanceof ClipPendingError) throw e;
        log.warn('clip step failed, no new clip', { slot: slot.id, error: String(e) });
      }
      if (!ok) { why = 'the clip step gave no clip'; break; }
      hold();

      const info = await d.probeClip(clipFile).catch(() => null); // a corrupt download counts as a rejected clip
      why = 'every clip was rejected';
      if (!info || info.seconds < 14 || Math.min(info.width, info.height) < 480) {
        reject('clip failed the size or length check');
        continue;
      }
      // The spoken line needs the clip's own sound, and the music is mixed under it: a silent clip would carry bare music.
      if (!(await d.clipSound(clipFile, info.seconds).catch(() => false))) {
        reject('clip has no sound');
        continue;
      }
      let check;
      try {
        check = await d.checkClip(db, config, { clipFile, refImages: images.slice(0, refShots.length), brief, concept }, now, slot.id);
      } catch (e) {
        if (d.signal?.aborted || e instanceof ClaimLostError) throw e;
        if (e instanceof RetryableLlmError) throw new DeferSlotError(`the frame check is unavailable, the paid clip is kept: ${e}`); // the spend row stays 'succeeded', so the next run checks the same clip
        throw e;
      }
      hold();
      if (!check.pass) {
        reject(check.problems.join('; '));
        log.warn('clip failed the frame check, trying again', { slot: slot.id, problems: check.problems });
        continue;
      }
      const qa = await render(clipFile, concept.caption, concept.line, concept.shots[0].seconds);
      hold();
      if (!qa) {
        reject('the rendered video failed QA');
        continue;
      }
      made = { concept, clipFile, file: ugcOut, qa };
    }
  }

  // No new clip: post a stored one again.
  let reusedFrom: string | null = null;
  if (!made && slot.kind === 'manual') {
    // A post the owner asked for is never a repeat of an old clip.
    const msg = 'no new clip: ' + (tier === 't0' ? 'the clip provider is signed out or the monthly clip cap is reached' : why);
    if (!outage) throw new Error(msg);
    const e = new DeferSlotError(`${msg}: the model is unavailable`);
    e.counted = ((db.prepare('SELECT error FROM slots WHERE id = ?').get(slot.id) as { error: string | null }).error ?? '').includes(e.message);
    throw e;
  }
  if (!made) {
    const old = pickStoredClip(db, config, brief, now, slot.local_date);
    if (!old) {
      const msg = 'no new clip could be made and no stored clip can be posted again';
      if (!outage) throw new Error(msg);
      // Each deferral can bill up to 3 model calls: the first is free, a repeat counts as an attempt.
      const e = new DeferSlotError(`${msg}: the model is unavailable`);
      e.counted = ((db.prepare('SELECT error FROM slots WHERE id = ?').get(slot.id) as { error: string | null }).error ?? '').includes(e.message);
      throw e;
    }
    await alert(db, 'degraded', slot.id, `${slot.id} posts the clip of ${old.slotId} again: ${why}`, now);
    const qa = await render(old.clipFile, old.concept.caption, old.concept.line, old.concept.shots[0].seconds);
    if (!qa) throw new Error(`QA failed on the reused clip from ${old.slotId}`);
    made = { concept: old.concept, clipFile: old.clipFile, file: ugcOut, qa };
    reusedFrom = old.slotId;
  }
  hold();

  const copy = await getCopy(db, config, brief, aboutConcept(made.concept), now, slot.id);
  hold();
  const platforms = enabledPlatforms(config) as PlatformName[];
  for (const p of platforms) copyFileSync(made.file, path.join(attemptDir, `${p}.mp4`));
  commitSlot(db, slot, dir, attemptDir, token, {
    handle, hookId: null, tier: reusedFrom ? 't0' : tier, master: JSON.stringify({ mode: 'ugc', concept: made.concept, clipFile: path.relative(path.resolve(env.dataDir()), made.clipFile), reusedFrom, music: mixed && track ? { sha256: track.sha256, name: track.name } : null }),
    platforms, qaOf: Object.fromEntries(platforms.map((p) => [p, made.qa])), ai: { visuals: true, voice: true, music: false }, copy,
    hold: slot.kind === 'manual' ? 'waiting' : null, heldAt: slot.kind === 'manual' ? (d.clock?.() ?? now).toISOString() : null, musicSha: mixed ? track?.sha256 ?? null : null,
  });
  log.info('slot produced', { slot: slot.id, seconds: Math.round((Date.now() - t0) / 100) / 10, reusedFrom });
}
