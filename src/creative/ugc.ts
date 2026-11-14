// The UGC-style concept: one structured model call, deterministic checks, the claim judge, one retry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UgcConcept, type Brief } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
import { activeText, promptText, systemPrompt } from '../llm/prompts.ts';
import { dollarProblems, judgeTexts, languageProblems, norm, textProblems, urlsIn, words } from './claims.ts';

export class ConceptRejectedError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`concept rejected:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

const NOTES = join(import.meta.dirname, '../../config/product-notes.json');

// The owner's note on what the product looks like; null when there is none.
export function productLook(handle: string, file: string = NOTES): string | null {
  const edited = activeText(`note:${handle}`);
  if (edited !== undefined) return edited;
  if (!existsSync(file)) return null;
  const notes = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { look?: string }>;
  return Object.hasOwn(notes, handle) ? (notes[handle].look ?? null) : null;
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const NO_NUMBERS = new Set<string>();
const EQUIPMENT = /\b(phone|smartphone|tripod|selfie stick|camera crew)\b/i;
// The video model also makes the sound, so speech in a scene text would be spoken; the one spoken line belongs in `line`.
const SPEECH = /\b(says?|said|saying|tells?|told|telling|asks?|asked|asking|shouts?|shouted|shouting|whispers?|whispered|whispering|repl(?:y|ies|ied|ying)|announc(?:e|es|ed|ing)|explains?|explained|explaining|speaks?|spoke|speaking|talks?|talked|talking|yells?|yelled|yelling|mutters?|muttered|exclaims?|exclaimed)\b/i;
// Lower case, no emoji, no punctuation, single spaces: two captions that differ only in these are the same.
const squash = (s: string): string => norm(s).toLowerCase().replace(EMOJI, ' ').replace(/[\p{P}\p{S}️]/gu, ' ').replace(/\s+/g, ' ').trim();

// `years` are the only numbers a caption may carry ("the coziest gift of 2026"): a year is not a product claim.
export function conceptProblems(brief: Brief, c: UgcConcept, seconds: number, recentCaptions: string[], years: number[] = []): string[] {
  const p: string[] = [];
  const caption = norm(c.caption);
  if ([...caption].length > 60) p.push(`caption is ${[...caption].length} characters, at most 60`);
  if (words(caption) > 12) p.push(`caption is ${words(caption)} words, at most 12`);
  if ((caption.match(EMOJI) ?? []).length > 3) p.push('caption has more than 3 emoji');
  if (caption.includes('#')) p.push('caption has a hashtag');
  if (caption.includes('@')) p.push('caption has an @name');
  if (urlsIn(caption).length) p.push('caption has a link');
  p.push(...textProblems(brief, c.caption, new Set(years.map(String)), 'caption'));
  const key = squash(c.caption);
  if (recentCaptions.some((r) => squash(r) === key)) p.push('caption repeats a recent caption');

  if (words(c.line) > 9) p.push(`line is ${words(c.line)} words, at most 9`);
  p.push(...textProblems(brief, c.line, NO_NUMBERS, 'line'));

  if (!brief.product.colors.some((x) => x.toLowerCase() === c.color.toLowerCase())) p.push(`color "${c.color}" is not one of ${brief.product.colors.join(', ')}`);

  const total = c.shots.reduce((a, s) => a + s.seconds, 0);
  if (total !== seconds) p.push(`shot seconds add up to ${total}, want ${seconds}`);
  c.shots.forEach((s, i) => {
    const where = `shot ${i + 1}`;
    if ([...s.action].length > 300) p.push(`${where}: action is over 300 characters`);
    if (/["“”]/.test(s.action)) p.push(`${where}: action has quotation marks`);
    if (EQUIPMENT.test(s.action)) p.push(`${where}: action mentions filming equipment`);
    if (urlsIn(s.action).length) p.push(`${where}: action has a link`);
  });
  // Scene text describes a picture, so counts in it ("two coworkers") are not claims and are not checked as numbers.
  const scene = [...c.shots.map((s, i) => [`shot ${i + 1}`, s.action] as const), ['setting', c.setting], ['person', c.person]] as const;
  for (const [where, text] of scene) {
    p.push(...languageProblems(brief, text, where), ...dollarProblems(brief, text, where));
    if (SPEECH.test(text)) p.push(`${where}: speech in the scene text; the one spoken line belongs in the line field`);
  }

  if (!/\bwoman\b/i.test(c.person)) p.push('person must be a woman');
  return p;
}

export async function writeConcept(db: Db, config: Config, brief: Brief, recent: { caption: string; setting: string }[], now: Date, slotId: string): Promise<UgcConcept> {
  const seconds = config.tiers.clipSeconds;
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: config.timezone }).format(now);
  const year = Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: config.timezone }).format(now));
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '(none)');
  const base =
    `Write the concept for this video.\nVideo length: ${seconds} seconds.\nMonth: ${month} ${year}.\nProduct note: ${productLook(brief.product.handle) ?? 'none'}\n` +
    `Recent captions, do not reuse:\n${list(recent.map((r) => r.caption))}\nRecent settings, do not reuse:\n${list(recent.map((r) => r.setting))}`;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? base : `${base}\n\nYour previous attempt had these problems. Fix all of them:\n${problems.map((x) => `- ${x}`).join('\n')}`;
    const c = await callJson(
      db,
      config,
      { purpose: 'ugc', model: config.llm.models.script, system: systemPrompt('ugc', brief), user, schema: UgcConcept, maxTokens: 3000, effort: 'medium', slotId },
      now,
    );
    problems = conceptProblems(brief, c, seconds, recent.map((r) => r.caption), [year, year + 1]);
    if (!problems.length) problems = await judgeTexts(db, config, brief, [{ label: 'caption', text: c.caption }, { label: 'line', text: c.line }], now, slotId);
    if (!problems.length) return c;
  }
  throw new ConceptRejectedError(problems);
}

export function buildClipPrompt(brief: Brief, c: UgcConcept, refNotes: string[], opts: { look: string | null; brand: string; logo: boolean }): { prompt: string; shots: { prompt: string; seconds: number }[] } {
  const line = c.line.replaceAll('"', '').trim();
  const n = refNotes.length;
  const product = [
    `The product is the ${c.color} ${brief.product.title} shown in the first ${n} reference ${n === 1 ? 'image' : 'images'}.`,
    ...(opts.look ? [opts.look] : []),
    ...refNotes.map((note, i) => `Reference image ${i + 1}: ${note}`),
    'Keep its shape, colour, texture and details exactly as in the references.',
    ...(opts.logo ? [`The last reference image is the ${opts.brand} logo. It appears only printed on the lid of a plain cardboard gift box, spelled exactly "${opts.brand}".`] : []),
  ].join(' ');
  const shots = c.shots.map((s, i) => ({ prompt: (i === 0 && line ? `${s.action} She says to the camera: "${line}"` : s.action).slice(0, 500), seconds: s.seconds }));
  let t = 0;
  const shotLines = shots.map((s, i) => {
    const start = t;
    t += s.seconds;
    return `Shot ${i + 1} (${start}-${t}s): ${s.prompt}`;
  });
  const prompt = [
    promptText('video'),
    `Setting: ${c.setting}\nPerson: ${c.person}`,
    product,
    shotLines.join('\n'),
    `Audio: natural room sound that fits the setting. ${line ? 'The only spoken words in the whole video are her line in shot 1.' : 'Nobody speaks.'}`,
  ].join('\n\n');
  return { prompt, shots };
}
