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

// Every checked string is normalized first, so look-alike forms (fullwidth digits, zero-width characters,
// odd spacing) cannot slip past the patterns below.
export const norm = (s: string): string => s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();

const DISCOUNT = /% off|\b\d+\s*off\b|half[\s-]*(off|price)|\bbogo\b|buy (one|1)\b|clearance|discount|\bsales?\b|save \$|was \$|\bdeals?\b/i;
const URGENCY = /limited time|today only|last chance|hurry|selling fast|while supplies last|\bact now\b|ends (soon|tonight)/i;
const REVIEW = /review|rated|\bstars?\b|customers (say|love)/i;
const BANNED = /best.?sell|#\s?1|number one|guarantee|\bcure|\bheal|pain relief|medical|doctor/i;
const FREE_SHIPPING = /free\s+(shipping|delivery)/i;

// Banned wording in one string, according to the brief's rules.
export function languageProblems(brief: Brief, raw: string, where: string): string[] {
  const text = norm(raw);
  const out: string[] = [];
  if (!brief.rules.discountClaims && (DISCOUNT.test(text) || URGENCY.test(text))) out.push(`${where}: discount or urgency language "${text}"`);
  if (!brief.rules.reviewClaims && REVIEW.test(text)) out.push(`${where}: review language "${text}"`);
  if (BANNED.test(text)) out.push(`${where}: banned phrase "${text}"`);
  // A look-alike letter from another script ("bеstseller" with a Cyrillic е) reads the same and matches no pattern.
  if (/[^\p{Script=Latin}\P{L}]/u.test(text)) out.push(`${where}: non-Latin letters in "${text}"`);
  if (FREE_SHIPPING.test(text) && !brief.facts.some((f) => FREE_SHIPPING.test(norm(f.text)))) out.push(`${where}: free shipping is not in the facts: "${text}"`);
  return out;
}

// "$49.99" and, for "from $49.99", the amount alone.
const AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?/;
const priceForms = (brief: Brief): string[] => {
  const amount = AMOUNT.exec(brief.product.priceText)?.[0];
  return amount && amount !== brief.product.priceText ? [brief.product.priceText, amount] : [brief.product.priceText];
};
// [49, 99] for $49.99; [49] when there are no cents.
export function priceParts(brief: Brief): string[] {
  const m = /(\d[\d,]*)(?:\.(\d+))?/.exec(AMOUNT.exec(brief.product.priceText)?.[0] ?? '');
  if (!m) return [];
  const cents = m[2] && Number(m[2]) !== 0 ? [String(Number(m[2]))] : [];
  return [String(Number(m[1].replace(/,/g, ''))), ...cents];
}

// Dollar amounts must be exactly the brief's price; no other currency, no non-ASCII digits.
export function dollarProblems(brief: Brief, raw: string, where: string): string[] {
  const text = norm(raw);
  const out: string[] = [];
  const amounts = text.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? [];
  const ok = priceForms(brief);
  for (const a of amounts) if (!ok.includes(a)) out.push(`${where}: price "${a}" is not "${brief.product.priceText}"`);
  if (/(?![0-9])\p{Nd}/u.test(text)) out.push(`${where}: non-ASCII digits in "${text}"`);
  if (/[\p{Sc}--[$]]/v.test(text) || /\$(?!\s?\d)/.test(text)) out.push(`${where}: stray currency symbol in "${text}"`);
  return out;
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

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// Number words in a run ("forty nine ninety nine") become separate numbers (49, 99).
function wordNumbers(run: string[]): number[] {
  const out: number[] = [];
  let total = 0;
  let cur = 0;
  let kind = '';
  const flush = () => {
    if (kind) out.push(total + cur);
    total = 0;
    cur = 0;
    kind = '';
  };
  for (const w of run) {
    const u = UNITS.indexOf(w);
    const t = TENS.indexOf(w);
    if (u >= 0) {
      if (kind === 'tens' && u >= 1 && u <= 9) { cur += u; kind = 'tensunit'; }
      else if (kind === 'hundred' || kind === 'thousand') { cur += u; kind = 'unit'; }
      else { flush(); cur = u; kind = u < 10 ? 'unit' : 'teen'; }
    } else if (t >= 2) {
      if (kind === 'hundred' || kind === 'thousand') { cur += t * 10; kind = 'tens'; }
      else { flush(); cur = t * 10; kind = 'tens'; }
    } else if (w === 'hundred') {
      if (kind === 'unit' && cur >= 1 && cur <= 9) cur *= 100;
      else { flush(); cur = 100; }
      kind = 'hundred';
    } else if (w === 'thousand') {
      total += (cur || 1) * 1000;
      cur = 0;
      kind = 'thousand';
    }
  }
  flush();
  return out;
}

const NUMBER_WORD = new Set([...UNITS, ...TENS.slice(2), 'hundred', 'thousand']);
type Num = { v: string; colour: boolean };

// Every number in a string, written as digits or as words. `colour` is set when it counts colours.
export function numbersIn(raw: string): Num[] {
  const tokens = norm(raw).toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/-/g, ' ').match(/\d+(?:\.\d+)?|[a-z]+/g) ?? [];
  const out: Num[] = [];
  const colourAt = (i: number) => /^colou?rs?$/.test(tokens[i] ?? '');
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d/.test(tokens[i])) out.push({ v: tokens[i], colour: colourAt(i + 1) });
    else if (NUMBER_WORD.has(tokens[i])) {
      let j = i;
      while (j < tokens.length && (NUMBER_WORD.has(tokens[j]) || (tokens[j] === 'and' && NUMBER_WORD.has(tokens[j + 1] ?? '') && /hundred|thousand/.test(tokens[j - 1])))) j++;
      const run = tokens.slice(i, j).filter((t) => t !== 'and');
      // shortcut: a lone "one" is a pronoun more often than a count ("the heated one"), so it is not checked; "one heat level" passes.
      const vals = run.length === 1 && run[0] === 'one' ? [] : wordNumbers(run);
      vals.forEach((v, k) => out.push({ v: String(v), colour: k === vals.length - 1 && colourAt(j) }));
      i = j - 1;
    }
  }
  return out;
}

// Numbers a fact states, including the parts of a decimal ("49.99" also allows 49 and 99).
export const factNumbers = (texts: string[]): Set<string> =>
  new Set(texts.flatMap(numbersIn).flatMap((n) => [n.v, ...(n.v.includes('.') ? n.v.split('.').map((p) => String(Number(p))) : [])]));

// Numbers must come from a cited fact, the price (as written), or the colour count next to a colour word.
function numberProblems(brief: Brief, raw: string, allowed: Set<string>, where: string): string[] {
  let text = norm(raw);
  for (const f of priceForms(brief)) text = text.split(f).join(' ');
  return numbersIn(text)
    .filter((n) => !allowed.has(n.v) && !(n.colour && n.v === String(brief.product.colors.length)))
    .map((n) => `${where}: number ${n.v} is not in a cited fact`);
}

// The numbers spoken in the offer must be the price (plus the colour count) and nothing else.
function spokenPriceProblems(brief: Brief, say: string, where: string): string[] {
  const spoken = numbersIn(say).filter((n) => !(n.colour && n.v === String(brief.product.colors.length))).map((n) => n.v);
  const price = priceParts(brief);
  if (!spoken.length || (spoken.length === price.length && spoken.every((v, i) => v === price[i]))) return [];
  return [`${where}: spoken numbers "${spoken.join(' ')}" are not the price ${brief.product.priceText}`];
}

// All the deterministic rules for one string. `allowed` is the set of numbers the string may use.
export function textProblems(brief: Brief, text: string, allowed: Set<string>, where: string): string[] {
  return [...languageProblems(brief, text, where), ...dollarProblems(brief, text, where), ...numberProblems(brief, text, allowed, where), ...urlProblems(brief, text, where)];
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
  for (const t of [hook.headline, hook.say]) problems.push(...textProblems(brief, t, factNumbers(texts), where));
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
      const allowed = factNumbers(texts);
      problems.push(...textProblems(brief, c.show, allowed, where), ...textProblems(brief, c.say, allowed, where));
    }
    if (beat.kind === 'offer') problems.push(...spokenPriceProblems(brief, beat.chunks.map((c) => c.say).join(' '), where));
  }
  if (total < TOTAL_WORDS[0] || total > TOTAL_WORDS[1]) problems.push(`script has ${total} spoken words, want ${TOTAL_WORDS[0]} to ${TOTAL_WORDS[1]}`);

  const hookFacts = script.beats.find((b) => b.kind === 'hook')?.factIds ?? [];
  const hookTexts = factProblems(brief, hookFacts, 'hook').texts;
  if (words(script.hook.headline) > HEADLINE_MAX_WORDS) problems.push(`hook headline over ${HEADLINE_MAX_WORDS} words`);
  problems.push(...textProblems(brief, script.hook.headline, factNumbers(hookTexts), 'hook headline'));
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
  const seen = new Set<number>();
  for (const v of r.verdicts) {
    const c = chunks[v.chunk - 1];
    if (!c) problems.push(`claim check named chunk ${v.chunk}, which does not exist`);
    else if (seen.has(v.chunk)) problems.push(`claim check gave chunk ${v.chunk} more than one verdict`);
    else if (!v.supported) problems.push(`unsupported claim "${c.show}": ${v.reason}`);
    else if (v.factId !== null && !ids.has(v.factId)) problems.push(`claim check cited unknown fact "${v.factId}" for "${c.show}"`);
    else if (v.factId === null && (c.beat === 'benefit' || c.beat === 'offer')) problems.push(`claim check found no supporting fact for "${c.show}"`);
    seen.add(v.chunk);
  }
  for (let i = 1; i <= chunks.length; i++) if (!seen.has(i)) problems.push(`claim check gave no verdict for chunk ${i}`);
  return problems;
}
