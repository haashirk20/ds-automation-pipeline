// The Factory page: the pipeline drawn as a factory floor. Each slot is a crate that rides a conveyor
// belt from station to station. The page reads the database only; it never writes and never calls out.
import { readFileSync } from 'node:fs';
import { kvGet, type Db } from '../db/index.ts';
import { loadEffectiveConfig } from '../config/overrides.ts';
import { addDays, localDateOf } from '../scheduler/time.ts';
import { html, raw, type Raw } from './html.ts';
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

// ---------- the drawing ----------

// A gear outline with a hole, centred on 0,0.
function gearPath(teeth: number, ro: number, ri: number, hole: number): string {
  const pts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  const f = (a: number, r: number) => `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    pts.push(f(a, ri), f(a + step * 0.15, ro), f(a + step * 0.45, ro), f(a + step * 0.6, ri));
  }
  return `M${pts.join('L')}Z M${hole},0 A${hole},${hole} 0 1 0 ${-hole},0 A${hole},${hole} 0 1 0 ${hole},0Z`;
}

const DEFS = raw(`<svg class="defs" aria-hidden="true" focusable="false"><defs>
<symbol id="gear" viewBox="-12 -12 24 24"><path fill-rule="evenodd" d="${gearPath(10, 11.5, 8.6, 3.2)}"/></symbol>
<pattern id="hazard" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="12" height="12" class="hz-a"/><rect width="6" height="12" class="hz-b"/></pattern>
<radialGradient id="fire" cx="50%" cy="80%" r="75%"><stop offset="0" stop-color="#fff3b0"/><stop offset=".35" stop-color="#ffb347"/><stop offset=".75" stop-color="#e8502a"/><stop offset="1" stop-color="#5a1408"/></radialGradient>
<linearGradient id="steel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d7f94"/><stop offset="1" stop-color="#3a4553"/></linearGradient>
<linearGradient id="steelDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#465464"/><stop offset="1" stop-color="#262e38"/></linearGradient>
<clipPath id="doorClip"><rect x="18" y="34" width="98" height="106"/></clipPath>
<clipPath id="screenClip"><rect x="28" y="34" width="70" height="48" rx="2"/></clipPath>
</defs></svg>`);

const gear = (x: number, y: number, size: number, cls: string) => `<use href="#gear" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" class="gear ${cls}"/>`;
const slats = (n: number, x: number, y: number, w: number, h: number) => Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * h}" width="${w}" height="${h - 1.5}" class="slat"/>`).join('');
const lines = Array.from({ length: 14 }, (_, i) => `<rect x="32" y="${38 + i * 7}" width="${[52, 38, 60, 30, 46, 56, 24][i % 7]}" height="3" rx="1.5" class="code c${i % 3}"/>`).join('');

const MACHINES: Record<(typeof STAGES)[number], string> = {
  dock: `<rect x="6" y="18" width="148" height="122" rx="4" fill="url(#steelDark)"/>
<rect x="6" y="18" width="148" height="9" fill="url(#hazard)"/>
<rect x="18" y="34" width="98" height="106" class="void"/>
<g clip-path="url(#doorClip)"><g class="door act">${slats(9, 18, 34, 98, 8)}<rect x="18" y="104" width="98" height="4" class="door-lip"/></g></g>
<g class="crate-stack"><rect x="122" y="114" width="26" height="26" class="box"/><rect x="124" y="90" width="22" height="22" class="box"/><rect x="122" y="125" width="26" height="3" class="tape"/><rect x="124" y="99" width="22" height="3" class="tape"/></g>
<g class="hoist act"><line x1="66" y1="34" x2="66" y2="70" class="cable"/><rect x="56" y="70" width="20" height="16" class="box"/><rect x="56" y="76" width="20" height="3" class="tape"/></g>
<circle cx="140" cy="38" r="6" class="beacon amb"/>`,
  design: `<rect x="12" y="94" width="136" height="46" rx="4" fill="url(#steel)"/>
<rect x="24" y="30" width="78" height="56" rx="4" class="bezel"/><rect x="28" y="34" width="70" height="48" rx="2" class="screen"/>
<g clip-path="url(#screenClip)"><g class="scroll act">${lines}</g></g>
<rect x="58" y="86" width="10" height="8" class="bezel"/>
<circle cx="126" cy="34" r="11" class="bulb amb"/><rect x="121" y="45" width="10" height="7" rx="1" class="metal"/>
<rect x="117" y="56" width="6" height="22" class="metal"/>
<g class="stamp act"><rect x="118" y="52" width="4" height="28" class="rod"/><rect x="106" y="78" width="28" height="12" rx="2" class="stamp-head"/><text x="120" y="87" class="stamp-txt">OK</text></g>
${gear(30, 112, 22, 'spin amb')}${gear(48, 120, 14, 'spin rev amb')}`,
  foundry: `<rect x="110" y="4" width="20" height="50" fill="url(#steelDark)"/><rect x="107" y="4" width="26" height="6" class="metal"/>
<circle cx="120" cy="2" r="7" class="smoke s1 amb"/><circle cx="120" cy="2" r="9" class="smoke s2 amb"/><circle cx="120" cy="2" r="6" class="smoke s3 amb"/>
<rect x="12" y="40" width="136" height="100" rx="10" fill="url(#steelDark)"/>
<path d="M36 140 V100 a34 30 0 0 1 68 0 V140 Z" class="mouth-rim"/>
<path d="M42 140 V102 a28 25 0 0 1 56 0 V140 Z" fill="url(#fire)" class="fire amb"/>
<g class="reel spin act"><circle cx="70" cy="114" r="14" class="reel-disc"/><circle cx="70" cy="106" r="3" class="reel-hole"/><circle cx="77" cy="118" r="3" class="reel-hole"/><circle cx="63" cy="118" r="3" class="reel-hole"/></g>
<circle cx="128" cy="70" r="12" class="gauge"/><line x1="128" y1="70" x2="128" y2="61" class="needle amb"/><circle cx="128" cy="70" r="2" class="metal"/>
${gear(28, 60, 24, 'spin amb')}${gear(46, 52, 15, 'spin rev amb')}`,
  inspect: `<path d="M16 140 V48 a64 42 0 0 1 128 0 V140 h-14 V50 a50 30 0 0 0 -100 0 V140 Z" fill="url(#steel)"/>
<rect x="74" y="4" width="12" height="10" class="metal"/><circle cx="80" cy="14" r="6" class="lamp-g amb"/>
<circle cx="80" cy="38" r="10" class="lens"/><circle cx="80" cy="38" r="4" class="pupil act"/>
<rect x="34" y="52" width="3" height="88" class="beam act"/>
<rect x="30" y="136" width="100" height="4" class="scan-floor"/>`,
  paint: `<rect x="8" y="16" width="144" height="12" rx="3" fill="url(#steel)"/>
<rect x="8" y="16" width="9" height="124" fill="url(#steelDark)"/><rect x="143" y="16" width="9" height="124" fill="url(#steelDark)"/>
<rect x="42" y="28" width="16" height="20" rx="2" class="metal"/><rect x="102" y="28" width="16" height="20" rx="2" class="metal"/>
<polygon points="44,48 56,48 70,108 30,108" class="spray sp1 act"/><polygon points="104,48 116,48 130,108 90,108" class="spray sp2 act"/>
<circle cx="50" cy="56" r="2.5" class="drip d1 act"/><circle cx="110" cy="56" r="2.5" class="drip d2 act"/>
<rect x="22" y="2" width="28" height="14" rx="2" class="can c1"/><rect x="110" y="2" width="28" height="14" rx="2" class="can c2"/>
<text x="80" y="12" class="paint-txt amb">Aa</text>`,
  label: `<rect x="26" y="8" width="108" height="18" rx="3" fill="url(#steel)"/>
<rect x="26" y="8" width="12" height="132" fill="url(#steelDark)"/><rect x="122" y="8" width="12" height="132" fill="url(#steelDark)"/>
<rect x="68" y="26" width="24" height="26" class="metal"/>
<g class="press act"><rect x="75" y="48" width="10" height="42" class="rod"/><rect x="46" y="88" width="68" height="16" rx="2" class="press-head"/><text x="80" y="100" class="press-txt">#TAG</text></g>
<g class="sparks act"><line x1="48" y1="132" x2="38" y2="124" class="spark"/><line x1="112" y1="132" x2="122" y2="124" class="spark"/><line x1="54" y1="134" x2="50" y2="120" class="spark"/><line x1="106" y1="134" x2="110" y2="120" class="spark"/></g>
${gear(44, 17, 16, 'spin amb')}${gear(116, 17, 16, 'spin rev amb')}`,
  gate: `<rect x="8" y="46" width="48" height="94" rx="4" fill="url(#steelDark)"/><rect x="4" y="40" width="56" height="8" rx="2" class="metal"/>
<rect x="16" y="58" width="32" height="24" rx="2" class="booth-win"/><circle cx="32" cy="74" r="6" class="guard"/>
<rect x="64" y="36" width="20" height="44" rx="5" class="tl"/><circle cx="74" cy="48" r="6" class="tl-red"/><circle cx="74" cy="67" r="6" class="tl-green"/>
<rect x="70" y="80" width="8" height="60" class="metal"/>
<g class="arm"><rect x="74" y="96" width="84" height="9" rx="2" fill="url(#hazard)"/><circle cx="74" cy="100" r="6" class="metal"/></g>`,
  shipping: '',
};

const TRUCK = (p: string, label: string, i: number) => {
  const x = 8 + i * 64;
  return `<g class="truck t-${p}" data-p="${p}" transform="translate(${x} 0)">
<rect x="0" y="10" width="58" height="10" class="canopy"/>
<g class="rig"><rect x="2" y="62" width="40" height="40" rx="3" class="cargo"/><text x="22" y="88" class="truck-txt">${label}</text>
<path d="M42 76 h10 l6 10 v16 h-16 Z" class="cab"/><rect x="45" y="79" width="7" height="7" class="cab-win"/>
<circle cx="12" cy="104" r="5" class="wheel"/><circle cx="48" cy="104" r="5" class="wheel"/>
<circle cx="-2" cy="98" r="3" class="exhaust e1"/><circle cx="-2" cy="98" r="4" class="exhaust e2"/></g>
<text x="29" y="40" class="ship-n" data-n="${p}">0</text><text x="29" y="52" class="ship-l">sent 24 h</text>
<rect x="0" y="112" width="58" height="28" class="bay"/></g>`;
};
MACHINES.shipping = `<rect x="0" y="4" width="264" height="8" fill="url(#hazard)"/>${['YT', 'FB', 'IG', 'TT'].map((l, i) => TRUCK(PLATFORMS[i], l, i)).join('')}`;

function station(k: (typeof STAGES)[number], i: number): Raw {
  const wide = k === 'shipping';
  return html`<section class="station st-${k}" data-station="${k}" aria-label="${STATION[k].name}">
<div class="sign"><span class="sign-n">${i + 1}</span><span class="sign-t">${STATION[k].name}</span><b class="count" data-count="${k}">0</b></div>
<svg class="machine" viewBox="0 0 ${wide ? 264 : 160} 140" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">${raw(MACHINES[k])}</svg>
<p class="what">${STATION[k].what}</p></section>`;
}

const ROLLERS = raw(Array.from({ length: 40 }, () => '<span class="roller"></span>').join(''));

export async function factoryPage(ctx: Ctx): Promise<Res> {
  const st = await factoryState(ctx.db, ctx.now);
  const demo = ctx.query.get('demo') === '1';
  const active = st.slots.filter((s) => s.stage !== 'shipped' && s.stage !== 'scrap');
  const name = (s: Stage) => (s === 'shipped' ? 'Shipped' : s === 'scrap' ? 'Scrap bin' : STATION[s].name);
  const body = html`${DEFS}
<div class="f-bar">
<span class="f-hb" data-hb>${st.heartbeatAge === null ? 'Pipeline never ticked' : st.heartbeatAge > 300 ? `Pipeline stale (${st.heartbeatAge} s)` : `Pipeline alive (${st.heartbeatAge} s ago)`}</span>
<span class="f-up muted" data-updated>Updated ${st.now.slice(11, 19)}Z</span>
${demo ? html`<a class="f-demo on" href="/factory">Demo running: show the real floor</a>` : html`<a class="f-demo" href="/factory?demo=1">Run a demo shift</a>`}
</div>
${demo ? html`<p class="banner">Demo shift: made-up crates, not your pipeline. Nothing is read or written.</p>` : ''}
<div class="floor-wrap" tabindex="0" aria-label="Factory floor; scroll sideways on a small screen">
<div class="floor${st.dryRun ? ' dry' : ''}" id="factory" data-demo="${demo ? '1' : '0'}" data-state="${JSON.stringify(st)}">
<div class="wall" aria-hidden="true">
<div class="windows"></div>
<svg class="pipes" viewBox="0 0 1000 40" preserveAspectRatio="none"><path d="M0 14 H1000" class="pipe"/><path d="M0 14 H1000" class="flow"/><path d="M0 30 H1000" class="pipe thin"/><path d="M0 30 H1000" class="flow slow"/></svg>
<div class="fans"><span class="fan"><svg viewBox="-12 -12 24 24"><use href="#gear" x="-12" y="-12" width="24" height="24"/></svg></span><span class="fan"><svg viewBox="-12 -12 24 24"><use href="#gear" x="-12" y="-12" width="24" height="24"/></svg></span><span class="fan"><svg viewBox="-12 -12 24 24"><use href="#gear" x="-12" y="-12" width="24" height="24"/></svg></span></div>
<div class="dry-sign"><span>DRY RUN</span><small>nothing is published</small></div>
</div>
<div class="line">${STAGES.map((k, i) => station(k, i))}</div>
<div class="belt" aria-hidden="true"><div class="belt-top"></div><div class="rollers">${ROLLERS}</div><div class="legs"></div></div>
<div class="yard">
<div class="scrap" data-scrap><svg viewBox="0 0 140 70" aria-hidden="true" focusable="false"><path d="M10 14 H130 L118 66 H22 Z" class="bin"/><rect x="6" y="8" width="128" height="8" rx="2" class="bin-rim"/><text x="70" y="46" class="bin-txt">SCRAP</text><circle cx="124" cy="4" r="4" class="bin-lamp"/></svg><span class="scrap-n"><b data-scrapn>${st.scrapped}</b> scrapped in 24 h</span></div>
<p class="yard-note muted">Click a crate to inspect it. Manual posts ride in blue-taped crates.</p>
</div>
<div class="items" data-items></div>
</div>
</div>
<div class="panel inspector" data-inspector aria-live="polite"><p class="muted">Select a crate on the belt to see where it is and what happens next.</p></div>
<h2>Line board</h2>
<div class="scroll"><table><thead><tr><th>Crate (slot)</th><th>Kind</th><th>Station</th><th>Caption</th><th>Platforms</th></tr></thead><tbody data-board>
${active.length ? active.map((s) => html`<tr><td class="nw">${s.id}</td><td>${s.kind}</td><td>${name(s.stage)}</td><td>${s.caption}</td><td>${s.pubs.map((p) => `${p.p}: ${p.s}`).join(', ')}</td></tr>`) : html`<tr><td colspan="5" class="muted">The line is empty. Nothing is planned or in production.</td></tr>`}
</tbody></table></div>
<noscript><p class="muted">Without JavaScript the floor does not move; the line board above is current as of page load.</p></noscript>`;
  const r = layout(ctx, 'Factory', '/factory', body, html`<link rel="stylesheet" href="/factory.css"><script src="/factory.js" defer></script>`);
  return { ...r, headers: { ...r.headers, 'content-security-policy': FACTORY_CSP } };
}
