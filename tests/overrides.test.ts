import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import raw from '../config/pipeline.config.ts';
import { parseConfig } from '../src/config/index.ts';
import { activateConfig, effectiveConfig, limits, loadEffectiveConfig, resolveConfig, saveConfig } from '../src/config/overrides.ts';
import { migrate } from '../src/db/index.ts';
import { makeProducer, run } from '../src/scheduler/loop.ts';
import { loadCustomModels } from '../src/config/models.ts';
import { fresh } from './helpers.ts';

const NOW = new Date('2026-11-12T17:20:00Z');
const bad = (o: Record<string, unknown>, re: RegExp) => {
  const r = effectiveConfig(raw, o);
  assert.ok('errors' in r, JSON.stringify(o) + ' was accepted');
  assert.match(r.errors.join('\n'), re);
};
const good = (o: Record<string, unknown>) => {
  const r = effectiveConfig(raw, o);
  assert.ok('config' in r, JSON.stringify(r));
  return r.config;
};

test('a path outside the editable list is refused', () => {
  bad({ 'publish.timeoutMinutes': 5 }, /publish.timeoutMinutes cannot be changed/);
  bad({ 'platforms.youtube.handle': 'x' }, /handle cannot be changed/);
  bad({ 'tiers.mix.t1': 0.5 }, /tiers.mix.t1 cannot be changed/);
  bad({ 'tiers.t2.params': {} }, /cannot be changed/);
});

test('each ceiling and floor refuses one past its limit and accepts the limit', () => {
  const edge = (p: string, ok: unknown, over: unknown) => {
    good({ [p]: ok });
    bad({ [p]: over }, new RegExp(p.replaceAll('.', '\\.')));
  };
  edge('tiers.capsUsd.t2', 52, 52.01);
  edge('llm.monthlyCapUsd', 10, 10.01);
  edge('tiers.t2.maxCredits', 30, 30.01);
  edge('tiers.t2.keepCredits', 350, 349);
  edge('tiers.maxJobsPerSlot', 2, 3);
  edge('ops.keepDays', 30, 31);
  edge('ops.diskAlertPercent', 95, 96);
  edge('ugc.reuseAfterDays', 7, 6);
  edge('platforms.youtube.safe.top', 960, 961);
  good({ 'platforms.youtube.slots': ['12:15'], 'platforms.tiktok.slots': ['12:15'] });
  bad({ 'platforms.youtube.slots': ['12:15', '19:45', '21:00'], 'platforms.tiktok.slots': ['12:15', '19:45', '21:00'] }, /slots: 3 is above the limit 2/);
});

test('models, presets and preset ceilings', () => {
  bad({ 'llm.models.copy': 'gpt-9' }, /not one of/);
  bad({ 'tiers.t2Preset': 'nope' }, /unknown preset/);
  const c = good({ 'tiers.t2Preset': 'seedance_2_0_fast_720p' });
  assert.equal(c.tiers.t2.model, 'seedance_2_0');
  good({ 'tiers.t2Preset': 'seedance_2_0_fast_720p', 'tiers.t2.maxCredits': 40 });
  bad({ 'tiers.t2Preset': 'seedance_2_0_fast_720p', 'tiers.t2.maxCredits': 41 }, /above the limit 40/);
  assert.equal(limits(raw, 'seedance_2_0_fast_720p')['tiers.t2.maxCredits'].max, 40);
});

test('a preset may not set the keys the request sets itself', () => {
  const file = structuredClone(raw) as any;
  file.tiers.t2Presets.x = { ...file.tiers.t2, params: { prompt: 'hi' } };
  assert.throws(() => parseConfig(file), /must not set/);
});

test('mix is a share of reused clips; tier 1 stays 0', () => {
  const c = good({ 'tiers.mix.t0': 0.25 });
  assert.deepEqual(c.tiers.mix, { t0: 0.25, t1: 0, t2: 0.75 });
  bad({ 'tiers.mix.t0': 1.1 }, /tiers\.mix/);
});

test('slot rules: ascending, 60 minutes apart, same count on enabled platforms', () => {
  bad({ 'platforms.youtube.slots': ['19:45', '12:15'] }, /ascend/);
  bad({ 'platforms.youtube.slots': ['12:15', '12:45'] }, /60 minutes/);
  bad({ 'platforms.youtube.slots': ['12:15'] }, /same number of slots/);
  good({ 'platforms.youtube.slots': ['12:30', '20:00'], 'platforms.tiktok.slots': ['12:30', '20:00'] });
});

test('produceAt must leave time for every attempt before the next first slot', () => {
  good({ 'produceAt': '21:00' });
  bad({ 'platforms.youtube.slots': ['00:30', '19:45'], 'platforms.tiktok.slots': ['00:30', '19:45'], produceAt: '22:00' }, /produceAt/);
  bad({ produceAt: '25:00' }, /HH:MM/);
});

test('valid overrides equal the schema applied to the merged object', () => {
  const c = good({ 'platforms.youtube.slots': ['12:30', '20:00'], 'platforms.tiktok.slots': ['12:30', '20:00'], 'ugc.captionPx': 90, 'platforms.youtube.visibility': 'public' });
  const m = structuredClone(raw) as any;
  m.platforms.youtube.slots = m.platforms.tiktok.slots = ['12:30', '20:00'];
  m.ugc.captionPx = 90;
  m.platforms.youtube.visibility = 'public';
  assert.deepEqual(c, parseConfig(m));
});

test('save, base_id check, rollback and reset', () => {
  const db = fresh();
  const a = saveConfig(db, { 'ugc.captionPx': 90 }, null, 'first', NOW) as { id: number };
  assert.equal(a.id, 1);
  assert.ok('errors' in saveConfig(db, { 'ugc.captionPx': 80 }, null, 'stale', NOW));
  assert.ok('errors' in saveConfig(db, { 'ugc.captionPx': 500 }, a.id, 'bad', NOW));
  const b = saveConfig(db, { 'ugc.captionPx': 80 }, a.id, 'second', NOW) as { id: number };
  const val = async () => (await loadEffectiveConfig(db, NOW)).ugc.captionPx;
  return (async () => {
    assert.equal(await val(), 80);
    activateConfig(db, a.id, NOW);
    assert.equal(await val(), 90);
    activateConfig(db, null, NOW);
    assert.equal(await val(), 84);
    assert.equal(b.id, 2);
    const audits = db.prepare('SELECT action FROM audit ORDER BY id').all().map((r: any) => r.action);
    assert.deepEqual(audits, ['config.save', 'config.save', 'config.activate', 'config.reset']);
    assert.throws(() => activateConfig(db, 99, NOW), /no config version/);
  })();
});

test('a stored version that fails today\'s rules falls back to the file with one alert', async () => {
  const db = fresh();
  db.prepare("INSERT INTO config_versions (id, created_at, overrides_json) VALUES (1, 't', ?)").run(JSON.stringify({ 'tiers.capsUsd.t2': 5000 }));
  db.prepare("INSERT INTO kv (key, value) VALUES ('config_active', '1')").run();
  const r = await resolveConfig(db, NOW);
  assert.equal(r.config.tiers.capsUsd.t2, 52);
  assert.match(String(r.version), /^refused: .*capsUsd/);
  await resolveConfig(db, NOW);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'config_invalid'").get() as any).n, 1);
});

test('the next tick picks up a new version; a snapshot taken earlier keeps the old one', async () => {
  const db = fresh();
  process.env.DRY_RUN = '1';
  const seen: number[] = [];
  const deps = { db, config: parseConfig(raw), publishers: {}, producer: makeProducer(async () => {}), rebuild: (c: any) => { seen.push(c.ugc.captionPx); return {}; } };
  const snapshot = await loadEffectiveConfig(db, NOW); // what a producer child holds
  saveConfig(db, { 'ugc.captionPx': 90 }, null, '', NOW);
  await run(deps, () => NOW, true);
  saveConfig(db, { 'ugc.captionPx': 70 }, 1, '', NOW);
  await run(deps, () => NOW, true);
  assert.deepEqual(seen, [90, 70]);
  assert.equal(snapshot.ugc.captionPx, 84);
  const state = JSON.parse((db.prepare("SELECT value FROM kv WHERE key = 'pipeline_state'").get() as any).value);
  assert.deepEqual([state.dryRun, state.configVersion, state.tickAt], [true, 2, NOW.toISOString()]);
});

test('migrate re-reads the version inside the transaction', () => {
  const log: string[] = [];
  const versions = [8, 8, 8, 8, 8, 8, 8, 8, 8, 9]; // another process applies 009 between the first read and BEGIN IMMEDIATE
  const fake = { prepare: () => ({ get: () => ({ user_version: versions.shift() ?? 9 }) }), exec: (s: string) => log.push(s.slice(0, 20)) };
  migrate(fake as unknown as DatabaseSync);
  assert.deepEqual(log, ['BEGIN IMMEDIATE', 'ROLLBACK']);
});

function edgeCheck(p: string, ok: unknown, over: unknown) {
  good({ [p]: ok });
  bad({ [p]: over }, new RegExp(p.replaceAll('.', '\\.')));
}

test('new editable fields respect their limits', () => {
  edgeCheck('ugc.music.volumeDb', -6, -5.9);
  edgeCheck('ugc.music.volumeDb', -30, -30.1);
  edgeCheck('ugc.music.duckDb', 0, 0.1);
  edgeCheck('ugc.music.duckDb', -20, -20.1);
  edgeCheck('approval.manualPerDay', 3, 4);
  assert.equal(good({ 'approval.manualPerDay': 0 }).approval.manualPerDay, 0);
  bad({ 'approval.expireHours': 5 }, /cannot be changed/);
  bad({ 'tiers.usdPerCredit': 1 }, /cannot be changed/);
  bad({ 'tiers.customMaxCredits': 1 }, /cannot be changed/);
});

test('custom:<id> is accepted only when the approved custom is passed', () => {
  const db = fresh();
  const add = (approved: boolean) => Number(db.prepare('INSERT INTO video_models (name, model, params_json, max_credits, keep_credits, created_at, approved_at) VALUES (?,?,?,?,?,?,?)').run('m', 'wan3_0', '{"resolution":"720p"}', 40, 350, 't', approved ? 't' : null).lastInsertRowid);
  const a = add(true), b = add(false);
  const customs = loadCustomModels(db, parseConfig(raw), { approvedOnly: true });
  const r = effectiveConfig(raw, { 'tiers.t2Preset': `custom:${a}` }, customs);
  assert.ok('config' in r);
  assert.equal(r.config.tiers.t2.maxCredits, 40);
  assert.ok('errors' in effectiveConfig(raw, { 'tiers.t2Preset': `custom:${a}` }));
  assert.ok('errors' in effectiveConfig(raw, { 'tiers.t2Preset': `custom:${b}` }, customs));
  assert.ok('errors' in effectiveConfig(raw, { 'tiers.t2Preset': `custom:${a}`, 'tiers.t2.maxCredits': 41 }, customs));
  assert.equal(limits(raw, `custom:${a}`, customs)['tiers.t2.maxCredits'].max, 40);
  assert.ok('id' in saveConfig(db, { 'tiers.t2Preset': `custom:${a}` }, null, '', NOW));
  assert.ok('errors' in saveConfig(db, { 'tiers.t2Preset': `custom:${b}` }, 1, '', NOW));
});

test('resolveConfig refuses a version that names an unapproved custom and sends config_invalid', async () => {
  const db = fresh();
  const id = Number(db.prepare("INSERT INTO video_models (name, model, params_json, max_credits, keep_credits, created_at) VALUES ('m','wan3_0','{}',40,350,'t')").run().lastInsertRowid);
  db.prepare("INSERT INTO config_versions (id, created_at, overrides_json) VALUES (1,'t',?)").run(JSON.stringify({ 'tiers.t2Preset': `custom:${id}` }));
  db.prepare("INSERT INTO kv (key, value) VALUES ('config_active','1')").run();
  const r = await resolveConfig(db, NOW);
  assert.match(String(r.version), /^refused: .*unknown preset/);
  assert.equal(r.config.tiers.t2.model, 'wan3_0');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'config_invalid'").get() as any).n, 1);
  db.prepare('UPDATE video_models SET approved_at = ?').run('t');
  assert.equal((await resolveConfig(db, NOW)).version, 1);
});
