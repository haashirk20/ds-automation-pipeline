// Posts on demand: make one held video, look at it, press Post or Discard.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from '../config/index.ts';
import { audit, loadEffectiveConfig } from '../config/overrides.ts';
import { kvGet } from '../db/index.ts';
import { approveHold, discardHold, manualToday, planManual } from '../scheduler/holds.ts';
import { html, raw } from './html.ts';
import { inside, SLOT_ID } from './media.ts';
import { csrfField, fmtTs, layout, redirect, type Ctx, type Res } from './pages.ts';

const PNAME: Record<string, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
const MESSAGES: Record<string, string> = {
  made: 'The video is being made. This page refreshes while it works.',
  nothing: 'Nothing to post: no platform has a post waiting for this video. Discard it.',
  approved: 'Posted: the video is queued for the enabled platforms and goes out at the next tick.',
  discarded: 'Discarded. Nothing was posted.',
  noop: 'Nothing to do: that post was already posted, discarded or has expired.',
  nofile: 'The video file is missing, so it cannot be posted. Discard it.',
};

type ManualSlot = { id: string; status: string; hold: string | null; video_model: string | null; error: string | null; held_at: string | null; master_json: string | null };

const caption = (m: string | null): string => {
  try { return JSON.parse(m ?? 'null')?.concept?.caption ?? ''; } catch { return ''; }
};
const usd = (n: number) => `$${n.toFixed(2)}`;

export async function postsPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const dry = (() => { try { return !!JSON.parse(kvGet(ctx.db, 'pipeline_state') ?? '{}').dryRun; } catch { return false; } })();
  const { made, inFlight } = manualToday(ctx.db, cfg, ctx.now);
  const enabled = Object.entries(cfg.platforms).filter(([, p]) => p.enabled);
  const slots = ctx.db.prepare("SELECT id, status, hold, video_model, error, held_at, master_json FROM slots WHERE kind = 'manual' ORDER BY local_date DESC, idx DESC LIMIT 20").all() as ManualSlot[];
  const waiting = slots.filter((s) => s.status === 'ready' && s.hold === 'waiting');
  const customs = ctx.db.prepare('SELECT id, name, approved_at FROM video_models WHERE removed_at IS NULL ORDER BY id').all() as { id: number; name: string; approved_at: string | null }[];
  const per = cfg.tiers.t2.usdPerClip;
  const blocked = cfg.creative.mode !== 'ugc' ? 'Posts on demand need the ugc creative mode.' : !enabled.length ? 'No platform is enabled.' : inFlight ? 'A post is being made.' : made >= cfg.approval.manualPerDay ? `The limit of ${cfg.approval.manualPerDay} posts a day is reached.` : null;
  const msg = ctx.query.get('msg');
  const refused = ctx.query.get('refused');
  const flash = msg && MESSAGES[msg] ? html`<p class="notice" role="status">${MESSAGES[msg]}</p>` : refused ? html`<p class="error-box" role="alert">Not made: ${refused.slice(0, 200)}</p>` : '';
  const head = inFlight ? raw('<meta http-equiv="refresh" content="30">') : '';
  return layout(ctx, 'Posts', '/posts', html`${flash}${dry ? html`<p class="banner">DRY_RUN is on: the clip is still made and paid for; Post sends nothing.</p>` : ''}
<div class="panel"><p>Makes one video now: a new clip (about ${usd(per)}; up to ${usd(per * cfg.tiers.maxJobsPerSlot)} if the frame check rejects the first), inside the monthly cap. Nothing posts until you press Post. Unanswered posts are discarded after ${cfg.approval.expireHours} hours.</p>
<p class="muted">Today: ${made} of ${cfg.approval.manualPerDay} made. More posts a day raise the repetitive-content risk on every platform.</p>
<form method="post" action="/posts/new">${csrfField(ctx)}
<div class="field"><label for="model">Clip model</label><div><select id="model" name="model"><option value="">Current setting (${cfg.tiers.t2.model}, ${usd(per)})</option>
${Object.entries(cfg.tiers.t2Presets).map(([k, d]) => html`<option value="${k}">${k} (${usd(d.usdPerClip)})</option>`)}
${customs.map((c) => html`<option value="custom:${c.id}">${c.name} (custom${c.approved_at ? '' : ', untested'})</option>`)}</select></div></div>
<div class="actions"><button class="primary" type="submit"${blocked ? raw(' disabled') : ''}>Make a new post</button>${blocked ? html`<span class="muted">${blocked}</span>` : ''}</div></form></div>
<h2>Waiting for your decision</h2>${waiting.length ? waiting.map((s) => html`<div class="panel card"><video controls preload="metadata" playsinline src="/media/render?slot=${encodeURIComponent(s.id)}"></video>
<div><p><strong>${s.id}</strong> ${s.video_model ? html`<span class="tag">${s.video_model}</span>` : ''}</p><p>${caption(s.master_json)}</p>
<p class="muted">Made ${fmtTs(s.held_at)}. Discarded automatically after ${cfg.approval.expireHours} hours.</p>
<div class="actions"><form method="post" action="/posts/approve">${csrfField(ctx)}<input type="hidden" name="slot" value="${s.id}"><button class="primary" type="submit">Post</button></form><span class="muted">to ${enabled.map(([k, p]) => `${PNAME[k]} (${p.visibility})`).join(', ') || 'nowhere'}</span>
<form method="post" action="/posts/discard">${csrfField(ctx)}<input type="hidden" name="slot" value="${s.id}"><button type="submit">Discard</button></form></div></div></div>`) : html`<p class="muted">Nothing is waiting.</p>`}
<h2>Recent posts on demand</h2><div class="scroll"><table><thead><tr><th>Slot</th><th>Status</th><th>Hold</th><th>Model</th><th>Error</th></tr></thead><tbody>${slots.map((s) => html`<tr><td class="nw">${s.id}</td><td>${s.status}</td><td>${s.hold ?? ''}</td><td>${s.video_model ?? 'setting'}</td><td>${s.error}</td></tr>`)}</tbody></table></div>`, head);
}

export async function postNew(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const model = ctx.form.get('model') || null;
  const r = planManual(ctx.db, cfg, ctx.now, model);
  if ('refused' in r) return redirect(`/posts?refused=${encodeURIComponent(r.refused)}`);
  audit(ctx.db, 'admin', 'post.new', r.slotId, { model }, ctx.now);
  return redirect('/posts?msg=made');
}

export function postApprove(ctx: Ctx): Res {
  const slot = ctx.form.get('slot') ?? '';
  if (!SLOT_ID.test(slot)) return redirect('/posts?msg=noop');
  const files = ctx.db.prepare('SELECT file_path FROM renders WHERE slot_id = ?').all(slot) as { file_path: string }[];
  if (!files.length || !files.every((f) => inside(path.resolve(f.file_path), env.outDir()) && existsSync(f.file_path))) return redirect('/posts?msg=nofile');
  const r = approveHold(ctx.db, slot, ctx.now);
  return redirect(`/posts?msg=${r === 'nothing' ? 'nothing' : r ? 'approved' : 'noop'}`);
}

export function postDiscard(ctx: Ctx): Res {
  const slot = ctx.form.get('slot') ?? '';
  return redirect(`/posts?msg=${SLOT_ID.test(slot) && discardHold(ctx.db, slot, ctx.now) ? 'discarded' : 'noop'}`);
}
