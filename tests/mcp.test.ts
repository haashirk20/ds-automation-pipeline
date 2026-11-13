import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpAuthError, McpToolError, openMcp } from '../src/router/mcp.ts';

type Req = { headers: Record<string, string>; body: any };
const json = (b: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json', ...h } });
const sse = (...events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const result = (id: number, r: unknown) => ({ jsonrpc: '2.0', id, result: r });

// Answers initialize, the initialized notification, then each tool call with the next reply.
function server(replies: ((id: number) => Response)[]) {
  const reqs: Req[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    reqs.push({ headers: init.headers as Record<string, string>, body });
    if (body.method === 'initialize') return json(result(body.id, {}), { 'mcp-session-id': 'sess-1' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return replies.shift()!(body.id);
  }) as unknown as typeof fetch;
  return { f, reqs };
}

test('mcp: JSON result, session header reuse, structuredContent over text', async () => {
  const { f, reqs } = server([(id) => json(result(id, { structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] }))]);
  const m = await openMcp({ url: 'https://x/mcp', token: 'tok', fetch: f });
  assert.deepEqual(await m.call('balance', {}), { a: 1 });
  assert.equal(reqs[0].body.params.protocolVersion, '2025-06-18');
  assert.equal(reqs[0].body.params.clientInfo.name, 'ad-pipeline');
  assert.match(reqs[0].headers.accept, /text\/event-stream/);
  assert.equal(reqs[0].headers['mcp-session-id'], undefined);
  for (const r of reqs.slice(1)) {
    assert.equal(r.headers['mcp-session-id'], 'sess-1');
    assert.equal(r.headers['mcp-protocol-version'], '2025-06-18');
  }
  assert.equal(reqs[1].body.method, 'notifications/initialized');
});

test('mcp: SSE with a notification before the result; text block parsed when no structuredContent', async () => {
  const { f } = server([(id) => sse({ jsonrpc: '2.0', method: 'notifications/progress' }, result(id, { content: [{ type: 'text', text: '{"ok":true}' }] }))]);
  const m = await openMcp({ url: 'https://x/mcp', token: 'tok', fetch: f });
  assert.deepEqual(await m.call('t', {}), { ok: true });
});

test('mcp: isError and JSON-RPC error throw McpToolError; 401 throws McpAuthError; other HTTP errors are plain', async () => {
  const { f } = server([
    (id) => json(result(id, { isError: true, content: [{ type: 'text', text: 'no credits' }] })),
    (id) => json({ jsonrpc: '2.0', id, error: { code: -1, message: 'bad params' } }),
    () => new Response('x', { status: 401 }),
    () => new Response('x', { status: 500 }),
  ]);
  const m = await openMcp({ url: 'https://x/mcp', token: 'secret-token-123', fetch: f });
  await assert.rejects(m.call('t', {}), (e: Error) => e instanceof McpToolError && e.message === 'no credits');
  await assert.rejects(m.call('t', {}), (e: Error) => e instanceof McpToolError && e.message === 'bad params');
  await assert.rejects(m.call('t', {}), McpAuthError);
  await assert.rejects(m.call('t', {}), (e: Error) => !(e instanceof McpAuthError) && /500/.test(e.message) && !e.message.includes('secret-token-123'));
});

test('mcp: a body over 5 MB is refused', async () => {
  const { f } = server([() => new Response('x'.repeat(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]);
  const m = await openMcp({ url: 'https://x/mcp', token: 't', fetch: f });
  await assert.rejects(m.call('t', {}), /too large/);
});
