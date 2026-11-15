// The file holds the defaults and the ceilings. The admin page stores sparse overrides (dotted path -> value) in
// the database; every load merges them into the file object and runs the same schema and the same guard rules.
import { kvGet, type Db } from '../db/index.ts';
import raw from '../../config/pipeline.config.ts';
import { PRICES } from '../llm/client.ts';
import { alert } from '../ops/alert.ts';
import { loadRaw, parseConfig, type Config } from './index.ts';
import { loadCustomModels, type TierDef } from './models.ts';

type Obj = Record<string, any>;
export type Limit = { min?: number; max?: number; choices?: unknown[]; reason?: string };

const PLATFORMS = ['youtube', 'facebook', 'instagram', 'tiktok'];
export const EDITABLE: readonly string[] = [
  'produceAt', 'ops.summaryAt', 'ops.snapshotAt', 'ops.keepDays', 'ops.diskAlertPercent',
  'llm.models.script', 'llm.models.copy', 'llm.models.qa', 'llm.monthlyCapUsd',
  'ugc.reuseAfterDays', 'ugc.captionPx', 'ugc.music.volumeDb', 'ugc.music.duckDb', 'approval.manualPerDay',
  'tiers.t2Preset', 'tiers.t2.maxCredits', 'tiers.t2.keepCredits', 'tiers.capsUsd.t2', 'tiers.mix.t0', 'tiers.maxJobsPerSlot',
  ...PLATFORMS.flatMap((p) => [`platforms.${p}.enabled`, `platforms.${p}.visibility`, `platforms.${p}.slots`, ...['top', 'bottom', 'left', 'right'].map((e) => `platforms.${p}.safe.${e}`)]),
];

const LOCKED: [string, string][] = [
  ['prompts.claims', 'The claim judge is a safety check.'], ['prompts.copycheck', 'The copy judge is a safety check.'], ['prompts.vision', 'The frame check is calibrated on its prompt.'],
  ['publish', 'Retry and timeout rules keep posts from doubling.'], ['disclosure', 'AI disclosure follows the platform rules.'], ['DRY_RUN', 'Set in the environment.'],
  ['timezone', 'Slot times and the database use it.'], ['render', 'The timeouts are tied to the video job limits.'], ['watchdogMinutes', 'Tied to the tick length.'],
  ['creative.mode', 'Changes the whole pipeline.'], ['tiers.clipSeconds', 'Tied to the concept and the model.'], ['tiers.t2.params', 'Free-form model parameters are not checked.'],
  ['tiers.t1', 'No provider exists for it.'], ['tiers.capsUsd.t1', 'No provider exists for it.'], ['brand', 'Brand name and logo are set in the file.'],
  ['approval.expireHours', 'Held clips are paid for; the expiry is set in the file.'], ['tiers.usdPerCredit', 'The plan price per credit is set in the file.'], ['tiers.customMaxCredits', 'The ceiling for added models is set in the file.'],
  ['photo-tags.json', 'Set in the file.'], ...PLATFORMS.map((p): [string, string] => [`platforms.${p}.handle`, 'The account name at the bridge.']),
];

// What each editable field accepts, from the file. `preset`: the t2 preset being edited (its limits replace the file's t2); a
// custom model's own limits come from `customs`.
export function limits(fileRaw: unknown, preset?: string, customs: Record<string, TierDef> = {}): Record<string, Limit> {
  const f = parseConfig(fileRaw);
  const t2 = preset === undefined ? f.tiers.t2 : Object.hasOwn(f.tiers.t2Presets, preset) ? f.tiers.t2Presets[preset] : Object.hasOwn(customs, preset) ? customs[preset] : f.tiers.t2;
  const models = { choices: Object.keys(PRICES) };
  return {
    ...Object.fromEntries(LOCKED.map(([k, reason]) => [k, { reason }])),
    'ops.keepDays': { min: 3, max: 30 }, 'ops.diskAlertPercent': { min: 50, max: 95 },
    'llm.models.script': models, 'llm.models.copy': models, 'llm.models.qa': models, 'llm.monthlyCapUsd': { min: 0, max: f.llm.monthlyCapUsd },
    'ugc.reuseAfterDays': { min: 7, max: 60 }, 'ugc.captionPx': { min: 56, max: 110 },
    'ugc.music.volumeDb': { min: -30, max: -6 }, 'ugc.music.duckDb': { min: -20, max: 0 }, 'approval.manualPerDay': { min: 0, max: f.approval.manualPerDay },
    'tiers.t2Preset': { choices: [...Object.keys(f.tiers.t2Presets), ...Object.keys(customs)] },
    'tiers.t2.maxCredits': { max: t2.maxCredits }, 'tiers.t2.keepCredits': { min: t2.keepCredits },
    'tiers.capsUsd.t2': { min: 0, max: f.tiers.capsUsd.t2 }, 'tiers.mix.t0': { min: 0, max: 1 }, 'tiers.maxJobsPerSlot': { min: 1, max: f.tiers.maxJobsPerSlot },
    ...Object.fromEntries(PLATFORMS.flatMap((p) => [
      [`platforms.${p}.slots`, { max: f.platforms[p as keyof Config['platforms']].slots.length }],
      [`platforms.${p}.visibility`, { choices: ['public', 'private'] }],
      ...['top', 'bottom', 'left', 'right'].map((e) => [`platforms.${p}.safe.${e}`, { min: 0, max: 960 }]),
    ])),
  };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
function setPath(o: Obj, path: string, v: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let c = o;
  for (const k of keys) c = c[k] ??= {};
  c[last] = v;
}

// customs: the approved custom models, keyed 'custom:<id>' (see loadCustomModels).
export function effectiveConfig(fileRaw: unknown, o: Record<string, unknown>, customs: Record<string, TierDef> = {}): { config: Config } | { errors: string[] } {
  const bad = Object.keys(o).filter((p) => !EDITABLE.includes(p));
  if (bad.length) return { errors: bad.map((p) => `${p} cannot be changed here`) };
  const file = parseConfig(fileRaw);
  const merged = structuredClone(fileRaw) as Obj;
  const preset = o['tiers.t2Preset'];
  if (preset !== undefined) {
    const custom = typeof preset === 'string' && Object.hasOwn(customs, preset);
    if (typeof preset !== 'string' || !(custom || Object.hasOwn(file.tiers.t2Presets, preset))) return { errors: [`tiers.t2Preset: unknown preset ${JSON.stringify(preset)}`] };
    merged.tiers.t2 = structuredClone(custom ? customs[preset] : merged.tiers.t2Presets[preset]);
  }
  for (const [p, v] of Object.entries(o)) if (p !== 'tiers.t2Preset') setPath(merged, p, v);
  // The GUI sets the share of reused clips; the rest is tier 2 and tier 1 stays off.
  if (typeof o['tiers.mix.t0'] === 'number') Object.assign(merged.tiers.mix, { t1: 0, t2: 1 - o['tiers.mix.t0'] });

  let c: Config;
  try {
    c = parseConfig(merged);
  } catch (e) {
    return { errors: (e as Error).message.split('\n').slice(1).map((l) => l.trim()) };
  }

  const errors: string[] = [];
  const lim = limits(fileRaw, typeof preset === 'string' ? preset : undefined, customs);
  for (const [p, v] of Object.entries(o)) {
    const l = lim[p] as Limit | undefined;
    if (!l) continue;
    const n = Array.isArray(v) ? v.length : v;
    if (l.choices && !l.choices.includes(v)) errors.push(`${p}: ${JSON.stringify(v)} is not one of ${l.choices.join(', ')}`);
    if (typeof n === 'number' && l.min !== undefined && n < l.min) errors.push(`${p}: ${n} is below the limit ${l.min}`);
    if (typeof n === 'number' && l.max !== undefined && n > l.max) errors.push(`${p}: ${n} is above the limit ${l.max}`);
  }
  for (const [name, p] of Object.entries(c.platforms)) {
    const t = p.slots.map(minutes);
    if (t.some((x, i) => i && x - t[i - 1] < 60)) errors.push(`platforms.${name}.slots: times must ascend, at least 60 minutes apart`);
  }
  const first = Object.values(c.platforms).filter((p) => p.enabled).map((p) => minutes(p.slots[0]));
  const need = c.render.produceTimeoutMinutes * c.render.maxAttempts + 10;
  if (first.length && 1440 - minutes(c.produceAt) + Math.min(...first) < need) errors.push(`produceAt: producing must start at least ${need} minutes before the next day's first slot`);
  return errors.length ? { errors } : { config: c };
}

export function audit(db: Db, actor: string, action: string, target: string, detail: unknown, now: Date): void {
  db.prepare('INSERT INTO audit (ts, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)').run(now.toISOString(), actor, action, target, JSON.stringify(detail));
}

const activeId = (db: Db): number | null => {
  const v = kvGet(db, 'config_active');
  return v === undefined ? null : Number(v);
};
const overridesOf = (db: Db, id: number | null): Record<string, unknown> => {
  const r = id === null ? undefined : (db.prepare('SELECT overrides_json FROM config_versions WHERE id = ?').get(id) as { overrides_json: string } | undefined);
  return r ? JSON.parse(r.overrides_json) : {};
};
const setActive = (db: Db, id: number | null) => {
  if (id === null) db.prepare("DELETE FROM kv WHERE key = 'config_active'").run();
  else db.prepare("INSERT INTO kv (key, value) VALUES ('config_active', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(id));
};

// `o` is the whole sparse map of the new version. baseId is the version the form was opened on.
export function saveConfig(db: Db, o: Record<string, unknown>, baseId: number | null, note: string, now: Date, fileRaw: unknown = raw): { id: number } | { errors: string[] } {
  const r = effectiveConfig(fileRaw, o, loadCustomModels(db, parseConfig(fileRaw), { approvedOnly: true }));
  if ('errors' in r) return r;
  db.exec('BEGIN IMMEDIATE');
  try {
    const was = activeId(db);
    if (was !== baseId) {
      db.exec('ROLLBACK');
      return { errors: ['the settings changed since you opened them; reload and try again'] };
    }
    const old = overridesOf(db, was);
    const id = Number(db.prepare('INSERT INTO config_versions (created_at, overrides_json, note) VALUES (?, ?, ?)').run(now.toISOString(), JSON.stringify(o), note).lastInsertRowid);
    setActive(db, id);
    const changes = [...new Set([...Object.keys(old), ...Object.keys(o)])].filter((p) => JSON.stringify(old[p]) !== JSON.stringify(o[p])).map((p) => ({ path: p, old: old[p] ?? null, new: o[p] ?? null }));
    audit(db, 'admin', 'config.save', 'config', { id, changes }, now);
    db.exec('COMMIT');
    return { id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// id null = use the file again.
// Refuses (returns errors) a version the rules reject today, e.g. one that names a removed model.
export function activateConfig(db: Db, id: number | null, now: Date, fileRaw: unknown = raw): { errors: string[] } | null {
  if (id !== null && !db.prepare('SELECT 1 FROM config_versions WHERE id = ?').get(id)) throw new Error(`no config version ${id}`);
  if (id !== null) {
    const r = effectiveConfig(fileRaw, overridesOf(db, id), loadCustomModels(db, parseConfig(fileRaw), { approvedOnly: true }));
    if ('errors' in r) return r;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    setActive(db, id);
    audit(db, 'admin', id === null ? 'config.reset' : 'config.activate', 'config', { id }, now);
    db.exec('COMMIT');
    return null;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The config to run with, and which version it is: a version id, 'file', or 'refused: why' when the stored
// overrides fail today's rules (the file config is used then, and one alert says so).
export async function resolveConfig(db: Db, now: Date): Promise<{ config: Config; version: number | string }> {
  const fileRaw = await loadRaw();
  const id = activeId(db);
  if (id === null) return { config: parseConfig(fileRaw), version: 'file' };
  let errors: string[];
  try {
    const r = effectiveConfig(fileRaw, overridesOf(db, id), loadCustomModels(db, parseConfig(fileRaw), { approvedOnly: true }));
    if ('config' in r) return { config: r.config, version: id };
    errors = r.errors;
  } catch (e) {
    errors = [e instanceof Error ? e.message : String(e)];
  }
  const why = errors.join('; ').slice(0, 300);
  await alert(db, 'config_invalid', String(id), `config version ${id} refused, running on the file: ${why}`, now);
  return { config: parseConfig(fileRaw), version: `refused: ${why}` };
}

export const loadEffectiveConfig = async (db: Db, now: Date): Promise<Config> => (await resolveConfig(db, now)).config;
