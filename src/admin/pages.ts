import raw from '../../config/pipeline.config.ts';
import { parseConfig, type Config } from '../config/index.ts';
import { activateConfig, audit, effectiveConfig, limits, loadEffectiveConfig, saveConfig } from '../config/overrides.ts';
import { autoPaused, kvGet, kvSet, migrate, type Db } from '../db/index.ts';
import { loadCustomModels, type TierDef } from '../config/models.ts';
import { DatabaseSync } from 'node:sqlite';
import { activateText, EDITABLE_TEXT, fileText as promptFile, isEditable, loadPrompts, saveText, systemPrompt, usePrompts } from '../llm/prompts.ts';
import { PRICES, monthSpend } from '../llm/client.ts';
import { productLook } from '../creative/ugc.ts';
import { buildSummary } from '../ops/summary.ts';
import { monthSpendUsd } from '../router/index.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import type { Brief } from '../contracts.ts';
import { foldDiff, lineDiff } from './diff.ts';
import { html, raw as rawHtml, Raw } from './html.ts';
import { badge, confirmRemove, empty, errSummary, flash, fmtDate, fmtLocal, formRow, money, notice, toggle, type FieldErr } from './ui.ts';

export type Ctx = {
  db: Db;
  now: Date;
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  csrf: string | null; // null when not signed in
  range?: string | null; // the Range header of a media request
};
export type Res = { status: number; body?: Raw | string; type?: string; headers?: Record<string, string | string[]>; file?: { path: string; start: number; end: number; size: number; type: string } };

const ok = (body: Raw): Res => ({ status: 200, body });
export const redirect = (to: string): Res => ({ status: 303, headers: { location: to } });
const fileRaw = raw as unknown as Record<string, any>;

// ---------- layout ----------

const PRIMARY: [string, string][] = [['/overview', 'Home'], ['/town', 'Town'], ['/posts', 'Videos'], ['/products', 'Products'], ['/music', 'Music'], ['/settings', 'Settings'], ['/factory', 'Factory']];
const MORE: [string, string][] = [['/activity', 'Activity log'], ['/history', 'Change history'], ['/prompts', 'Writing instructions'], ['/models', 'Video models']];

// One plain sentence under each page title: what the page is for.
const HELP: Record<string, string> = {
  '/overview': 'How things are going, and what needs you.',
  '/factory': 'Watch every video move down the line, live.',
  '/town': 'Walk around town: every building is a page.',
  '/products': 'Pick which products get videos and which daily post they go in.',
  '/posts': 'Approve videos before they go out, or make one now.',
  '/settings': 'When videos are posted, where they go, and how much may be spent.',
  '/music': 'Background music for your videos. Tracks that are switched on take turns.',
  '/models': 'Video models the factory may use for clips.',
  '/prompts': 'Advanced: the instructions the AI writers follow.',
  '/activity': 'What was made, posted, or went wrong this week.',
  '/history': 'Go back to earlier settings, and see every change made.',
};

// h1: false when the page puts its own title inside a card (the sign-in page).
export function layout(ctx: Ctx | null, title: string, active: string, body: Raw, head: Raw | '' = '', opts: { h1?: boolean } = {}): Res {
  const link = ([h, t]: [string, string]) => html`<a href="${h}"${h === active ? rawHtml(' aria-current="page"') : ''}>${t}</a>`;
  const logout = ctx?.csrf ? html`<form method="post" action="/logout"><input type="hidden" name="csrf" value="${ctx.csrf}"><button class="link" type="submit">Log out</button></form>` : '';
  const nav = ctx?.csrf
    ? html`<header class="top"><nav aria-label="Main"><a class="brand" href="/overview">Ad factory</a>
<div class="nav-wide">${PRIMARY.map(link)}<details class="more"><summary>More</summary><div class="drop">${MORE.map(link)}<hr>${logout}</div></details></div>
<details class="menu"><summary>Menu</summary><div class="drop">${PRIMARY.map(link)}<hr>${MORE.map(link)}<hr>${logout}</div></details></nav></header>`
    : '';
  // D-45: the flash after Stop or Start shows only while it is still true, so a reload never claims a stale change.
  const paused = ctx?.csrf ? !!autoPaused(ctx.db) : false;
  const m = ctx?.csrf ? ctx.query.get('msg') : null;
  const autoMsg = m === 'auto-stopped' && paused ? flash('ok', 'Daily posts stopped.') : m === 'auto-started' && ctx?.csrf && !paused ? flash('ok', 'Daily posts are on again.') : '';
  // Home and Videos carry the full control; every other page gets one line.
  const autoLine = paused && active !== '/overview' && active !== '/posts' ? html`<p class="flash warn"><span class="icon" aria-hidden="true">!</span><span>Daily posts are stopped. <a href="/overview#auto">Start them on Home</a>.</span></p>` : '';
  const help = ctx?.csrf && HELP[active] && !/^(Not |Review|Edit|Add|History of|Check)/.test(title) ? html`<p class="lede">${HELP[active]}</p>` : '';
  return ok(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} - Ad factory</title><link rel="stylesheet" href="/style.css">${head}</head><body><a class="skip" href="#main">Skip to content</a>${nav}<main id="main" tabindex="-1">${opts.h1 === false ? '' : html`<h1>${title}</h1>`}${help}${autoMsg}${autoLine}${body}</main></body></html>`);
}

export const csrfField = (ctx: Ctx) => html`<input type="hidden" name="csrf" value="${ctx.csrf}">`;
// UTC, for the technical tables only. Owner-facing times use fmtLocal.
export const fmtTs = (s: string | null | undefined) => (s ? s.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '');

// ---------- login ----------

// opts.next: where to go after signing in (already checked by safeNext). opts.out: the owner just signed out.
export function loginPage(msg: string | null, hasPassword: boolean, opts: { next?: string; out?: boolean } = {}): Res {
  return layout(null, 'Sign in', '', html`<div class="card login">
<p class="brandname">Ad factory</p><h1>Sign in</h1>
${opts.out ? flash('ok', 'You are signed out.') : ''}
${msg ? flash('bad', msg) : ''}
${hasPassword ? '' : flash('bad', 'No password is set.', html`Run <code>node src/cli.ts admin password</code> on the server first.`)}
<form method="post" action="/login">${opts.next ? html`<input type="hidden" name="next" value="${opts.next}">` : ''}
${formRow({ id: 'u', label: 'Username', control: html`<input id="u" type="text" name="username" value="admin" readonly autocomplete="username">`, hint: 'There is one account, admin.' })}
${formRow({ id: 'p', label: 'Password', control: html`<input id="p" type="password" name="password" autocomplete="current-password" required autofocus>` })}
<div class="actions"><button class="primary" type="submit">Sign in</button></div></form></div>`, '', { h1: false });
}

// A plain error page in the normal layout: what went wrong in owner words, and a way back. ctx null (not signed in) hides the menu.
export function errorPage(ctx: Ctx | null, status: number, title: string, text: string, back: { href: string; label: string } = { href: '/overview', label: 'Go to Home' }): Res {
  return { ...layout(ctx, title, '', html`<p>${text}</p><p><a class="btn" href="${back.href}">${back.label}</a></p>`), status };
}

export const notFound = (ctx: Ctx | null): Res => errorPage(ctx, 404, 'Page not found', 'There is no page at this address.');

// ---------- shared reads ----------

const versionId = (db: Db, key: string): number | null => {
  const v = kvGet(db, key);
  return v ? Number(v) : null;
};

function overridesById(db: Db, id: number | null): Record<string, unknown> {
  const r = id === null ? undefined : (db.prepare('SELECT overrides_json FROM config_versions WHERE id = ?').get(id) as { overrides_json: string } | undefined);
  try { return r ? JSON.parse(r.overrides_json) : {}; } catch { return {}; }
}

function activeOverrides(db: Db): { id: number | null; o: Record<string, unknown> } {
  const id = versionId(db, 'config_active');
  if (id === null) return { id: null, o: {} };
  const r = db.prepare('SELECT overrides_json FROM config_versions WHERE id = ?').get(id) as { overrides_json: string } | undefined;
  try {
    return { id, o: r ? JSON.parse(r.overrides_json) : {} };
  } catch {
    return { id, o: {} };
  }
}

const getPath = (o: any, p: string): unknown => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const dryRunOn = (db: Db): boolean => { try { return !!JSON.parse(kvGet(db, 'pipeline_state') ?? '{}').dryRun; } catch { return false; } };

// The prompt file for a key; product notes come from the notes file.
function fileText(key: string): string {
  return key.startsWith('note:') ? (productLook(key.slice(5)) ?? '') : promptFile(key);
}

function activeText(db: Db, key: string): { id: number | null; body: string } {
  const id = versionId(db, `text_active:${key}`);
  const r = id === null ? undefined : (db.prepare('SELECT body FROM text_versions WHERE id = ? AND key = ?').get(id, key) as { body: string } | undefined);
  return r ? { id, body: r.body } : { id: null, body: fileText(key) };
}

const handles = (db: Db): string[] => (db.prepare('SELECT handle FROM products ORDER BY handle').all() as { handle: string }[]).map((r) => r.handle);

function validKey(db: Db, key: string | null): key is string {
  if (!key) return false;
  if (key.startsWith('note:')) return handles(db).includes(key.slice(5));
  return isEditable(key);
}

const idOrNull = (s: string | null): number | null => (s && /^\d{1,9}$/.test(s) ? Number(s) : null);

// ---------- settings ----------

type Kind = 'time' | 'int' | 'num' | 'bool' | 'select' | 'times';
// when / where / money / look are the visible sections; models, safe and house sit under Advanced.
type Sec = 'when' | 'where' | 'money' | 'look' | 'models' | 'safe' | 'house';
type Field = { path: string; label: string; sec: Sec; kind: Kind; unit?: string; hint?: string };
const PLATFORMS = ['youtube', 'facebook', 'instagram', 'tiktok'] as const;
export const PNAME: Record<string, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
const EDGES = ['top', 'bottom', 'left', 'right'] as const;
const VIS: Record<string, string> = { public: 'Everyone', private: 'Only me' };

const FIELDS: Field[] = [
  { path: 'produceAt', label: "Make tomorrow's videos at", sec: 'when', kind: 'time' },
  ...PLATFORMS.map((p): Field => ({ path: `platforms.${p}.slots`, label: `${PNAME[p]} post times`, sec: 'when', kind: 'times' })),
  ...PLATFORMS.flatMap((p): Field[] => [
    { path: `platforms.${p}.enabled`, label: `${PNAME[p]}: posting`, sec: 'where', kind: 'bool' },
    { path: `platforms.${p}.visibility`, label: `${PNAME[p]}: who can see posts`, sec: 'where', kind: 'select', hint: p === 'instagram' ? 'Instagram has no "Only me": choose Everyone, or turn Instagram off.' : undefined },
  ]),
  { path: 'tiers.capsUsd.t2', label: 'Most to spend on video clips each month', sec: 'money', kind: 'num', unit: 'USD' },
  { path: 'llm.monthlyCapUsd', label: 'Most to spend on AI writing each month', sec: 'money', kind: 'num', unit: 'USD' },
  { path: 'approval.manualPerDay', label: '"Make a video now" uses per day', sec: 'money', kind: 'int', hint: '0 turns the button off. More videos a day can look repetitive to the platforms.' },
  { path: 'tiers.maxJobsPerSlot', label: 'Tries per video if the quality check fails', sec: 'money', kind: 'int', hint: 'Each try is a new paid clip.' },
  { path: 'tiers.t2.maxCredits', label: 'Most credits for one clip', sec: 'money', kind: 'num', unit: 'credits' },
  { path: 'tiers.t2.keepCredits', label: 'Always leave this many credits in the account', sec: 'money', kind: 'num', unit: 'credits' },
  { path: 'ugc.captionPx', label: 'Caption text size', sec: 'look', kind: 'int', unit: 'px' },
  { path: 'ugc.music.volumeDb', label: 'Music volume', sec: 'look', kind: 'num', unit: 'dB', hint: 'Closer to 0 is louder; −20 is quiet. Music comes from the Music page.' },
  { path: 'ugc.music.duckDb', label: 'Lower the music while someone speaks by', sec: 'look', kind: 'num', unit: 'dB', hint: 'Use a negative number: −6 makes the music 6 dB quieter while someone speaks. 0 changes nothing.' },
  { path: 'ugc.reuseAfterDays', label: 'Reuse an earlier clip after', sec: 'look', kind: 'int', unit: 'days' },
  { path: 'tiers.mix.t0', label: 'Share of videos that reuse an earlier clip', sec: 'look', kind: 'num', hint: '0 = always a new clip, 1 = always reuse.' },
  { path: 'tiers.t2Preset', label: 'Video model', sec: 'models', kind: 'select' },
  { path: 'llm.models.script', label: 'Script writer', sec: 'models', kind: 'select' },
  { path: 'llm.models.copy', label: 'Fact checker and caption writer', sec: 'models', kind: 'select' },
  { path: 'llm.models.qa', label: 'Quality check', sec: 'models', kind: 'select', hint: 'Tested on claude-haiku-5-5 at low effort (D-28); other models are untested.' },
  ...PLATFORMS.flatMap((p) => EDGES.map((e): Field => ({ path: `platforms.${p}.safe.${e}`, label: `${PNAME[p]} text safe zone, ${e}`, sec: 'safe', kind: 'int', unit: 'px' }))),
  { path: 'ops.summaryAt', label: 'Daily summary at', sec: 'house', kind: 'time' },
  { path: 'ops.snapshotAt', label: 'Nightly backup snapshot at', sec: 'house', kind: 'time' },
  { path: 'ops.keepDays', label: 'Keep old videos for', sec: 'house', kind: 'int', unit: 'days' },
  { path: 'ops.diskAlertPercent', label: 'Warn me when the disk is fuller than', sec: 'house', kind: 'int', unit: '%' },
];
const fieldOf = (p: string) => FIELDS.find((f) => f.path === p);
const labelOf = (p: string) => fieldOf(p)?.label ?? p;
const ADVANCED: Sec[] = ['models', 'safe', 'house'];

const LOCKED: { label: string; value: (c: Config, dry: boolean) => unknown; reason: string }[] = [
  { label: 'Time zone', value: (c) => c.timezone, reason: 'Changing it moves every post time.' },
  { label: 'Practice mode', value: (_c, dry) => (dry ? 'on' : 'off'), reason: 'Set where the factory is started (DRY_RUN), not here.' },
  { label: 'Account names', value: (c) => PLATFORMS.map((p) => `${PNAME[p]}: ${c.platforms[p].handle}`).join(', '), reason: 'They name the real accounts.' },
  { label: 'Publishing timing and retries', value: (c) => c.publish, reason: 'They guard against double posting.' },
  { label: 'AI disclosure', value: (c) => c.disclosure, reason: 'A legal label.' },
  { label: 'Creative mode', value: (c) => c.creative.mode, reason: 'It changes the whole production path.' },
  { label: 'Brand', value: (c) => c.brand, reason: 'Brand name and logo file; the logo can be uploaded on Products.' },
  { label: 'Rule checks', value: () => 'claims, caption check, frame check', reason: 'They enforce the advertising rules; see Writing instructions (read only).' },
  { label: 'Clip length (seconds)', value: (c) => c.tiers.clipSeconds, reason: 'Tied to the 14 to 16 second rule.' },
  { label: 'Clip model parameters', value: (c) => c.tiers.t2.params, reason: 'Free-form values; pick a video model instead.' },
  { label: 'Frame check effort and photo tags', value: () => 'low; config/photo-tags.json', reason: 'Calibrated together with the model.' },
  { label: 'Waiting-video expiry, credit price, added-model ceiling', value: (c) => `${c.approval.expireHours} h, ${c.tiers.usdPerCredit.toFixed(4)} USD per credit, ${c.tiers.customMaxCredits} credits`, reason: 'They guard spend and stale posts.' },
  { label: 'Render timeouts and attempts', value: (c) => c.render, reason: 'Tied to the tries per video and the clip timeout.' },
  { label: 'Watchdog (minutes)', value: (c) => c.watchdogMinutes, reason: 'Tied to the one-minute tick.' },
];

function limitText(l: { min?: number; max?: number } | undefined): string {
  if (!l) return '';
  if (l.min !== undefined && l.max !== undefined) return `${l.min} to ${l.max}`;
  if (l.max !== undefined) return `up to ${l.max}`;
  if (l.min !== undefined) return `at least ${l.min}`;
  return '';
}

type Customs = Record<string, TierDef>;
const customsOf = (db: Db): Customs => loadCustomModels(db, parseConfig(fileRaw), { approvedOnly: true });
const t2PresetKeys = (customs: Customs = {}): string[] => [...Object.keys(fileRaw.tiers?.t2Presets ?? {}), ...Object.keys(customs)];
function fileDefault(f: Field, preset?: string, customs: Customs = {}): unknown {
  const t2 = fileRaw.tiers?.t2;
  if (f.path === 'tiers.t2Preset') return t2PresetKeys().find((k) => fileRaw.tiers.t2Presets[k].model === t2?.model && same(fileRaw.tiers.t2Presets[k].params, t2?.params)) ?? t2PresetKeys()[0];
  // The preset in use supplies the file values of the tiers.t2 fields.
  if (f.path.startsWith('tiers.t2.') && preset && customs[preset]) return getPath(customs[preset], f.path.slice('tiers.t2.'.length));
  if (f.path.startsWith('tiers.t2.') && preset && fileRaw.tiers.t2Presets?.[preset]) return getPath(fileRaw.tiers.t2Presets[preset], f.path.slice('tiers.t2.'.length));
  return getPath(fileRaw, f.path);
}
const presetField = FIELDS.find((x) => x.path === 'tiers.t2Preset')!;

function currentValue(f: Field, cfg: Config, o: Record<string, unknown>): unknown {
  if (f.path === 'tiers.t2Preset') return o[f.path] ?? fileDefault(f);
  return getPath(cfg, f.path);
}

function choicesOf(f: Field, lim: Record<string, any>, customs: Customs): string[] {
  if (f.path === 'tiers.t2Preset') return t2PresetKeys(customs);
  if (f.path === 'platforms.instagram.visibility') return ['public']; // Instagram has no private posts
  if (f.path.endsWith('.visibility')) return ['public', 'private'];
  if (f.path.startsWith('llm.models.')) return lim[f.path]?.choices ?? Object.keys(PRICES);
  return lim[f.path]?.choices ?? [];
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''));
// A value as the owner reads it: On/Off, Everyone/Only me, model names, units.
function showVal(f: Field | undefined, v: unknown, names: Map<string, string> = new Map()): string {
  if (!f) return show(v);
  if (f.kind === 'bool') return v ? 'On' : 'Off';
  if (f.path.endsWith('.visibility')) return VIS[String(v)] ?? show(v);
  if (f.kind === 'times') return Array.isArray(v) && v.length ? v.join(', ') : 'none';
  if (f.kind === 'select') return names.get(String(v)) ?? show(v);
  return f.unit ? `${show(v)} ${f.unit}` : show(v);
}
const modelNames = (db: Db) => new Map((db.prepare('SELECT id, name FROM video_models').all() as { id: number; name: string }[]).map((r) => [`custom:${r.id}`, `${r.name} (added)`]));
const fid = (p: string) => 'f-' + p.replace(/\./g, '-');
const errId = (f: Field) => (f.kind === 'times' ? `${fid(f.path)}-0` : fid(f.path));
const stripPath = (path: string, m: string) => (m.startsWith(`${path}: `) ? m.slice(path.length + 2) : m);

function settingsForm(ctx: Ctx, cfg: Config, o: Record<string, unknown>, activeId: number | null, submitted: URLSearchParams | null, errs: Map<string, string[]>, other: string[]): Raw {
  const preset = String(o['tiers.t2Preset'] ?? fileDefault(presetField));
  const customs = customsOf(ctx.db);
  const lim = limits(fileRaw, preset, customs) as Record<string, any>;
  // Added models show their name; the value stays 'custom:<id>'.
  const names = modelNames(ctx.db);
  const dry = dryRunOn(ctx.db);
  const fdPreset = submitted ? (submitted.get('tiers.t2Preset') ?? preset) : preset;
  const errsOf = (f: Field) => (errs.get(f.path) ?? []).map((m) => stripPath(f.path, m));
  const invalid = (f: Field) => (errs.has(f.path) ? rawHtml(' aria-invalid="true"') : '');

  const control = (f: Field, id = fid(f.path)): Raw => {
    const cur = currentValue(f, cfg, o);
    const val = submitted ? (submitted.get(f.path) ?? '') : String(cur ?? '');
    if (f.kind === 'bool') return toggle({ id, name: f.path, checked: submitted ? submitted.has(f.path) : cur === true, label: f.label, invalid: errs.has(f.path) });
    if (f.kind === 'select') {
      // Instagram offers only Everyone. A stored "Only me" (the file default while Instagram is off) stays visible so an untouched form changes nothing.
      const opts = choicesOf(f, lim, customs);
      if (f.path === 'platforms.instagram.visibility' && val === 'private') opts.push('private');
      return html`<select id="${id}" name="${f.path}"${invalid(f)}>${opts.map((c) => html`<option value="${c}"${c === val ? rawHtml(' selected') : ''}>${f.path === 'platforms.instagram.visibility' && c === 'private' ? 'Only me (Instagram cannot use this)' : f.path.endsWith('.visibility') ? VIS[c] : (names.get(c) ?? c)}</option>`)}</select>`;
    }
    if (f.kind === 'time') return html`<input id="${id}" type="time" name="${f.path}" value="${val}"${invalid(f)}>`;
    const l = lim[f.path] ?? {};
    const range = `${l.min !== undefined ? ` min="${l.min}"` : ''}${l.max !== undefined ? ` max="${l.max}"` : ''}`;
    return html`<input id="${id}" type="number" name="${f.path}" value="${val}" inputmode="decimal" step="${f.kind === 'int' ? '1' : 'any'}"${rawHtml(range)}${invalid(f)}>`;
  };
  const hintOf = (f: Field, extra = ''): string => {
    const cur = currentValue(f, cfg, o);
    const fd = fileDefault(f, fdPreset, customs);
    const lt = f.kind === 'select' || f.kind === 'bool' ? '' : limitText(lim[f.path]);
    return [extra, f.hint, lt && `Allowed: ${lt}${f.unit ? ` ${f.unit}` : ''}.`, !same(cur, fd) && fd !== undefined && `Default: ${showVal(f, fd, names)}.`].filter(Boolean).join(' ');
  };
  const row = (f: Field, extra = '') => formRow({ id: fid(f.path), label: f.label, control: control(f), unit: f.kind === 'int' || f.kind === 'num' ? f.unit : undefined, hint: hintOf(f, extra), err: errsOf(f) });
  const rows = (s: Sec) => FIELDS.filter((f) => f.sec === s).map((f) => row(f));
  const errLines = (fs: Field[]) => fs.flatMap((f) => errsOf(f).map((m) => html`<span class="err">${f.label}: ${m}</span>`));

  // Post times: one row per daily post, one column per platform. Each cell is its own input with the platform's name.
  const timeFields = FIELDS.filter((f) => f.kind === 'times');
  const nPosts = Math.max(2, ...PLATFORMS.map((p) => (fileRaw.platforms?.[p]?.slots ?? []).length));
  const timeVal = (f: Field, i: number) => (submitted ? (submitted.getAll(f.path)[i] ?? '') : (((currentValue(f, cfg, o) as string[]) ?? [])[i] ?? ''));
  const times = html`<h3>Post times</h3><p class="hint">Each day makes Post 1 and Post 2. Each one goes out to every platform that is on, at the time in its column. Leave Post 2 empty for one post a day.</p>
<div class="scroll"><table class="times"><thead><tr><th scope="col"><span class="vh">Daily post</span></th>${PLATFORMS.map((p) => html`<th scope="col">${PNAME[p]}</th>`)}</tr></thead><tbody>
${Array.from({ length: nPosts }, (_, i) => html`<tr><th scope="row" class="nw">Post ${i + 1}</th>${timeFields.map((f, k) => html`<td data-label="${PNAME[PLATFORMS[k]]}"><label class="vh" for="${fid(f.path)}-${i}">${PNAME[PLATFORMS[k]]}, Post ${i + 1} time</label><input id="${fid(f.path)}-${i}" type="time" name="${f.path}" value="${timeVal(f, i)}"${invalid(f)}></td>`)}</tr>`)}
</tbody></table></div>${errLines(timeFields)}`;

  const where = PLATFORMS.map((p) => {
    const en = fieldOf(`platforms.${p}.enabled`)!;
    const vis = fieldOf(`platforms.${p}.visibility`)!;
    return html`<div class="form-row${errs.has(en.path) || errs.has(vis.path) ? ' has-error' : ''}" role="group" aria-labelledby="g-${p}"><span class="lbl" id="g-${p}">${PNAME[p]}</span><div class="ctl">${control(en)}
<label for="${fid(vis.path)}" class="hint">Who can see posts</label>${control(vis)}${vis.hint ? html`<span class="hint">${vis.hint}</span>` : ''}${errLines([en, vis])}</div></div>`;
  });

  const safeFields = FIELDS.filter((f) => f.sec === 'safe');
  const safe = html`<h3>Text safe zones</h3><p class="hint">Pixels kept clear of each platform's buttons, so captions are not hidden. Allowed: 0 to 960.</p>
<div class="scroll"><table class="safe"><thead><tr><th scope="col">Platform</th>${EDGES.map((e) => html`<th scope="col">${e[0].toUpperCase() + e.slice(1)}</th>`)}</tr></thead><tbody>
${PLATFORMS.map((p) => html`<tr><th scope="row">${PNAME[p]}</th>${EDGES.map((e) => {
    const f = fieldOf(`platforms.${p}.safe.${e}`)!;
    return html`<td><label class="vh" for="${fid(f.path)}">${PNAME[p]}, ${e} (pixels)</label>${control(f)}</td>`;
  })}</tr>`)}
</tbody></table></div>${errLines(safeFields)}`;

  const advOpen = FIELDS.some((f) => ADVANCED.includes(f.sec) && errs.has(f.path));
  const summary: FieldErr[] = [
    ...FIELDS.filter((f) => errs.has(f.path)).flatMap((f) => errsOf(f).map((msg) => ({ id: errId(f), label: f.label, msg }))),
    ...other.map((msg) => ({ msg })),
  ];
  return html`${errSummary(summary)}
<form method="post" action="/settings/preview" novalidate>${csrfField(ctx)}${submitted?.get('note') ? html`<input type="hidden" name="note" value="${submitted.get('note')}">` : ''}<input type="hidden" name="base_id" value="${activeId ?? ''}">
<section class="card" id="when"><h2>When videos go out</h2>${row(fieldOf('produceAt')!, `Time zone: ${cfg.timezone}.`)}${times}</section>
<section class="card" id="where"><h2>Where videos go</h2><p class="hint">Turning every platform off pauses the factory.</p>${where}</section>
<section class="card" id="money"><h2>Spending limits</h2>${rows('money')}</section>
<section class="card" id="look"><h2>Look and sound</h2>${rows('look')}</section>
<details class="card" id="advanced"${advOpen ? rawHtml(' open') : ''}><summary>Advanced</summary>
<h3>AI and video models</h3><p class="hint">Models added on <a href="/models">Video models</a> appear here once they have made a video you posted.</p>${rows('models')}
${safe}
<h3>Housekeeping</h3>${rows('house')}
<details class="plain"><summary>Set in the config file</summary><div class="scroll"><table class="stack"><thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Why it is not here</th></tr></thead><tbody>
${LOCKED.map((l) => html`<tr><td data-label="Setting">${l.label}</td><td data-label="Value"><code>${show(l.value(cfg, dry))}</code></td><td data-label="Why">${l.reason}</td></tr>`)}
</tbody></table></div></details></details>
<div class="sticky-save"><button class="primary" type="submit">Review changes</button><span class="muted">Nothing is saved until you check and confirm.</span></div></form>`;
}

// First local date whose slots are not planned yet.
function firstUnplanned(db: Db, now: Date, tz: string): string {
  const last = (db.prepare("SELECT MAX(local_date) AS d FROM slots WHERE kind = 'planned'").get() as { d: string | null }).d;
  const today = localDateOf(now, tz);
  return last && last >= today ? addDays(last, 1) : today;
}

const TAKES = 'The factory picks up the change within a minute. Videos already being made finish with the old settings.';
function settingsFlash(ctx: Ctx, cfg: Config): Raw | '' {
  if (idOrNull(ctx.query.get('saved')) !== null) return flash('ok', 'Saved.', `${TAKES} New post times start on ${fmtDate(firstUnplanned(ctx.db, ctx.now, cfg.timezone))}.`);
  if (ctx.query.get('ok') === 'file') return flash('ok', 'Back to the defaults.', TAKES);
  if (idOrNull(ctx.query.get('active')) !== null) return flash('ok', 'Earlier settings are in use again.', TAKES);
  return '';
}

export async function settingsPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const { id, o } = activeOverrides(ctx.db);
  return layout(ctx, 'Settings', '/settings', html`${settingsFlash(ctx, cfg)}<p class="muted">Products and the logo are on <a href="/products">Products</a>. Every saved change is kept on <a href="/history">Change history</a>.</p>${settingsForm(ctx, cfg, o, id, null, new Map(), [])}`);
}

// lim: the allowed ranges, so every field is checked in one pass and the owner sees all problems at once.
function parseField(f: Field, form: URLSearchParams, errs: Map<string, string[]>, lim: Record<string, { min?: number; max?: number }> = {}): unknown {
  const v = (form.get(f.path) ?? '').trim();
  const bad = (m: string) => (errs.set(f.path, [m]), undefined);
  switch (f.kind) {
    case 'bool': return form.has(f.path);
    case 'times': {
      // One input per daily post, in order. A comma list in one input is read the same way.
      const all = form.getAll(f.path).map((s) => s.trim());
      if (all.length > 1 && !all[0] && all.slice(1).some(Boolean)) return bad('Fill in Post 1 first.');
      const times = all.flatMap((s) => s.split(/[\s,]+/)).filter(Boolean);
      const most = lim[f.path]?.max;
      if (most !== undefined && times.length > most) return bad(`Use at most ${most} times.`);
      return times;
    }
    case 'int': case 'num': {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n)) return bad('Enter a number.');
      if (f.kind === 'int' && !Number.isInteger(n)) return bad('Enter a whole number.');
      const l = lim[f.path];
      if (l && ((l.min !== undefined && n < l.min) || (l.max !== undefined && n > l.max))) return bad(`Use ${limitText(l)}${f.unit ? ` ${f.unit}` : ''}.`);
      return n;
    }
    default: return v;
  }
}

function draftFrom(form: URLSearchParams, active: Record<string, unknown>, errs: Map<string, string[]>, customs: Customs): Record<string, unknown> {
  const draft = { ...active };
  const preset = form.get('tiers.t2Preset') ?? undefined;
  // The form shows the old preset's caps. Switching preset must not carry them over as overrides of the new one.
  const oldPreset = String(active['tiers.t2Preset'] ?? fileDefault(presetField));
  const lim = limits(fileRaw, preset ?? oldPreset, customs) as Record<string, { min?: number; max?: number }>;
  for (const f of FIELDS) {
    delete draft[f.path];
    // A cap that is still the old preset's value is not checked against the new preset's limit.
    const carried = f.path.startsWith('tiers.t2.') && preset !== undefined && preset !== oldPreset && Number(form.get(f.path)) === fileDefault(f, oldPreset, customs);
    const v = parseField(f, form, errs, carried ? {} : lim);
    if (v !== undefined && !same(v, fileDefault(f, preset, customs)) && !(f.path.startsWith('tiers.t2.') && preset !== oldPreset && same(v, fileDefault(f, oldPreset, customs)))) draft[f.path] = v;
  }
  return draft;
}

function matchErrors(errors: string[], errs: Map<string, string[]>): string[] {
  const other: string[] = [];
  for (const e of errors) {
    const f = FIELDS.find((x) => e.startsWith(x.path) || e.includes(` ${x.path}`) || e.includes(`${x.path}:`));
    if (f) errs.set(f.path, [...(errs.get(f.path) ?? []), e]);
    else other.push(e);
  }
  return other;
}

const newlyPublic = (before: Config, after: Config) => PLATFORMS.filter((p) => after.platforms[p].visibility === 'public' && (before.platforms[p].visibility !== 'public' || (!before.platforms[p].enabled && after.platforms[p].enabled)));

// notice: why the owner is back here (the public-post box was not ticked).
export async function settingsPreview(ctx: Ctx, notice: string | null = null): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const { id, o } = activeOverrides(ctx.db);
  const errs = new Map<string, string[]>();
  const customs = customsOf(ctx.db);
  const draft = draftFrom(ctx.form, o, errs, customs);
  let other: string[] = [];
  let next: Config | null = null;
  if (!errs.size) {
    const r = effectiveConfig(fileRaw, draft, customs);
    if ('errors' in r) other = matchErrors(r.errors, errs);
    else next = r.config;
  }
  if (!next) return { ...layout(ctx, 'Settings', '/settings', settingsForm(ctx, cfg, o, id, ctx.form, errs, other)), status: 422 };

  const paths = [...new Set([...Object.keys(o), ...Object.keys(draft)])].filter((p) => !same(o[p], draft[p])).sort((a, b) => FIELDS.findIndex((f) => f.path === a) - FIELDS.findIndex((f) => f.path === b));
  if (!paths.length) return layout(ctx, 'Settings', '/settings', html`${flash('info', 'No changes.', 'Every value is the same as now.')}<p><a class="btn" href="/settings">Back to Settings</a></p>`);
  const pub = newlyPublic(cfg, next);
  const names = modelNames(ctx.db);
  const preset = String(draft['tiers.t2Preset'] ?? '') || undefined;
  const cell = (p: string, src: Record<string, unknown>) => {
    const f = fieldOf(p);
    return p in src ? showVal(f, src[p], names) : `Default (${f ? showVal(f, fileDefault(f, preset, customs), names) : ''})`;
  };
  const res = layout(ctx, 'Check your changes', '/settings', html`${notice ? errSummary([{ id: 'cp', msg: notice }]) : ''}<p>Nothing is saved until you press <strong>Save changes</strong>.</p>
<div class="scroll"><table class="stack"><thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">New</th></tr></thead><tbody>
${paths.map((p) => html`<tr data-path="${p}"><td data-label="Setting">${labelOf(p)}</td><td data-label="Now">${cell(p, o)}</td><td data-label="New"><strong>${cell(p, draft)}</strong></td></tr>`)}
</tbody></table></div>
<form method="post" action="/settings/save" class="card">${csrfField(ctx)}<input type="hidden" name="base_id" value="${(ctx.form.has('base_id') ? baseOf(ctx.form) : id) ?? ''}"><input type="hidden" name="draft" value="${JSON.stringify(draft)}"><input type="hidden" name="orig" value="${origOf(ctx.form)}">
${pub.length ? html`<div class="form-row"><span class="lbl">Public posts</span><div class="ctl"><label class="check" for="cp"><input id="cp" type="checkbox" name="confirm_public" value="1" required> I understand that ${pub.map((p) => PNAME[p]).join(', ')} will publish posts that anyone can see.</label></div></div>` : ''}
${formRow({ id: 'note', label: 'Note for yourself (optional)', control: html`<input id="note" type="text" name="note" maxlength="200" value="${ctx.form.get('note') ?? ''}">`, hint: 'Shown on Change history, to remember why.' })}
<div class="actions"><button class="primary" type="submit">Save changes</button><button type="submit" formaction="/settings/edit" formnovalidate>Go back and edit</button></div></form>`);
  return notice ? { ...res, status: 422 } : res;
}

// Back to the form with the owner's entries kept (the Go back button of the review page).
export async function settingsEdit(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const { id, o } = activeOverrides(ctx.db);
  const orig = new URLSearchParams(ctx.form.get('orig') ?? '');
  if (ctx.form.get('note')) orig.set('note', ctx.form.get('note')!);
  return layout(ctx, 'Settings', '/settings', settingsForm(ctx, cfg, o, id, orig.size ? orig : null, new Map(), []));
}


// The form as the owner sent it, without the token, so a failed save can show it again.
const origOf = (form: URLSearchParams) => new URLSearchParams([...form].filter(([k]) => k !== 'csrf')).toString();
const baseOf = (form: URLSearchParams) => idOrNull(form.get('base_id') || null);

export async function settingsSave(ctx: Ctx): Promise<Res> {
  const orig = new URLSearchParams(ctx.form.get('orig') ?? '');
  if (ctx.form.get('note')) orig.set('note', ctx.form.get('note')!);
  // Any failure shows the form again with the owner's entries and the reasons inline; nothing is lost.
  let draft: unknown;
  const fail = async (m: string[]): Promise<Res> => {
    const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
    const { id, o } = activeOverrides(ctx.db);
    const errs = new Map<string, string[]>();
    let sub = orig.size ? orig : null;
    if (m.some((e) => /changed since/.test(e))) {
      // Another tab saved first. Fields the owner did not touch show the stored values now; the owner's own edits stay.
      const baseO = overridesById(ctx.db, baseOf(ctx.form));
      const mine = draft && typeof draft === 'object' ? (draft as Record<string, unknown>) : {};
      const theirs = FIELDS.filter((f) => !same(baseO[f.path], o[f.path])).map((f) => f.label);
      m = [`Someone saved Settings in another tab. Check the values below, then save again.${theirs.length ? ` Changed there: ${theirs.slice(0, 5).join(', ')}${theirs.length > 5 ? ` and ${theirs.length - 5} more` : ''}.` : ''}`];
      if (sub) {
        sub = new URLSearchParams(sub);
        for (const f of FIELDS.filter((x) => same(mine[x.path], baseO[x.path]))) {
          const cur = currentValue(f, cfg, o);
          sub.delete(f.path);
          if (f.kind === 'bool') { if (cur === true) sub.append(f.path, '1'); }
          else if (f.kind === 'times') for (const t of (cur as string[]) ?? []) sub.append(f.path, t);
          else sub.append(f.path, String(cur ?? ''));
        }
      }
    }
    const other = matchErrors(m, errs);
    return { ...layout(ctx, 'Settings', '/settings', settingsForm(ctx, cfg, o, id, sub, errs, other)), status: 422 };
  };
  try {
    draft = JSON.parse(ctx.form.get('draft') ?? '');
  } catch {
    return fail(['The draft was not understood. Check the values and press Review changes again.']);
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return fail(['The draft was not understood. Check the values and press Review changes again.']);
  const r = effectiveConfig(fileRaw, draft as Record<string, unknown>, customsOf(ctx.db));
  if ('errors' in r) return fail(r.errors);
  // Another tab saved first: say so before anything else, so a re-render can never carry a stale base forward.
  if (baseOf(ctx.form) !== versionId(ctx.db, 'config_active')) return fail(['the settings changed since you opened them']);
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const pub = newlyPublic(cfg, r.config);
  if (pub.length && ctx.form.get('confirm_public') !== '1') {
    const msg = `Tick the box to confirm that ${pub.map((p) => PNAME[p]).join(', ')} will publish posts anyone can see.`;
    return orig.size ? settingsPreview({ ...ctx, form: orig }, msg) : fail([msg]);
  }
  const prev = versionId(ctx.db, 'config_active');
  const res = saveConfig(ctx.db, draft as Record<string, unknown>, baseOf(ctx.form), (ctx.form.get('note') ?? '').slice(0, 200), ctx.now);
  if ('errors' in res) return fail(res.errors);
  return redirect(`/settings?saved=${res.id}${prev === null ? '' : `&prev=${prev}`}`);
}

// ---------- writing instructions (prompts) ----------

const TEXT_NAME: Record<string, string> = { ugc: 'Video script', hooks: 'Opening lines (ad mode)', script: 'Ad script (ad mode)', copy: 'Captions and titles', video: 'Scene description for the video model', house: 'House style (all writers)' };
const TEXT_USE: Record<string, string> = { ugc: 'Writing what each video shows and says', hooks: 'Ad mode only: the first line of an ad', script: 'Ad mode only: the ad script', copy: 'Checking facts, and writing captions and titles', video: 'What the video model is asked to film', house: 'Added before every writer' };
const LOCKED_PROMPTS: [string, string, string][] = [['claims', 'Claim check', 'Makes sure ads claim only what the product facts say.'], ['copycheck', 'Caption check', 'Checks captions and titles against the product facts.'], ['vision', 'Frame check', 'Compares the video with the product photos; tested with its model (D-28).']];

const productTitle = (db: Db, handle: string): string => (db.prepare('SELECT title FROM products WHERE handle = ?').get(handle) as { title: string } | undefined)?.title ?? handle;
const textName = (db: Db, key: string) => (key.startsWith('note:') ? `Look of ${productTitle(db, key.slice(5))}` : (TEXT_NAME[key] ?? key));
const textUse = (key: string) => (key.startsWith('note:') ? 'How the product looks in the video' : (TEXT_USE[key] ?? ''));
// Product looks belong to Products in the menu and in the way back.
const areaOf = (key: string) => (key.startsWith('note:') ? '/products' : '/prompts');
const inUse = (id: number | null) => (id === null ? 'Built-in' : `Your version ${id}`);

export function promptsPage(ctx: Ctx): Res {
  const links = (key: string) => html`<a href="/prompts/edit?key=${encodeURIComponent(key)}">Edit</a> · <a href="/prompts/history?key=${encodeURIComponent(key)}">History</a>`;
  const hs = handles(ctx.db);
  return layout(ctx, 'Writing instructions', '/prompts', html`${flash('info', 'Most owners never need this page.', html`To describe how a product looks, use <a class="tap" href="/products">Products</a>.`)}
<section><h2>Texts the writers follow</h2><div class="scroll"><table class="stack"><thead><tr><th scope="col">Text</th><th scope="col">Used for</th><th scope="col">In use</th><th scope="col"><span class="vh">Actions</span></th></tr></thead><tbody>
${EDITABLE_TEXT.map((k) => html`<tr><td data-label="Text">${TEXT_NAME[k]}</td><td data-label="Used for">${TEXT_USE[k]}</td><td data-label="In use">${inUse(activeText(ctx.db, k).id)}</td><td class="nw">${links(k)}</td></tr>`)}</tbody></table></div></section>
<section><h2>Product looks</h2>${hs.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">Product</th><th scope="col">In use</th><th scope="col"><span class="vh">Actions</span></th></tr></thead><tbody>${hs.map((h) => html`<tr><td data-label="Product">${productTitle(ctx.db, h)}</td><td data-label="In use">${inUse(activeText(ctx.db, `note:${h}`).id)}</td><td class="nw">${links(`note:${h}`)}</td></tr>`)}</tbody></table></div>` : empty('No products yet.', html`<a class="btn" href="/products">Go to Products</a>`)}</section>
<details class="tech"><summary>Rule checks (read only)</summary><div class="scroll"><table class="stack"><thead><tr><th scope="col">Text</th><th scope="col">What it does</th></tr></thead><tbody>${LOCKED_PROMPTS.map(([k, name, why]) => html`<tr><td data-label="Text"><a href="/prompts/view?key=${k}">${name}</a></td><td data-label="Does">${why}</td></tr>`)}</tbody></table></div></details>`);
}

export function promptView(ctx: Ctx): Res {
  const k = ctx.query.get('key');
  const l = LOCKED_PROMPTS.find(([n]) => n === k);
  if (!l) return notFound(ctx);
  return layout(ctx, `${l[1]} (read only)`, '/prompts', html`<p class="muted">${l[2]}</p><pre>${fileText(l[0])}</pre><p><a href="/prompts">Back to Writing instructions</a></p>`);
}

export function promptEdit(ctx: Ctx, key: string | null = ctx.query.get('key'), body: string | null = null, errors: string[] = []): Res {
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const a = activeText(ctx.db, key);
  const note = key.startsWith('note:');
  return { ...layout(ctx, `Edit: ${textName(ctx.db, key)}`, areaOf(key), html`<p class="muted">Used for: ${textUse(key)}. In use: ${inUse(a.id)}. <a href="/prompts/history?key=${encodeURIComponent(key)}">History</a></p>
${errSummary(errors.map((msg) => ({ id: 'body', msg })))}
<form method="post" action="/prompts/preview">${csrfField(ctx)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="base_id" value="${a.id ?? ''}">
<p class="hint">House style, scene and product look texts are checked: prices, discounts and links are refused, even in an instruction not to use them.</p>
<div class="form-row${errors.length ? ' has-error' : ''}"><label for="body">${note ? 'How it looks (colour, material, shape, what is in the box)' : 'Text'}</label><div class="ctl">${note ? html`<span class="hint">For example: A matte black steel bottle with a screw lid, about 25 cm tall. The box holds the bottle and a cleaning brush.</span>` : ''}<textarea id="body" name="body" rows="${note ? 8 : 24}">${body ?? a.body}</textarea></div></div>
<div class="actions"><button class="primary" type="submit">Preview changes</button><a href="${note ? '/products' : '/prompts'}">Cancel</a></div></form>`), status: errors.length ? 422 : 200 };
}

// Runs saveText's own checks without touching the real tables: a scratch database holds a copy of the briefs.
function validateText(db: Db, key: string, body: string, now: Date): string[] {
  const m = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  try {
    migrate(m);
    const ins = m.prepare('INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?,?,?,?)');
    for (const b of db.prepare('SELECT handle, source_hash, json, built_at FROM briefs').all() as { handle: string; source_hash: string; json: string; built_at: string }[]) ins.run(b.handle, b.source_hash, b.json, b.built_at);
    const r = saveText(m, key, body, null, '', now);
    return 'errors' in r ? r.errors : [];
  } finally {
    m.close();
  }
}

const WRITERS = ['ugc', 'copy', 'hooks', 'script'] as const;

function renderedSystem(db: Db, key: string, draft: string): string | null {
  const purpose = (WRITERS as readonly string[]).includes(key) ? key : key === 'house' ? 'ugc' : null;
  if (!purpose) return null;
  const b = db.prepare('SELECT json FROM briefs ORDER BY built_at DESC LIMIT 1').get() as { json: string } | undefined;
  if (!b) return null;
  try {
    usePrompts({ ...loadPrompts(db), [key]: draft });
    return systemPrompt(purpose as 'ugc', JSON.parse(b.json) as Brief);
  } finally {
    usePrompts({});
  }
}

const diffView = (d: ReturnType<typeof lineDiff>) => html`<div class="diff" aria-label="Changes">${foldDiff(d).map((x) => html`<div class="${x.op === '+' ? 'add' : x.op === '-' ? 'del' : ''}">${x.op} ${x.text}</div>`)}</div>`;

export async function promptPreview(ctx: Ctx): Promise<Res> {
  const key = ctx.form.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const body = ctx.form.get('body') ?? '';
  const errors = validateText(ctx.db, key, body, ctx.now);
  if (errors.length) return promptEdit(ctx, key, body, errors);
  const a = activeText(ctx.db, key);
  const diff = lineDiff(a.body, body);
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const model = key === 'copy' ? cfg.llm.models.copy : cfg.llm.models.script;
  const tokens = Math.ceil(body.length / 4);
  const price = PRICES[model]?.cacheWrite;
  const sys = renderedSystem(ctx.db, key, body);
  const changed = diff.some((d) => d.op !== ' ');
  return layout(ctx, `Review: ${textName(ctx.db, key)}`, areaOf(key), html`<section><h2>Changes against the text in use</h2>${changed ? diffView(diff) : flash('info', 'No changes.', 'The text is the same as the one in use.')}</section>
<section><h2>Text the AI receives</h2>${sys ? html`<pre>${sys}</pre>` : html`<p class="muted">${(WRITERS as readonly string[]).includes(key) || key === 'house' ? 'No product is stored yet, so the full text cannot be shown.' : 'This text is added to another instruction when a video is made; see the changes above.'}</p>`}</section>
<details class="tech"><summary>Technical details</summary><p>About ${tokens} tokens (characters / 4). ${price === undefined ? '' : `The first AI call after a change costs about ${money((tokens * price) / 1e6)} extra at ${model} prices.`}</p></details>
${changed ? html`<form method="post" action="/prompts/save" class="card">${csrfField(ctx)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="base_id" value="${a.id ?? ''}"><input type="hidden" name="body" value="${body}">
${formRow({ id: 'note', label: 'Note for yourself (optional)', control: html`<input id="note" type="text" name="note" maxlength="200">` })}
<div class="actions"><button class="primary" type="submit">Save this text</button><button type="submit" formaction="/prompts/back" formnovalidate>Go back and edit</button></div></form>` : html`<form method="post" action="/prompts/back">${csrfField(ctx)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="body" value="${body}"><button type="submit">Go back and edit</button></form>`}`);
}

// The review page's Go back: the editor again with the typed text.
export function promptBack(ctx: Ctx): Res {
  const key = ctx.form.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  return promptEdit(ctx, key, ctx.form.get('body') ?? '');
}

export function promptSave(ctx: Ctx): Res {
  const key = ctx.form.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const prev = versionId(ctx.db, `text_active:${key}`);
  const r = saveText(ctx.db, key, ctx.form.get('body') ?? '', baseOf(ctx.form), (ctx.form.get('note') ?? '').slice(0, 200), ctx.now);
  if ('errors' in r) return promptEdit(ctx, key, ctx.form.get('body') ?? '', r.errors);
  if (key.startsWith('note:')) return redirect('/products?msg=look');
  return redirect(`/prompts/history?key=${encodeURIComponent(key)}&saved=${r.id}${prev === null ? '' : `&prev=${prev}`}`);
}

export async function promptHistory(ctx: Ctx): Promise<Res> {
  const key = ctx.query.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const a = activeText(ctx.db, key);
  const rows = ctx.db.prepare('SELECT id, sha256, length(body) AS len, created_at, note FROM text_versions WHERE key = ? ORDER BY id DESC LIMIT 100').all(key) as { id: number; sha256: string; len: number; created_at: string; note: string | null }[];
  const view = idOrNull(ctx.query.get('view'));
  const vr = view === null ? undefined : (ctx.db.prepare('SELECT body FROM text_versions WHERE id = ? AND key = ?').get(view, key) as { body: string } | undefined);
  const saved = idOrNull(ctx.query.get('saved'));
  const k = encodeURIComponent(key);
  const act = (id: string, label: string) => html`<form method="post" action="/prompts/activate">${csrfField(ctx)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="id" value="${id}"><button type="submit">${label}</button></form>`;
  return layout(ctx, `History of ${textName(ctx.db, key)}`, areaOf(key), html`${saved !== null ? flash('ok', 'Saved.', 'The writers use it from the next video. A video already being made finishes with the old text.') : ''}
<div class="section-head"><p>In use: <strong>${inUse(a.id)}</strong>.</p><div class="section-actions"><a class="btn" href="/prompts/edit?key=${k}">Edit</a>${a.id === null ? '' : act('', 'Go back to the built-in text')}</div></div>
${vr ? html`<section><h2>Version ${view} compared with the text in use</h2>${diffView(lineDiff(a.body, vr.body))}</section>` : ''}
<section><h2>Saved versions</h2>${rows.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">Version</th><th scope="col">Saved</th><th scope="col">Note</th><th scope="col"><span class="vh">Actions</span></th></tr></thead><tbody>
${rows.map((r) => html`<tr><td data-label="Version">Version ${r.id}${r.id === a.id ? html` ${badge('ok', 'In use')}` : ''}</td><td data-label="Saved">${fmtLocal(r.created_at, cfg.timezone)}</td><td data-label="Note">${r.note}</td><td><a href="/prompts/history?key=${k}&view=${r.id}">Show changes</a> ${r.id === a.id ? '' : act(String(r.id), 'Use this version')}</td></tr>`)}
</tbody></table></div>
<details class="tech"><summary>Technical details</summary><div class="scroll"><table><thead><tr><th scope="col">Version</th><th scope="col">Length</th><th scope="col">sha256</th><th scope="col">Saved (UTC)</th></tr></thead><tbody>${rows.map((r) => html`<tr><td>${r.id}</td><td class="num">${r.len}</td><td><code>${r.sha256.slice(0, 12)}</code></td><td class="nw">${fmtTs(r.created_at)}</td></tr>`)}</tbody></table></div></details>` : empty('No saved versions yet. The built-in text is in use.')}</section>`);
}

export function promptActivate(ctx: Ctx): Res {
  const key = ctx.form.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const id = idOrNull(ctx.form.get('id'));
  if (id !== null && !ctx.db.prepare('SELECT 1 FROM text_versions WHERE id = ? AND key = ?').get(id, key)) return notFound(ctx);
  activateText(ctx.db, key, id, ctx.now);
  return redirect(`/prompts/history?key=${encodeURIComponent(key)}`);
}

// ---------- change history ----------

export async function historyPage(ctx: Ctx): Promise<Res> {
  const active = versionId(ctx.db, 'config_active');
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const tz = cfg.timezone;
  const rows = ctx.db.prepare('SELECT id, created_at, overrides_json, note FROM config_versions ORDER BY id DESC LIMIT 50').all() as { id: number; created_at: string; overrides_json: string; note: string | null }[];
  const view = idOrNull(ctx.query.get('view'));
  const vr = rows.find((r) => r.id === view);
  const page = Math.max(0, Math.min(10_000, idOrNull(ctx.query.get('page')) ?? 0));
  const audits = ctx.db.prepare('SELECT id, ts, actor, action, target, detail_json FROM audit ORDER BY id DESC LIMIT 51 OFFSET ?').all(page * 50) as { id: number; ts: string; actor: string; action: string; target: string; detail_json: string }[];
  const act = (id: string, label: string, cls = '') => html`<form method="post" action="/history/activate">${csrfField(ctx)}<input type="hidden" name="id" value="${id}"><button${cls ? html` class="${cls}"` : ''} type="submit">${label}</button></form>`;
  const parse = (j: string): Record<string, unknown> | null => { try { return JSON.parse(j); } catch { return null; } };
  const changed = (j: string) => {
    const o = parse(j);
    if (!o) return 'unreadable';
    const ls = Object.keys(o).map(labelOf);
    return ls.length > 4 ? `${ls.slice(0, 4).join(', ')} and ${ls.length - 4} more` : ls.join(', ') || 'nothing';
  };
  const overrides = vr ? (parse(vr.overrides_json) ?? {}) : {};
  const names = modelNames(ctx.db);
  return layout(ctx, 'Change history', '/history', html`${settingsFlash(ctx, cfg)}
<section><div class="section-head"><h2>Saved settings</h2><div class="section-actions">${active === null ? '' : confirmRemove('Go back to the defaults…', act('', 'Yes, go back to the defaults', 'danger'), 'Every setting returns to its default. Your saved versions stay listed here.')}</div></div>
<p>In use: <strong>${active === null ? 'the defaults' : `the settings saved ${fmtLocal(rows.find((r) => r.id === active)?.created_at, tz) || `as version ${active}`}`}</strong>.</p>
${vr ? html`<h3>Saved ${fmtLocal(vr.created_at, tz)}, compared with the defaults</h3><div class="scroll"><table class="stack"><thead><tr><th scope="col">Setting</th><th scope="col">Default</th><th scope="col">Value</th></tr></thead><tbody>${Object.entries(overrides).map(([p, v]) => html`<tr data-path="${p}"><td data-label="Setting">${labelOf(p)}</td><td data-label="Default">${showVal(fieldOf(p), getPath(fileRaw, p), names)}</td><td data-label="Value">${showVal(fieldOf(p), v, names)}</td></tr>`)}</tbody></table></div>` : ''}
${rows.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">Saved</th><th scope="col">What changed</th><th scope="col">Note</th><th scope="col"><span class="vh">Actions</span></th></tr></thead><tbody>
${rows.map((r) => html`<tr><td data-label="Saved" class="nw">${fmtLocal(r.created_at, tz) || r.created_at}${r.id === active ? html` ${badge('ok', 'In use')}` : ''}</td><td data-label="Changed">${changed(r.overrides_json)}</td><td data-label="Note">${r.note}</td><td><a href="/history?view=${r.id}">Show</a> ${r.id === active ? '' : act(String(r.id), 'Use this version')}</td></tr>`)}</tbody></table></div>` : empty('No settings saved yet. The defaults are in use.', html`<a class="btn" href="/settings">Go to Settings</a>`)}</section>
<details class="tech"${page > 0 ? rawHtml(' open') : ''}><summary>Full audit log</summary><div class="scroll"><table><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Detail</th></tr></thead><tbody>
${audits.slice(0, 50).map((a) => html`<tr><td class="nw">${fmtTs(a.ts)}</td><td>${a.actor}</td><td>${a.action}</td><td>${a.target}</td><td><code>${a.detail_json}</code></td></tr>`)}</tbody></table></div>
<p>${page > 0 ? html`<a href="/history?page=${page - 1}">Newer</a> ` : ''}${audits.length > 50 ? html`<a href="/history?page=${page + 1}">Older</a>` : ''}</p></details>`);
}

export function historyActivate(ctx: Ctx): Res {
  const id = idOrNull(ctx.form.get('id'));
  if (id !== null && !ctx.db.prepare('SELECT 1 FROM config_versions WHERE id = ?').get(id)) return notFound(ctx);
  const r = activateConfig(ctx.db, id, ctx.now);
  if (r) return { ...layout(ctx, 'Not changed', '/history', html`${errSummary(r.errors.map((msg) => ({ msg })), 'These settings cannot be used.')}<p><a class="btn" href="/history">Back to Change history</a></p>`), status: 422 };
  return redirect(id === null ? '/history?ok=file' : `/history?active=${id}`);
}

// ---------- home ----------

export async function overviewPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const tz = cfg.timezone;
  let st: { dryRun?: boolean; configVersion?: number | string; promptVersions?: Record<string, number>; tickAt?: string } = {};
  try { st = JSON.parse(kvGet(ctx.db, 'pipeline_state') ?? '{}'); } catch { /* none */ }
  const hb = kvGet(ctx.db, 'heartbeat');
  const age = hb ? Math.round((ctx.now.getTime() - Date.parse(hb)) / 1000) : null;
  const paused = autoPaused(ctx.db);
  const next = nextPost(ctx.db, ctx.now, !!paused);
  const attention = (ctx.db.prepare("SELECT COUNT(*) AS n FROM publications WHERE state = 'needs_attention'").get() as { n: number }).n;
  const cv = st.configVersion;
  const refused = typeof cv === 'string' && cv.startsWith('refused');
  const today = localDateOf(ctx.now, tz);
  const made = (ctx.db.prepare("SELECT COUNT(*) AS n FROM slots WHERE local_date = ? AND status IN ('ready','done')").get(today) as { n: number }).n;
  // Posts sent today (the shop's day), the same window as the videos made.
  const posted = (ctx.db.prepare("SELECT published_at FROM publications WHERE state = 'published' AND published_at >= ?").all(new Date(ctx.now.getTime() - 2 * 86_400_000).toISOString()) as { published_at: string }[]).filter((r) => localDateOf(new Date(r.published_at), tz) === today).length;
  const waiting = (ctx.db.prepare("SELECT COUNT(*) AS n FROM slots WHERE hold = 'waiting'").get() as { n: number }).n;
  const llm = monthSpend(ctx.db, ctx.now);
  const clips = monthSpendUsd(ctx.db, 't2', ctx.now);
  const alive = age !== null && age <= 300;
  // A factory that is not running needs the owner too; the headline says so, and the badge only shows when all is running.
  const down = age === null ? 'has not started yet' : !alive ? 'has stopped' : null;
  // Stopped by the owner counts as something to look at, but it is not the factory being down.
  const needs = attention + waiting + (down ? 1 : 0) + (paused ? 1 : 0);
  const headline = down ? `The factory ${down}.` : paused && needs === 1 ? 'Daily posts are stopped.' : needs ? `${needs} thing${needs === 1 ? ' needs' : 's need'} you.` : 'All good.';
  const tile = (cls: string, label: string, value: string, sub: string, href: string) => html`<a class="tile ${cls}" href="${href}"><span class="tile-l">${label}</span><span class="tile-v">${value}</span><span class="tile-s">${sub}</span></a>`;
  return layout(ctx, 'Home', '/overview', html`${st.dryRun ? flash('warn', 'Practice mode is on.', 'Videos are made, and paid clips still cost money, but nothing is posted.') : ''}
${refused ? flash('bad', 'Your saved settings could not be used, so the defaults are running.', html`Open <a href="/history">Change history</a>.`) : ''}
<div class="headline"><p>${headline}</p>${alive ? (paused ? badge('warn', 'Factory running · daily posts stopped') : badge('ok', 'Factory running')) : ''}</div>
${autoControl(ctx, tz)}
<div class="tiles">
${tile(attention || (age !== null && !alive) ? 'bad' : waiting || down || paused ? 'warn' : 'ok', 'Needs you', needs ? String(needs) : 'Nothing', (attention ? `${attention} post${attention === 1 ? '' : 's'} need checking` : down ? `The factory ${down}` : waiting ? `${waiting} video${waiting === 1 ? '' : 's'} waiting for Post it or Discard` : paused ? 'Daily posts stopped' : 'All clear') + (paused && (attention || down || waiting) ? ' · Daily posts stopped' : ''), attention ? '/activity' : waiting ? '/posts' : down ? '/factory' : paused ? '#auto' : '/posts')}
${tile('', 'Next post', next ? fmtLocal(next.scheduled_at, tz) : 'None', next ? (PNAME[next.platform] ?? next.platform) : paused ? 'Daily posts are stopped' : 'Nothing is scheduled', '/activity')}
${tile('', 'Today', `${made} made · ${posted} posted`, 'Videos made, posts sent', '/activity')}
${tile(llm + clips > 0.9 * (cfg.llm.monthlyCapUsd + cfg.tiers.capsUsd.t2) ? 'warn' : '', 'Spent this month', `${money(llm + clips)} of $${cfg.llm.monthlyCapUsd + cfg.tiers.capsUsd.t2}`, `AI writing ${money(llm)} · Video clips ${money(clips)}`, '/activity')}
</div>
<h2>Shortcuts</h2>
<div class="quick">
<a class="qa" href="/posts"><b>Make a video now</b><span>Made right away; you press Post it when you like it.</span></a>
<a class="qa" href="/products"><b>Choose products</b><span>Pick what gets videos and which post they go in.</span></a>
<a class="qa" href="/settings#when"><b>Change post times</b><span>When Post 1 and Post 2 go out.</span></a>
<a class="qa" href="/music"><b>Add music</b><span>Upload tracks the videos may use.</span></a>
<a class="qa" href="/factory"><b>Watch the factory</b><span>See each video move from station to station.</span></a>
</div>
<details class="tech"><summary>Technical details</summary><div class="scroll"><table><tbody>
<tr><th scope="row">Pipeline heartbeat</th><td>${age === null ? 'never' : html`${age} s ago ${age > 300 ? badge('bad', 'stale') : badge('ok', 'alive')}`}</td></tr>
<tr><th scope="row">Settings in use</th><td>${cv === undefined ? 'unknown (no tick since the admin was installed)' : typeof cv === 'number' ? `version ${cv} since ${fmtTs(st.tickAt)}` : cv === 'file' ? `the file${st.tickAt ? ` since ${fmtTs(st.tickAt)}` : ''}` : 'the file (stored settings refused)'}</td></tr>
<tr><th scope="row">Prompt versions in use</th><td>${st.promptVersions && Object.keys(st.promptVersions).length ? Object.entries(st.promptVersions).map(([k, v]) => `${k}: v${v}`).join(', ') : 'files'}</td></tr>
<tr><th scope="row">Next publication</th><td>${next ? `${fmtTs(next.scheduled_at)} (${next.platform}, ${next.slot_id})` : 'none planned'}</td></tr>
<tr><th scope="row">Needs attention</th><td>${attention ? html`${badge('bad', String(attention))} <a href="/activity">See Activity log</a>` : '0'}</td></tr>
<tr><th scope="row">Platforms enabled</th><td>${PLATFORMS.filter((p) => cfg.platforms[p].enabled).map((p) => `${PNAME[p]} (${cfg.platforms[p].visibility})`).join(', ') || 'none: the pipeline is paused'}</td></tr>
</tbody></table></div></details>`);
}

// ---------- stop and start daily posts (D-45) ----------

// The next publication still going out: while stopped, only "Make a video now" videos post.
export function nextPost(db: Db, now: Date, paused: boolean) {
  return db.prepare(`SELECT p.slot_id, p.platform, p.scheduled_at FROM publications p JOIN slots s ON s.id = p.slot_id WHERE p.state = 'pending' AND p.scheduled_at > ?${paused ? " AND s.kind = 'manual'" : ''} ORDER BY p.scheduled_at LIMIT 1`).get(now.toISOString()) as { slot_id: string; platform: string; scheduled_at: string } | undefined;
}

// The on/off control for the daily posts. Home shows it as a card; Videos passes compact.
export function autoControl(ctx: Ctx, tz: string, compact = false): Raw {
  const paused = autoPaused(ctx.db);
  if (paused) {
    const since = fmtLocal(paused.at, tz);
    return html`<div id="auto">${notice('auto-h', `Daily posts are stopped${since ? ` (since ${since})` : ''}.`, html`Post 1 and Post 2 are not made or posted. Make a video now and Post it still work. Posts due while stopped are skipped, not sent later.<div class="actions"><form method="post" action="/auto/start">${csrfField(ctx)}<button class="primary" type="submit">Start daily posts</button></form></div>`)}</div>`;
  }
  const text = 'Stopping skips Post 1 and Post 2 until you start again; skipped posts are not sent later.';
  const form = html`<form method="post" action="/auto/stop">${csrfField(ctx)}<button type="submit">Stop daily posts</button></form>`;
  return compact ? html`<div id="auto" class="actions auto-compact"><span><strong>Daily posts are on.</strong> ${text}</span>${form}</div>` : html`<section id="auto" class="card" aria-labelledby="auto-h"><h2 id="auto-h">Daily posts are on</h2><p>${text}</p><div class="actions">${form}</div></section>`;
}

// Back to the page the button was on, with the flash. `back` is the server's safe same-site path.
const withMsg = (back: string, msg: string): string => {
  const u = new URL(back, 'http://x');
  u.searchParams.set('msg', msg);
  return u.pathname + u.search;
};

export function autoStop(ctx: Ctx, back = '/overview'): Res {
  if (!autoPaused(ctx.db)) {
    kvSet(ctx.db, 'auto_paused', JSON.stringify({ at: ctx.now.toISOString() }));
    audit(ctx.db, 'admin', 'auto.stop', 'auto_paused', {}, ctx.now);
  }
  return redirect(withMsg(back, 'auto-stopped'));
}

export function autoStart(ctx: Ctx, back = '/overview'): Res {
  if (ctx.db.prepare("DELETE FROM kv WHERE key = 'auto_paused'").run().changes) audit(ctx.db, 'admin', 'auto.start', 'auto_paused', {}, ctx.now);
  return redirect(withMsg(back, 'auto-started'));
}

// ---------- activity log ----------

const link = (u: string | null, text?: string) => (u && /^https:\/\//.test(u) ? html`<a href="${u}" rel="noreferrer noopener">${text ?? u}</a>` : (text ? '' : (u ?? '')));
const postName = (kind: string, idx: number) => (kind === 'manual' ? 'Made now' : `Post ${idx}`);

export async function activityPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const tz = cfg.timezone;
  const today = localDateOf(ctx.now, tz);
  const weekAgo = new Date(ctx.now.getTime() - 7 * 86_400_000).toISOString();
  const slots = ctx.db.prepare('SELECT id, status, tier, attempt, error, master_json, updated_at, idx, kind FROM slots WHERE local_date >= ? AND local_date <= ? ORDER BY id DESC').all(addDays(today, -7), addDays(today, 2)) as { id: string; status: string; tier: string | null; attempt: number; error: string | null; master_json: string | null; updated_at: string; idx: number; kind: string }[];
  const caption = (m: string | null) => {
    try { return JSON.parse(m ?? 'null')?.concept?.caption ?? ''; } catch { return ''; }
  };
  type PubRow = { slot_id: string; platform: string; state: string; scheduled_at: string; published_at: string | null; post_url: string | null; error: string | null; idx: number; kind: string; sstatus: string; shold: string | null; title: string | null };
  const pubQ = (where: string, order: string, limit: number, ...a: string[]) => ctx.db.prepare(`SELECT p.slot_id, p.platform, p.state, p.scheduled_at, p.published_at, p.post_url, p.error, s.idx, s.kind, s.status AS sstatus, s.hold AS shold, pr.title FROM publications p JOIN slots s ON s.id = p.slot_id LEFT JOIN products pr ON pr.handle = s.product_handle WHERE ${where} ORDER BY ${order} LIMIT ${limit}`).all(...a) as PubRow[];
  const nowIso = ctx.now.toISOString();
  // Late: due more than 15 minutes ago and not held back for a reason the owner already sees (waiting for Post it, or a "Make a video now" video still being made).
  const lateBefore = new Date(ctx.now.getTime() - 15 * 60_000).toISOString();
  const pending = pubQ("p.state = 'pending'", 'p.scheduled_at', 100);
  const isLate = (p: PubRow) => p.scheduled_at <= lateBefore && p.shold !== 'waiting' && !(p.kind === 'manual' && (p.sstatus === 'planned' || p.sstatus === 'producing'));
  const upcoming = pending.filter((p) => !isLate(p)).slice(0, 10);
  // One row per video, listing its platforms; newest first.
  const lateBy = new Map<string, { p: PubRow; platforms: string[] }>();
  for (const p of pending.filter(isLate).reverse()) {
    const g = lateBy.get(p.slot_id);
    if (g) g.platforms.push(PNAME[p.platform] ?? p.platform);
    else lateBy.set(p.slot_id, { p, platforms: [PNAME[p.platform] ?? p.platform] });
  }
  const late = [...lateBy.values()];
  const paused = !!autoPaused(ctx.db);
  const hb = kvGet(ctx.db, 'heartbeat');
  const factoryUp = !!hb && ctx.now.getTime() - Date.parse(hb) <= 300_000;
  const problems = pubQ("p.state = 'needs_attention'", 'p.scheduled_at DESC', 30);
  const posted = pubQ("p.state = 'published' AND p.published_at >= ?", 'p.published_at DESC', 50, weekAgo);
  // 'paused': not made because the owner stopped daily posts or switched every platform off, which is not a problem.
  const failed = slots.filter((s) => s.status === 'failed' && s.error !== 'paused');
  const pubs = ctx.db.prepare("SELECT slot_id, platform, state, scheduled_at, post_url, error FROM publications ORDER BY (state = 'needs_attention') DESC, scheduled_at DESC LIMIT 60").all() as { slot_id: string; platform: string; state: string; scheduled_at: string; post_url: string | null; error: string | null }[];
  const events = ctx.db.prepare('SELECT ts, kind, key, message, delivered FROM events ORDER BY id DESC LIMIT 50').all() as { ts: string; kind: string; key: string; message: string; delivered: number }[];
  const t2n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM spend WHERE tier = 't2' AND state != 'rejected' AND created_at >= ?").get(new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1)).toISOString()) as { n: number }).n;
  const raw = (e: string | null) => (e ? html`<details><summary>What the system said</summary><code>${e}</code></details>` : '');
  // One list, newest first, whatever kind of problem it is.
  const problemRows = [
  ...problems.map((p) => ({ t: p.scheduled_at, row: html`<tr><td data-label="When" class="nw">${fmtLocal(p.scheduled_at, tz)}</td><td data-label="What">${PNAME[p.platform] ?? p.platform}, ${postName(p.kind, p.idx)}${p.title ? ` (${p.title})` : ''}</td><td data-label="Status">${badge('bad', 'Needs you')}</td><td data-label="To do">Check the post on ${PNAME[p.platform] ?? p.platform}; if it is not there, ask for help. It is never re-posted automatically.${raw(p.error)}</td></tr>` })),
  ...failed.map((s) => ({ t: s.updated_at, row: html`<tr><td data-label="When" class="nw">${fmtLocal(s.updated_at, tz)}</td><td data-label="What">${postName(s.kind, s.idx)} video</td><td data-label="Status">${badge('bad', 'Failed')}</td><td data-label="To do">The video could not be made, so nothing was posted. Nothing to do unless it keeps happening.${raw(s.error)}</td></tr>` })),
  ...late.map(({ p, platforms }) => ({ t: p.scheduled_at, row: html`<tr><td data-label="When" class="nw">${fmtLocal(p.scheduled_at, tz)}</td><td data-label="What">${platforms.join(', ')}, ${postName(p.kind, p.idx)}${p.title ? ` (${p.title})` : ''}</td><td data-label="Status">${badge('warn', 'Late: not sent yet')}</td><td data-label="To do">${paused && p.kind === 'planned' ? html`Held because daily posts are stopped. Start them on <a href="/overview#auto">Home</a>; if it is too late by then, it is skipped, not sent later.` : factoryUp ? html`This post was due and has not gone out. The factory sends it on its next check; if it is still here in an hour, ask for help.` : html`This post was due, and the factory is not running. Start the factory (see <a href="/overview">Home</a>), then ask for help if it is still here.`}</td></tr>` })),
  ].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
  return layout(ctx, 'Activity log', '/activity', html`
<section><h2>Coming up</h2>${paused ? html`<p class="hint">Post 1 and Post 2 below do not go out while daily posts are stopped.</p>` : ''}${upcoming.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">When</th><th scope="col">Platform</th><th scope="col">Post</th><th scope="col">Product</th></tr></thead><tbody>${upcoming.map((p) => html`<tr><td data-label="When" class="nw">${fmtLocal(p.scheduled_at, tz)}</td><td data-label="Platform">${PNAME[p.platform] ?? p.platform}</td><td data-label="Post">${postName(p.kind, p.idx)}</td><td data-label="Product">${p.title ?? ''}</td></tr>`)}</tbody></table></div>` : empty(`Nothing is scheduled yet. Tomorrow's videos are made at ${cfg.produceAt}.`)}</section>
<section><h2>Problems</h2>${problems.length || failed.length || late.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Status</th><th scope="col">What to do</th></tr></thead><tbody>
${problemRows.map((r) => r.row)}
</tbody></table></div>` : empty('No problems this week.')}</section>
<section><h2>Posted</h2>${posted.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">When</th><th scope="col">Platform</th><th scope="col">Post</th></tr></thead><tbody>${posted.map((p) => html`<tr><td data-label="When" class="nw">${fmtLocal(p.published_at, tz)}</td><td data-label="Platform">${PNAME[p.platform] ?? p.platform}</td><td data-label="Post">${link(p.post_url, 'Open post') || postName(p.kind, p.idx)}</td></tr>`)}</tbody></table></div>` : empty('Nothing was posted this week.')}</section>
<section><h2>Spending this month</h2><div class="card"><p>AI writing: <strong>${money(monthSpend(ctx.db, ctx.now))}</strong> of $${cfg.llm.monthlyCapUsd}</p><p>Video clips: <strong>${money(monthSpendUsd(ctx.db, 't2', ctx.now))}</strong> of $${cfg.tiers.capsUsd.t2} (${t2n} clip${t2n === 1 ? '' : 's'})</p></div></section>
<details class="tech"><summary>Technical tables</summary>
<h3>Slots</h3><div class="scroll"><table><thead><tr><th scope="col">Slot</th><th scope="col">Status</th><th scope="col">Tier</th><th scope="col">Attempt</th><th scope="col">Error</th><th scope="col">Caption</th></tr></thead><tbody>${slots.map((s) => html`<tr><td class="nw">${s.id}</td><td>${s.status}</td><td>${s.tier}</td><td>${s.attempt}</td><td>${s.error}</td><td>${caption(s.master_json)}</td></tr>`)}</tbody></table></div>
<h3>Publications</h3><div class="scroll"><table><thead><tr><th scope="col">Slot</th><th scope="col">Platform</th><th scope="col">State</th><th scope="col">Scheduled (UTC)</th><th scope="col">Post</th><th scope="col">Error</th></tr></thead><tbody>${pubs.map((p) => html`<tr><td class="nw">${p.slot_id}</td><td>${p.platform}</td><td>${p.state === 'needs_attention' ? badge('bad', 'needs attention') : p.state}</td><td class="nw">${fmtTs(p.scheduled_at)}</td><td>${link(p.post_url)}</td><td>${p.error}</td></tr>`)}</tbody></table></div>
<h3>Alerts</h3><div class="scroll"><table><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Kind</th><th scope="col">Key</th><th scope="col">Message</th><th scope="col">Delivered</th></tr></thead><tbody>${events.map((e) => html`<tr><td class="nw">${fmtTs(e.ts)}</td><td>${e.kind}</td><td>${e.key}</td><td>${e.message}</td><td>${e.delivered ? 'yes' : 'no'}</td></tr>`)}</tbody></table></div>
<h3>Summary (live)</h3><pre>${buildSummary(ctx.db, cfg, ctx.now)}</pre></details>`);
}
