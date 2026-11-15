// Video models added on the page. Guardrails live in customModelProblems and customDef (shared with the pipeline).
import raw from '../../config/pipeline.config.ts';
import { parseConfig } from '../config/index.ts';
import { CUSTOM_PARAM_KEYS, customModelProblems, modelInUse, type VideoModelRow } from '../config/models.ts';
import { audit } from '../config/overrides.ts';
import { html } from './html.ts';
import { csrfField, fmtTs, layout, redirect, type Ctx, type Res } from './pages.ts';

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
  const flash = m === 'added' ? html`<p class="notice" role="status">Model added. Try it in a test post on the Posts page.</p>` : m === 'removed' ? html`<p class="notice" role="status">Model removed.</p>` : ctx.query.get('refused') ? html`<p class="error-box" role="alert">Not removed: ${ctx.query.get('refused')!.slice(0, 200)}</p>` : '';
  return {
    ...layout(ctx, 'Models', '/models', html`${flash}<p>A new model is quoted live before its first job and refused above your limit. Use it in a test post first; after you press Post on one, it can be chosen in Settings.</p>
<h2>Added models</h2>${rows.length ? html`<div class="scroll"><table><thead><tr><th>Id</th><th>Name</th><th>Model</th><th>Options</th><th>Most credits</th><th>Keep credits</th><th>State</th><th></th></tr></thead><tbody>${rows.map((r) => html`<tr><td>custom:${r.id}</td><td>${r.name}</td><td>${r.model}</td><td><code>${r.params_json}</code></td><td>${r.max_credits}</td><td>${r.keep_credits}</td><td>${r.removed_at ? `removed ${fmtTs(r.removed_at)}` : r.approved_at ? 'approved' : 'untested'}</td><td>${r.removed_at ? '' : html`<form method="post" action="/models/remove">${csrfField(ctx)}<input type="hidden" name="id" value="${r.id}"><button type="submit">Remove</button></form>`}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None yet.</p>`}
<h2>Add a model</h2>${errors.length ? html`<div class="error-box" role="alert"><strong>Not added.</strong><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
<form method="post" action="/models/add">${csrfField(ctx)}
<div class="field"><label for="n">Name</label><div><input id="n" type="text" name="name" value="${draft.name}" maxlength="40"></div></div>
<div class="field"><label for="m">Higgsfield model id</label><div><input id="m" type="text" name="model" value="${draft.model}"><span class="hint">Lower case letters, digits and underscores, such as wan3_0.</span></div></div>
<div class="field"><label for="o">Options</label><div><textarea id="o" name="options" class="short" rows="4">${draft.options}</textarea><span class="hint">One key=value per line. Allowed keys: ${CUSTOM_PARAM_KEYS.join(', ')} (at most 6). The clip must keep its sound.</span></div></div>
<div class="field"><label for="x">Most credits for one clip</label><div><input id="x" type="text" name="maxCredits" value="${draft.maxCredits}" inputmode="decimal"><span class="hint">Above 0 and at most ${file.tiers.customMaxCredits}.</span></div></div>
<div class="field"><label for="k">Credits to keep in the account</label><div><input id="k" type="text" name="keepCredits" value="${draft.keepCredits}" inputmode="decimal"><span class="hint">At least ${file.tiers.t2.keepCredits}.</span></div></div>
<div class="actions"><button class="primary" type="submit">Add model</button></div></form>`),
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
