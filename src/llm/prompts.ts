import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Brief } from '../contracts.ts';
import { audit } from '../config/overrides.ts';
import { dollarProblems, languageProblems, urlsIn } from '../creative/claims.ts';
import { kvGet, type Db } from '../db/index.ts';

// The texts the admin page may change. claims, copycheck and vision are never editable.
export const EDITABLE_TEXT = ['ugc', 'ugc-asmr', 'copy', 'hooks', 'script', 'video', 'house'] as const;
const WRITERS: readonly string[] = ['ugc', 'ugc-asmr', 'copy', 'hooks', 'script']; // these get the house text first
const LIMITS: Record<string, number> = { ugc: 20000, 'ugc-asmr': 20000, copy: 20000, hooks: 20000, script: 20000, video: 4000, house: 4000, note: 1000 };
const LINTED = ['video', 'house', 'note'];

const isNote = (key: string) => key.startsWith('note:') && key.length > 5;
export const isEditable = (key: string) => (EDITABLE_TEXT as readonly string[]).includes(key) || isNote(key);

let active: Record<string, string> = {};
// Set once per process, so the system text stays byte-identical and the prompt cache holds.
export function usePrompts(map: Record<string, string>): void {
  active = { ...map };
}

// The text the file holds. Only house.md may be missing; it then adds nothing.
export function fileText(key: string): string {
  try {
    return readFileSync(join(import.meta.dirname, '../../prompts', `${key}.md`), 'utf8').trimEnd();
  } catch (e) {
    if (key === 'house') return '';
    throw e;
  }
}

export const activeText = (key: string): string | undefined => (isEditable(key) ? active[key] : undefined);
export const promptText = (key: string): string => (activeText(key) ?? fileText(key)).trimEnd();

// The system text for a purpose: the rules plus the brief, with the house text first for the writers.
// Fixed key order and no timestamps, so it is byte-identical across calls.
export function systemPrompt(purpose: 'hooks' | 'script' | 'claims' | 'copy' | 'copycheck' | 'ugc' | 'ugc-asmr' | 'vision', brief: Brief): string {
  const house = WRITERS.includes(purpose) ? promptText('house') : '';
  const rules = (house ? `${house}\n\n` : '') + promptText(purpose);
  const b = {
    shop: { name: brief.shop.name, domain: brief.shop.domain, currency: brief.shop.currency, shipsTo: brief.shop.shipsTo },
    product: { handle: brief.product.handle, title: brief.product.title, url: brief.product.url, type: brief.product.type, priceText: brief.product.priceText, colors: brief.product.colors },
    facts: brief.facts.map((f) => ({ id: f.id, text: f.text })),
    disclosures: brief.disclosures,
    angles: brief.angles,
    shots: brief.shots.map((s) => ({ id: s.id, kind: s.kind, variant: s.variant, note: s.note })),
    rules: { discountClaims: brief.rules.discountClaims, reviewClaims: brief.rules.reviewClaims },
  };
  return `${rules}\n\n<brief>\n${JSON.stringify(b, null, 1)}\n</brief>`;
}

// The active stored texts, for usePrompts. A pointer to a locked or missing text is ignored.
export function loadPrompts(db: Db): Record<string, string> {
  const rows = db.prepare("SELECT substr(k.key, 13) AS key, v.body FROM kv k JOIN text_versions v ON v.id = CAST(k.value AS INTEGER) AND v.key = substr(k.key, 13) WHERE k.key LIKE 'text_active:%'").all() as { key: string; body: string }[];
  return Object.fromEntries(rows.filter((r) => isEditable(r.key)).map((r) => [r.key, r.body]));
}

const activeId = (db: Db, key: string): number | null => {
  const v = kvGet(db, `text_active:${key}`);
  return v === undefined ? null : Number(v);
};

// Video, house and note texts reach the video model or every writer, so they get the claim checks of a caption.
function lint(db: Db, key: string, body: string): string[] {
  const rows = db.prepare(isNote(key) ? 'SELECT json FROM briefs WHERE handle = ?' : 'SELECT json FROM briefs').all(...(isNote(key) ? [key.slice(5)] : [])) as { json: string }[];
  const out: string[] = [];
  for (const r of rows) {
    const brief = JSON.parse(r.json) as Brief;
    out.push(...languageProblems(brief, body, key), ...dollarProblems(brief, body, key));
  }
  if (urlsIn(body).length) out.push(`${key}: has a link`);
  return [...new Set(out)];
}

export function saveText(db: Db, key: string, body: string, baseId: number | null, note: string, now: Date): { id: number } | { errors: string[] } {
  if (!isEditable(key)) return { errors: [`${key} is not editable`] };
  const kind = isNote(key) ? 'note' : key;
  const errors: string[] = [];
  if (body.length > LIMITS[kind]) errors.push(`${key} is ${body.length} characters, at most ${LIMITS[kind]}`);
  if (!body.trim() && kind !== 'house') errors.push(`${key} is empty`);
  if (LINTED.includes(kind) && !errors.length) errors.push(...lint(db, key, body));
  if (errors.length) return { errors };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (activeId(db, key) !== baseId) {
      db.exec('ROLLBACK');
      return { errors: [`${key} changed since you opened it; reload and try again`] };
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    const id = Number(db.prepare('INSERT INTO text_versions (key, body, sha256, created_at, note) VALUES (?, ?, ?, ?, ?)').run(key, body, sha256, now.toISOString(), note).lastInsertRowid);
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`text_active:${key}`, String(id));
    audit(db, 'admin', 'text.save', key, { id, sha256, length: body.length }, now);
    db.exec('COMMIT');
    return { id };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// id null = use the file again.
export function activateText(db: Db, key: string, id: number | null, now: Date): void {
  if (!isEditable(key)) throw new Error(`${key} is not editable`);
  if (id !== null && !db.prepare('SELECT 1 FROM text_versions WHERE id = ? AND key = ?').get(id, key)) throw new Error(`no version ${id} of ${key}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (id === null) db.prepare('DELETE FROM kv WHERE key = ?').run(`text_active:${key}`);
    else db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`text_active:${key}`, String(id));
    audit(db, 'admin', id === null ? 'text.reset' : 'text.activate', key, { id }, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
