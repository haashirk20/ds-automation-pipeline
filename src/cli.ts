import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { env, loadConfig } from './config/index.ts';
import { loadEffectiveConfig, resolveConfig } from './config/overrides.ts';
import { loadPrompts, usePrompts } from './llm/prompts.ts';
import { hasAlertChannel } from './ops/alert.ts';
import { backupStatus, privateWarnings } from './ops/summary.ts';
import { afterRestore } from './ops/snapshot.ts';
import { kvGet, kvSet, openDb, schemaVersion } from './db/index.ts';
import { publishDue } from './publish/index.ts';
import { findAccount, listAccounts, makePublishers } from './publish/bridge.ts';
import { authorize, higgsfieldStatus } from './router/higgsfield-auth.ts';
import { runSamples, runUgcSample } from './render/samples.ts';
import { planDay } from './scheduler/planner.ts';
import { runIngest } from './shopify/index.ts';
import { childSpawn, makeProducer, run } from './scheduler/loop.ts';
import { localDateOf } from './scheduler/time.ts';

const USAGE = 'usage: cli.ts [--now ISO] run [--once] | plan [--date YYYY-MM-DD] | publish | produce --slot ID | ingest [--print] | samples [--clip FILE --caption TEXT [--name NAME]] | doctor | health | after-restore | auth higgsfield | admin serve | admin password';
const ENV_NAMES = ['PIPELINE_CONFIG', 'DRY_RUN', 'DATA_DIR', 'OUT_DIR', 'ALERT_DISCORD_WEBHOOK', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID', 'HEALTHCHECK_URL', 'HEALTHCHECK_DAILY_URL', 'BACKUP_STATUS_DIR', 'SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'BRIDGE_API_KEY', 'ANTHROPIC_API_KEY'];

async function main(): Promise<number> {
  process.umask(0o077); // the database and its journal files hold OAuth tokens
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { now: { type: 'string' }, once: { type: 'boolean' }, date: { type: 'string' }, print: { type: 'boolean' }, slot: { type: 'string' }, clip: { type: 'string' }, caption: { type: 'string' }, name: { type: 'string' } },
  });
  const cmd = positionals[0];
  if (!['run', 'plan', 'publish', 'produce', 'ingest', 'samples', 'doctor', 'health', 'after-restore', 'auth', 'admin'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  // The clock is only read here; below this layer, time arrives as `now`.
  const override = values.now ?? process.env.PIPELINE_NOW;
  const offsetMs = override ? Date.parse(override) - Date.now() : 0;
  if (Number.isNaN(offsetMs)) {
    console.error('invalid --now');
    return 2;
  }
  // A false clock would defeat the publisher's 23-hour idempotency-key check.
  if (override && (cmd === 'run' || cmd === 'publish') && !env.dryRun()) {
    console.error(`--now and PIPELINE_NOW are refused for '${cmd}' unless DRY_RUN=1`);
    return 2;
  }
  // Stand-ins for the model and the clip provider produce fake output: dry runs only.
  if ((process.env.LLM_STUB === '1' || process.env.CLIP_STUB_FILE) && !env.dryRun() && cmd !== 'doctor' && cmd !== 'health') {
    console.error(`LLM_STUB and CLIP_STUB_FILE are refused for '${cmd}' unless DRY_RUN=1`);
    return 2;
  }
  const clock = () => new Date(Date.now() + offsetMs);

  if (cmd === 'health') {
    const db = openDb(env.dataDir());
    const hb = kvGet(db, 'heartbeat');
    return hb && clock().getTime() - Date.parse(hb) < 300_000 ? 0 : 1;
  }
  if (cmd === 'doctor') return doctor(clock());
  if (cmd === 'after-restore') {
    console.log(`${await afterRestore(openDb(env.dataDir()), clock())} publication(s) set to needs_attention`);
    return 0;
  }
  if (cmd === 'auth') {
    if (positionals[1] !== 'higgsfield') {
      console.error(USAGE);
      return 2;
    }
    await authorize(openDb(env.dataDir()), clock());
    return 0;
  }

  if (cmd === 'admin') {
    if (positionals[1] !== 'serve' && positionals[1] !== 'password') {
      console.error(USAGE);
      return 2;
    }
    const admin = await import('./admin/index.ts'); // only this command loads the admin code
    await (positionals[1] === 'serve' ? admin.serve({ now: clock }) : admin.setPassword({ now: clock }));
    return 0;
  }

  if (cmd === 'samples') {
    const config = await loadConfig();
    if (values.clip) {
      if (!values.caption) {
        console.error(USAGE);
        return 2;
      }
      await runUgcSample(config, values.clip, values.caption, values.name);
      return 0;
    }
    await runSamples(config, clock());
    return 0;
  }
  const db = openDb(env.dataDir());
  const config = await loadEffectiveConfig(db, clock()); // a producer keeps the snapshot it starts with
  usePrompts(loadPrompts(db));
  const rebuild = (c: typeof config) => makePublishers(c, { now: clock });
  const deps = { db, config, publishers: rebuild(config), producer: makeProducer(childSpawn(config, { clock: override ? clock : undefined })), wait: !!values.once, clock, rebuild, ingest: async (c: typeof config, n: Date, signal: AbortSignal) => { await runIngest(db, c, n, { print: false, signal }); } };
  if (cmd === 'run') await run(deps, clock, !!values.once);
  else if (cmd === 'produce') {
    if (!values.slot) {
      console.error(USAGE);
      return 2;
    }
    const { produceSlot } = await import('./render/produce.ts'); // loads Remotion; only the child needs it
    // SIGTERM from the parent: cancel the render (and its Chrome) and exit non-zero; the slot stays 'producing'.
    const stop = new AbortController();
    process.once('SIGTERM', () => stop.abort());
    await produceSlot(db, config, values.slot, clock(), { signal: stop.signal, clock });
  } else if (cmd === 'ingest') {
    await runIngest(db, config, clock(), { print: !!values.print });
    kvSet(db, 'ingest_at', clock().toISOString());
  } else if (cmd === 'plan') {
    const now = clock();
    planDay(db, config, values.date ?? localDateOf(now, config.timezone), now);
  } else await publishDue(db, config, deps.publishers, clock(), clock);
  return 0;
}

async function doctor(now: Date): Promise<number> {
  let bad = false;
  let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    config = await loadConfig();
    console.log('config: ok');
  } catch (e) {
    bad = true;
    console.log('config: INVALID\n' + (e as Error).message);
  }
  try {
    const db = openDb(env.dataDir());
    console.log(`db: ${env.dataDir()}/pipeline.db schema_version=${schemaVersion(db)}`);
    const hb = kvGet(db, 'heartbeat');
    const age = hb ? Math.round((now.getTime() - Date.parse(hb)) / 1000) : null;
    console.log('heartbeat: ' + (age === null ? 'never' : age < 0 ? 'in the future (clock override?)' : `${age}s ago`));
    console.log('higgsfield: ' + higgsfieldStatus(db, now));
    try {
      const r = await resolveConfig(db, now);
      for (const w of privateWarnings(r.config)) console.log('WARNING ' + w);
      const v = r.version;
      console.log('settings: ' + (typeof v === 'number' ? `version ${v} active` : v === 'file' ? 'the file (no stored version active)' : `stored version ${v.replace(/^refused: /, 'REFUSED, running on the file: ')}`));
    } catch (e) {
      console.log('settings: unreadable ' + (e as Error).message);
    }
  } catch (e) {
    bad = true;
    console.log('db: BROKEN ' + e);
  }
  if (!env.dryRun() && !hasAlertChannel()) {
    bad = true;
    console.log('alerts: NO CHANNEL configured and DRY_RUN is not 1');
  }
  const key = env.bridgeKey();
  if (key && config) {
    try {
      const accounts = await listAccounts(fetch, key, AbortSignal.timeout(10_000));
      for (const [name, p] of Object.entries(config.platforms).filter(([, p]) => p.enabled)) {
        const a = findAccount(accounts, name, p.handle);
        if (!a) bad ||= !env.dryRun();
        console.log(a ? `bridge ${name}: ok (${a.username ?? a.displayName})` : `bridge ${name}: NO ACCOUNT for handle ${p.handle}`);
      }
    } catch (e) {
      bad ||= !env.dryRun();
      console.log('bridge: accounts call failed: ' + (e as Error).message);
    }
  }
  if (env.backupStatusDir()) console.log('backup: ' + backupStatus(now));
  const backupKeys = ['RESTIC_PASSWORD', 'RESTIC_REPOSITORY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((n) => process.env[n]);
  if (backupKeys.length) {
    bad = true;
    console.log(`backup keys: FAIL ${backupKeys.join(', ')} set in the pipeline's environment; they belong in .env.backup`);
  }
  for (const n of ENV_NAMES) console.log(`env ${n}: ${process.env[n] ? 'set' : 'unset'}`);
  return bad ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
