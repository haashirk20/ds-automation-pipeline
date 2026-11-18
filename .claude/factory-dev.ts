// Local preview of the admin Factory page on http://localhost:3000 with a throwaway database.
// Not part of the pipeline. Test password for this throwaway database only: factory-dev-preview
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'factory-dev-'));
process.env.DATA_DIR = join(dir, 'data');
process.env.OUT_DIR = join(dir, 'out');

const { openDb, kvSet } = await import('../src/db/index.ts');
const { startAdmin, setPassword } = await import('../src/admin/index.ts');
const db = openDb(process.env.DATA_DIR);
const now = () => new Date();
await setPassword({ db, now, read: async () => 'factory-dev-preview' });

const t = new Date();
const ts = t.toISOString();
const day = ts.slice(0, 10);
const claim = new Date(t.getTime() - 5 * 60_000).toISOString();
const master = (caption: string) => JSON.stringify({ mode: 'ugc', concept: { caption } });
const slot = (idx: number, status: string, o: { master?: string; hold?: string; kind?: string } = {}) =>
  db.prepare('INSERT INTO slots (id, local_date, idx, status, created_at, updated_at, claimed_at, master_json, hold, kind, tier, attempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)')
    .run(`${day}#${idx}`, day, idx, status, ts, ts, status === 'producing' ? claim : null, o.master ?? null, o.hold ?? null, o.kind ?? 'planned', 't2');
const pubs = (idx: number, states: string[]) => ['youtube', 'facebook', 'instagram', 'tiktok'].forEach((p, i) =>
  db.prepare('INSERT INTO publications (slot_id, platform, scheduled_at, state, published_at, dry_run) VALUES (?,?,?,?,?,1)').run(`${day}#${idx}`, p, ts, states[i], states[i] === 'published' ? ts : null));
const llm = (idx: number, purpose: string) => db.prepare("INSERT INTO llm_calls (ts, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, slot_id) VALUES (?,?,'claude-haiku-5-5',0,0,0,0,0,?)").run(ts, purpose, `${day}#${idx}`);
const spend = (idx: number, state: string) => db.prepare("INSERT INTO spend (slot_id, tier, provider, model, state, quoted_usd, created_at, updated_at) VALUES (?,'t2','higgsfield','wan',?,0.59,?,?)").run(`${day}#${idx}`, state, ts, ts);

slot(1, 'planned'); pubs(1, ['pending', 'pending', 'pending', 'pending']);
slot(2, 'producing'); pubs(2, ['pending', 'pending', 'pending', 'pending']);
slot(3, 'producing', { master: master('Cold office? Not anymore.') }); spend(3, 'submitted'); pubs(3, ['pending', 'pending', 'pending', 'pending']);
slot(4, 'producing', { master: master('Movie night, upgraded.') }); spend(4, 'succeeded'); llm(4, 'vision'); pubs(4, ['pending', 'pending', 'pending', 'pending']);
slot(101, 'ready', { master: master('Sweater weather, but heated.'), hold: 'waiting', kind: 'manual' }); pubs(101, ['pending', 'pending', 'pending', 'pending']);
slot(5, 'ready', { master: master('Warm shoulders, no wall socket.') }); pubs(5, ['published', 'uploading', 'pending', 'published']);
slot(6, 'failed', { master: master('Wrapped up and plugged in.') });
kvSet(db, 'pipeline_state', JSON.stringify({ dryRun: true }));
// Read the store's public product feed once, so the Products page shows real products.
process.env.SHOPIFY_SHOP ??= 'shopgiftwell.myshopify.com';
try {
  const { runIngest } = await import('../src/shopify/index.ts');
  const { loadConfig } = await import('../src/config/index.ts');
  await runIngest(db, await loadConfig(), new Date(), { print: false });
} catch (e) {
  console.log(JSON.stringify({ msg: 'store read failed; Products starts empty', error: (e as Error).message }));
}
const beat = () => kvSet(db, 'heartbeat', new Date().toISOString());
beat();
setInterval(beat, 30_000);

await startAdmin({ db, port: 3000, host: '127.0.0.1', now });
console.log(JSON.stringify({ msg: 'factory preview on http://localhost:3000/factory', dataDir: process.env.DATA_DIR }));
