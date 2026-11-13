import type { Db } from '../db/index.ts';
import { env } from '../config/index.ts';
import { log, scrub } from './log.ts';

const WINDOW_MS = 6 * 3600 * 1000;

export const hasAlertChannel = () => !!(env.discordWebhook() || (env.telegramToken() && env.telegramChat()));

// Always records an events row (delivered flag). Same kind+key is de-duplicated only
// against delivered rows within 6 hours. Never throws; never logs URLs or tokens.
export async function alert(db: Db, kind: string, key: string, message: string, now: Date): Promise<void> {
  try {
    const since = new Date(now.getTime() - WINDOW_MS).toISOString();
    const dup = db.prepare('SELECT 1 FROM events WHERE kind = ? AND key = ? AND ts > ? AND delivered = 1').get(kind, key, since);
    if (dup) return;
    const text = scrub(`[${kind}] ${message}`);
    log.warn('alert', { kind, subject: key, message: scrub(message) });
    const sends: Promise<Response>[] = [];
    const post = (url: string, body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const hook = env.discordWebhook();
    if (hook) sends.push(post(hook, { content: text, allowed_mentions: { parse: [] } }));
    const tg = env.telegramToken();
    const chat = env.telegramChat();
    if (tg && chat) sends.push(post(`https://api.telegram.org/bot${tg}/sendMessage`, { chat_id: chat, text }));
    const ok = await Promise.all(
      sends.map((s) =>
        s.then(
          (r) => {
            if (!r.ok) log.warn('alert send failed', { status: r.status });
            return r.ok;
          },
          () => {
            log.warn('alert send failed', { status: 'network' });
            return false;
          },
        ),
      ),
    );
    const delivered = sends.length === 0 || ok.some(Boolean);
    db.prepare('INSERT INTO events (ts, kind, key, message, delivered) VALUES (?, ?, ?, ?, ?)').run(now.toISOString(), kind, key, text, delivered ? 1 : 0);
  } catch (e) {
    log.error('alert failed', { error: e instanceof Error ? e.name : 'error' });
  }
}
