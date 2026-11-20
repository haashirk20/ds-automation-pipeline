// Video models added on the page. Guardrails live in customModelProblems and customDef (shared with the pipeline).
import raw from '../../config/pipeline.config.ts';
import { parseConfig } from '../config/index.ts';
import { CUSTOM_PARAM_KEYS, customModelProblems, modelInUse, type VideoModelRow } from '../config/models.ts';
import { audit } from '../config/overrides.ts';
import { html } from './html.ts';
import { csrfField, layout, redirect, type Ctx, type Res } from './pages.ts';
import { badge, confirmRemove, empty, errSummary, flash, fmtLocal, formRow } from './ui.ts';

type Draft = { name: string; model: string; options: string; maxCredits: string; keepCredits: string };

function parseOptions(text: string): { params: Record<string, unknown>; errors: string[] } {
  const params: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const i = l.indexOf('=');
    const k = l.slice(0, i).trim();
    const v = l.slice(i + 1).trim();
    if (i < 1 || !v) errors.push(`options: "${l.slice(0, 40)}" is not key=value`);
    else if (Object.hasOwn(params, k)) errors.push(`options: ${k} appears twice`);
    else params[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return { params, errors };
}

export function modelsPage(ctx: Ctx, draft: Draft = { name: '', model: '', options: 'resolution=720p\ngenerate_audio=true', maxCredits: '', keepCredits: '350' }, errors: string[] = []): Res {
  const file = parseConfig(raw);
  const rows = ctx.db.prepare('SELECT * FROM video_models ORDER BY id DESC').all() as VideoModelRow[];
  const m = ctx.query.get('msg');
  const refused = ctx.query.get('refused');
  const top = m === 'added' ? flash('ok', 'Model added.', 'Try it with "Make a video now" on Videos. Once you post a video made with it, it can be chosen in Settings.') : m === 'removed' ? flash('ok', 'Model removed.', 'Videos already made are not changed.') : refused ? flash('bad', 'Not removed.', refused.slice(0, 200)) : '';
  const state = (r: VideoModelRow) => (r.removed_at ? badge('neutral', `Removed ${fmtLocal(r.removed_at, file.timezone)}`) : r.approved_at ? badge('ok', 'Ready for Settings') : badge('warn', 'Not tried yet'));
  return {
    ...layout(ctx, 'Video models (advanced)', '/models', html`${top}<p>A new model's price is checked live before its first clip, and refused above your limit. Try it with "Make a video now" first; after you post a video made with it, it can be chosen in Settings.</p>
<section><h2>Added models</h2>${rows.length ? html`<div class="scroll"><table class="stack"><thead><tr><th scope="col">Name</th><th scope="col">Model</th><th scope="col">Options</th><th scope="col">Most credits</th><th scope="col">Keep credits</th><th scope="col">State</th><th scope="col"><span class="vh">Actions</span></th></tr></thead><tbody>${rows.map((r) => html`<tr><td data-label="Name">${r.name}</td><td data-label="Model"><code>${r.model}</code></td><td data-label="Options"><code>${r.params_json}</code></td><td data-label="Most credits" class="num">${r.max_credits}</td><td data-label="Keep" class="num">${r.keep_credits}</td><td data-label="State">${state(r)}</td><td>${r.removed_at ? '' : confirmRemove('Remove…', html`<form method="post" action="/models/remove">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button class="danger" type="submit">Yes, remove ${r.name}</button></form>`)}</td></tr>`)}</tbody></table></div>` : empty('No models added yet. The models from the config file are always available.')}</section>
<section class="card"><h2>Add a model</h2>${errSummary(errors.map((msg) => ({ msg })), 'Not added.')}
<form method="post" action="/models/add">${csrfField(ctx)}
${formRow({ id: 'n', label: 'Name', control: html`<input id="n" type="text" name="name" value="${draft.name}" maxlength="40">`, hint: 'Your own name for it.' })}
${formRow({ id: 'm', label: 'Higgsfield model id', control: html`<input id="m" type="text" name="model" value="${draft.model}">`, hint: 'Lower case letters, digits and underscores, such as wan3_0.' })}
${formRow({ id: 'o', label: 'Options', control: html`<textarea id="o" name="options" class="short" rows="4">${draft.options}</textarea>`, hint: `One key=value per line. Allowed keys: ${CUSTOM_PARAM_KEYS.join(', ')} (at most 6). The clip must keep its sound.` })}
${formRow({ id: 'x', label: 'Most credits for one clip', control: html`<input id="x" type="text" name="maxCredits" value="${draft.maxCredits}" inputmode="decimal">`, hint: `Above 0 and at most ${file.tiers.customMaxCredits}.` })}
${formRow({ id: 'k', label: 'Credits to keep in the account', control: html`<input id="k" type="text" name="keepCredits" value="${draft.keepCredits}" inputmode="decimal">`, hint: `At least ${file.tiers.t2.keepCredits}.` })}
<div class="actions"><button class="primary" type="submit">Add model</button></div></form></section>`),
    status: errors.length ? 422 : 200,
  };
}

export function modelAdd(ctx: Ctx): Res {
  const f = (k: string) => (ctx.form.get(k) ?? '').trim();
  const draft: Draft = { name: f('name'), model: f('model'), options: ctx.form.get('options') ?? '', maxCredits: f('maxCredits'), keepCredits: f('keepCredits') };
  const { params, errors } = parseOptions(draft.options);
  const num = (s: string) => (s === '' ? NaN : Number(s));
  const input = { name: draft.name, model: draft.model, params, maxCredits: num(draft.maxCredits), keepCredits: num(draft.keepCredits) };
  const problems = [...errors, ...customModelProblems(input, parseConfig(raw))];
  if (problems.length) return modelsPage(ctx, draft, problems);
  const id = Number(ctx.db.prepare('INSERT INTO video_models (name, model, params_json, max_credits, keep_credits, created_at) VALUES (?,?,?,?,?,?)').run(input.name, input.model, JSON.stringify(params), input.maxCredits, input.keepCredits, ctx.now.toISOString()).lastInsertRowid);
  audit(ctx.db, 'admin', 'model.add', `custom:${id}`, { name: input.name, model: input.model, params, maxCredits: input.maxCredits }, ctx.now);
  return redirect('/models?msg=added');
}

export function modelRemove(ctx: Ctx): Res {
  const s = ctx.form.get('id') ?? '';
  const id = /^\d{1,9}$/.test(s) ? Number(s) : null;
  if (id === null || !ctx.db.prepare('SELECT 1 FROM video_models WHERE id = ? AND removed_at IS NULL').get(id)) return redirect('/models?refused=no%20such%20model');
  const why = modelInUse(ctx.db, id);
  if (why) return redirect(`/models?refused=${encodeURIComponent(why)}`);
  ctx.db.prepare('UPDATE video_models SET removed_at = ? WHERE id = ?').run(ctx.now.toISOString(), id);
  audit(ctx.db, 'admin', 'model.remove', `custom:${id}`, {}, ctx.now);
  return redirect('/models?msg=removed');
}
