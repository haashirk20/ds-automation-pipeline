import raw from '../../config/pipeline.config.ts';
import { parseConfig, type Config } from '../config/index.ts';
import { activateConfig, effectiveConfig, limits, loadEffectiveConfig, saveConfig } from '../config/overrides.ts';
import { kvGet, migrate, type Db } from '../db/index.ts';
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

const NAV: [string, string][] = [['/overview', 'Overview'], ['/settings', 'Settings'], ['/posts', 'Posts'], ['/music', 'Music'], ['/models', 'Models'], ['/prompts', 'Prompts'], ['/activity', 'Activity'], ['/history', 'History']];

export function layout(ctx: Ctx | null, title: string, active: string, body: Raw, head: Raw | '' = ''): Res {
  const nav = ctx?.csrf
    ? html`<header class="top"><nav aria-label="Main">${NAV.map(([h, t]) => html`<a href="${h}"${h === active ? rawHtml(' aria-current="page"') : ''}>${t}</a>`)}<form method="post" action="/logout"><input type="hidden" name="csrf" value="${ctx.csrf}"><button class="link" type="submit">Log out</button></form></nav></header>`
    : '';
  return ok(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} - Ad pipeline admin</title><link rel="stylesheet" href="/style.css">${head}</head><body>${nav}<main><h1>${title}</h1>${body}</main></body></html>`);
}

export const csrfField = (ctx: Ctx) => html`<input type="hidden" name="csrf" value="${ctx.csrf}">`;
export const fmtTs = (s: string | null | undefined) => (s ? s.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '');
const json = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

// ---------- login ----------

export function loginPage(msg: string | null, hasPassword: boolean): Res {
  return layout(null, 'Sign in', '', html`<form class="panel login" method="post" action="/login">
${msg ? html`<p class="error-box" role="alert">${msg}</p>` : ''}
${hasPassword ? '' : html`<p class="error-box">No password is set. Run <code>node src/cli.ts admin password</code> first.</p>`}
<div class="field"><label for="u">Username</label><div><input id="u" type="text" name="username" value="admin" readonly autocomplete="username"></div></div>
<div class="field"><label for="p">Password</label><div><input id="p" type="password" name="password" autocomplete="current-password" required autofocus></div></div>
<div class="actions"><button class="primary" type="submit">Sign in</button></div></form>`);
}

// ---------- shared reads ----------

const versionId = (db: Db, key: string): number | null => {
  const v = kvGet(db, key);
  return v ? Number(v) : null;
};

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

type Kind = 'text' | 'int' | 'num' | 'bool' | 'select' | 'times';
type Field = { path: string; label: string; stage: string; kind: Kind; hint?: string };
const PLATFORMS = ['youtube', 'facebook', 'instagram', 'tiktok'] as const;
const PNAME: Record<string, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
const S = ['Schedule and timing', 'Platforms', 'Concept writing', 'Claim checks', 'Video generation', 'Music', 'Frame check', 'Budget', 'Ops'] as const;

const FIELDS: Field[] = [
  { path: 'produceAt', label: 'Produce tomorrow\'s slots at (HH:MM local)', stage: S[0], kind: 'text' },
  ...PLATFORMS.map((p): Field => ({ path: `platforms.${p}.slots`, label: `${PNAME[p]} slot times`, stage: S[0], kind: 'times', hint: 'HH:MM, comma separated. New times apply from the first unplanned day.' })),
  { path: 'ops.summaryAt', label: 'Daily summary at (HH:MM)', stage: S[0], kind: 'text' },
  { path: 'ops.snapshotAt', label: 'Nightly snapshot at (HH:MM)', stage: S[0], kind: 'text' },
  ...PLATFORMS.flatMap((p): Field[] => [
    { path: `platforms.${p}.enabled`, label: `${PNAME[p]}: enabled`, stage: S[1], kind: 'bool', hint: 'Turning every platform off pauses the pipeline.' },
    { path: `platforms.${p}.visibility`, label: `${PNAME[p]}: visibility`, stage: S[1], kind: 'select', hint: p === 'instagram' ? 'Instagram has no private mode.' : undefined },
    ...(['top', 'bottom', 'left', 'right'] as const).map((e): Field => ({ path: `platforms.${p}.safe.${e}`, label: `${PNAME[p]}: safe zone ${e} (px)`, stage: S[1], kind: 'int' })),
  ]),
  { path: 'llm.models.script', label: 'Concept writer model', stage: S[2], kind: 'select', hint: 'Used for ugc; hooks and script in ad mode.' },
  { path: 'ugc.reuseAfterDays', label: 'Reuse a stored clip after (days)', stage: S[2], kind: 'int' },
  { path: 'ugc.captionPx', label: 'Caption size (px)', stage: S[2], kind: 'int' },
  { path: 'llm.models.copy', label: 'Claim judge, copy writer and copy judge model', stage: S[3], kind: 'select' },
  { path: 'tiers.t2Preset', label: 'Clip model preset', stage: S[4], kind: 'select' },
  { path: 'tiers.t2.maxCredits', label: 'Most credits for one clip', stage: S[4], kind: 'num' },
  { path: 'tiers.t2.keepCredits', label: 'Credits to keep in the account', stage: S[4], kind: 'num' },
  { path: 'tiers.capsUsd.t2', label: 'Monthly clip cap (USD)', stage: S[4], kind: 'num' },
  { path: 'tiers.mix.t0', label: 'Share of slots that reuse a stored clip (0 to 1)', stage: S[4], kind: 'num', hint: 'The rest make a new clip (t2). t1 stays 0.' },
  { path: 'tiers.maxJobsPerSlot', label: 'Most paid jobs per slot', stage: S[4], kind: 'int' },
  { path: 'ugc.music.volumeDb', label: 'Music level (dB, relative to the -14 LUFS mix)', stage: S[5], kind: 'num', hint: 'Music is mixed in from the Music page; with no track ticked there is none.' },
  { path: 'ugc.music.duckDb', label: 'Music dip while the spoken line plays (dB)', stage: S[5], kind: 'num' },
  { path: 'llm.models.qa', label: 'Frame check model', stage: S[6], kind: 'select', hint: 'Calibrated on claude-haiku-5-5 at low effort (D-28); other models are unchecked.' },
  { path: 'approval.manualPerDay', label: 'Most Post-button videos a day (0 turns it off)', stage: S[7], kind: 'int', hint: 'More posts a day raise the repetitive-content risk on every platform.' },
  { path: 'llm.monthlyCapUsd', label: 'Monthly model-call cap (USD)', stage: S[7], kind: 'num' },
  { path: 'ops.keepDays', label: 'Keep renders and failed attempts (days)', stage: S[8], kind: 'int' },
  { path: 'ops.diskAlertPercent', label: 'Alert when a disk is fuller than (%)', stage: S[8], kind: 'int' },
];

const LOCKED: { stage: string; label: string; value: (c: Config, dry: boolean) => unknown; reason: string }[] = [
  { stage: S[0], label: 'Time zone', value: (c) => c.timezone, reason: 'Changing it moves every slot; edit the file.' },
  { stage: S[1], label: 'Account handles', value: (c) => PLATFORMS.map((p) => `${p}: ${c.platforms[p].handle}`).join(', '), reason: 'They name real accounts at the bridge; edit the file.' },
  { stage: S[1], label: 'Publishing: lateness, retries, timeouts', value: (c) => c.publish, reason: 'They guard against double posting; edit the file.' },
  { stage: S[1], label: 'Disclosure', value: (c) => c.disclosure, reason: 'A legal label; edit the file.' },
  { stage: S[1], label: 'DRY_RUN', value: (_c, dry) => (dry ? 'on' : 'off'), reason: 'It is an environment value of the pipeline, not a setting.' },
  { stage: S[2], label: 'Creative mode', value: (c) => c.creative.mode, reason: 'It changes the whole production path; edit the file.' },
  { stage: S[2], label: 'Brand', value: (c) => c.brand, reason: 'Brand name and logo; edit the file.' },
  { stage: S[2], label: 'Claim, copy-check and frame-check prompts', value: () => 'claims.md, copycheck.md, vision.md', reason: 'They enforce the advertising rules; see Prompts (read only).' },
  { stage: S[4], label: 'Clip length (seconds)', value: (c) => c.tiers.clipSeconds, reason: 'Tied to the 14 to 16 second rule; edit the file.' },
  { stage: S[4], label: 'Clip model parameters', value: (c) => c.tiers.t2.params, reason: 'Free-form values the clip service interprets; pick a preset instead.' },
  { stage: S[4], label: 'Tier 1 (open-weight clips)', value: (c) => `share ${c.tiers.mix.t1}, cap $${c.tiers.capsUsd.t1}`, reason: 'No provider exists for it yet.' },
  { stage: S[6], label: 'Frame check effort and photo tags', value: () => 'low; config/photo-tags.json', reason: 'Calibrated together with the model; edit the file.' },
  { stage: S[7], label: 'Hold expiry, credit price, custom model ceiling', value: (c) => `${c.approval.expireHours} h, ${c.tiers.usdPerCredit.toFixed(4)} USD per credit, ${c.tiers.customMaxCredits} credits`, reason: 'They guard spend and stale posts; edit the file.' },
  { stage: S[8], label: 'Render timeouts and attempts', value: (c) => c.render, reason: 'Tied to maxJobsPerSlot and the clip timeout; edit the file.' },
  { stage: S[8], label: 'Watchdog (minutes)', value: (c) => c.watchdogMinutes, reason: 'Edit the file.' },
];

function limitText(l: { min?: number; max?: number; choices?: string[]; reason?: string } | undefined): string {
  if (!l) return '';
  const p: string[] = [];
  if (l.min !== undefined && l.max !== undefined) p.push(`${l.min} to ${l.max}`);
  else if (l.max !== undefined) p.push(`≤ ${l.max}`);
  else if (l.min !== undefined) p.push(`≥ ${l.min}`);
  if (l.choices) p.push(`one of ${l.choices.join(', ')}`);
  if (l.reason) p.push(l.reason);
  return p.join('; ');
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

function currentValue(f: Field, cfg: Config, o: Record<string, unknown>): unknown {
  if (f.path === 'tiers.t2Preset') return o[f.path] ?? fileDefault(f);
  return getPath(cfg, f.path);
}

function choicesOf(f: Field, lim: Record<string, any>, customs: Customs): string[] {
  if (f.path === 'tiers.t2Preset') return t2PresetKeys(customs);
  if (f.path.endsWith('.visibility')) return ['public', 'private'];
  if (f.path.startsWith('llm.models.')) return lim[f.path]?.choices ?? Object.keys(PRICES);
  return lim[f.path]?.choices ?? [];
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''));

function settingsForm(ctx: Ctx, cfg: Config, o: Record<string, unknown>, activeId: number | null, submitted: URLSearchParams | null, errs: Map<string, string[]>, other: string[]): Raw {
  const preset = String(o['tiers.t2Preset'] ?? fileDefault(FIELDS.find((x) => x.path === 'tiers.t2Preset')!));
  const customs = customsOf(ctx.db);
  const lim = limits(fileRaw, preset, customs) as Record<string, any>;
  // Custom presets show their name; the value stays 'custom:<id>'.
  const names = new Map((ctx.db.prepare('SELECT id, name FROM video_models').all() as { id: number; name: string }[]).map((r) => [`custom:${r.id}`, `${r.name} (custom)`]));
  const dry = (() => { try { return !!JSON.parse(kvGet(ctx.db, 'pipeline_state') ?? '{}').dryRun; } catch { return false; } })();
  const stages = S.map((st) => {
    const rows = FIELDS.filter((f) => f.stage === st).map((f) => {
      const cur = currentValue(f, cfg, o);
      const val = submitted ? (submitted.get(f.path) ?? '') : f.kind === 'times' ? (cur as string[]).join(', ') : f.kind === 'bool' ? '' : String(cur ?? '');
      const checked = submitted ? submitted.has(f.path) : cur === true;
      const e = errs.get(f.path);
      const id = 'f-' + f.path.replace(/\./g, '-');
      const input =
        f.kind === 'bool'
          ? html`<input id="${id}" type="checkbox" name="${f.path}" value="1"${checked ? rawHtml(' checked') : ''}${e ? rawHtml(' aria-invalid="true"') : ''}>`
          : f.kind === 'select'
            ? html`<select id="${id}" name="${f.path}"${e ? rawHtml(' aria-invalid="true"') : ''}>${choicesOf(f, lim, customs).map((c) => html`<option value="${c}"${c === val ? rawHtml(' selected') : ''}>${names.get(c) ?? c}</option>`)}</select>`
            : html`<input id="${id}" type="text" name="${f.path}" value="${val}" inputmode="${f.kind === 'int' || f.kind === 'num' ? 'decimal' : 'text'}"${e ? rawHtml(' aria-invalid="true"') : ''}>`;
      const fd = fileDefault(f, submitted ? (submitted.get('tiers.t2Preset') ?? preset) : preset, customs);
      const lt = limitText(lim[f.path]);
      return html`<div class="field${e ? ' has-error' : ''}"><label for="${id}">${f.label}</label><div>${input}
<span class="hint">Current: ${show(cur)}. File default: ${show(fd)}.${lt ? ` Limit: ${lt}.` : ''}${f.hint ? ' ' + f.hint : ''}</span>${(e ?? []).map((m) => html`<span class="err" role="alert">${m}</span>`)}</div></div>`;
    });
    const locked = LOCKED.filter((l) => l.stage === st).map((l) => html`<div class="field"><span class="lbl">${l.label}</span><div><code>${show(l.value(cfg, dry))}</code><span class="hint">Read only. ${l.reason}</span></div></div>`);
    return html`<fieldset><legend>${st}</legend>${rows}${locked}</fieldset>`;
  });
  return html`${other.length ? html`<div class="error-box" role="alert"><strong>Not saved.</strong><ul>${other.map((m) => html`<li>${m}</li>`)}</ul></div>` : ''}
<form method="post" action="/settings/preview">${csrfField(ctx)}<input type="hidden" name="base_id" value="${activeId ?? ''}">${stages}
<div class="actions"><button class="primary" type="submit">Review changes</button></div></form>`;
}

// First local date whose slots are not planned yet.
function firstUnplanned(db: Db, now: Date, tz: string): string {
  const last = (db.prepare("SELECT MAX(local_date) AS d FROM slots WHERE kind = 'planned'").get() as { d: string | null }).d;
  const today = localDateOf(now, tz);
  return last && last >= today ? addDays(last, 1) : today;
}

function flash(ctx: Ctx, cfg: Config): Raw | '' {
  const saved = idOrNull(ctx.query.get('saved'));
  if (saved !== null) {
    const prev = idOrNull(ctx.query.get('prev'));
    return html`<p class="notice" role="status">Saved as v${saved}. Takes effect at the next tick (within 1 minute). A slot in production finishes on ${prev === null ? 'the file settings' : `v${prev}`}. New slot times apply from ${firstUnplanned(ctx.db, ctx.now, cfg.timezone)}.</p>`;
  }
  const m = ctx.query.get('ok');
  if (m === 'file') return html`<p class="notice" role="status">Now using the file settings. Takes effect at the next tick.</p>`;
  const act = idOrNull(ctx.query.get('active'));
  if (act !== null) return html`<p class="notice" role="status">Version ${act} is active. Takes effect at the next tick.</p>`;
  return '';
}

export async function settingsPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const { id, o } = activeOverrides(ctx.db);
  return layout(ctx, 'Settings', '/settings', html`${flash(ctx, cfg)}<p class="muted">Changes are saved as versions and take effect at the next tick. The file holds defaults and ceilings. Product notes and prompt texts are on the <a href="/prompts">Prompts</a> page.</p>${settingsForm(ctx, cfg, o, id, null, new Map(), [])}`);
}

function parseField(f: Field, form: URLSearchParams, errs: Map<string, string[]>): unknown {
  const v = (form.get(f.path) ?? '').trim();
  const bad = (m: string) => (errs.set(f.path, [m]), undefined);
  switch (f.kind) {
    case 'bool': return form.has(f.path);
    case 'times': return v.split(/[\s,]+/).filter(Boolean);
    case 'int': case 'num': {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n)) return bad('must be a number');
      if (f.kind === 'int' && !Number.isInteger(n)) return bad('must be a whole number');
      return n;
    }
    default: return v;
  }
}

function draftFrom(form: URLSearchParams, active: Record<string, unknown>, errs: Map<string, string[]>, customs: Customs): Record<string, unknown> {
  const draft = { ...active };
  const preset = form.get('tiers.t2Preset') ?? undefined;
  // The form shows the old preset's caps. Switching preset must not carry them over as overrides of the new one.
  const oldPreset = String(active['tiers.t2Preset'] ?? fileDefault(FIELDS.find((x) => x.path === 'tiers.t2Preset')!));
  for (const f of FIELDS) {
    delete draft[f.path];
    const v = parseField(f, form, errs);
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

export async function settingsPreview(ctx: Ctx): Promise<Res> {
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

  const paths = [...new Set([...Object.keys(o), ...Object.keys(draft)])].filter((p) => !same(o[p], draft[p])).sort();
  if (!paths.length) return layout(ctx, 'Settings', '/settings', html`<p class="notice">No changes.</p><p><a href="/settings">Back to settings</a></p>`);
  const pub = newlyPublic(cfg, next);
  return layout(ctx, 'Review changes', '/settings', html`<p>These values change. Nothing is saved until you press the button.</p>
<div class="scroll"><table><thead><tr><th>Setting</th><th>File default</th><th>Now</th><th>New</th></tr></thead><tbody>
${paths.map((p) => html`<tr><td><code>${p}</code></td><td>${show(fileDefault(FIELDS.find((f) => f.path === p)!, String(draft['tiers.t2Preset'] ?? '') || undefined, customs))}</td><td>${p in o ? show(o[p]) : 'file'}</td><td>${p in draft ? show(draft[p]) : 'file'}</td></tr>`)}
</tbody></table></div>
<form method="post" action="/settings/save">${csrfField(ctx)}<input type="hidden" name="base_id" value="${id ?? ''}"><input type="hidden" name="draft" value="${JSON.stringify(draft)}">
${pub.length ? html`<div class="field"><label for="cp">Confirm public posting</label><div><input id="cp" type="checkbox" name="confirm_public" value="1"> I understand that ${pub.map((p) => PNAME[p]).join(', ')} will publish posts that anyone can see.</div></div>` : ''}
<div class="field"><label for="note">Note (optional)</label><div><input id="note" type="text" name="note" maxlength="200"></div></div>
<div class="actions"><button class="primary" type="submit">Save as version ${(db_nextId(ctx.db, 'config_versions'))}</button><a href="/settings">Cancel</a></div></form>`);
}

const db_nextId = (db: Db, table: string): number => ((db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`).get() as { n: number }).n);

const baseOf = (form: URLSearchParams) => idOrNull(form.get('base_id') || null);

export async function settingsSave(ctx: Ctx): Promise<Res> {
  const fail = (m: string[]): Res => ({ ...layout(ctx, 'Not saved', '/settings', html`<div class="error-box" role="alert"><ul>${m.map((x) => html`<li>${x}</li>`)}</ul></div><p><a href="/settings">Back to settings</a></p>`), status: 422 });
  let draft: unknown;
  try {
    draft = JSON.parse(ctx.form.get('draft') ?? '');
  } catch {
    return fail(['The draft was not understood. Start again from Settings.']);
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return fail(['The draft was not understood. Start again from Settings.']);
  const r = effectiveConfig(fileRaw, draft as Record<string, unknown>, customsOf(ctx.db));
  if ('errors' in r) return fail(r.errors);
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const pub = newlyPublic(cfg, r.config);
  if (pub.length && ctx.form.get('confirm_public') !== '1') return fail([`Tick the confirmation to make ${pub.map((p) => PNAME[p]).join(', ')} public.`]);
  const prev = versionId(ctx.db, 'config_active');
  const res = saveConfig(ctx.db, draft as Record<string, unknown>, baseOf(ctx.form), (ctx.form.get('note') ?? '').slice(0, 200), ctx.now);
  if ('errors' in res) return fail(res.errors);
  return redirect(`/settings?saved=${res.id}${prev === null ? '' : `&prev=${prev}`}`);
}

// ---------- prompts ----------

const TEXT_STAGE: Record<string, string> = { ugc: 'Concept writing', hooks: 'Concept writing (ad mode)', script: 'Concept writing (ad mode)', copy: 'Claim checks', video: 'Video generation', house: 'All writers' };
const LOCKED_PROMPTS: [string, string][] = [['claims', 'Enforces that ad claims come from the brief.'], ['copycheck', 'Judges the copy against the brief.'], ['vision', 'Frame check; calibrated with its model (D-28).']];

export function promptsPage(ctx: Ctx): Res {
  const text = (key: string, label: string, stage: string) => {
    const a = activeText(ctx.db, key);
    return html`<tr><td><a href="/prompts/edit?key=${encodeURIComponent(key)}">${label}</a></td><td>${stage}</td><td>${a.id === null ? 'file' : `v${a.id}`}</td><td><a href="/prompts/history?key=${encodeURIComponent(key)}">History</a></td></tr>`;
  };
  return layout(ctx, 'Prompts', '/prompts', html`<h2>Editable texts</h2><div class="scroll"><table><thead><tr><th>Text</th><th>Stage</th><th>Active</th><th></th></tr></thead><tbody>${EDITABLE_TEXT.filter((k) => !k.startsWith('note:')).map((k) => text(k, k, TEXT_STAGE[k] ?? ''))}</tbody></table></div>
<h2>Product notes</h2>${handles(ctx.db).length ? html`<div class="scroll"><table><thead><tr><th>Product</th><th>Stage</th><th>Active</th><th></th></tr></thead><tbody>${handles(ctx.db).map((h) => text(`note:${h}`, h, 'Concept writing'))}</tbody></table></div>` : html`<p class="muted">No products stored yet.</p>`}
<h2>Read only</h2><div class="scroll"><table><thead><tr><th>Text</th><th>Why locked</th></tr></thead><tbody>${LOCKED_PROMPTS.map(([k, why]) => html`<tr><td><a href="/prompts/view?key=${k}">${k}</a></td><td>${why}</td></tr>`)}</tbody></table></div>`);
}

export function promptView(ctx: Ctx): Res {
  const k = ctx.query.get('key');
  const l = LOCKED_PROMPTS.find(([n]) => n === k);
  if (!l) return notFound(ctx);
  return layout(ctx, `${l[0]} (read only)`, '/prompts', html`<p class="muted">${l[1]}</p><pre>${fileText(l[0])}</pre><p><a href="/prompts">Back to prompts</a></p>`);
}

export const notFound = (ctx: Ctx | null): Res => ({ ...layout(ctx, 'Not found', '', html`<p>No such page.</p>`), status: 404 });

export function promptEdit(ctx: Ctx, key: string | null = ctx.query.get('key'), body: string | null = null, errors: string[] = []): Res {
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const a = activeText(ctx.db, key);
  return { ...layout(ctx, `Edit ${key}`, '/prompts', html`<p class="muted">Stage: ${key.startsWith('note:') ? 'Concept writing' : TEXT_STAGE[key]}. Active: ${a.id === null ? 'file' : `v${a.id}`}. <a href="/prompts/history?key=${encodeURIComponent(key)}">History</a></p>
${errors.length ? html`<div class="error-box" role="alert"><ul>${errors.map((m) => html`<li>${m}</li>`)}</ul></div>` : ''}
<form method="post" action="/prompts/preview">${csrfField(ctx)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="base_id" value="${a.id ?? ''}">
<p class="muted">House, video and note texts are checked: prices, discounts and links are refused, even in an instruction not to use them.</p>
<div class="field${errors.length ? ' has-error' : ''}"><label for="body">Text</label><div><textarea id="body" name="body" rows="24">${body ?? a.body}</textarea></div></div>
<div class="actions"><button class="primary" type="submit">Preview</button><a href="/prompts">Cancel</a></div></form>`), status: errors.length ? 422 : 200 };
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
  return layout(ctx, `Review ${key}`, '/prompts', html`<p>About ${tokens} tokens (characters / 4). ${price === undefined ? '' : `First call after a change writes the prompt cache at ${model} price: about $${((tokens * price) / 1e6).toFixed(4)}.`}</p>
<h2>Changes against the active text</h2>${changed ? html`<div class="diff panel" aria-label="Diff">${foldDiff(diff).map((d) => html`<div class="${d.op === '+' ? 'add' : d.op === '-' ? 'del' : ''}">${d.op} ${d.text}</div>`)}</div>` : html`<p class="notice">No changes.</p>`}
<h2>Text the model receives</h2>${sys ? html`<pre>${sys}</pre>` : html`<p class="muted">${(WRITERS as readonly string[]).includes(key) || key === 'house' ? 'No product brief is stored yet, so the full text cannot be shown.' : 'This text is added to another prompt at run time; see the diff above.'}</p>`}
${changed ? html`<form method="post" action="/prompts/save">${csrfField(ctx)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="base_id" value="${a.id ?? ''}"><input type="hidden" name="body" value="${body}">
<div class="field"><label for="note">Note (optional)</label><div><input id="note" type="text" name="note" maxlength="200"></div></div>
<div class="actions"><button class="primary" type="submit">Save as version ${db_nextId(ctx.db, 'text_versions')}</button><a href="/prompts">Cancel</a></div></form>` : ''}`);
}

export function promptSave(ctx: Ctx): Res {
  const key = ctx.form.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const prev = versionId(ctx.db, `text_active:${key}`);
  const r = saveText(ctx.db, key, ctx.form.get('body') ?? '', baseOf(ctx.form), (ctx.form.get('note') ?? '').slice(0, 200), ctx.now);
  if ('errors' in r) return promptEdit(ctx, key, ctx.form.get('body') ?? '', r.errors);
  return redirect(`/prompts/history?key=${encodeURIComponent(key)}&saved=${r.id}${prev === null ? '' : `&prev=${prev}`}`);
}

export function promptHistory(ctx: Ctx): Res {
  const key = ctx.query.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const a = activeText(ctx.db, key);
  const rows = ctx.db.prepare('SELECT id, sha256, length(body) AS len, created_at, note FROM text_versions WHERE key = ? ORDER BY id DESC LIMIT 100').all(key) as { id: number; sha256: string; len: number; created_at: string; note: string | null }[];
  const view = idOrNull(ctx.query.get('view'));
  const vr = view === null ? undefined : (ctx.db.prepare('SELECT body FROM text_versions WHERE id = ? AND key = ?').get(view, key) as { body: string } | undefined);
  const saved = idOrNull(ctx.query.get('saved'));
  const prev = idOrNull(ctx.query.get('prev'));
  const act = (id: string, label: string) => html`<form method="post" action="/prompts/activate">${csrfField(ctx)}<input type="hidden" name="key" value="${key}"><input type="hidden" name="id" value="${id}"><button type="submit">${label}</button></form>`;
  return layout(ctx, `History of ${key}`, '/prompts', html`${saved !== null ? html`<p class="notice" role="status">Saved as v${saved}. Takes effect at the next tick (within 1 minute). A slot in production finishes on ${prev === null ? 'the file text' : `v${prev}`}.</p>` : ''}
<p>Active: ${a.id === null ? 'the file' : `v${a.id}`}. <a href="/prompts/edit?key=${encodeURIComponent(key)}">Edit</a></p>
<div class="actions">${act('', 'Use file')}</div>
${vr ? html`<h2>Version ${view} against the active text</h2><div class="diff panel">${foldDiff(lineDiff(a.body, vr.body)).map((d) => html`<div class="${d.op === '+' ? 'add' : d.op === '-' ? 'del' : ''}">${d.op} ${d.text}</div>`)}</div>` : ''}
<h2>Versions</h2><div class="scroll"><table><thead><tr><th>Version</th><th>Saved</th><th>Length</th><th>sha256</th><th>Note</th><th></th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>v${r.id}${r.id === a.id ? html` <span class="tag ok">active</span>` : ''}</td><td>${fmtTs(r.created_at)}</td><td>${r.len}</td><td><code>${r.sha256.slice(0, 12)}</code></td><td>${r.note}</td><td><a href="/prompts/history?key=${encodeURIComponent(key)}&view=${r.id}">Diff</a> ${r.id === a.id ? '' : act(String(r.id), 'Activate')}</td></tr>`)}
</tbody></table></div>`);
}

export function promptActivate(ctx: Ctx): Res {
  const key = ctx.form.get('key');
  if (!validKey(ctx.db, key)) return notFound(ctx);
  const id = idOrNull(ctx.form.get('id'));
  if (id !== null && !ctx.db.prepare('SELECT 1 FROM text_versions WHERE id = ? AND key = ?').get(id, key)) return notFound(ctx);
  activateText(ctx.db, key, id, ctx.now);
  return redirect(`/prompts/history?key=${encodeURIComponent(key)}`);
}

// ---------- history ----------

export async function historyPage(ctx: Ctx): Promise<Res> {
  const active = versionId(ctx.db, 'config_active');
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const rows = ctx.db.prepare('SELECT id, created_at, overrides_json, note FROM config_versions ORDER BY id DESC LIMIT 50').all() as { id: number; created_at: string; overrides_json: string; note: string | null }[];
  const view = idOrNull(ctx.query.get('view'));
  const vr = rows.find((r) => r.id === view);
  const page = Math.max(0, Math.min(10_000, idOrNull(ctx.query.get('page')) ?? 0));
  const audits = ctx.db.prepare('SELECT id, ts, actor, action, target, detail_json FROM audit ORDER BY id DESC LIMIT 51 OFFSET ?').all(page * 50) as { id: number; ts: string; actor: string; action: string; target: string; detail_json: string }[];
  const act = (id: string, label: string) => html`<form method="post" action="/history/activate">${csrfField(ctx)}<input type="hidden" name="id" value="${id}"><button type="submit">${label}</button></form>`;
  let overrides: Record<string, unknown> = {};
  try { overrides = vr ? JSON.parse(vr.overrides_json) : {}; } catch { /* shown empty */ }
  return layout(ctx, 'History', '/history', html`${flash(ctx, cfg)}
<h2>Settings versions</h2><p>Active: ${active === null ? 'the file' : `v${active}`}. ${active === null ? '' : act('', 'Use file')}</p>
${vr ? html`<h3>Version ${vr.id} against the file</h3><div class="scroll"><table><thead><tr><th>Setting</th><th>File default</th><th>Value</th></tr></thead><tbody>${Object.entries(overrides).map(([p, v]) => html`<tr><td><code>${p}</code></td><td>${show(getPath(fileRaw, p))}</td><td>${show(v)}</td></tr>`)}</tbody></table></div>` : ''}
<div class="scroll"><table><thead><tr><th>Version</th><th>Saved</th><th>Changed settings</th><th>Note</th><th></th></tr></thead><tbody>
${rows.map((r) => {
  let n = 0;
  try { n = Object.keys(JSON.parse(r.overrides_json)).length; } catch { /* corrupt */ }
  return html`<tr><td>v${r.id}${r.id === active ? html` <span class="tag ok">active</span>` : ''}</td><td>${fmtTs(r.created_at)}</td><td>${n}</td><td>${r.note}</td><td><a href="/history?view=${r.id}">Show</a> ${r.id === active ? '' : act(String(r.id), 'Activate')}</td></tr>`;
})}</tbody></table></div>
<h2>Audit log</h2><div class="scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
${audits.slice(0, 50).map((a) => html`<tr><td>${fmtTs(a.ts)}</td><td>${a.actor}</td><td>${a.action}</td><td>${a.target}</td><td><code>${a.detail_json}</code></td></tr>`)}</tbody></table></div>
<p>${page > 0 ? html`<a href="/history?page=${page - 1}">Newer</a> ` : ''}${audits.length > 50 ? html`<a href="/history?page=${page + 1}">Older</a>` : ''}</p>`);
}

export function historyActivate(ctx: Ctx): Res {
  const id = idOrNull(ctx.form.get('id'));
  if (id !== null && !ctx.db.prepare('SELECT 1 FROM config_versions WHERE id = ?').get(id)) return notFound(ctx);
  const r = activateConfig(ctx.db, id, ctx.now);
  if (r) return { ...layout(ctx, 'Not activated', '/history', html`<div class="error-box" role="alert"><ul>${r.errors.map((x) => html`<li>${x}</li>`)}</ul></div><p><a href="/history">Back to history</a></p>`), status: 422 };
  return redirect(id === null ? '/history?ok=file' : `/history?active=${id}`);
}

// ---------- overview ----------

export async function overviewPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  let st: { dryRun?: boolean; configVersion?: number | string; promptVersions?: Record<string, number>; tickAt?: string } = {};
  try { st = JSON.parse(kvGet(ctx.db, 'pipeline_state') ?? '{}'); } catch { /* none */ }
  const hb = kvGet(ctx.db, 'heartbeat');
  const age = hb ? Math.round((ctx.now.getTime() - Date.parse(hb)) / 1000) : null;
  const next = ctx.db.prepare("SELECT slot_id, platform, scheduled_at FROM publications WHERE state = 'pending' AND scheduled_at > ? ORDER BY scheduled_at LIMIT 1").get(ctx.now.toISOString()) as { slot_id: string; platform: string; scheduled_at: string } | undefined;
  const attention = (ctx.db.prepare("SELECT COUNT(*) AS n FROM publications WHERE state = 'needs_attention'").get() as { n: number }).n;
  const cv = st.configVersion;
  const refused = typeof cv === 'string' && cv.startsWith('refused');
  return layout(ctx, 'Overview', '/overview', html`${st.dryRun ? html`<p class="banner">DRY_RUN is on: the pipeline publishes nothing.</p>` : ''}
${refused ? html`<p class="error-box" role="alert">The stored settings were refused and the file is in use: ${cv}</p>` : ''}
<div class="panel"><table><tbody>
<tr><th scope="row">Pipeline heartbeat</th><td>${age === null ? 'never' : html`${age} s ago ${age > 300 ? html`<span class="tag bad">stale</span>` : html`<span class="tag ok">alive</span>`}`}</td></tr>
<tr><th scope="row">Settings in use</th><td>${cv === undefined ? 'unknown (no tick since the admin was installed)' : typeof cv === 'number' ? `version ${cv} since ${fmtTs(st.tickAt)}` : cv === 'file' ? `the file${st.tickAt ? ` since ${fmtTs(st.tickAt)}` : ''}` : 'the file (stored settings refused)'}</td></tr>
<tr><th scope="row">Prompt versions in use</th><td>${st.promptVersions && Object.keys(st.promptVersions).length ? Object.entries(st.promptVersions).map(([k, v]) => `${k}: v${v}`).join(', ') : 'files'}</td></tr>
<tr><th scope="row">Next publication</th><td>${next ? `${fmtTs(next.scheduled_at)} (${next.platform}, ${next.slot_id})` : 'none planned'}</td></tr>
<tr><th scope="row">Needs attention</th><td>${attention ? html`<span class="tag bad">${attention}</span> <a href="/activity">See Activity</a>` : '0'}</td></tr>
<tr><th scope="row">Platforms enabled</th><td>${PLATFORMS.filter((p) => cfg.platforms[p].enabled).map((p) => `${PNAME[p]} (${cfg.platforms[p].visibility})`).join(', ') || 'none: the pipeline is paused'}</td></tr>
</tbody></table></div>`);
}

// ---------- activity ----------

const link = (u: string | null) => (u && /^https:\/\//.test(u) ? html`<a href="${u}" rel="noreferrer noopener">${u}</a>` : (u ?? ''));

export async function activityPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const today = localDateOf(ctx.now, cfg.timezone);
  const slots = ctx.db.prepare('SELECT id, status, tier, attempt, error, master_json FROM slots WHERE local_date >= ? AND local_date <= ? ORDER BY id DESC').all(addDays(today, -7), addDays(today, 2)) as { id: string; status: string; tier: string | null; attempt: number; error: string | null; master_json: string | null }[];
  const caption = (m: string | null) => {
    try { return JSON.parse(m ?? 'null')?.concept?.caption ?? ''; } catch { return ''; }
  };
  const pubs = ctx.db.prepare("SELECT slot_id, platform, state, scheduled_at, post_url, error FROM publications ORDER BY (state = 'needs_attention') DESC, scheduled_at DESC LIMIT 60").all() as { slot_id: string; platform: string; state: string; scheduled_at: string; post_url: string | null; error: string | null }[];
  const events = ctx.db.prepare('SELECT ts, kind, key, message, delivered FROM events ORDER BY id DESC LIMIT 50').all() as { ts: string; kind: string; key: string; message: string; delivered: number }[];
  const t2n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM spend WHERE tier = 't2' AND state != 'rejected' AND created_at >= ?").get(new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1)).toISOString()) as { n: number }).n;
  return layout(ctx, 'Activity', '/activity', html`
<h2>Slots</h2><div class="scroll"><table><thead><tr><th>Slot</th><th>Status</th><th>Tier</th><th>Attempt</th><th>Error</th><th>Caption</th></tr></thead><tbody>${slots.map((s) => html`<tr><td>${s.id}</td><td>${s.status}</td><td>${s.tier}</td><td>${s.attempt}</td><td>${s.error}</td><td>${caption(s.master_json)}</td></tr>`)}</tbody></table></div>
<h2>Publications</h2><div class="scroll"><table><thead><tr><th>Slot</th><th>Platform</th><th>State</th><th>Scheduled</th><th>Post</th><th>Error</th></tr></thead><tbody>${pubs.map((p) => html`<tr><td>${p.slot_id}</td><td>${p.platform}</td><td>${p.state === 'needs_attention' ? html`<span class="tag bad">needs attention</span>` : p.state}</td><td>${fmtTs(p.scheduled_at)}</td><td>${link(p.post_url)}</td><td>${p.error}</td></tr>`)}</tbody></table></div>
<h2>Spend this month</h2><div class="scroll"><table><tbody>
<tr><th scope="row">Model calls</th><td>$${monthSpend(ctx.db, ctx.now).toFixed(2)} of $${cfg.llm.monthlyCapUsd}</td></tr>
<tr><th scope="row">Clips (t2)</th><td>$${monthSpendUsd(ctx.db, 't2', ctx.now).toFixed(2)} of $${cfg.tiers.capsUsd.t2}, ${t2n} job(s)</td></tr></tbody></table></div>
<h2>Alerts</h2><div class="scroll"><table><thead><tr><th>Time</th><th>Kind</th><th>Key</th><th>Message</th><th>Delivered</th></tr></thead><tbody>${events.map((e) => html`<tr><td>${fmtTs(e.ts)}</td><td>${e.kind}</td><td>${e.key}</td><td>${e.message}</td><td>${e.delivered ? 'yes' : 'no'}</td></tr>`)}</tbody></table></div>
<h2>Summary (live)</h2><pre>${buildSummary(ctx.db, cfg, ctx.now)}</pre>`);
}
