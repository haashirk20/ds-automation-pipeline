import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';
import { parseConfig } from '../src/config/index.ts';
import raw from '../config/pipeline.config.ts';
import { planDay } from '../src/scheduler/planner.ts';
import { produceSlot } from '../src/render/produce.ts';
import { PermanentError, type Publisher } from '../src/publish/types.ts';

export const config = parseConfig(raw);

// Fresh temp dirs and DB per call; no network alerts.
export function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  process.env.DATA_DIR = join(dir, 'data');
  process.env.OUT_DIR = join(dir, 'out');
  process.env.DRY_RUN = '0';
  for (const k of ['ALERT_DISCORD_WEBHOOK', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID', 'HEALTHCHECK_URL']) delete process.env[k];
  return openDb(process.env.DATA_DIR);
}

// Plans and stub-produces 2026-11-12 slots (21:30 Toronto the evening before).
export async function readyDb() {
  const db = fresh();
  const t = new Date('2026-11-12T02:30:00Z');
  planDay(db, config, '2026-11-12', t);
  for (const id of ['2026-11-12#1', '2026-11-12#2']) await produceSlot(db, config, id, t);
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
