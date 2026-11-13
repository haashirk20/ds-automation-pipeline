import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { parseConfig } from '../src/config/index.ts';
import raw from '../config/pipeline.config.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { makeProducer } from '../src/scheduler/loop.ts';
import { PermanentError, type Publisher } from '../src/publish/types.ts';

// Facebook and Instagram are off in the shipped config; the suite exercises all four.
export const config = parseConfig({ ...raw, platforms: { ...raw.platforms, facebook: { ...raw.platforms.facebook, enabled: true }, instagram: { ...raw.platforms.instagram, enabled: true } } });

// Fresh temp dirs and DB per call; no network alerts.
export function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  process.env.DATA_DIR = join(dir, 'data');
  process.env.OUT_DIR = join(dir, 'out');
  process.env.DRY_RUN = '0';
  for (const k of ['ALERT_DISCORD_WEBHOOK', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID', 'HEALTHCHECK_URL']) delete process.env[k];
  return openDb(process.env.DATA_DIR);
}

// Stands in for the real producer: same claim, placeholder renders with copy, no media.
export async function stubProduce(db: ReturnType<typeof openDb>, id: string, now: Date) {
  const ts = now.toISOString();
  if (db.prepare("UPDATE slots SET status = 'producing', attempt = attempt + 1, updated_at = ?, claimed_at = ? WHERE id = ? AND status = 'planned'").run(ts, ts, id).changes !== 1) return;
  for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) {
    db.prepare("INSERT OR REPLACE INTO renders (slot_id, platform, file_path, qa_pass, qa_json, title, caption, created_at) VALUES (?,?,?,1,'{}',?,?,?)").run(id, p, `/x/${id}/${p}.mp4`, `title ${p}`, `caption ${p}`, ts);
  }
  db.prepare("UPDATE slots SET tier = 't0', status = 'ready', updated_at = ? WHERE id = ?").run(ts, id);
}

export const stubProducer = (db: ReturnType<typeof openDb>) => makeProducer((id, now) => stubProduce(db, id, now));

// Plans and stub-produces 2026-11-12 slots (21:30 Toronto the evening before).
export async function readyDb() {
  const db = fresh();
  const t = new Date('2026-11-12T02:30:00Z');
  planDay(db, config, '2026-11-12', t);
  for (const id of ['2026-11-12#1', '2026-11-12#2']) await stubProduce(db, id, t);
  return db;
}

export const AT_SLOT1 = new Date('2026-11-12T17:20:00Z'); // 12:20 Toronto

export function fakePublishers(impl: Publisher['publish'] = async () => ({ postId: 'p1', postUrl: 'u1' })) {
  const calls: unknown[] = [];
  const publishers = Object.fromEntries(
    ['youtube', 'facebook', 'instagram', 'tiktok'].map((platform) => [platform, { platform, publish: async (i: Parameters<Publisher['publish']>[0]) => { calls.push(i); return impl(i); } }]),
  );
  return { publishers, calls };
}

export { PermanentError };
