import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { Script } from '../src/contracts.ts';
import { callJson, costUsd, LlmCapError, LlmRefusalError, monthSpend, RetryableLlmError, setLlmClient, type LlmClient, type LlmResponse } from '../src/llm/client.ts';
import { config, fresh } from './helpers.ts';

const NOW = new Date('2026-11-12T17:00:00Z');
const Ok = z.object({ ok: z.boolean() });
const base = { purpose: 'x', model: 'claude-haiku-5-5', system: 'SYS', user: 'USER', schema: Ok, maxTokens: 100, effort: 'low' as const };

afterEach(() => {
  delete process.env.LLM_STUB;
  setLlmClient(null);
});

function fake(res: Partial<LlmResponse> | (() => never)) {
  const calls: Record<string, unknown>[] = [];
  const client: LlmClient = {
    create: async (p) => {
      calls.push(p);
      if (typeof res === 'function') res();
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 1000, output_tokens: 100 }, ...(res as object) };
    },
  };
  setLlmClient(client);
  return calls;
}
const rows = (db: ReturnType<typeof fresh>) => db.prepare('SELECT * FROM llm_calls').all() as Record<string, unknown>[];

test('stub mode returns the fixture and logs a zero-cost row', async () => {
  const db = fresh();
  process.env.LLM_STUB = '1';
  const s = await callJson(db, config, { ...base, purpose: 'script', schema: Script }, NOW);
  assert.equal(s.beats.length, 4);
  const r = rows(db);
  assert.equal(r.length, 1);
  assert.equal(r[0].model, 'stub');
  assert.equal(r[0].cost_usd, 0);
});

test('cost arithmetic includes cache reads and writes', () => {
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 };
  assert.ok(Math.abs(costUsd('claude-sonnet-5-5', u) - 14.6) < 1e-9);
  assert.ok(Math.abs(costUsd('claude-haiku-5-5', u) - 0.735) < 1e-9);
  assert.ok(Math.abs(costUsd('claude-opus-5-5', u) - 29.2) < 1e-9);
  assert.throws(() => costUsd('claude-nope', u));
});

test('a call writes tokens and cost; monthSpend only counts the current UTC month', async () => {
  const db = fresh();
  db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd) VALUES ('2026-10-31T23:59:59.000Z','x','m',0,0,0,0,5)").run();
  fake({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } });
  assert.deepEqual(await callJson(db, config, base, NOW), { ok: true });
  const r = rows(db).at(-1)!;
  assert.deepEqual([r.input_tokens, r.cache_read_tokens, r.cache_write_tokens, r.output_tokens], [1000, 5000, 300, 200]);
  assert.ok(Math.abs((r.cost_usd as number) - (1000 * 0.1 + 200 * 0.5 + 5000 * 0.01 + 300 * 0.125) / 1e6) < 1e-12);
  assert.equal(monthSpend(db, NOW), r.cost_usd);
});

test('the monthly cap blocks a call before the client is used', async () => {
  const db = fresh();
  db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd) VALUES ('2026-11-02T00:00:00.000Z','x','m',0,0,0,0,?)").run(config.llm.monthlyCapUsd);
  const calls = fake({});
  await assert.rejects(callJson(db, config, base, NOW), LlmCapError);
  assert.equal(calls.length, 0);
});

test('unknown model throws before any request', async () => {
  const calls = fake({});
  await assert.rejects(callJson(fresh(), config, { ...base, model: 'claude-nope' }, NOW), /unknown model/);
  assert.equal(calls.length, 0);
});

test('request has no sampling parameters, caches the system block, and the system block is stable', async () => {
  const db = fresh();
  const calls = fake({});
  await callJson(db, config, base, NOW);
  await callJson(db, config, { ...base, user: 'OTHER' }, new Date('2026-11-12T19:00:00Z'));
  const p = calls[0];
  for (const k of ['temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'thinking']) assert.ok(!(k in p), k);
  const sys = p.system as { type: string; text: string; cache_control: unknown }[];
  assert.equal(sys.length, 1);
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
  const oc = p.output_config as { effort: string; format: { type: string } };
  assert.equal(oc.effort, 'low');
  assert.equal(oc.format.type, 'json_schema');
  assert.equal(JSON.stringify(calls[0].system), JSON.stringify(calls[1].system));
});

test('refusal and max_tokens are errors, still ledgered', async () => {
  const db = fresh();
  fake({ stop_reason: 'refusal', content: [] });
  await assert.rejects(callJson(db, config, base, NOW), LlmRefusalError);
  fake({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok' }] });
  await assert.rejects(callJson(db, config, base, NOW), /max_tokens/);
  assert.equal(rows(db).length, 2);
});

test('output that fails the schema is rejected', async () => {
  fake({ content: [{ type: 'text', text: '{"ok":"yes"}' }] });
  await assert.rejects(callJson(fresh(), config, base, NOW));
});

test('SDK errors: rate limit, overloaded and connection become retryable; others pass through', async () => {
  const h = new Headers();
  for (const e of [new Anthropic.RateLimitError(429, {}, 'slow', h), new Anthropic.InternalServerError(529, {}, 'overloaded', h), new Anthropic.APIConnectionError({ message: 'down' })]) {
    fake(() => {
      throw e;
    });
    await assert.rejects(callJson(fresh(), config, base, NOW), RetryableLlmError);
  }
  const bad = new Anthropic.BadRequestError(400, {}, 'bad', h);
  fake(() => {
    throw bad;
  });
  await assert.rejects(callJson(fresh(), config, base, NOW), (e) => e === bad);
});
