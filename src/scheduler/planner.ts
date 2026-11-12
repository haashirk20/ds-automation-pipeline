import type { Db } from '../db/index.ts';
import type { Config } from '../config/index.ts';
import { localToUtc } from './time.ts';

export function enabledPlatforms(config: Config): string[] {
  return Object.entries(config.platforms).filter(([, p]) => p.enabled).map(([name]) => name);
}

// Idempotent. Creates only slot indexes whose scheduled times are all still in the future.
export function planDay(db: Db, config: Config, localDate: string, now: Date): void {
  const platforms = enabledPlatforms(config);
  if (!platforms.length) return;
  const count = config.platforms[platforms[0] as keyof Config['platforms']].slots.length;
  const ts = now.toISOString();
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const times = platforms.map((p) => localToUtc(localDate, config.platforms[p as keyof Config['platforms']].slots[i], config.timezone));
      if (times.some((t) => t <= now)) continue;
      const id = `${localDate}#${i + 1}`;
      db.prepare("INSERT OR IGNORE INTO slots (id, local_date, idx, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, localDate, i + 1, ts, ts);
      platforms.forEach((p, k) => {
        db.prepare('INSERT OR IGNORE INTO publications (slot_id, platform, scheduled_at) VALUES (?, ?, ?)').run(id, p, times[k].toISOString());
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
