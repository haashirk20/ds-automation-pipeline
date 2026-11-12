// Claim checks. Deterministic rules first (checkScript, checkHook), then one cheap model pass (judgeClaims).
import { z } from 'zod';
import { BEATS, type Brief, type Script } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
import { systemPrompt } from '../llm/prompts.ts';

export const FRAMEWORKS = ['problem-agitate', 'curiosity-gap', 'bold-claim', 'pov', 'comparison', 'objection-flip'] as const;
export interface HookDraft {
  framework: string;
  headline: string;
  say: string;
  factIds: string[];
}

// Measured: the voice speaks about 2.5 words a second with pauses, and speech must end by 13.8 s.
export const WORD_BUDGET = { hook: [1, 7], benefit: [8, 18], offer: [4, 9], cta: [3, 7] } as const;
export const TOTAL_WORDS = [24, 32] as const;
export const HEADLINE_MAX_WORDS = 8;

export const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

const DISCOUNT = /% off|discount|\bsales?\b|save \$|was \$|\bdeals?\b/i;
const REVIEW = /review|rated|\bstars?\b|customers (say|love)/i;
const BANNED = /best.?sell|#\s?1|number one|guarantee|\bcure|\bheal|pain relief|medical|doctor/i;

// Banned wording in one string, according to the brief's rules.
export function languageProblems(brief: Brief, text: string, where: string): string[] {
  const out: string[] = [];
  if (!brief.rules.discountClaims && DISCOUNT.test(text)) out.push(`${where}: discount language "${text}"`);
  if (!brief.rules.reviewClaims && REVIEW.test(text)) out.push(`${where}: review language "${text}"`);
  if (BANNED.test(text)) out.push(`${where}: banned phrase "${text}"`);
  return out;
}

// Dollar amounts must be exactly the brief's priceText.
export function dollarProblems(brief: Brief, text: string, where: string): string[] {
  const amounts = text.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return amounts.filter((a) => a !== brief.product.priceText).map((a) => `${where}: price "${a}" is not "${brief.product.priceText}"`);
}

const hostOf = (u: string): string => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#:]/)[0].toLowerCase();
const URL_LIKE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|net|org|io|co|shop|store|app|me|us|uk|ly|xyz)\b\S*/gi;

// Every URL or domain in the text, trailing punctuation removed.
export function urlsIn(text: string): string[] {
  return (text.match(URL_LIKE) ?? []).map((u) => u.replace(/[.,;:!?)"']+$/, ''));
}

function urlProblems(brief: Brief, text: string, where: string): string[] {
  const ok = new Set([hostOf(brief.shop.domain), hostOf(brief.product.url)]);
  return urlsIn(text)
    .filter((u) => !ok.has(hostOf(u)))
    .map((u) => `${where}: foreign URL "${u}"`);
}

const numbersIn = (s: string): string[] => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));

// Digits shown on screen must come from a cited fact, the price, or the colour count.
function numberProblems(brief: Brief, text: string, factTexts: string[], where: string): string[] {
  const allowed = new Set([String(brief.product.colors.length), ...factTexts.flatMap(numbersIn)]);
  return numbersIn(text.split(brief.product.priceText).join(' '))
    .filter((n) => !allowed.has(n))
    .map((n) => `${where}: number ${n} is not in a cited fact`);
}

function shownProblems(brief: Brief, text: string, factTexts: string[], where: string): string[] {
  return [...languageProblems(brief, text, where), ...dollarProblems(brief, text, where), ...numberProblems(brief, text, factTexts, where), ...urlProblems(brief, text, where)];
}

function factProblems(brief: Brief, ids: string[], where: string): { problems: string[]; texts: string[] } {
  const byId = new Map(brief.facts.map((f) => [f.id, f.text]));
  const problems = ids.filter((i) => !byId.has(i)).map((i) => `${where}: unknown fact id "${i}"`);
  return { problems, texts: ids.flatMap((i) => (byId.has(i) ? [byId.get(i)!] : [])) };
}

export function checkHook(brief: Brief, hook: HookDraft): string[] {
  const where = `hook "${hook.headline}"`;
  const { problems, texts } = factProblems(brief, hook.factIds, where);
  if (!(FRAMEWORKS as readonly string[]).includes(hook.framework)) problems.push(`${where}: unknown framework "${hook.framework}"`);
  if (words(hook.headline) > HEADLINE_MAX_WORDS) problems.push(`${where}: headline over ${HEADLINE_MAX_WORDS} words`);
  if (words(hook.say) > WORD_BUDGET.hook[1]) problems.push(`${where}: spoken line over ${WORD_BUDGET.hook[1]} words`);
  if (!hook.headline.trim() || !hook.say.trim()) problems.push(`${where}: empty text`);
  if (/[\d$]/.test(hook.say)) problems.push(`${where}: say must spell numbers out`);
  for (const t of [hook.headline, hook.say]) problems.push(...shownProblems(brief, t, texts, where));
  return problems;
}

export function checkScript(brief: Brief, script: Script): string[] {
  const problems: string[] = [];
  const shots = new Map(brief.shots.map((s) => [s.id, s]));
  if (script.beats.map((b) => b.kind).join() !== BEATS.join()) problems.push(`beats must be ${BEATS.join(', ')} in that order`);

  let total = 0;
  for (const beat of script.beats) {
    const where = `${beat.kind} beat`;
    const { problems: fp, texts } = factProblems(brief, beat.factIds, where);
    problems.push(...fp);
    for (const id of beat.shotIds) {
      const shot = shots.get(id);
      if (!shot) problems.push(`${where}: unknown shot id "${id}"`);
      else if (/not our product/i.test(shot.note) && beat.kind !== 'hook') problems.push(`${where}: shot "${id}" is not our product and may appear only in the hook beat`);
    }
    const n = beat.chunks.reduce((a, c) => a + words(c.say), 0);
    total += n;
    const [lo, hi] = WORD_BUDGET[beat.kind];
    if (n < lo || n > hi) problems.push(`${where}: ${n} spoken words, want ${lo} to ${hi}`);
    for (const c of beat.chunks) {
      if (/[\d$]/.test(c.say)) problems.push(`${where}: say "${c.say}" must spell numbers out`);
      problems.push(...shownProblems(brief, c.show, texts, where), ...languageProblems(brief, c.say, where), ...urlProblems(brief, c.say, where));
    }
  }
  if (total < TOTAL_WORDS[0] || total > TOTAL_WORDS[1]) problems.push(`script has ${total} spoken words, want ${TOTAL_WORDS[0]} to ${TOTAL_WORDS[1]}`);

  const hookFacts = script.beats.find((b) => b.kind === 'hook')?.factIds ?? [];
  const hookTexts = factProblems(brief, hookFacts, 'hook').texts;
  if (words(script.hook.headline) > HEADLINE_MAX_WORDS) problems.push(`hook headline over ${HEADLINE_MAX_WORDS} words`);
  problems.push(...shownProblems(brief, script.hook.headline, hookTexts, 'hook headline'));
  return problems;
}

const Verdicts = z.object({
  verdicts: z.array(z.object({ chunk: z.number().int(), supported: z.boolean(), factId: z.string().nullable(), reason: z.string() })),
});

// Model pass: does a fact support each chunk? Returns problems, empty when every chunk is supported.
export async function judgeClaims(db: Db, config: Config, brief: Brief, script: Script, now: Date, slotId?: string): Promise<string[]> {
  const chunks = script.beats.flatMap((b) => b.chunks.map((c) => ({ beat: b.kind, ...c })));
  const user = `Judge these ${chunks.length} chunks.\n` + chunks.map((c, i) => `${i + 1}. [${c.beat}] say: ${c.say} | show: ${c.show}`).join('\n');
  const r = await callJson(
    db,
    config,
    { purpose: 'claims', model: config.llm.models.copy, system: systemPrompt('claims', brief), user, schema: Verdicts, maxTokens: 2000, effort: 'low', slotId },
    now,
  );
  const ids = new Set(brief.facts.map((f) => f.id));
  const problems: string[] = [];
  if (r.verdicts.length !== chunks.length) problems.push(`claim check returned ${r.verdicts.length} verdicts for ${chunks.length} chunks`);
  for (const v of r.verdicts) {
    const c = chunks[v.chunk - 1];
    if (!c) problems.push(`claim check named chunk ${v.chunk}, which does not exist`);
    else if (!v.supported) problems.push(`unsupported claim "${c.show}": ${v.reason}`);
    else if (v.factId !== null && !ids.has(v.factId)) problems.push(`claim check cited unknown fact "${v.factId}" for "${c.show}"`);
  }
  return problems;
}
