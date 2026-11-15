import { test } from 'node:test';
import assert from 'node:assert/strict';
import raw from '../config/pipeline.config.ts';
import { parseConfig } from '../src/config/index.ts';
import { customDef, customModelProblems, loadCustomModels, modelInUse, slotTierDef } from '../src/config/models.ts';
import { fresh } from './helpers.ts';

const file = parseConfig(raw);
const ok = { name: 'Wan 3', model: 'wan3_0', params: { resolution: '720p', generate_audio: true } as Record<string, unknown>, maxCredits: 30, keepCredits: 350 };
const problems = (o: Partial<typeof ok>) => customModelProblems({ ...ok, ...o }, file);

test('a plain model passes', () => assert.deepEqual(problems({}), []));

test('each bad input is refused', () => {
  for (const k of ['prompt', 'duration', 'aspect_ratio', 'use_unlim', 'model', 'multi_shots', 'medias', 'get_cost', 'draft_job_id', 'avatar_ids', 'extension_mode', 'unknown']) assert.ok(problems({ params: { [k]: 'x' } }).length, k);
  for (const v of [{ a: 1 }, [1], null]) assert.ok(problems({ params: { genre: v } }).length);
  assert.ok(problems({ params: { genre: 'has space' } }).length);
  assert.ok(problems({ params: { resolution: '4k' } }).length);
  assert.ok(problems({ params: { mode: 'video_edit' } }).length);
  assert.ok(problems({ params: { mode: 'video_extension' } }).length);
  assert.ok(problems({ params: { generate_audio: false } }).length);
  assert.ok(problems({ params: { sound: 'off' } }).length);
  assert.ok(problems({ maxCredits: 120.01 }).length);
  assert.deepEqual(problems({ maxCredits: 120 }), []);
  assert.ok(problems({ maxCredits: 0 }).length);
  assert.ok(problems({ keepCredits: 349 }).length);
  for (const m of ['Wan 3', '../x', 'a']) assert.ok(problems({ model: m }).length, m);
  assert.ok(problems({ name: '' }).length);
  assert.ok(problems({ name: 'a\nb' }).length);
  assert.ok(problems({ params: Object.fromEntries(['resolution', 'mode', 'generate_audio', 'sound', 'bitrate_mode', 'genre', 'enable_thinking'].map((k) => [k, 1])) }).length);
});

test('customDef prices the worst case and refuses a bad row', () => {
  const row = { id: 3, name: 'Wan 3', model: 'wan3_0', params_json: JSON.stringify(ok.params), max_credits: 30, keep_credits: 350, created_at: 't', approved_at: null, removed_at: null };
  const d = customDef(row, file);
  assert.equal(d.usdPerClip, 30 * file.tiers.usdPerCredit);
  assert.equal(d.provider, file.tiers.t2.provider);
  assert.throws(() => customDef({ ...row, params_json: '{"prompt":"x"}' }, file), /not an allowed/);
});

test('loadCustomModels, slotTierDef and modelInUse read the database', () => {
  const db = fresh();
  const add = (approved: boolean, removed = false) => Number(db.prepare('INSERT INTO video_models (name, model, params_json, max_credits, keep_credits, created_at, approved_at, removed_at) VALUES (?,?,?,?,?,?,?,?)').run('m', 'wan3_0', JSON.stringify(ok.params), 30, 350, 't', approved ? 't' : null, removed ? 't' : null).lastInsertRowid);
  const a = add(true), b = add(false), c = add(true, true);
  assert.deepEqual(Object.keys(loadCustomModels(db, file, { approvedOnly: true })), [`custom:${a}`]);
  assert.deepEqual(Object.keys(loadCustomModels(db, file, { approvedOnly: false })), [`custom:${a}`, `custom:${b}`]);
  assert.equal(slotTierDef(db, file, null), null);
  assert.equal(slotTierDef(db, file, 'seedance_2_0_fast_720p')?.model, 'seedance_2_0');
  assert.equal(slotTierDef(db, file, `custom:${b}`)?.model, 'wan3_0');
  assert.throws(() => slotTierDef(db, file, `custom:${c}`), /unknown video model/);
  assert.throws(() => slotTierDef(db, file, 'nope'), /unknown video model/);
  assert.equal(modelInUse(db, a), null);
  db.prepare("INSERT INTO slots (id, local_date, idx, status, video_model, created_at, updated_at) VALUES ('d#101','d',101,'planned',?, 't','t')").run(`custom:${a}`);
  assert.match(modelInUse(db, a)!, /d#101/);
  db.prepare("UPDATE slots SET status = 'done'").run();
  assert.equal(modelInUse(db, a), null);
  db.prepare("INSERT INTO config_versions (id, created_at, overrides_json) VALUES (1,'t',?)").run(JSON.stringify({ 'tiers.t2Preset': `custom:${a}` }));
  db.prepare("INSERT INTO kv (key, value) VALUES ('config_active','1')").run();
  assert.match(modelInUse(db, a)!, /active settings/);
});

test('a bad approved row is skipped: the pause still applies, Settings renders, and a version naming the row is refused', async () => {
  const { saveConfig, activateConfig, loadEffectiveConfig } = await import('../src/config/overrides.ts');
  const { settingsPage } = await import('../src/admin/pages.ts');
  const db = fresh();
  const NOW = new Date('2026-11-12T17:20:00Z');
  const good = Number(db.prepare("INSERT INTO video_models (name, model, params_json, max_credits, keep_credits, created_at, approved_at) VALUES ('m','wan3_0',?,30,350,'t','t')").run(JSON.stringify(ok.params)).lastInsertRowid);
  const v1 = saveConfig(db, { 'tiers.t2Preset': `custom:${good}` }, null, 'uses it', NOW) as { id: number };
  const v2 = saveConfig(db, { 'platforms.tiktok.enabled': false }, v1.id, 'pause', NOW) as { id: number };
  // The rows go bad after approval (written straight into the database).
  db.prepare("UPDATE video_models SET params_json = '{\"prompt\":\"x\"}' WHERE id = ?").run(good);
  db.prepare("INSERT INTO video_models (name, model, params_json, max_credits, keep_credits, created_at, approved_at) VALUES ('n','wan3_0','not json',30,350,'t','t')").run();
  assert.deepEqual(loadCustomModels(db, file, { approvedOnly: true }), {});
  assert.equal((await loadEffectiveConfig(db, NOW)).platforms.tiktok.enabled, false); // the pause still applies
  assert.ok('id' in (saveConfig(db, { 'platforms.tiktok.enabled': false, 'ugc.captionPx': 90 }, v2.id, 'again', NOW))); // saving does not throw
  const page = await settingsPage({ db, now: NOW, method: 'GET', path: '/settings', query: new URLSearchParams(), form: new URLSearchParams(), csrf: 'x', range: null });
  assert.equal(page.status, 200);
  // Activating the version that names the skipped row is refused, with the errors to show.
  const r = activateConfig(db, v1.id, NOW);
  assert.ok(r && r.errors.length);
  assert.equal(activateConfig(db, v2.id, NOW), null);
});

test('slotTierDef checks the row against the file ceilings; a name with a format character is refused', () => {
  const db = fresh();
  const id = Number(db.prepare("INSERT INTO video_models (name, model, params_json, max_credits, keep_credits, created_at) VALUES ('m','wan3_0',?,30,350,'t')").run(JSON.stringify(ok.params)).lastInsertRowid);
  const loose = parseConfig({ ...raw, tiers: { ...raw.tiers, customMaxCredits: 10 } });
  assert.equal(slotTierDef(db, loose, `custom:${id}`)?.maxCredits, 30); // the effective config does not change the check
  assert.ok(problems({ name: 'a‮b' }).length);
});
