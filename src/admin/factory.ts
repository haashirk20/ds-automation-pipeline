// The Factory page: the pipeline drawn as a factory floor. Each slot is a crate that rides a conveyor
// belt from station to station. The page reads the database only; it never writes and never calls out.
import { readFileSync } from 'node:fs';
import { kvGet, type Db } from '../db/index.ts';
import { loadEffectiveConfig } from '../config/overrides.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import { html } from './html.ts';
import { layout, type Ctx, type Res } from './pages.ts';

export const STAGES = ['dock', 'design', 'foundry', 'inspect', 'paint', 'label', 'gate', 'shipping'] as const;
export type Stage = (typeof STAGES)[number] | 'shipped' | 'scrap';

export const STATION: Record<(typeof STAGES)[number], { name: string; what: string }> = {
  dock: { name: 'Loading dock', what: 'Planned slots wait here for the producer' },
  design: { name: 'Concept studio', what: 'Brief from Shopify, concept writer, claim judge' },
  foundry: { name: 'Clip foundry', what: 'Higgsfield makes the 15 s clip (or a stored clip is pulled)' },
  inspect: { name: 'Inspection', what: 'Frame check against the product photos' },
  paint: { name: 'Caption shop', what: 'Caption render, music, loudness and the QA gate' },
  label: { name: 'Label press', what: 'Titles, captions and hashtags, then the copy judge' },
  gate: { name: 'Approval gate', what: 'Manual posts wait here for Post or Discard' },
  shipping: { name: 'Shipping docks', what: 'Publishing to YouTube, Facebook, Instagram and TikTok' },
};

const PLATFORMS = ['youtube', 'facebook', 'instagram', 'tiktok'] as const;

type SlotRow = { id: string; kind: string; status: string; tier: string | null; attempt: number; error: string | null; master_json: string | null; hold: string | null; claimed_at: string | null; updated_at: string };
type Pub = { p: string; s: string };
export type FactorySlot = { id: string; kind: string; stage: Stage; caption: string; tier: string | null; attempt: number; hold: string | null; error: string | null; pubs: Pub[] };
export type FactoryState = {
  now: string;
  dryRun: boolean;
  heartbeatAge: number | null;
  slots: FactorySlot[];
  published: Record<string, number>; // last 24 h, per platform
  uploading: Record<string, number>;
  scrapped: number; // last 24 h
};

// Where a slot is on the line. Production sub-steps are read from what the producer has already written:
// the concept in master_json, the spend ledger, and the model calls logged against the slot since its claim.
export function stageOf(s: Pick<SlotRow, 'status' | 'hold' | 'master_json'>, purposes: Set<string>, spend: string[], pubs: Pub[]): Stage {
  if (s.status === 'failed') return 'scrap';
  if (s.status === 'done') return s.hold === 'discarded' || s.hold === 'expired' || !pubs.some((p) => p.s === 'published') ? 'scrap' : 'shipped';
  if (s.status === 'ready') return s.hold === 'waiting' ? 'gate' : 'shipping';
  if (s.status === 'planned') return 'dock';
  if (purposes.has('copy') || purposes.has('copycheck')) return 'label';
  if (purposes.has('vision')) return 'paint';
  if (spend.includes('succeeded')) return 'inspect';
  if (s.master_json) return 'foundry';
  return 'design';
}

const captionOf = (m: string | null): string => {
  try {
    const c = JSON.parse(m ?? 'null')?.concept?.caption;
    return typeof c === 'string' ? c.slice(0, 140) : '';
  } catch {
    return '';
  }
};

export async function factoryState(db: Db, now: Date): Promise<FactoryState> {
  const cfg = await loadEffectiveConfig(db, now);
  const today = localDateOf(now, cfg.timezone);
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const rows = db
    .prepare("SELECT id, kind, status, tier, attempt, error, master_json, hold, claimed_at, updated_at FROM slots WHERE status IN ('planned','producing','ready') OR (local_date >= ? AND updated_at >= ?) ORDER BY id LIMIT 60")
    .all(addDays(today, -1), dayAgo) as SlotRow[];
  const pubQ = db.prepare('SELECT platform AS p, state AS s FROM publications WHERE slot_id = ? ORDER BY platform');
  const llmQ = db.prepare('SELECT DISTINCT purpose FROM llm_calls WHERE slot_id = ? AND ts >= ?');
  const spendQ = db.prepare('SELECT state FROM spend WHERE slot_id = ?');
  const slots = rows.map((r): FactorySlot => {
    const pubs = pubQ.all(r.id) as Pub[];
    const purposes = new Set(r.status === 'producing' && r.claimed_at ? (llmQ.all(r.id, r.claimed_at) as { purpose: string }[]).map((x) => x.purpose) : []);
    const spend = r.status === 'producing' ? (spendQ.all(r.id) as { state: string }[]).map((x) => x.state) : [];
    return { id: r.id, kind: r.kind, stage: stageOf(r, purposes, spend, pubs), caption: captionOf(r.master_json), tier: r.tier, attempt: r.attempt, hold: r.hold, error: r.error ? r.error.slice(0, 200) : null, pubs };
  });
  const count = (sql: string, ...a: string[]) => {
    const o: Record<string, number> = Object.fromEntries(PLATFORMS.map((p) => [p, 0]));
    for (const r of db.prepare(sql).all(...a) as { platform: string; n: number }[]) o[r.platform] = r.n;
    return o;
  };
  let st: { dryRun?: boolean } = {};
  try { st = JSON.parse(kvGet(db, 'pipeline_state') ?? '{}'); } catch { /* none */ }
  const hb = kvGet(db, 'heartbeat');
  return {
    now: now.toISOString(),
    dryRun: !!st.dryRun,
    heartbeatAge: hb ? Math.round((now.getTime() - Date.parse(hb)) / 1000) : null,
    slots,
    published: count("SELECT platform, COUNT(*) AS n FROM publications WHERE state = 'published' AND published_at >= ? GROUP BY platform", dayAgo),
    uploading: count("SELECT platform, COUNT(*) AS n FROM publications WHERE state = 'uploading' GROUP BY platform"),
    scrapped: slots.filter((s) => s.stage === 'scrap').length,
  };
}

export async function factoryJson(ctx: Ctx): Promise<Res> {
  return { status: 200, body: JSON.stringify(await factoryState(ctx.db, ctx.now)), type: 'application/json; charset=utf-8' };
}

// Static files, read once. They hold no data: the page and /factory.json carry it.
export const FACTORY_JS = readFileSync(new URL('./factory.client.js', import.meta.url), 'utf8');
export const FACTORY_CSS = readFileSync(new URL('./factory.css', import.meta.url), 'utf8');

// The page allows exactly one script, /factory.js, from this origin, and fetch to this origin. Every other page keeps the no-script policy.
export const FACTORY_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";


// ---------- the page ----------
// The floor is one canvas that /factory.js draws as a top-down pixel-art factory. Everything a reader needs
// without the picture is also in the HTML: the station list with counts, the sent counters and the line board.

export async function factoryPage(ctx: Ctx): Promise<Res> {
  const st = await factoryState(ctx.db, ctx.now);
  const demo = ctx.query.get('demo') === '1';
  const active = st.slots.filter((s) => s.stage !== 'shipped' && s.stage !== 'scrap');
  const name = (s: Stage) => (s === 'shipped' ? 'Shipped' : s === 'scrap' ? 'Scrap bin' : STATION[s].name);
  const count = (k: Stage) => st.slots.filter((s) => s.stage === k).length;
  const body = html`<div class="f-bar">
<span class="f-hb" data-hb>${st.heartbeatAge === null ? 'Pipeline never ticked' : st.heartbeatAge > 300 ? `Pipeline stale (${st.heartbeatAge} s)` : `Pipeline alive (${st.heartbeatAge} s ago)`}</span>
<span class="f-up muted" data-updated>Updated ${st.now.slice(11, 19)}Z</span>
<button type="button" class="f-still" data-still aria-pressed="false" hidden>Pause animation</button>
${demo ? html`<a class="f-demo on" href="/factory">Demo running: show the real floor</a>` : html`<a class="f-demo" href="/factory?demo=1">Run a demo shift</a>`}
</div>
${demo ? html`<p class="banner">Demo shift: made-up crates, not your pipeline. Nothing is read or written.</p>` : ''}
<div class="fx-wrap">
<canvas id="factory" class="fx" width="544" height="320" tabindex="0" role="img" aria-label="Factory floor seen from above. Each crate is a slot riding the conveyor belt from station to station. The station list and the line board below say the same in text." data-demo="${demo ? '1' : '0'}" data-state="${JSON.stringify(st)}">The factory floor needs JavaScript and canvas. The station list and the line board below are current as of page load.</canvas>
</div>
<ol class="fx-legend">
${STAGES.map((k) => html`<li data-station="${k}"${count(k) ? html` class="busy"` : ''}><span class="fx-n"></span><span class="fx-t"><b>${STATION[k].name}</b><small>${STATION[k].what}</small></span><b class="count" data-count="${k}">${count(k)}</b></li>`)}
</ol>
<p class="fx-sent muted">Sent in 24 h: ${PLATFORMS.map((p) => html`<span>${p} <b data-n="${p}">${st.published[p] ?? 0}</b></span> `)}· scrapped <b data-scrapn>${st.scrapped}</b>. Click a crate, a machine or a truck. Blue-taped crates are manual posts.</p>
<div class="panel inspector" data-inspector aria-live="polite"><p class="muted">Click a crate, a machine or a truck on the floor to see what is happening there.</p></div>
<h2>Line board</h2>
<div class="scroll"><table><thead><tr><th>Crate (slot)</th><th>Kind</th><th>Station</th><th>Caption</th><th>Platforms</th></tr></thead><tbody data-board>
${active.length ? active.map((s) => html`<tr><td class="nw">${s.id}</td><td>${s.kind}</td><td>${name(s.stage)}</td><td>${s.caption}</td><td>${s.pubs.map((p) => `${p.p}: ${p.s}`).join(', ')}</td></tr>`) : html`<tr><td colspan="5" class="muted">The line is empty. Nothing is planned or in production.</td></tr>`}
</tbody></table></div>`;
  const r = layout(ctx, 'Factory', '/factory', body, html`<link rel="stylesheet" href="/factory.css"><script src="/factory.js" defer></script>`);
  return { ...r, headers: { ...r.headers, 'content-security-policy': FACTORY_CSP } };
}
