// The home page: a pixel-art town square. Each building is a page of the admin; the HUD around it shows the
// pipeline's state as a game would (a quest log, gold spent, a chat feed). The page reads the database only.
import { readFileSync } from 'node:fs';
import { loadEffectiveConfig } from '../config/overrides.ts';
import { kvGet, type Db } from '../db/index.ts';
import { monthSpend } from '../llm/client.ts';
import { monthSpendUsd } from '../router/index.ts';
import { localDateOf } from '../scheduler/time.ts';
import { activeHandles } from '../shopify/catalog.ts';
import { html, type Raw } from './html.ts';
import { fmtTs, layout, type Ctx, type Res } from './pages.ts';

const PNAME: Record<string, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };

export type ChatLine = { ts: string; who: string; text: string; kind: 'post' | 'make' | 'scrap' | 'alert' };
export type Quest = { text: string; href: string; urgent: boolean };
export type TownState = {
  now: string;
  dryRun: boolean;
  age: number | null;
  alive: boolean;
  waiting: number;
  attention: number;
  refused: boolean;
  next: { at: string; platform: string } | null;
  made: number;
  posted: number;
  spend: { llm: number; llmCap: number; clips: number; clipCap: number };
  products: { on: number; total: number };
  platforms: string[];
  quests: Quest[];
  chat: ChatLine[];
};

export async function townState(db: Db, now: Date): Promise<TownState> {
  const cfg = await loadEffectiveConfig(db, now);
  let st: { dryRun?: boolean; configVersion?: number | string } = {};
  try { st = JSON.parse(kvGet(db, 'pipeline_state') ?? '{}'); } catch { /* none */ }
  const hb = kvGet(db, 'heartbeat');
  const age = hb ? Math.round((now.getTime() - Date.parse(hb)) / 1000) : null;
  const one = (sql: string, ...a: string[]) => (db.prepare(sql).get(...a) as { n: number }).n;
  const nextRow = db.prepare("SELECT platform, scheduled_at FROM publications WHERE state = 'pending' AND scheduled_at > ? ORDER BY scheduled_at LIMIT 1").get(now.toISOString()) as { platform: string; scheduled_at: string } | undefined;
  const attention = one("SELECT COUNT(*) AS n FROM publications WHERE state = 'needs_attention'");
  const waiting = one("SELECT COUNT(*) AS n FROM slots WHERE hold = 'waiting'");
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const threeDays = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const handles = (db.prepare('SELECT handle FROM briefs').all() as { handle: string }[]).map((r) => r.handle);
  const act = activeHandles(db);
  const on = act ? handles.filter((h) => act.includes(h)).length || handles.length : handles.length;
  const refused = typeof st.configVersion === 'string' && st.configVersion.startsWith('refused');
  const alive = age !== null && age <= 300;
  const platforms = (['youtube', 'facebook', 'instagram', 'tiktok'] as const).filter((p) => cfg.platforms[p].enabled).map((p) => PNAME[p]);

  const quests: Quest[] = [];
  if (attention) quests.push({ text: `Help ${attention} stuck post${attention === 1 ? '' : 's'} at the notice board`, href: '/activity', urgent: true });
  if (waiting) quests.push({ text: `Decide on ${waiting} video${waiting === 1 ? '' : 's'} at the post office`, href: '/posts', urgent: true });
  if (refused) quests.push({ text: 'The town hall refused the saved settings: pick a version in the archive', href: '/history', urgent: true });
  if (!handles.length) quests.push({ text: 'Stock the market: add a product', href: '/products', urgent: true });
  if (!alive) quests.push({ text: age === null ? 'Start the pipeline: the factory has never opened' : 'Wake the factory: it has not checked in for a while', href: '/factory', urgent: true });
  if (!platforms.length) quests.push({ text: 'Open a shipping route: switch a platform on at the town hall', href: '/settings', urgent: false });
  if (!quests.length) quests.push({ text: 'Make a video now at the post office', href: '/posts', urgent: false });

  const chat: ChatLine[] = [];
  for (const r of db.prepare("SELECT slot_id, platform, published_at FROM publications WHERE state = 'published' AND published_at >= ? ORDER BY published_at DESC LIMIT 8").all(threeDays) as { slot_id: string; platform: string; published_at: string }[])
    chat.push({ ts: r.published_at, who: 'Post office', text: `Video ${r.slot_id} went out on ${PNAME[r.platform] ?? r.platform}.`, kind: 'post' });
  for (const r of db.prepare("SELECT id, status, updated_at, error FROM slots WHERE status IN ('ready','done','failed') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 8").all(threeDays) as { id: string; status: string; updated_at: string; error: string | null }[])
    chat.push(r.status === 'failed'
      ? { ts: r.updated_at, who: 'Factory', text: `Video ${r.id} went to the scrap bin${r.error ? `: ${r.error.slice(0, 90)}` : '.'}`, kind: 'scrap' }
      : { ts: r.updated_at, who: 'Factory', text: `Video ${r.id} rolled off the line.`, kind: 'make' });
  for (const r of db.prepare('SELECT ts, kind, message FROM events WHERE ts >= ? ORDER BY id DESC LIMIT 6').all(threeDays) as { ts: string; kind: string; message: string }[])
    chat.push({ ts: r.ts, who: 'Town crier', text: r.message.slice(0, 140), kind: 'alert' });
  chat.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return {
    now: now.toISOString(),
    dryRun: !!st.dryRun,
    age,
    alive,
    waiting,
    attention,
    refused,
    next: nextRow ? { at: nextRow.scheduled_at, platform: PNAME[nextRow.platform] ?? nextRow.platform } : null,
    made: one("SELECT COUNT(*) AS n FROM slots WHERE local_date = ? AND status IN ('ready','done')", localDateOf(now, cfg.timezone)),
    posted: one("SELECT COUNT(*) AS n FROM publications WHERE state = 'published' AND published_at >= ?", dayAgo),
    spend: { llm: monthSpend(db, now), llmCap: cfg.llm.monthlyCapUsd, clips: monthSpendUsd(db, 't2', now), clipCap: cfg.tiers.capsUsd.t2 },
    products: { on, total: handles.length },
    platforms,
    quests,
    chat: chat.slice(0, 12),
  };
}

export async function townJson(ctx: Ctx): Promise<Res> {
  return { status: 200, body: JSON.stringify(await townState(ctx.db, ctx.now)), type: 'application/json; charset=utf-8' };
}

// Static files, read once. They hold no data: the page and /town.json carry it.
export const TOWN_JS = readFileSync(new URL('./town.client.js', import.meta.url), 'utf8');
export const TOWN_CSS = readFileSync(new URL('./town.css', import.meta.url), 'utf8');
// Like the Factory page: one same-origin script and fetches to this origin only.
export const TOWN_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// The buildings, in the order the map lists them. The script draws them; this list is also the page's text.
export const PLACES: { href: string; place: string; page: string; what: string }[] = [
  { href: '/factory', place: 'Factory', page: 'Factory', what: 'Watch each video move down the line, live.' },
  { href: '/products', place: 'Market', page: 'Products', what: 'Choose what gets videos, add products, set the logo.' },
  { href: '/posts', place: 'Post office', page: 'Posts', what: 'Make a video now; Post or Discard it.' },
  { href: '/settings', place: 'Town hall', page: 'Settings', what: 'Times, platforms and budget, as blocks.' },
  { href: '/music', place: 'Music hall', page: 'Music', what: 'Upload and pick background music.' },
  { href: '/models', place: 'Wizard tower', page: 'Models', what: 'The video models the factory may use.' },
  { href: '/prompts', place: 'Library', page: 'Prompts', what: 'What the writers are told, and how each product looks.' },
  { href: '/activity', place: 'Notice board', page: 'Activity', what: 'Everything made, posted or stuck this week.' },
  { href: '/history', place: 'Archive', page: 'History', what: 'Earlier settings and a log of every change.' },
];

const money = (n: number) => '$' + n.toFixed(2);
const pct = (a: number, b: number) => Math.max(0, Math.min(100, b > 0 ? Math.round((a / b) * 100) : 0));

export async function townPage(ctx: Ctx): Promise<Res> {
  const s = await townState(ctx.db, ctx.now);
  const spent = s.spend.llm + s.spend.clips;
  const cap = s.spend.llmCap + s.spend.clipCap;
  const bar = (cls: string, label: string, value: number, text: string): Raw => html`<div class="bar ${cls}"><span class="bar-l">${label}</span><span class="bar-t"><meter min="0" max="100" value="${value}" aria-label="${label}">${value}%</meter><span class="bar-fill" data-fill="${cls}"></span></span><span class="bar-v" data-v="${cls}">${text}</span></div>`;
  const body = html`<div class="town">
<div class="town-stage">
<div class="hud-strip">
<div class="hud hud-me"><span class="me-face" aria-hidden="true"></span><div><b>Factory owner</b>
${bar('hp', 'Factory', s.alive ? 100 : 15, s.age === null ? 'never checked in' : s.alive ? 'running' : `quiet ${s.age} s`)}
${bar('mp', 'Budget', 100 - pct(spent, cap), `${money(cap - spent)} left`)}</div></div>
<div class="hud hud-gold" title="Spent this month on writers and clips"><span class="coin" aria-hidden="true"></span><b data-gold>${money(spent)}</b><small>of ${money(cap)}</small></div>
${s.dryRun ? html`<div class="hud hud-mode">Practice mode: nothing is published</div>` : ''}
</div>
<canvas id="town" class="tw" width="544" height="320" tabindex="0" role="img" aria-label="The town square seen from above. Each building is a page: walk your character to a door, or click a building, to go in. The map in the header lists the same places." data-state="${JSON.stringify(s)}">The town needs JavaScript and canvas. Use the Map in the header, or the list below.</canvas>
<p class="town-hint" data-hint>Walk with the arrow keys or WASD. Press E at a door to go in, or just click a building.</p>
</div>
<aside class="town-side">
<section class="hud-panel quests"><h2>Quest log</h2><ul data-quests>${s.quests.map((q) => html`<li class="${q.urgent ? 'urgent' : ''}"><a href="${q.href}">${q.text}</a></li>`)}</ul></section>
<section class="hud-panel today"><h2>Today</h2><dl>
<dt>Made</dt><dd data-made>${s.made}</dd><dt>Posted (24 h)</dt><dd data-posted>${s.posted}</dd>
<dt>Next post</dt><dd data-next>${s.next ? `${fmtTs(s.next.at).slice(11, 16)}Z, ${s.next.platform}` : 'none planned'}</dd>
<dt>Products in turn</dt><dd data-products>${s.products.on} of ${s.products.total}</dd></dl></section>
<section class="hud-panel chat"><h2>Town chat</h2><ol data-chat>${s.chat.length ? s.chat.map((c) => html`<li class="c-${c.kind}"><time>${fmtTs(c.ts).slice(11, 16)}</time> <b>[${c.who}]</b> ${c.text}</li>`) : html`<li class="muted">All quiet in town.</li>`}</ol></section>
</aside>
</div>
<nav class="town-dir" aria-label="Buildings"><h2>Buildings</h2><ul>${PLACES.map((p) => html`<li><a href="${p.href}"><b>${p.place}</b> <span class="muted">${p.page}</span><small>${p.what}</small></a></li>`)}</ul></nav>`;
  const r = layout(ctx, 'Town square', '/overview', body, html`<link rel="stylesheet" href="/town.css"><script src="/town.js" defer></script>`);
  return { ...r, headers: { ...r.headers, 'content-security-policy': TOWN_CSP } };
}
