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
    messages: [{ role: 'user', content: req.user }],
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
    for (const v of fixture.verdicts ?? []) if (!known.has(v.factId)) v.factId = [...known][0] ?? null;
    const out = req.schema.parse(fixture);
    record(db, now, req, 'stub', { input_tokens: 0, output_tokens: 0 }, 0);
    return out;
  }
  if (!PRICES[req.model]) throw new Error(`unknown model ${req.model}`);
  const spent = monthSpend(db, now);
  if (spent >= config.llm.monthlyCapUsd) throw new LlmCapError(`monthly model spend $${spent.toFixed(2)} reached the cap of $${config.llm.monthlyCapUsd}`);

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
