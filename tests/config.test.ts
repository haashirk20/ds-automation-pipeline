import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/index.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrate, schemaVersion } from '../src/db/index.ts';
import raw from '../config/pipeline.config.ts';

const mod = (f: (c: any) => void) => {
  const c = structuredClone(raw);
  f(c);
  return c;
};

test('ugc mode needs a produce timeout that outlasts every video job', () => {
  assert.ok(parseConfig(mod((c) => (c.render.produceTimeoutMinutes = 90))));
  assert.throws(() => parseConfig(mod((c) => (c.render.produceTimeoutMinutes = 89))), /produceTimeoutMinutes/);
  assert.ok(parseConfig(mod((c) => { c.creative.mode = 'ad'; c.tiers.mix = { t0: 1, t1: 0, t2: 0 }; c.tiers.clipSeconds = 4; c.render.produceTimeoutMinutes = 30; })));
});

test('an enabled instagram cannot be private', () => {
  assert.throws(() => parseConfig(mod((c) => { c.platforms.instagram.enabled = true; })), /instagram has no private mode/);
  assert.ok(parseConfig(mod((c) => { c.platforms.instagram.enabled = true; c.platforms.instagram.visibility = 'public'; })));
});

test('the Phase 6c keys parse and are bounded', () => {
  const c = parseConfig(raw);
  assert.deepEqual([c.ugc.music, c.approval, c.tiers.customMaxCredits], [{ volumeDb: -18, duckDb: -10 }, { manualPerDay: 3, expireHours: 24 }, 120]);
  assert.ok(c.tiers.usdPerCredit > 0);
  for (const k of ['seedance_2_0_std_720p', 'seedance_2_5_flash_720p', 'seedance_2_5_720p', 'kling_o3_std']) assert.ok(c.tiers.t2Presets[k], k);
  assert.throws(() => parseConfig(mod((c) => (c.ugc.music.volumeDb = 1))), /volumeDb/);
  assert.throws(() => parseConfig(mod((c) => (c.approval.manualPerDay = 11))), /manualPerDay/);
  assert.throws(() => parseConfig(mod((c) => (c.tiers.usdPerCredit = 0))), /usdPerCredit/);
  const twenty = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const slots = (n: string[]) => mod((c) => { for (const p of Object.values(c.platforms) as any[]) p.slots = n; });
  assert.ok(parseConfig(slots(twenty)));
  assert.throws(() => parseConfig(slots([...twenty, '23:30'])), /slots/);
});

test('migration 009 applies over version 8; old slots become planned', () => {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../src/db/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= 8).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  db.exec('PRAGMA user_version = 8');
  db.exec("INSERT INTO slots (id, local_date, idx, created_at, updated_at) VALUES ('d#0','d',0,'t','t')");
  migrate(db);
  assert.equal(schemaVersion(db), 9);
  assert.deepEqual({ ...(db.prepare("SELECT kind, hold, video_model FROM slots WHERE id = 'd#0'").get() as object) }, { kind: 'planned', hold: null, video_model: null });
});
