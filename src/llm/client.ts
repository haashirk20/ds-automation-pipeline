// The only place that talks to the Anthropic API. One request per call, structured output, no tools.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { env, type Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { log } from '../ops/log.ts';

export class LlmCapError extends Error {}
export class LlmRefusalError extends Error {}
export class RetryableLlmError extends Error {}

export type Effort = 'low' | 'medium' | 'high';
export interface LlmRequest<T> {
  purpose: string; // also names the stub fixture
  model: string;
  system: string; // stable: rules + brief, byte-identical across the day's calls
  user: string;
  schema: ZodType<T>;
  maxTokens: number;
  effort: Effort;
  slotId?: string;
  images?: { mediaType: 'image/jpeg' | 'image/png'; data: string }[]; // base64, sent before the user text
}

// Dollars per million tokens.
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for model ${model}`);
  return (
    (u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6
  );
}

// The most one call can cost: every output token, and the prompt at about 4 characters a token (an image about
// 1,600 tokens), all at the cache-write price.
// shortcut: rough upper bound (4 chars/token, 1,600 tokens/image), not a token count; the monthly cap is the hard stop. Count tokens if the cap is ever hit early.
export function maxCostUsd(req: Pick<LlmRequest<unknown>, 'model' | 'system' | 'user' | 'maxTokens' | 'images'>): number {
  const p = PRICES[req.model];
  if (!p) throw new Error(`no price for model ${req.model}`);
  const input = (req.system.length + req.user.length) / 4 + (req.images?.length ?? 0) * 1600;
  return (req.maxTokens * p.output + input * Math.max(p.input, p.cacheWrite)) / 1e6;
}

export function monthSpend(db: Db, now: Date): number {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls WHERE ts >= ? AND ts < ?').get(start, end) as { s: number };
  return r.s;
}

// The slice of the SDK this module needs; tests pass a fake.
export interface LlmResponse {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage: Usage;
}
export interface LlmClient {
  create(params: Record<string, unknown>): Promise<LlmResponse>;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function realClient(): LlmClient {
  const sdk = new Anthropic(); // key from ANTHROPIC_API_KEY
  return {
    create: (params) =>
      // Sonnet 5.5: server-side fallbacks in "default" form, as the migration guide asks. Haiku 5.5 has no
      // server-side fallback (the guide says not to send the parameter), so other models use the plain endpoint.
      (params.model === 'claude-sonnet-5-5'
        ? sdk.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' } as never)
        : sdk.messages.create(params as never)) as unknown as Promise<LlmResponse>,
  };
}

let client: LlmClient | null = null;
export function setLlmClient(c: LlmClient | null): void {
  client = c;
}

export function buildParams<T>(req: LlmRequest<T>): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: req.images?.length
          ? [...req.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: req.user }]
          : req.user,
      },
    ],
    output_config: { effort: req.effort, format: zodOutputFormat(req.schema as never) },
  };
}

function mapError(e: unknown): unknown {
  // InternalServerError covers 529 overloaded.
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
    return new RetryableLlmError((e as Error).message, { cause: e });
  }
  return e;
}

function record(db: Db, now: Date, req: { purpose: string; slotId?: string }, model: string, u: Usage, cost: number): void {
  db.prepare(
    'INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, slot_id) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(now.toISOString(), req.purpose, model, u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.output_tokens, cost, req.slotId ?? null);
}

export async function callJson<T>(db: Db, config: Config, req: LlmRequest<T>, now: Date): Promise<T> {
  if (env.llmStub()) {
    const file = join(import.meta.dirname, '../../tests/fixtures/llm', `${req.purpose}.json`);
    if (!existsSync(file)) throw new Error(`LLM_STUB=1 needs tests/fixtures, which are not in the Docker image: mount them (-v ./tests/fixtures:/app/tests/fixtures:ro). Missing ${file}`);
    const fixture = JSON.parse(readFileSync(file, 'utf8'));
    // The fixtures were written for the sample brief. The stub makes them fit the brief and the hook it is given:
    // the script opens with the asked-for hook, and fact ids the brief does not have are dropped.
    const known = new Set<string>((req.system.match(/"id": "(f-[^"]+)"/g) ?? []).map((m) => m.slice(7, -1)));
    const ask = req.purpose === 'script' ? /headline \(show\): (.+)\nsay: (.+)\n/.exec(req.user) : null;
    if (ask) fixture.beats[0].chunks = [{ say: ask[2], show: ask[1] }];
    for (const b of fixture.beats ?? []) b.factIds = b.factIds.filter((f: string) => known.has(f));
    const judged = Number(/^Judge these (\d+)/.exec(req.user)?.[1]); // the claims fixture covers more items than a caption check asks about
    if (req.purpose === 'claims' && judged) fixture.verdicts = fixture.verdicts.filter((v: { chunk: number }) => v.chunk <= judged);
    for (const v of fixture.verdicts ?? []) if (!known.has(v.factId)) v.factId = [...known][0] ?? null;
    // One fixture caption would be refused as a repeat from the second slot on, so each slot gets its own lead.
    if ((req.purpose === 'ugc' || req.purpose === 'ugc-asmr') && req.slotId) fixture.caption = fixture.caption.replace('POV', ['POV', 'Okay', 'Update', 'Listen', 'Honestly', 'Seriously', 'Real talk'][Number(req.slotId.replace(/\D/g, '')) % 7]);
    const out = req.schema.parse(fixture);
    record(db, now, req, 'stub', { input_tokens: 0, output_tokens: 0 }, 0);
    return out;
  }
  if (!PRICES[req.model]) throw new Error(`unknown model ${req.model}`);
  const spent = monthSpend(db, now);
  const most = maxCostUsd(req);
  if (spent + most > config.llm.monthlyCapUsd) throw new LlmCapError(`monthly model spend $${spent.toFixed(2)} plus this call's most of $${most.toFixed(3)} would pass the cap of $${config.llm.monthlyCapUsd}`);

  client ??= realClient();
  let res: LlmResponse;
  try {
    res = await client.create(buildParams(req));
  } catch (e) {
    throw mapError(e);
  }
  const cost = costUsd(req.model, res.usage);
  record(db, now, req, req.model, res.usage, cost);
  log.info('llm_call', { purpose: req.purpose, model: req.model, costUsd: cost, stop: res.stop_reason });

  // stop_reason first: the content of a refusal or a cut-off answer is not an answer.
  if (res.stop_reason === 'refusal') throw new LlmRefusalError(`${req.purpose}: model refused`);
  if (res.stop_reason === 'max_tokens') throw new Error(`${req.purpose}: output hit max_tokens (${req.maxTokens})`);
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return req.schema.parse(JSON.parse(text));
}
