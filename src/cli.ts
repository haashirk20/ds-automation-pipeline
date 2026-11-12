import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { env, loadConfig } from './config/index.ts';
import { hasAlertChannel } from './ops/alert.ts';
import { kvGet, openDb, schemaVersion } from './db/index.ts';
import { publishDue } from './publish/index.ts';
import { publishers } from './publish/registry.ts';
import { planDay } from './scheduler/planner.ts';
import { run } from './scheduler/loop.ts';
import { localDateOf } from './scheduler/time.ts';

const USAGE = 'usage: cli.ts [--now ISO] run [--once] | plan [--date YYYY-MM-DD] | publish | doctor | health';
const ENV_NAMES = ['DRY_RUN', 'DATA_DIR', 'OUT_DIR', 'ALERT_DISCORD_WEBHOOK', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID', 'HEALTHCHECK_URL'];

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { now: { type: 'string' }, once: { type: 'boolean' }, date: { type: 'string' } },
  });
  const cmd = positionals[0];
  if (!['run', 'plan', 'publish', 'doctor', 'health'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  // The clock is only read here; below this layer, time arrives as `now`.
  const override = values.now ?? process.env.PIPELINE_NOW;
  const offsetMs = override ? Date.parse(override) - Date.now() : 0;
  if (Number.isNaN(offsetMs)) {
    console.error('invalid --now');
    return 2;
  }
  const clock = () => new Date(Date.now() + offsetMs);

  if (existsSync('.env')) process.loadEnvFile('.env');
  if (cmd === 'health') {
    const db = openDb(env.dataDir());
    const hb = kvGet(db, 'heartbeat');
    return hb && clock().getTime() - Date.parse(hb) < 300_000 ? 0 : 1;
  }
  if (cmd === 'doctor') return doctor(clock());

  const config = loadConfig();
  const db = openDb(env.dataDir());
  const deps = { db, config, publishers };
  if (cmd === 'run') await run(deps, clock, !!values.once);
  else if (cmd === 'plan') {
    const now = clock();
    planDay(db, config, values.date ?? localDateOf(now, config.timezone), now);
  } else await publishDue(db, config, publishers, clock());
  return 0;
}

function doctor(now: Date): number {
  let bad = false;
  try {
    loadConfig();
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
  } catch (e) {
    bad = true;
    console.log('db: BROKEN ' + e);
  }
  if (!env.dryRun() && !hasAlertChannel()) {
    bad = true;
    console.log('alerts: NO CHANNEL configured and DRY_RUN is not 1');
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
