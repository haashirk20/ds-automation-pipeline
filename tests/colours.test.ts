// D-47: one note section per colour, and the colour of each concept chosen in code.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brief, UgcConcept } from '../src/contracts.ts';
import { setLlmClient } from '../src/llm/client.ts';
import { usePrompts } from '../src/llm/prompts.ts';
import { lookFor, writeConcept } from '../src/creative/ugc.ts';
import { checkClip } from '../src/qa/vision.ts';
import { config, fresh } from './helpers.ts';

const brief = Brief.parse(JSON.parse(readFileSync(new URL('./fixtures/samples/samples.json', import.meta.url), 'utf8')).brief);
const story = UgcConcept.parse(JSON.parse(readFileSync(new URL('./fixtures/llm/ugc.json', import.meta.url), 'utf8')));
const NOW = new Date('2026-11-12T17:00:00Z');
const cfg = { ...config, tiers: { ...config.tiers, clipSeconds: 15 } };
const COLOURS = ['Beige', 'Green', 'Red'];
const NOTE = 'In the box: a shawl and a USB cable.\nGreen:\n  forest moss and brass, a pine candle.\n red : cherry and gold\nby a fireplace.\nBeige: oat and linen';

afterEach(() => { usePrompts({}); setLlmClient(null); });

test('lookFor: shared part plus the one colour section; headings are case and space blind; other text stays', () => {
  assert.equal(lookFor(null, 'Green', COLOURS), null);
  assert.equal(lookFor('A matte black bottle.\nIn the box: a brush.', 'Green', COLOURS), 'A matte black bottle.\nIn the box: a brush.'); // no headings: unchanged
  assert.equal(lookFor(NOTE, 'Green', COLOURS), 'In the box: a shawl and a USB cable.\n  forest moss and brass, a pine candle.');
  assert.equal(lookFor(NOTE, 'red', COLOURS), 'In the box: a shawl and a USB cable.\ncherry and gold\nby a fireplace.');
  assert.equal(lookFor(NOTE, 'Beige', COLOURS), 'In the box: a shawl and a USB cable.\noat and linen');
  // A colour with no section gets the shared part only; a heading that is not a colour is text.
  assert.equal(lookFor(NOTE, 'Blue', [...COLOURS, 'Blue']), 'In the box: a shawl and a USB cable.');
  assert.equal(lookFor('Scene: candles.\nPurple: violet.', 'Green', COLOURS), 'Scene: candles.\nPurple: violet.');
  assert.equal(lookFor('Green: moss.', 'Red', COLOURS), null);
});

test('writeConcept: the request names the colour and carries only its part of the note; the answer gets that colour', async () => {
  usePrompts({ [`note:${brief.product.handle}`]: NOTE });
  const users: string[] = [];
  setLlmClient({
    create: async (p) => {
      const content = (p.messages as { content: string }[])[0].content;
      users.push(content);
      const n = Number(/Judge these (\d+)/.exec(content)?.[1]);
      const body = n ? { verdicts: Array.from({ length: n }, (_, i) => ({ chunk: i + 1, supported: true, factId: null, reason: 'ok' })) } : story;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const c = await writeConcept(fresh(), cfg, brief, [], NOW, 's1', 'story', 'Green'); // the model answers Beige
  assert.equal(c.color, 'Green');
  assert.match(users[0], /\nColour: "Green" — use this colour\.\nProduct note: In the box: a shawl and a USB cable\.\n {2}forest moss and brass, a pine candle\.\n/);
  assert.doesNotMatch(users[0], /cherry|oat/);
  // Without a chosen colour, a sectioned note sends only the shared part.
  users.length = 0;
  await writeConcept(fresh(), cfg, brief, [], NOW, 's1', 'story');
  assert.doesNotMatch(users[0], /Colour:|moss|cherry|oat/);
  assert.match(users[0], /Product note: In the box: a shawl and a USB cable\.\n/);
});

test('checkClip: the frame check sees only the section of the concept colour', async () => {
  usePrompts({ [`note:${brief.product.handle}`]: NOTE });
  const ref = join(mkdtempSync(join(tmpdir(), 'vis-')), 'ref.jpg');
  writeFileSync(ref, 'ref');
  const ok = JSON.parse(readFileSync(new URL('./fixtures/llm/vision.json', import.meta.url), 'utf8'));
  let user = '';
  setLlmClient({ create: async (p) => { user = (p.messages as { content: { type: string; text?: string }[] }[])[0].content.find((x) => x.type === 'text')!.text!; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(ok) }], usage: { input_tokens: 1, output_tokens: 1 } }; } });
  await checkClip(fresh(), config, { clipFile: 'x.mp4', refImages: [ref], brief, concept: { ...story, color: 'Red' } }, NOW, 's1', { frames: async () => [Buffer.from('a')] });
  assert.match(user, /Owner's note on the product: In the box: a shawl and a USB cable\.\ncherry and gold\nby a fireplace\.\n/);
  assert.doesNotMatch(user, /moss|oat/);
  assert.doesNotMatch(user, /not a mismatch/);
  // A colour with no photo of its own: the references may show another kit, so colour is not judged.
  await checkClip(fresh(), config, { clipFile: 'x.mp4', refImages: [ref], brief, concept: { ...story, color: 'Red' }, refsShowColour: false }, NOW, 's1', { frames: async () => [Buffer.from('a')] });
  assert.match(user, /\nColour: Red \(no reference photo is tagged with this colour: [^\n]*a different colour is not a mismatch/);
});

test('lookFor: a one-colour product keeps its whole note, even a line starting with the colour name', async () => {
  const { lookFor } = await import('../src/creative/ugc.ts');
  assert.equal(lookFor('Black: matte steel, 25 cm', '', ['Black']), 'Black: matte steel, 25 cm');
  assert.equal(lookFor('Black: matte steel', 'Black', ['Black']), 'Black: matte steel');
});
