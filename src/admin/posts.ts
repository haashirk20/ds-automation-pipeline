// Posts on demand: make one held video, look at it, press Post or Discard.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from '../config/index.ts';
import { audit, loadEffectiveConfig } from '../config/overrides.ts';
import { kvGet } from '../db/index.ts';
import { approveHold, discardHold, manualToday, planManual } from '../scheduler/holds.ts';
import { html, raw } from './html.ts';
import { inside, SLOT_ID } from './media.ts';
import { csrfField, layout, redirect, type Ctx, type Res } from './pages.ts';
import { badge, empty, flash, fmtLocal, formRow, money, type Kind } from './ui.ts';

const PNAME: Record<string, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
const VIS: Record<string, string> = { public: 'everyone', private: 'only me' };
const MESSAGES: Record<string, [Kind, string, string]> = {
  made: ['ok', 'Making your video.', 'This takes about 5 minutes; the page refreshes by itself.'],
  nothing: ['warn', 'Nothing to post.', 'No platform has a post waiting for this video. Discard it.'],
  approved: ['ok', 'Posted.', ''],
  discarded: ['ok', 'Discarded.', 'Nothing was posted.'],
  noop: ['info', 'Nothing to do.', 'That video was already posted, discarded or has expired.'],
  nofile: ['bad', 'The video file is missing, so it cannot be posted.', 'Discard it and make a new one.'],
};

type ManualSlot = { id: string; status: string; hold: string | null; video_model: string | null; error: string | null; held_at: string | null; updated_at: string; master_json: string | null; product: string | null };

const caption = (m: string | null): string => {
  try { return JSON.parse(m ?? 'null')?.concept?.caption ?? ''; } catch { return ''; }
};

function statusOf(s: ManualSlot): ['ok' | 'warn' | 'bad' | 'neutral', string] {
  if (s.hold === 'discarded') return ['neutral', 'Discarded'];
  if (s.hold === 'expired') return ['neutral', 'Expired'];
  if (s.status === 'planned') return ['neutral', 'Queued'];
  if (s.status === 'producing') return ['warn', 'Being made'];
  if (s.status === 'ready' && s.hold === 'waiting') return ['warn', 'Waiting for you'];
  if (s.status === 'ready') return ['ok', 'Posting'];
  if (s.status === 'done') return ['ok', 'Posted'];
  if (s.status === 'failed') return ['bad', 'Failed'];
  return ['neutral', s.status];
}

export async function postsPage(ctx: Ctx): Promise<Res> {
  const cfg = await loadEffectiveConfig(ctx.db, ctx.now);
  const tz = cfg.timezone;
  const dry = (() => { try { return !!JSON.parse(kvGet(ctx.db, 'pipeline_state') ?? '{}').dryRun; } catch { return false; } })();
  const { made, inFlight } = manualToday(ctx.db, cfg, ctx.now);
  const enabled = Object.entries(cfg.platforms).filter(([, p]) => p.enabled);
  const slots = ctx.db.prepare("SELECT s.id, s.status, s.hold, s.video_model, s.error, s.held_at, s.updated_at, s.master_json, pr.title AS product FROM slots s LEFT JOIN products pr ON pr.handle = s.product_handle WHERE s.kind = 'manual' ORDER BY s.local_date DESC, s.idx DESC LIMIT 20").all() as ManualSlot[];
  const waiting = slots.filter((s) => s.status === 'ready' && s.hold === 'waiting');
  const customs = ctx.db.prepare('SELECT id, name, approved_at FROM video_models WHERE removed_at IS NULL ORDER BY id').all() as { id: number; name: string; approved_at: string | null }[];
  const names = new Map((ctx.db.prepare('SELECT id, name FROM video_models').all() as { id: number; name: string }[]).map((r) => [`custom:${r.id}`, r.name]));
  const modelName = (v: string | null) => (v === null ? 'Usual model' : (names.get(v) ?? v));
  const per = cfg.tiers.t2.usdPerClip;
  const goes = enabled.map(([k, p]) => `${PNAME[k]} (${VIS[p.visibility]})`).join(', ');
  const blocked = cfg.creative.mode !== 'ugc' ? 'This button needs the "ugc" creative mode in the config file.'
    : !enabled.length ? 'Every platform is off, so nothing could be posted. Turn one on in Settings.'
    : inFlight ? 'A video is being made right now. Wait for it to finish.'
    : cfg.approval.manualPerDay === 0 ? 'The button is turned off in Settings.'
    : made >= cfg.approval.manualPerDay ? `Today's limit of ${cfg.approval.manualPerDay} is used. It resets at midnight.` : null;
  const msg = ctx.query.get('msg');
  const refused = ctx.query.get('refused');
  const m = msg ? MESSAGES[msg] : undefined;
  const top = m ? flash(m[0], m[1], msg === 'approved' ? `It goes out to ${enabled.map(([k]) => PNAME[k]).join(', ') || 'no platform'} within a minute.` : m[2]) : refused ? flash('bad', 'Not made.', refused.slice(0, 200)) : '';
  const head = inFlight ? raw('<meta http-equiv="refresh" content="30">') : '';
  return layout(ctx, 'Videos', '/posts', html`${top}${dry ? flash('warn', 'Practice mode is on.', 'The clip is still made and paid for, but Post it sends nothing.') : ''}
<section><h2>Waiting for you</h2>${waiting.length ? waiting.map((s) => html`<div class="card media-row"><video controls preload="metadata" playsinline src="/media/render?slot=${encodeURIComponent(s.id)}"></video>
<div>${s.product ? html`<p><strong>${s.product}</strong></p>` : ''}<p>${caption(s.master_json)}</p>
<p class="hint">Made ${fmtLocal(s.held_at, tz)}. Thrown away automatically after ${cfg.approval.expireHours} hours if you do nothing.</p>
<p>Goes to: ${goes || 'nowhere (every platform is off)'}</p>
<div class="actions"><form method="post" action="/posts/approve">${csrfField(ctx)}<input type="hidden" name="slot" value="${s.id}"><button class="primary" type="submit">Post it</button></form>
<form method="post" action="/posts/discard" class="apart">${csrfField(ctx)}<input type="hidden" name="slot" value="${s.id}"><button type="submit">Discard</button></form></div></div></div>`) : empty('No videos are waiting for you.')}</section>
<section class="card"><h2>Make a video now</h2><p>Costs about ${money(per)}, at most ${money(per * cfg.tiers.maxJobsPerSlot)} if the first try fails the quality check. Nothing is posted until you press <strong>Post it</strong>.</p>
<p class="hint">Today: ${made} of ${cfg.approval.manualPerDay} used.</p>
<form method="post" action="/posts/new">${csrfField(ctx)}
<details class="plain"><summary>Use a different video model</summary>${formRow({ id: 'model', label: 'Video model', control: html`<select id="model" name="model"><option value="">Usual model (${cfg.tiers.t2.model}, ${money(per)})</option>
${Object.entries(cfg.tiers.t2Presets).map(([k, d]) => html`<option value="${k}">${k} (${money(d.usdPerClip)})</option>`)}
${customs.map((c) => html`<option value="custom:${c.id}">${c.name} (added${c.approved_at ? '' : ', not tried yet'})</option>`)}</select>` })}</details>
<div class="actions"><button class="primary" type="submit"${blocked ? raw(' disabled') : ''}>Make a video now</button>${blocked ? html`<span class="muted">${blocked}</span>` : ''}</div></form></section>
<section><h2>Recent</h2>${slots.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">When</th><th scope="col">Product</th><th scope="col">Status</th><th scope="col">Model</th></tr></thead><tbody>${slots.map((s) => {
    const [k, t] = statusOf(s);
    return html`<tr><td data-label="When" class="nw">${fmtLocal(s.held_at ?? s.updated_at, tz)}</td><td data-label="Product">${s.product ?? ''}</td><td data-label="Status">${badge(k, t)}${s.error ? html`<details><summary>Why</summary><code>${s.error}</code></details>` : ''}</td><td data-label="Model">${modelName(s.video_model)}</td></tr>`;
  })}</tbody></table></div>` : empty('No videos made with this button yet.')}</section>`, head);
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
