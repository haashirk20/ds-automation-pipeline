import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildClipPrompt, productLook } from '../src/creative/ugc.ts';
import { UgcConcept } from '../src/contracts.ts';
import { readFileSync } from 'node:fs';
import { activateText, loadPrompts, promptText, saveText, systemPrompt, usePrompts } from '../src/llm/prompts.ts';
import { fresh, sampleBrief as brief, seedBrief } from './helpers.ts';

const NOW = new Date('2026-11-12T17:20:00Z');
const concept = UgcConcept.parse(JSON.parse(readFileSync(new URL('./fixtures/llm/ugc.json', import.meta.url), 'utf8')));
const opts = { look: null, brand: 'Giftwell', logo: false };
afterEach(() => usePrompts({}));

test('an empty house text changes nothing, byte for byte', () => {
  const plain = ['ugc', 'copy', 'hooks', 'script', 'claims', 'copycheck', 'vision'].map((p) => systemPrompt(p as any, brief));
  usePrompts({ house: '' });
  assert.deepEqual(['ugc', 'copy', 'hooks', 'script', 'claims', 'copycheck', 'vision'].map((p) => systemPrompt(p as any, brief)), plain);
  assert.ok(plain.every((s) => s.endsWith('</brief>')));
});

test('the house text goes first on the writers and nowhere else', () => {
  usePrompts({ house: 'HOUSE STYLE' });
  for (const p of ['ugc', 'copy', 'hooks', 'script'] as const) assert.ok(systemPrompt(p, brief).startsWith('HOUSE STYLE\n\n'), p);
  for (const p of ['claims', 'copycheck', 'vision'] as const) assert.ok(!systemPrompt(p, brief).includes('HOUSE STYLE'), p);
});

test('the active version is used, two calls are identical, and "Use file" falls back', () => {
  const db = fresh();
  const file = systemPrompt('ugc', brief);
  const r = saveText(db, 'ugc', 'MY UGC RULES', null, 'n', NOW) as { id: number };
  usePrompts(loadPrompts(db));
  assert.ok(systemPrompt('ugc', brief).startsWith('MY UGC RULES\n\n<brief>'));
  assert.equal(systemPrompt('ugc', brief), systemPrompt('ugc', brief));
  assert.ok(!('errors' in saveText(db, 'ugc', 'V2', r.id, '', NOW)));
  assert.ok('errors' in saveText(db, 'ugc', 'V3', r.id, '', NOW)); // stale base
  activateText(db, 'ugc', null, NOW);
  usePrompts(loadPrompts(db));
  assert.equal(systemPrompt('ugc', brief), file);
  activateText(db, 'ugc', r.id, NOW);
  assert.equal(loadPrompts(db).ugc, 'MY UGC RULES');
  assert.throws(() => activateText(db, 'ugc', 99, NOW), /no version/);
});

test('claims, copycheck and vision are refused on save and ignored on load', () => {
  const db = fresh();
  for (const k of ['claims', 'copycheck', 'vision', 'nope']) assert.ok('errors' in saveText(db, k, 'x', null, '', NOW), k);
  db.prepare("INSERT INTO text_versions (id, key, body, sha256, created_at) VALUES (1, 'claims', 'EVIL', 'x', 't')").run();
  db.prepare("INSERT INTO kv (key, value) VALUES ('text_active:claims', '1')").run();
  assert.deepEqual(loadPrompts(db), {});
  usePrompts({ claims: 'EVIL' });
  assert.ok(!systemPrompt('claims', brief).includes('EVIL'));
});

test('the video text is used, and the speech sentence stays last', () => {
  const file = buildClipPrompt(brief, concept, ['a'], opts).prompt;
  assert.ok(file.startsWith(promptText('video')));
  usePrompts({ video: 'MY VIDEO STYLE' });
  const p = buildClipPrompt(brief, concept, ['a'], opts).prompt;
  assert.ok(p.startsWith('MY VIDEO STYLE\n\nSetting:'));
  assert.match(p, /\n\nAudio: natural room sound that fits the setting\. The only spoken words in the whole video are her line in shot 1\.$/);
});

test('a product note replaces the file note', () => {
  usePrompts({ 'note:snugwrap-heated-shawl-wrap': 'MY NOTE' });
  assert.equal(productLook('snugwrap-heated-shawl-wrap'), 'MY NOTE');
  assert.match(productLook('other') ?? 'none', /none/);
});

test('the lint refuses a price, a discount, a link or a long text', () => {
  const db = fresh();
  seedBrief(db);
  const note = (b: string) => saveText(db, `note:${brief.product.handle}`, b, null, '', NOW);
  assert.ok('errors' in note('A shawl that costs $12.'));
  assert.ok('errors' in note('Now 50% off, a great sale.'));
  assert.ok('errors' in note('See https://example.org/x for more.'));
  assert.ok('errors' in note('x'.repeat(1001)));
  const long = note(`${'a shawl that is soft and light. '.repeat(20)}Now 50% off, a great sale. ${'more words here. '.repeat(20)}`);
  assert.ok('errors' in long && long.errors.length > 0 && long.errors.every((m) => m.length <= 160), JSON.stringify(long));
  assert.ok('errors' in saveText(db, 'house', 'Everything is half price today', null, '', NOW));
  assert.ok('id' in (note('A waffle-knit shawl with a zip and one round button.') as object));
  assert.ok('id' in (saveText(db, 'house', '', null, '', NOW) as object)); // an empty house text is allowed
  assert.ok('errors' in saveText(db, 'ugc', '', null, '', NOW));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit').get() as any).n, 2);
  assert.ok(!JSON.stringify(db.prepare('SELECT detail_json FROM audit').all()).includes('waffle'));
});
