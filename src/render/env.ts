// What a subprocess (Python, FFmpeg) may see of our environment. API keys and webhooks are not in it.
const ALLOWED = /^(PATH|HOME|LANG|TMPDIR|LD_LIBRARY_PATH|UV_.*|HF_.*|XDG_.*|PYTHON.*)$/;

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ALLOWED.test(k)) out[k] = v;
  return { ...out, ...extra };
}
