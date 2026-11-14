export type DiffLine = { op: ' ' | '+' | '-'; text: string };

const MAX_CELLS = 4_000_000;

// Line diff by longest common subsequence. Prompts are a few hundred lines; past MAX_CELLS the whole text is shown as replaced.
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  if (x.length * y.length > MAX_CELLS) return [...x.map((text) => ({ op: '-' as const, text })), ...y.map((text) => ({ op: '+' as const, text }))];
  const w = y.length + 1;
  const t = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) out.push({ op: ' ', text: x[i++] }), j++;
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < x.length) out.push({ op: '-', text: x[i++] });
  while (j < y.length) out.push({ op: '+', text: y[j++] });
  return out;
}

// Keeps `n` unchanged lines around each change and folds longer unchanged runs into one marker line.
export function foldDiff(d: DiffLine[], n = 2): DiffLine[] {
  const keep = d.map((l, i) => l.op !== ' ' || d.slice(Math.max(0, i - n), i + n + 1).some((m) => m.op !== ' '));
  const out: DiffLine[] = [];
  for (let i = 0; i < d.length; i++) {
    if (keep[i]) { out.push(d[i]); continue; }
    let k = i;
    while (k < d.length && !keep[k]) k++;
    out.push({ op: ' ', text: `... ${k - i} unchanged line${k - i === 1 ? '' : 's'}` });
    i = k - 1;
  }
  return out;
}
