// Video models added on the admin page. Pure checks and database reads: no network, no audit.
import type { Db } from '../db/index.ts';
import raw from '../../config/pipeline.config.ts';
import { log } from '../ops/log.ts';
import { parseConfig, tierSchema, type Config } from './index.ts';

export const CUSTOM_PARAM_KEYS = ['resolution', 'mode', 'generate_audio', 'sound', 'bitrate_mode', 'genre', 'enable_thinking'] as const;
export type TierDef = Config['tiers']['t2'];
export type VideoModelRow = { id: number; name: string; model: string; params_json: string; max_credits: number; keep_credits: number; created_at: string; approved_at: string | null; removed_at: string | null };

export function customModelProblems(i: { name: string; model: string; params: Record<string, unknown>; maxCredits: number; keepCredits: number }, file: Config): string[] {
  const p: string[] = [];
  if (typeof i.name !== 'string' || i.name.length < 1 || i.name.length > 40 || /\p{C}/u.test(i.name)) p.push('name: 1 to 40 characters, no control characters');
  if (typeof i.model !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(i.model)) p.push('model: must be a Higgsfield model id such as wan3_0');
  const params = i.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) p.push('params: must be an object');
  else {
    const keys = Object.keys(params);
    if (keys.length > 6) p.push('params: at most 6 keys');
    for (const [k, v] of Object.entries(params)) {
      if (!(CUSTOM_PARAM_KEYS as readonly string[]).includes(k)) p.push(`params.${k}: not an allowed parameter (${CUSTOM_PARAM_KEYS.join(', ')})`);
      else if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6) || (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,24}$/.test(v)))) p.push(`params.${k}: must be a boolean, a number or a short plain string`);
    }
    if (params.resolution !== undefined && !['480p', '720p', '1080p'].includes(params.resolution as string)) p.push('params.resolution: one of 480p, 720p, 1080p');
    if (params.mode === 'video_edit' || params.mode === 'video_extension') p.push(`params.mode: ${params.mode} is not allowed`);
    if (params.generate_audio === false || params.sound === 'off') p.push('the clip must keep its sound: the spoken line needs it');
  }
  if (!(typeof i.maxCredits === 'number' && i.maxCredits > 0 && i.maxCredits <= file.tiers.customMaxCredits)) p.push(`maxCredits: above 0 and at most ${file.tiers.customMaxCredits}`);
  if (!(typeof i.keepCredits === 'number' && i.keepCredits >= (file.tiers.t2.keepCredits ?? 0))) p.push(`keepCredits: at least ${file.tiers.t2.keepCredits ?? 0}`);
  return p;
}

// usdPerClip is the worst case (maxCredits), which the cap checks use before a job. Checks again, so a row written
// straight into the database is refused the same way.
export function customDef(row: VideoModelRow, config: Config): TierDef {
  const params = JSON.parse(row.params_json);
  const problems = customModelProblems({ name: row.name, model: row.model, params, maxCredits: row.max_credits, keepCredits: row.keep_credits }, config);
  if (problems.length) throw new Error(`custom model ${row.id}: ${problems.join('; ')}`);
  return tierSchema.parse({ provider: config.tiers.t2.provider, model: row.model, usdPerClip: row.max_credits * config.tiers.usdPerCredit, params, maxCredits: row.max_credits, keepCredits: row.keep_credits });
}

export function loadCustomModels(db: Db, config: Config, o: { approvedOnly: boolean }): Record<string, TierDef> {
  const rows = db.prepare(`SELECT * FROM video_models WHERE removed_at IS NULL ${o.approvedOnly ? 'AND approved_at IS NOT NULL' : ''} ORDER BY id`).all() as VideoModelRow[];
  const out: Record<string, TierDef> = {};
  for (const r of rows) {
    // A bad row is skipped, never thrown: one row must not take the config load, the pause or the admin page down.
    try { out[`custom:${r.id}`] = customDef(r, config); } catch (e) { log.warn('custom model skipped', { id: r.id, problem: String((e as Error).message) }); }
  }
  return out;
}

// The tier a slot's video_model names: null = the effective t2 (null returned, caller keeps it). Unknown or removed throws.
export function slotTierDef(db: Db, config: Config, key: string | null): TierDef | null {
  if (key === null) return null;
  if (Object.hasOwn(config.tiers.t2Presets, key)) return config.tiers.t2Presets[key];
  const m = /^custom:(\d+)$/.exec(key);
  const row = m && (db.prepare('SELECT * FROM video_models WHERE id = ? AND removed_at IS NULL').get(Number(m[1])) as VideoModelRow | undefined);
  if (!row) throw new Error(`unknown video model ${JSON.stringify(key)}`);
  return customDef(row, parseConfig(raw)); // checked against the file's ceilings, not the effective config
}

// A reason the model cannot be removed, or null.
export function modelInUse(db: Db, id: number): string | null {
  const key = `custom:${id}`;
  const v = db.prepare("SELECT value FROM kv WHERE key = 'config_active'").get() as { value: string } | undefined;
  const o = v && (db.prepare('SELECT overrides_json FROM config_versions WHERE id = ?').get(Number(v.value)) as { overrides_json: string } | undefined);
  if (o && JSON.parse(o.overrides_json)['tiers.t2Preset'] === key) return 'the active settings use it';
  const s = db.prepare("SELECT id FROM slots WHERE video_model = ? AND (status IN ('planned','producing') OR (status = 'ready' AND hold = 'waiting')) LIMIT 1").get(key) as { id: string } | undefined;
  return s ? `slot ${s.id} uses it` : null;
}
