import { z } from 'zod';
import { PLATFORMS, type Brief, type Platform, type Script } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
import { systemPrompt } from '../llm/prompts.ts';
import { dollarProblems, languageProblems, urlsIn } from './claims.ts';

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
}

const Item = z.object({ title: z.string(), caption: z.string(), hashtags: z.array(z.string()) });
const Schema = z.object(Object.fromEntries(PLATFORMS.map((p) => [p, Item])) as Record<Platform, typeof Item>);

const LINKS_CLICKABLE: readonly Platform[] = ['youtube', 'facebook']; // captions on Instagram and TikTok do not link
const TITLE_MAX = 90;
const TEXT_MAX = 2200;

export async function writeCopy(db: Db, config: Config, brief: Brief, script: Script, now: Date, slotId: string): Promise<Record<Platform, PlatformCopy>> {
  const lines = script.beats.map((b) => `${b.kind}: ${b.chunks.map((c) => c.say).join(' ')}`).join('\n');
  const user = `Write copy for these platforms: ${PLATFORMS.join(', ')}.\nThe video's script:\n${lines}`;
  const raw = await callJson(
    db,
    config,
    { purpose: 'copy', model: config.llm.models.copy, system: systemPrompt('copy', brief), user, schema: Schema, maxTokens: 3000, effort: 'low', slotId },
    now,
  );

  const problems: string[] = [];
  const out = {} as Record<Platform, PlatformCopy>;
  for (const p of PLATFORMS) {
    const c = raw[p];
    const where = p;
    const text = [c.caption.trim(), ...(LINKS_CLICKABLE.includes(p) ? [brief.product.url] : []), ...brief.disclosures, c.hashtags.join(' ')].join('\n\n');
    if (c.title.length > TITLE_MAX) problems.push(`${where}: title is ${c.title.length} characters, max ${TITLE_MAX}`);
    if (text.length > TEXT_MAX) problems.push(`${where}: text is ${text.length} characters, max ${TEXT_MAX}`);
    if (c.hashtags.length < 3 || c.hashtags.length > 6) problems.push(`${where}: ${c.hashtags.length} hashtags, want 3 to 6`);
    for (const h of c.hashtags) if (!/^#[A-Za-z0-9]+$/.test(h)) problems.push(`${where}: bad hashtag "${h}"`);
    const own = `${c.title}\n${c.caption}\n${c.hashtags.join(' ')}`;
    problems.push(...languageProblems(brief, own, where), ...dollarProblems(brief, own, where));
    if (urlsIn(own).length) problems.push(`${where}: the model wrote a URL; only the product URL is allowed and code adds it`);
    for (const u of urlsIn(text)) if (u !== brief.product.url) problems.push(`${where}: URL "${u}" is not the product URL`);
    for (const d of brief.disclosures) if (!text.includes(d)) problems.push(`${where}: disclosure missing: ${d}`);
    out[p] = { title: c.title.trim(), text, hashtags: c.hashtags };
  }
  if (problems.length) throw new CopyRejectedError(problems);
  return out;
}
