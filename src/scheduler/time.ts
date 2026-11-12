function parts(ms: number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return p as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}

// Offset of timeZone from UTC at an instant, in ms.
function offset(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

export function localDateOf(now: Date, timeZone: string): string {
  const p = parts(now.getTime(), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localHHMM(now: Date, timeZone: string): string {
  const p = parts(now.getTime(), timeZone);
  return `${p.hour}:${p.minute}`;
}

// Nonexistent local time (spring forward) resolves forward; ambiguous (fall back) resolves to the first occurrence.
export function localToUtc(localDate: string, hhmm: string, timeZone: string): Date {
  const [y, mo, d] = localDate.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const day = 86400000;
  const before = offset(wall - day, timeZone);
  const offsets = [...new Set([before, offset(wall + day, timeZone)])];
  const valid = offsets.map((o) => wall - o).filter((t) => offset(t, timeZone) === wall - t);
  return new Date(valid.length ? Math.min(...valid) : wall - before);
}

export function addDays(localDate: string, n: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
