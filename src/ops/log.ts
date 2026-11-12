const SECRET_KEY = /token|secret|key|password|authorization/i;
const SECRET_ENV = /TOKEN|SECRET|KEY|PASSWORD|WEBHOOK|HEALTHCHECK/i;

// Replaces secret values that leak into free text (error messages, URLs).
export function scrub(s: string): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && SECRET_ENV.test(name)) s = s.replaceAll(value, '[redacted]');
  }
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, 'Bearer [redacted]')
    .replace(/access_token=[^&\s"']+/g, 'access_token=[redacted]')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/g, '[redacted-webhook]');
}

// Redacts values of secret-looking keys and scrubs every string value.
export function redact(v: unknown): unknown {
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(x)]));
  }
  return v;
}

function write(level: string, msg: string, fields: Record<string, unknown> = {}) {
  // The logger's own timestamp is the one allowed clock read outside cli.ts.
  // Core fields come last so caller fields cannot overwrite them.
  const line = JSON.stringify({ ...(redact(fields) as object), ts: new Date().toISOString(), level, msg: scrub(msg) });
  // stderr, so a command's stdout carries only its result (for example `ingest --print`).
  process.stderr.write(line + '\n');
}

export const log = {
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};
