// Small building blocks shared by the admin pages (D-41): one flash pattern, one error pattern, form rows,
// empty states, badges, confirmations and owner-facing local times.
import { html, raw, type Raw } from './html.ts';

export type Kind = 'ok' | 'bad' | 'warn' | 'info';
const ICON: Record<Kind, string> = { ok: '✓', bad: '!', warn: '!', info: 'i' };

// What happened (bold), then when it takes effect. Only ok and info are a status; the rest are alerts.
export function flash(kind: Kind, title: string, detail?: string | Raw | null): Raw {
  const role = kind === 'ok' || kind === 'info' ? 'status' : 'alert';
  return html`<div class="flash ${kind}" role="${role}"><span class="icon" aria-hidden="true">${ICON[kind]}</span><div><strong>${title}</strong>${detail ? html` ${detail}` : ''}</div></div>`;
}

export type FieldErr = { id?: string; label?: string; msg: string };

// "Not saved. Fix N thing(s):" with a link to each field that has an id.
export function errSummary(errs: FieldErr[], title = 'Not saved.'): Raw | '' {
  if (!errs.length) return '';
  return html`<div class="err-summary" role="alert" tabindex="-1"><strong>${title} Fix ${errs.length === 1 ? '1 thing' : `${errs.length} things`}:</strong><ul>${errs.map((e) => html`<li>${e.id ? html`<a href="#${e.id}">${e.label ? `${e.label}: ` : ''}${e.msg}</a>` : html`${e.label ? `${e.label}: ` : ''}${e.msg}`}</li>`)}</ul></div>`;
}

export function formRow(o: { id: string; label: string | Raw; control: Raw; unit?: string; hint?: string | Raw | null; err?: string[] | null }): Raw {
  return html`<div class="form-row${o.err?.length ? ' has-error' : ''}"><label for="${o.id}">${o.label}</label><div class="ctl">${o.control}${o.unit ? html`<span class="unit">${o.unit}</span>` : ''}${o.hint ? html`<span class="hint">${o.hint}</span>` : ''}${(o.err ?? []).map((m) => html`<span class="err">${m}</span>`)}</div></div>`;
}

export const empty = (text: string | Raw, action?: Raw): Raw => html`<div class="empty"><p>${text}</p>${action ?? ''}</div>`;

export const badge = (kind: 'ok' | 'warn' | 'bad' | 'neutral', text: string): Raw => html`<span class="badge ${kind}">${text}</span>`;

// A destructive action: the summary opens it, the real button sits inside. `button` is a submit button (or a whole form).
export function confirmRemove(summary: string, button: Raw, note = 'This cannot be undone.'): Raw {
  return html`<details class="confirm"><summary class="btn link danger">${summary}</summary><div><p>${note}</p>${button}</div></details>`;
}

// An on/off switch. The checkbox keeps its name and value; On/Off is shown as text too.
export function toggle(o: { id: string; name: string; value?: string; checked: boolean; label: string; invalid?: boolean }): Raw {
  return html`<label class="toggle" for="${o.id}"><input id="${o.id}" type="checkbox" role="switch" name="${o.name}" value="${o.value ?? '1'}"${o.checked ? raw(' checked') : ''}${o.invalid ? raw(' aria-invalid="true"') : ''}><span class="vh">${o.label}</span><span class="on" aria-hidden="true">On</span><span class="off" aria-hidden="true">Off</span></label>`;
}

const part = (parts: Intl.DateTimeFormatPart[], t: string) => parts.find((p) => p.type === t)?.value ?? '';

// An instant in the shop's time zone, e.g. "Fri 20 Nov, 12:15". Empty for no value.
export function fmtLocal(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return `${part(p, 'weekday')} ${part(p, 'day')} ${part(p, 'month').replace('.', '')}, ${part(p, 'hour')}:${part(p, 'minute')}`;
}

// A local calendar date (YYYY-MM-DD), e.g. "Fri 20 Nov".
export function fmtDate(ymd: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(`${ymd}T12:00:00Z`));
  return `${part(p, 'weekday')} ${part(p, 'day')} ${part(p, 'month').replace('.', '')}`;
}

export const money = (usd: number): string => `$${usd.toFixed(2)}`;
