// Minimal MCP client (streamable HTTP, JSON-RPC 2.0) over fetch. No model, no retries: callers decide.
export class McpToolError extends Error {}
export class McpAuthError extends Error {}
export type McpSession = { call(name: string, args: unknown): Promise<unknown> };

const MAX_BODY = 5 * 1024 * 1024;
const PROTOCOL = '2025-06-18';
type Rpc = { id?: number | string; result?: any; error?: { message?: string } };

// Reads the response and returns the JSON-RPC message with the wanted id (null when `id` is null: nothing to match).
async function readRpc(res: Response, id: number | null): Promise<Rpc | null> {
  const type = res.headers.get('content-type') ?? '';
  if (!res.body) return null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let total = 0, buf = '', data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.length;
        if (total > MAX_BODY) throw new Error('MCP response too large');
        buf += dec.decode(value, { stream: true });
      }
      if (!type.includes('text/event-stream')) {
        if (!done) continue;
        if (id === null || !buf.trim()) return null;
        const m = JSON.parse(buf);
        return (Array.isArray(m) ? m.find((x) => x.id === id) : m) ?? null;
      }
      const lines = buf.split(/\r?\n/);
      buf = done ? '' : lines.pop()!;
      if (done) lines.push(''); // flush an event the server did not terminate
      for (const line of lines) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line === '' && data.length) {
          const m = JSON.parse(data.join('\n')) as Rpc;
          data = [];
          if (id !== null && m.id === id) return m;
        }
      }
      if (done) return null;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function openMcp(o: { url: string; token: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<McpSession> {
  const f = o.fetch ?? fetch;
  let session: string | null = null;
  let nextId = 1;
  const post = async (body: unknown, id: number | null) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${o.token}` };
    if (session) { headers['mcp-session-id'] = session; headers['mcp-protocol-version'] = PROTOCOL; }
    // 90 s per request (the longest call, jobs_wait, holds for 15 s), so a dead connection cannot hold a slot until its own timeout.
    const limit = AbortSignal.timeout(90_000);
    const res = await f(o.url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: o.signal ? AbortSignal.any([o.signal, limit]) : limit });
    if (res.status === 401) { await res.body?.cancel().catch(() => {}); throw new McpAuthError('MCP server answered 401'); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`MCP server answered HTTP ${res.status}`); }
    const sid = res.headers.get('mcp-session-id');
    if (sid) session = sid;
    return readRpc(res, id);
  };
  const rpc = async (method: string, params: unknown) => {
    const id = nextId++;
    const m = await post({ jsonrpc: '2.0', id, method, params }, id);
    if (!m) throw new Error(`MCP: no response to ${method}`);
    if (m.error) throw new McpToolError(String(m.error.message ?? 'JSON-RPC error'));
    return m.result;
  };
  await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'ad-pipeline', version: '1' } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, null);
  return {
    async call(name, args) {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = (r?.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === 'text')?.text;
      if (r?.isError) throw new McpToolError(text ?? 'tool error');
      if (r?.structuredContent !== undefined) return r.structuredContent;
      if (text === undefined) throw new Error(`MCP: ${name} returned no content`);
      return JSON.parse(text);
    },
  };
}
