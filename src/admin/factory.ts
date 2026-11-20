// The Factory page: the pipeline drawn as a factory floor. Each slot is a crate that rides a conveyor
// belt from station to station. The page reads the database only; it never writes and never calls out.
import { readFileSync } from 'node:fs';
import { autoPaused, kvGet, type Db } from '../db/index.ts';
import { loadEffectiveConfig } from '../config/overrides.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import { html } from './html.ts';
import { layout, PNAME, type Ctx, type Res } from './pages.ts';
import { badge, fmtLocal } from './ui.ts';

export const STAGES = ['dock', 'design', 'foundry', 'inspect', 'paint', 'label', 'gate', 'shipping'] as const;
export type Stage = (typeof STAGES)[number] | 'shipped' | 'scrap';

export const STATION: Record<(typeof STAGES)[number], { name: string; what: string }> = {
  dock: { name: 'Loading dock', what: 'Videos planned next wait here' },
  design: { name: 'Concept studio', what: 'Reads the product page, writes the idea, checks the ad only says what the page says' },
  foundry: { name: 'Clip foundry', what: 'Makes the 15 second video clip (or reuses one you already have)' },
  inspect: { name: 'Inspection', what: 'Checks the clip looks like your product photos' },
  paint: { name: 'Caption shop', what: 'Adds captions and music, evens out the sound, then the quality check' },
  label: { name: 'Label press', what: 'Writes titles, captions and hashtags, then checks them' },
  gate: { name: 'Approval gate', what: 'Videos you made by hand wait here for Post it or Discard' },
  shipping: { name: 'Shipping docks', what: 'Posts to YouTube, Facebook, Instagram and TikTok' },
};

const PLATFORMS = ['youtube', 'facebook', 'instagram', 'tiktok'] as const;

type SlotRow = { id: string; kind: string; idx: number; when_at: string | null; made_at: string; product: string | null; status: string; tier: string | null; attempt: number; error: string | null; master_json: string | null; hold: string | null; claimed_at: string | null; updated_at: string };
type Pub = { p: string; s: string };
export type FactorySlot = { id: string; kind: string; idx: number; when: string | null; name: string; stage: Stage; caption: string; tier: string | null; attempt: number; hold: string | null; error: string | null; pubs: Pub[] };
export type FactoryState = {
  now: string;
  tz: string; // the shop's time zone, so the page script can show local times
  dryRun: boolean;
  heartbeatAge: number | null;
  slots: FactorySlot[];
  published: Record<string, number>; // today (the shop's local day), per platform
  uploading: Record<string, number>;
  scrapped: number; // among the videos listed
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
    .prepare("SELECT s.id, s.kind, s.idx, (SELECT MIN(scheduled_at) FROM publications WHERE slot_id = s.id) AS when_at, s.created_at AS made_at, (SELECT title FROM products WHERE handle = s.product_handle) AS product, s.status, s.tier, s.attempt, s.error, s.master_json, s.hold, s.claimed_at, s.updated_at FROM slots s WHERE s.status IN ('planned','producing','ready') OR (local_date >= ? AND updated_at >= ?) ORDER BY s.id LIMIT 60")
    .all(addDays(today, -1), dayAgo) as SlotRow[];
  const pubQ = db.prepare('SELECT platform AS p, state AS s FROM publications WHERE slot_id = ? ORDER BY platform');
  const llmQ = db.prepare('SELECT DISTINCT purpose FROM llm_calls WHERE slot_id = ? AND ts >= ?');
  const spendQ = db.prepare('SELECT state FROM spend WHERE slot_id = ?');
  const slots = rows.map((r): FactorySlot => {
    const pubs = pubQ.all(r.id) as Pub[];
    const purposes = new Set(r.status === 'producing' && r.claimed_at ? (llmQ.all(r.id, r.claimed_at) as { purpose: string }[]).map((x) => x.purpose) : []);
    const spend = r.status === 'producing' ? (spendQ.all(r.id) as { state: string }[]).map((x) => x.state) : [];
    return { id: r.id, kind: r.kind, idx: r.idx, when: r.kind === 'manual' ? r.made_at : r.when_at ?? r.updated_at, name: '', stage: stageOf(r, purposes, spend, pubs), caption: captionOf(r.master_json), tier: r.tier, attempt: r.attempt, hold: r.hold, error: r.error ? r.error.slice(0, 200) : null, pubs };
  });
  // Name each video by when it goes out (or was made) and which post it is; add the product, and a number if two still read the same.
  const seen = new Map<string, number>();
  for (const s of slots) {
    const prod = rows.find((r) => r.id === s.id)?.product;
    const base = slotName(s, cfg.timezone) + (s.kind === 'manual' && prod ? `: ${prod}` : '');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    s.name = n > 1 ? `${base} (video ${n})` : base;
  }
  const count = (sql: string, ...a: string[]) => {
    const o: Record<string, number> = Object.fromEntries(PLATFORMS.map((p) => [p, 0]));
    for (const r of db.prepare(sql).all(...a) as { platform: string; n: number }[]) o[r.platform] = r.n;
    return o;
  };
  // Posts sent today, in the shop's local day, as Home counts them.
  const published: Record<string, number> = Object.fromEntries(PLATFORMS.map((p) => [p, 0]));
  for (const r of db.prepare("SELECT platform, published_at FROM publications WHERE state = 'published' AND published_at >= ?").all(new Date(now.getTime() - 2 * 86_400_000).toISOString()) as { platform: string; published_at: string }[])
    if (localDateOf(new Date(r.published_at), cfg.timezone) === today) published[r.platform] = (published[r.platform] ?? 0) + 1;
  let st: { dryRun?: boolean } = {};
  try { st = JSON.parse(kvGet(db, 'pipeline_state') ?? '{}'); } catch { /* none */ }
  const hb = kvGet(db, 'heartbeat');
  return {
    now: now.toISOString(),
    tz: cfg.timezone,
    dryRun: !!st.dryRun,
    heartbeatAge: hb ? Math.round((now.getTime() - Date.parse(hb)) / 1000) : null,
    slots,
    published,
    uploading: count("SELECT platform, COUNT(*) AS n FROM publications WHERE state = 'uploading' GROUP BY platform"),
    scrapped: slots.filter((s) => s.stage === 'scrap').length,
  };
}

// Plain name of a slot for the owner: when it goes out and which post it is.
export const slotName = (s: Pick<FactorySlot, 'kind' | 'idx' | 'when'>, tz: string): string =>
  `${fmtLocal(s.when, tz)}, ${s.kind === 'manual' ? 'Made now' : `Post ${s.idx}`}`;
export const PUB_WORD: Record<string, string> = { pending: 'Waiting', uploading: 'Posting', published: 'Posted', skipped: 'Skipped', needs_attention: 'Needs you' };

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
// without the picture is also in the HTML: the station list with counts, the sent counters and the video list.

export async function factoryPage(ctx: Ctx): Promise<Res> {
  const st = await factoryState(ctx.db, ctx.now);
  const demo = ctx.query.get('demo') === '1';
  const paused = !!autoPaused(ctx.db);
  const active = st.slots.filter((s) => s.stage !== 'shipped' && s.stage !== 'scrap').sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''));
  const name = (s: Stage) => (s === 'shipped' ? 'Shipped' : s === 'scrap' ? 'Thrown away' : STATION[s].name);
  const count = (k: Stage) => st.slots.filter((s) => s.stage === k).length;
  const body = html`<div class="f-bar">
<span class="f-hb" data-hb>${st.heartbeatAge === null ? 'Factory not started yet' : st.heartbeatAge > 300 ? 'Factory stopped: no sign of life for a while' : 'Factory running'}</span>
${paused ? html`${badge('warn', 'Daily posts stopped by you')}<a class="btn" href="/overview#auto">Start on Home</a>` : ''}
<span class="f-up muted" data-updated>Updated ${fmtLocal(st.now, st.tz).slice(-5)}</span>
<button type="button" class="f-still" data-still aria-pressed="false" hidden>Pause animation</button>
${demo ? html`<a class="btn primary f-demo" href="/factory">Demo running: show the real floor</a>` : html`<a class="btn f-demo" href="/factory?demo=1">Run a demo shift</a>`}
</div>
${demo ? html`<p class="banner">Demo shift: made-up crates, not your pipeline. Nothing is read or written.</p>` : ''}
<div class="fx-wrap">
<canvas id="factory" class="fx" width="544" height="320" tabindex="0" role="img" aria-label="Factory floor seen from above. Each crate is a video riding the conveyor belt from station to station. The station list and the video list below say the same in text." data-demo="${demo ? '1' : '0'}" data-state="${JSON.stringify(st)}">The factory floor needs JavaScript and canvas. The station list and the video list below are current as of page load.</canvas>
</div>
<ol class="fx-legend">
${STAGES.map((k) => html`<li data-station="${k}"${count(k) ? html` class="busy"` : ''}><span class="fx-n"></span><span class="fx-t"><b>${STATION[k].name}</b><small>${STATION[k].what}</small></span><span class="count"><b data-count="${k}">${count(k)}</b> here</span></li>`)}
</ol>
<p class="fx-sent muted">Posted today: ${PLATFORMS.map((p) => html`<span>${PNAME[p]} <b data-n="${p}">${st.published[p] ?? 0}</b></span> `)}· thrown away <b data-scrapn>${st.scrapped}</b>. Click a crate, a machine or a truck. Blue-taped crates are videos you made by hand.</p>
<div class="card inspector" data-inspector aria-live="polite"><p class="muted">Click a crate, a machine or a truck on the floor to see what is happening there.</p></div>
<h2>On the line</h2>
<div class="scroll"><table><thead><tr><th>Video</th><th>Station</th><th>Caption</th><th>Platforms</th></tr></thead><tbody data-board>
${active.length ? active.map((s) => html`<tr><td class="nw">${s.name}</td><td>${paused && s.kind === 'planned' && s.stage === 'dock' ? 'Held: stopped by you' : name(s.stage)}</td><td>${s.caption}</td><td>${s.pubs.map((p) => `${PNAME[p.p] ?? p.p}: ${PUB_WORD[p.s] ?? p.s}`).join(', ')}</td></tr>`) : html`<tr><td colspan="4" class="muted">The line is empty. Nothing is planned or in production.</td></tr>`}
</tbody></table></div>`;
  const r = layout(ctx, 'Factory', '/factory', body, html`<link rel="stylesheet" href="/factory.css"><script src="/factory.js" defer></script>`);
  return { ...r, headers: { ...r.headers, 'content-security-policy': FACTORY_CSP } };
}
