// The hook library: generated in batches by the script model, drawn least-recently-used.
import { z } from 'zod';
import type { Brief } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
import { systemPrompt } from '../llm/prompts.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import { checkHook, FRAMEWORKS, type HookDraft } from './claims.ts';

export interface Hook extends HookDraft {
  id: number;
  productHandle: string;
}

const REFILL = 24;

export function hookFloor(config: Config): number {
  const first = Object.values(config.platforms).find((p) => p.enabled);
  const perDay = first ? first.slots.length : 0;
  return Math.ceil(config.hooks.noRepeatDays * perDay * config.hooks.poolFactor);
}

const Batch = z.object({
  hooks: z.array(z.object({ framework: z.string(), headline: z.string(), say: z.string(), factIds: z.array(z.string()) })),
});

// Returns how many hooks were added (0 when the library is already at the floor).
export async function refillHooks(db: Db, config: Config, brief: Brief, now: Date): Promise<number> {
  const handle = brief.product.handle;
  const active = (db.prepare("SELECT COUNT(*) AS n FROM hooks WHERE product_handle = ? AND status = 'active'").get(handle) as { n: number }).n;
  if (active >= hookFloor(config)) return 0;

  const existing = (db.prepare('SELECT headline FROM hooks WHERE product_handle = ?').all(handle) as { headline: string }[]).map((r) => r.headline);
  const per = REFILL / FRAMEWORKS.length;
  const user =
    `Write ${REFILL} hooks: ${per} for each of these frameworks: ${FRAMEWORKS.join(', ')}.\n` +
    (existing.length ? `Headlines already used (do not repeat or closely paraphrase any):\n${existing.map((h) => `- ${h}`).join('\n')}` : 'No hooks exist yet.');
  const r = await callJson(
    db,
    config,
    { purpose: 'hooks', model: config.llm.models.script, system: systemPrompt('hooks', brief), user, schema: Batch, maxTokens: 8000, effort: 'medium' },
    now,
  );

  const seen = new Set(existing.map((h) => h.toLowerCase()));
  const ins = db.prepare('INSERT INTO hooks (product_handle, framework, headline, say, fact_ids_json, created_at) VALUES (?,?,?,?,?,?)');
  let added = 0;
  for (const h of r.hooks) {
    const key = h.headline.trim().toLowerCase();
    if (seen.has(key) || checkHook(brief, h).length) continue;
    seen.add(key);
    ins.run(handle, h.framework, h.headline.trim(), h.say.trim(), JSON.stringify(h.factIds), now.toISOString());
    added++;
  }
  return added;
}

// Least recently used active hook that no slot in the last noRepeatDays days uses; null when none qualifies.
export function pickHook(db: Db, config: Config, productHandle: string, now: Date): Hook | null {
  const cutoff = addDays(localDateOf(now, config.timezone), -config.hooks.noRepeatDays);
  const row = db
    .prepare(
      `SELECT h.*, (SELECT MAX(local_date) FROM slots s WHERE s.hook_id = h.id) AS last_used
       FROM hooks h
       WHERE h.product_handle = ? AND h.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.hook_id = h.id AND s.local_date > ?)
       ORDER BY last_used IS NOT NULL, last_used, h.id LIMIT 1`,
    )
    .get(productHandle, cutoff) as { id: number; product_handle: string; framework: string; headline: string; say: string; fact_ids_json: string } | undefined;
  if (!row) return null;
  return { id: row.id, productHandle: row.product_handle, framework: row.framework, headline: row.headline, say: row.say, factIds: JSON.parse(row.fact_ids_json) };
}
