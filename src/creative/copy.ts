import { z } from 'zod';
import { AI_LINE, PLATFORMS, type Brief, type Platform, type Script, type UgcConcept } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
import { log } from '../ops/log.ts';
import { systemPrompt } from '../llm/prompts.ts';
import { factNumbers, textProblems, urlsIn } from './claims.ts';

export class CopyRejectedError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`copy rejected:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

export interface PlatformCopy {
  title: string;
  text: string; // final caption: caption, link (where clickable), disclosures, hashtags
  hashtags: string[];
  caption?: string; // the model's own caption, before links and disclosures were added
}

// What the video is about, for the copy writer and the fallback. 'ad' is a scripted ad, 'ugc' a scene with one caption.
export type CopyAbout = { style: 'ad' | 'ugc'; headline: string; summary: string };
export const aboutScript = (script: Script): CopyAbout => ({
  style: 'ad',
  headline: script.hook.headline,
  summary: `The video's script:\n${script.beats.map((b) => `${b.kind}: ${b.chunks.map((c) => c.say).join(' ')}`).join('\n')}`,
});
export const aboutConcept = (c: UgcConcept): CopyAbout => ({
  style: 'ugc',
  headline: c.caption,
  summary: `On-screen caption: ${c.caption}\nSpoken line: ${c.line.trim() || 'none'}\nWhat happens:\n${c.shots.map((s) => `- ${s.action}`).join('\n')}`,
});

const Item = z.object({ title: z.string(), caption: z.string(), hashtags: z.array(z.string()) });
const Schema = z.object(Object.fromEntries(PLATFORMS.map((p) => [p, Item])) as Record<Platform, typeof Item>);

const LINKS_CLICKABLE: readonly Platform[] = ['facebook']; // Shorts descriptions (support.google.com/youtube/answer/13748639), Instagram and TikTok captions do not link
const TITLE_MAX = 90;
const TEXT_MAX = 2200 - AI_LINE.length; // Instagram's limit, less the line the bridge adds to AI posts

const clickable = (p: Platform) => LINKS_CLICKABLE.includes(p);
const assemble = (brief: Brief, p: Platform, caption: string, hashtags: string[]) =>
  [caption.trim(), ...(clickable(p) ? [brief.product.url] : []), ...brief.disclosures, hashtags.join(' ')].join('\n\n');

// "#BlackFridaySale" and "#50OFF" become "black friday sale" and "50 off", so the claim patterns see them.
export const deTag = (h: string): string =>
  h.replace(/^#/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2').toLowerCase();

// Every deterministic rule for the copy of all platforms. Numbers must come from the brief's facts.
// `years` may appear in a caption ("the coziest gift of 2026").
export function copyProblems(brief: Brief, copy: Record<Platform, PlatformCopy>, years: number[] = []): string[] {
  const problems: string[] = [];
  const allowed = factNumbers(brief.facts.map((f) => f.text));
  for (const y of years) allowed.add(String(y));
  for (const p of PLATFORMS) {
    const c = copy[p];
    const where = p;
    if (c.title.length > TITLE_MAX) problems.push(`${where}: title is ${c.title.length} characters, max ${TITLE_MAX}`);
    if (c.text.length > TEXT_MAX) problems.push(`${where}: text is ${c.text.length} characters, max ${TEXT_MAX}`);
    if (c.hashtags.length < 3 || c.hashtags.length > 6) problems.push(`${where}: ${c.hashtags.length} hashtags, want 3 to 6`);
    for (const h of c.hashtags) if (!/^#[A-Za-z0-9]+$/.test(h)) problems.push(`${where}: bad hashtag "${h}"`);
    const own = [c.title, c.caption ?? '', ...c.hashtags.map(deTag)].join('\n');
    problems.push(...textProblems(brief, own, allowed, where));
    if (c.caption !== undefined && urlsIn(own).length) problems.push(`${where}: the copy contains a URL; only the product URL is allowed and code adds it`);
    for (const u of urlsIn(c.text)) if (u !== brief.product.url) problems.push(`${where}: URL "${u}" is not the product URL`);
    for (const d of brief.disclosures) if (!c.text.includes(d)) problems.push(`${where}: disclosure missing: ${d}`);
  }
  return problems;
}

const Verdicts = z.object({ verdicts: z.array(z.object({ platform: z.string(), supported: z.boolean(), reason: z.string() })) });

// Deterministic copy from the brief and the script alone, for when the copy model cannot be used.
export function fallbackCopy(brief: Brief, about: CopyAbout): Record<Platform, PlatformCopy> {
  const alnum = (s: string) => s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const tags = [...new Set([brief.product.type, brief.shop.name, ...brief.product.title.split(/\s+/)].map(alnum).filter((t) => t.length > 2))].slice(0, 5).map((t) => `#${t}`);
  const caption = about.style === 'ugc' ? `${about.headline}\n${brief.product.title} from ${brief.shop.name}.` : `${about.headline} ${brief.product.title}, ${brief.product.priceText}, at ${brief.shop.name}.`;
  const out = {} as Record<Platform, PlatformCopy>;
  for (const p of PLATFORMS) out[p] = { title: about.headline.slice(0, TITLE_MAX), text: assemble(brief, p, caption, tags), hashtags: tags, caption };
  return out;
}

export async function writeCopy(db: Db, config: Config, brief: Brief, about: CopyAbout, now: Date, slotId: string, years: number[] = []): Promise<Record<Platform, PlatformCopy>> {
  const user = `${about.style === 'ugc' ? 'style: ugc\n' : ''}Write copy for these platforms: ${PLATFORMS.join(', ')}.\n${about.summary}`;
  const raw = await callJson(
    db,
    config,
    { purpose: 'copy', model: config.llm.models.copy, system: systemPrompt('copy', brief), user, schema: Schema, maxTokens: 3000, effort: 'low', slotId },
    now,
  );

  const out = {} as Record<Platform, PlatformCopy>;
  for (const p of PLATFORMS) {
    const c = raw[p];
    out[p] = { title: c.title.trim(), text: assemble(brief, p, c.caption, c.hashtags), hashtags: c.hashtags, caption: c.caption.trim() };
  }
  // A platform whose copy fails a check gets the fallback copy; the others keep the model's.
  const bad = new Map<Platform, string[]>();
  const reject = (p: Platform, why: string) => bad.set(p, [...(bad.get(p) ?? []), why]);
  for (const why of copyProblems(brief, out, years)) reject(PLATFORMS.find((p) => why.startsWith(`${p}:`))!, why);
  const rest = PLATFORMS.filter((p) => !bad.has(p));
  if (rest.length) {
    // One judge call for the platforms that passed the code checks: is every claim in the copy backed by a fact?
    const judged = rest.map((p) => `${p}: title: ${out[p].title} | caption: ${out[p].caption} | hashtags: ${out[p].hashtags.join(' ')}`).join('\n');
    const j = await callJson(
      db,
      config,
      { purpose: 'copycheck', model: config.llm.models.copy, system: systemPrompt('copycheck', brief), user: `${about.style === 'ugc' ? 'style: ugc\n' : ''}What the video shows:\n${about.summary}\n\nJudge the copy of these ${rest.length} platforms.\n${judged}`, schema: Verdicts, maxTokens: 1500, effort: 'low', slotId },
      now,
    );
    for (const p of rest) {
      const vs = j.verdicts.filter((v) => v.platform === p);
      if (vs.length !== 1) reject(p, `${p}: copy check gave ${vs.length} verdicts`);
      else if (!vs[0].supported) reject(p, `${p}: unsupported claim in the copy: ${vs[0].reason}`);
    }
  }
  if (bad.size) {
    const fb = fallbackCopy(brief, about);
    for (const p of bad.keys()) out[p] = fb[p];
    const left = copyProblems(brief, out, years);
    if (left.length) throw new CopyRejectedError(left);
    log.warn('copy fell back for some platforms', { slot: slotId, platforms: [...bad.keys()], problems: [...bad.values()].flat() });
  }
  return out;
}
