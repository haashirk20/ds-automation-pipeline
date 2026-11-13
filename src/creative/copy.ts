import { z } from 'zod';
import { PLATFORMS, type Brief, type Platform, type Script } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
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

const Item = z.object({ title: z.string(), caption: z.string(), hashtags: z.array(z.string()) });
const Schema = z.object(Object.fromEntries(PLATFORMS.map((p) => [p, Item])) as Record<Platform, typeof Item>);

const LINKS_CLICKABLE: readonly Platform[] = ['youtube', 'facebook']; // captions on Instagram and TikTok do not link
const TITLE_MAX = 90;
const TEXT_MAX = 2200;

const clickable = (p: Platform) => LINKS_CLICKABLE.includes(p);
const assemble = (brief: Brief, p: Platform, caption: string, hashtags: string[]) =>
  [caption.trim(), ...(clickable(p) ? [brief.product.url] : []), ...brief.disclosures, hashtags.join(' ')].join('\n\n');

// "#BlackFridaySale" and "#50OFF" become "black friday sale" and "50 off", so the claim patterns see them.
export const deTag = (h: string): string =>
  h.replace(/^#/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2').toLowerCase();

// Every deterministic rule for the copy of all platforms. Numbers must come from the brief's facts.
export function copyProblems(brief: Brief, copy: Record<Platform, PlatformCopy>): string[] {
  const problems: string[] = [];
  const allowed = factNumbers(brief.facts.map((f) => f.text));
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
export function fallbackCopy(brief: Brief, script: Script): Record<Platform, PlatformCopy> {
  const alnum = (s: string) => s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const tags = [...new Set([...brief.angles, brief.product.type, brief.shop.name, ...brief.product.title.split(/\s+/)].map(alnum).filter((t) => t.length > 2))].slice(0, 5).map((t) => `#${t}`);
  const caption = `${script.hook.headline} ${brief.product.title}, ${brief.product.priceText}, at ${brief.shop.name}.`;
  const out = {} as Record<Platform, PlatformCopy>;
  for (const p of PLATFORMS) out[p] = { title: script.hook.headline.slice(0, TITLE_MAX), text: assemble(brief, p, caption, tags), hashtags: tags, caption };
  return out;
}

export async function writeCopy(db: Db, config: Config, brief: Brief, script: Script, now: Date, slotId: string): Promise<Record<Platform, PlatformCopy>> {
  const lines = script.beats.map((b) => `${b.kind}: ${b.chunks.map((c) => c.say).join(' ')}`).join('\n');
  const user = `Write copy for these platforms: ${PLATFORMS.join(', ')}.\nThe video's script:\n${lines}`;
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
  const problems = copyProblems(brief, out);
  if (!problems.length) {
    // One judge call for all platforms: is every claim in the copy backed by a fact?
    const judged = PLATFORMS.map((p) => `${p}: title: ${out[p].title} | caption: ${out[p].caption} | hashtags: ${out[p].hashtags.join(' ')}`).join('\n');
    const j = await callJson(
      db,
      config,
      { purpose: 'copycheck', model: config.llm.models.copy, system: systemPrompt('copycheck', brief), user: `Judge the copy of these ${PLATFORMS.length} platforms.\n${judged}`, schema: Verdicts, maxTokens: 1500, effort: 'low', slotId },
      now,
    );
    for (const p of PLATFORMS) {
      const vs = j.verdicts.filter((v) => v.platform === p);
      if (vs.length !== 1) problems.push(`${p}: copy check gave ${vs.length} verdicts`);
      else if (!vs[0].supported) problems.push(`${p}: unsupported claim in the copy: ${vs[0].reason}`);
    }
  }
  if (problems.length) throw new CopyRejectedError(problems);
  return out;
}
