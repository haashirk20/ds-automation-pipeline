// Phase 6 exit criterion: two slots a day per platform, alerts, summary, cleanup, in a compressed-time DRY_RUN.
//
// Calls `node src/cli.ts --now T run --once` every 5 simulated minutes from 2026-11-20 20:55 to
// 2026-11-22 23:59 (America/Toronto), with the 'fake' clip provider, stubbed model calls and a local
// capture server in place of every webhook and ping. Two faults: one slot receives a 10-second clip
// (it must be rejected), and the capture server answers 500 for the whole local day 2026-11-21.
// Then it asserts from the database, the capture server and the files, and prints a pass/fail table.
//
// Spends nothing and sends nothing: the child gets an explicit environment (no .env, no real keys),
// and the driver refuses to start otherwise.
//
//   node tools/sim/compressed-run.ts --clip FILE(15 s or longer) --brief brief.json [--root DIR] [--steps N]
//
// --brief: a JSON array of stored briefs whose photos exist under ./data/ of the repository.
// --steps N runs only the first N steps (a smoke test; the assertions are skipped).
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/db/index.ts';
import { ff } from '../../src/render/ffmpeg.ts';
import { probeVideo } from '../../src/render/probe.ts';
import { addDays, localDateOf, localHHMM } from '../../src/scheduler/time.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TZ = 'America/Toronto';
const D = '2026-11-20';
const FAULT_SLOT = '2026-11-22#1'; // gets the 10-second clip
const OUTAGE_DAY = '2026-11-21'; // the capture server answers 500 on this local day
const START = new Date('2026-11-21T01:55:00Z'); // 20:55 on D (UTC-5)
const END = new Date('2026-11-23T04:59:00Z'); // 23:59 on D+2

const { values } = parseArgs({ options: { clip: { type: 'string' }, steps: { type: 'string' }, root: { type: 'string' }, brief: { type: 'string' } } });
if (!values.clip || !values.brief) throw new Error('usage: compressed-run.ts --clip FILE --brief brief.json [--root DIR] [--steps N]');

// ---------- temp area and safety checks ----------
const tmp = mkdtempSync(path.join(path.resolve(values.root ?? tmpdir()), 'p6sim-'));
const dirs = { cwd: path.join(tmp, 'cwd'), data: path.join(tmp, 'data'), out: path.join(tmp, 'out'), stub: path.join(tmp, 'stub') };
for (const d of [dirs.cwd, dirs.out, dirs.stub]) mkdirSync(d);
// Remotion looks for its Chrome in <nearest package.json dir>/node_modules/.remotion and downloads it (remotion.media) when absent.
// Give the child a package.json and the installed browser, or the guard below blocks that download.
writeFileSync(path.join(dirs.cwd, 'package.json'), '{}');
mkdirSync(path.join(dirs.cwd, 'node_modules'));
symlinkSync(path.join(ROOT, 'node_modules/.remotion'), path.join(dirs.cwd, 'node_modules/.remotion'));
if (existsSync(dirs.data)) throw new Error('refusing to start: DATA_DIR already exists');
if (existsSync(path.join(dirs.cwd, '.env'))) throw new Error('refusing to start: a .env exists in the working directory');

const stubClip = path.join(dirs.stub, 'clip.mp4');
const longClip = path.join(dirs.stub, 'long.mp4');
const shortClip = path.join(dirs.stub, 'short.mp4');
copyFileSync(values.clip, longClip);
await ff('ffmpeg', ['-y', '-v', 'error', '-i', longClip, '-t', '10', '-c', 'copy', shortClip]);
const probeLong = await probeVideo(longClip);
const probeShort = await probeVideo(shortClip);
if (!probeLong || probeLong.seconds < 15) throw new Error(`the stub clip must be at least 15 s: ${probeLong?.seconds}`);
if (!probeShort || probeShort.seconds >= 14) throw new Error(`the short clip must be under 14 s: ${probeShort?.seconds}`);
const setStub = (src: string) => { copyFileSync(src, stubClip + '.tmp'); renameSync(stubClip + '.tmp', stubClip); };
setStub(longClip);

// ---------- override config ----------
const configFile = path.join(tmp, 'sim.config.ts');
writeFileSync(configFile, `import raw from ${JSON.stringify(path.join(ROOT, 'config/pipeline.config.ts'))};
export default {
  ...raw,
  platforms: {
    ...raw.platforms,
    facebook: { ...raw.platforms.facebook, enabled: true },
    instagram: { ...raw.platforms.instagram, enabled: true, visibility: 'public' },
  },
  ugc: { ...raw.ugc, reuseAfterDays: 1 },
  ops: { ...raw.ops, keepDays: 1 },
  // Three jobs fit under the cap (3 x 0.57 = 1.71); the fourth is refused. Day 2 makes two clips, day 3 one
  // (the fault slot's, rejected), so day 3's slots both post a stored clip again.
  tiers: { ...raw.tiers, mix: { t0: 0, t1: 0, t2: 1 }, capsUsd: { t1: 15, t2: 1.8 }, t2: { ...raw.tiers.t2, provider: 'fake' } },
};
`);
const sim = (await import(configFile)).default;
if (sim.tiers.t2.provider !== 'fake') throw new Error('refusing to start: tier 2 provider is not fake');

// ---------- seed the brief (there is no Shopify) ----------
const db0 = openDb(dirs.data);
for (const b of JSON.parse(readFileSync(values.brief, 'utf8'))) {
  db0.prepare('INSERT INTO products (handle, title, updated_at, raw_json, fetched_at) VALUES (?,?,?,?,?)').run(b.product.handle, b.product.title, null, '{}', START.toISOString());
  db0.prepare('INSERT INTO briefs (handle, source_hash, json, built_at) VALUES (?,?,?,?)').run(b.product.handle, b.sourceHash, JSON.stringify(b), START.toISOString());
  for (const s of b.shots) {
    const dest = path.join(dirs.data, s.file);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(ROOT, 'data', s.file), dest);
  }
}
db0.close();

// ---------- capture server ----------
type Hit = { sim: string; path: string; status: number; kind: string | null };
const hits: Hit[] = [];
let simNow = START;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const status = localDateOf(simNow, TZ) === OUTAGE_DAY ? 500 : 200;
    let content = '';
    try { content = JSON.parse(body).content ?? ''; } catch { /* a ping has no body */ }
    hits.push({ sim: simNow.toISOString(), path: req.url ?? '', status, kind: /^\[(\w+)\]/.exec(content)?.[1] ?? null });
    res.writeHead(status).end('{}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = (p: string) => `http://127.0.0.1:${(server.address() as { port: number }).port}${p}`;

// ---------- the child environment: explicit, nothing else ----------
const childEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
  DRY_RUN: '1', LLM_STUB: '1', DATA_DIR: dirs.data, OUT_DIR: dirs.out, PIPELINE_CONFIG: configFile, CLIP_STUB_FILE: stubClip,
  ALERT_DISCORD_WEBHOOK: url('/discord'), HEALTHCHECK_URL: url('/hc'), HEALTHCHECK_DAILY_URL: url('/daily'),
  // Any request that is not to the local capture server goes to a dead proxy and fails.
  NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost,0.0.0.0,::,::1,[::],[::1]', // Remotion serves its bundle on 0.0.0.0 or :: and connects back to it
};
const ALLOWED = new Set(['PATH', 'HOME', 'DRY_RUN', 'LLM_STUB', 'DATA_DIR', 'OUT_DIR', 'PIPELINE_CONFIG', 'CLIP_STUB_FILE', 'ALERT_DISCORD_WEBHOOK', 'HEALTHCHECK_URL', 'HEALTHCHECK_DAILY_URL', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
for (const k of Object.keys(childEnv)) if (!ALLOWED.has(k)) throw new Error(`refusing to start: ${k} is not an allowed variable`);

// ---------- fault watcher: when the fault slot starts producing, the stub becomes the 10 s clip ----------
let faultHit = false;
let restored = false;
let rd: DatabaseSync | undefined;
const watching = setInterval(() => {
  try {
    rd ??= new DatabaseSync(path.join(dirs.data, 'pipeline.db'), { readOnly: true });
    if (!faultHit && rd.prepare("SELECT 1 FROM slots WHERE id = ? AND status = 'producing'").get(FAULT_SLOT)) { setStub(shortClip); faultHit = true; }
  } catch { rd = undefined; }
}, 20);

// ---------- the steps ----------
const steps: Date[] = [];
for (let t = START.getTime(); t <= END.getTime(); t += 5 * 60000) steps.push(new Date(t));
if (steps.at(-1)!.getTime() !== END.getTime()) steps.push(END);
const limit = values.steps ? Number(values.steps) : steps.length;
if (localDateOf(START, TZ) !== D || localHHMM(START, TZ) !== '20:55' || localHHMM(END, TZ) !== '23:59') throw new Error('step range is not what it claims');

const logFile = path.join(tmp, 'cli.stderr.log');
const errLines: string[] = [];
const runStep = (now: Date) => new Promise<number>((resolve) => {
  simNow = now;
  const c = spawn(process.execPath, [path.join(ROOT, 'src/cli.ts'), '--now', now.toISOString(), 'run', '--once'], { cwd: dirs.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  c.stdout.on('data', () => {});
  c.stderr.on('data', (d) => (err += d));
  c.on('close', (code) => {
    writeFileSync(logFile, `--- ${now.toISOString()} exit ${code}\n${err}`, { flag: 'a' });
    for (const l of err.split('\n')) if (l && (/"level":"error"/.test(l) || !l.startsWith('{'))) errLines.push(l.slice(0, 300));
    resolve(code ?? -1);
  });
});

const t0 = Date.now();
let badExits = 0;
for (let i = 0; i < limit; i++) {
  if (await runStep(steps[i]) !== 0) badExits++;
  if (faultHit && !restored) { setStub(longClip); restored = true; } // the step is over: back to the 15 s clip
  if (i % 50 === 0) console.log(`step ${i + 1}/${limit} ${steps[i].toISOString()} elapsed ${Math.round((Date.now() - t0) / 1000)}s`);
}
clearInterval(watching);
const seconds = Math.round((Date.now() - t0) / 1000);
server.close();
console.log(`ran ${limit} steps in ${seconds}s, ${badExits} non-zero exits; workdir ${tmp}`);
if (values.steps) process.exit(0);

// ---------- assertions ----------
const db = new DatabaseSync(path.join(dirs.data, 'pipeline.db'), { readOnly: true });
const all = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as T[];
const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T;
const rows: { id: string; what: string; ok: boolean; detail: string }[] = [];
const check = (id: string, what: string, ok: boolean, detail: string) => rows.push({ id, what, ok, detail });
const days = [D, addDays(D, 1), addDays(D, 2)];
const platforms = Object.entries(sim.platforms).filter(([, p]) => (p as { enabled: boolean }).enabled).map(([n]) => n);

// 1. Two slots a day per platform.
for (const day of days) {
  const per = platforms.map((p) => {
    const r = all<{ state: string; dry_run: number; error: string | null }>('SELECT p.state, p.dry_run, p.error FROM publications p JOIN slots s ON s.id = p.slot_id WHERE s.local_date = ? AND p.platform = ?', day, p);
    return { p, published: r.filter((x) => x.state === 'published' && x.dry_run === 1).length, other: r.filter((x) => x.state !== 'published') };
  });
  if (day === D) {
    // The run starts at 20:55, after both slots of D (12:15, 19:45): the planner does not create past slots.
    check('A1-D', `${day}: no slots (both times were past at the first step)`, one<{ n: number }>('SELECT COUNT(*) AS n FROM slots WHERE local_date = ?', day).n === 0, '');
  } else {
    check(`A1-D+${days.indexOf(day)}`, `${day}: 2 published (dry_run=1) per platform`, per.every((x) => x.published === 2 && !x.other.length), JSON.stringify(per.map((x) => [x.p, x.published])));
  }
}
const nonDry = one<{ n: number }>("SELECT COUNT(*) AS n FROM publications WHERE state = 'published' AND (dry_run != 1 OR post_id != 'dry-run')").n;
check('A2', 'every published row is a dry run', nonDry === 0, `${nonDry} not dry-run`);

// 2. Spend.
const spend = all<{ provider: string; state: string; slot_id: string }>('SELECT provider, state, slot_id FROM spend ORDER BY id');
const states = spend.map((s) => `${s.slot_id}:${s.state}`).join(' ');
check('A3', 'spend rows only from provider fake', spend.length > 0 && spend.every((s) => s.provider === 'fake'), states);
check('A4', 'ledger: two clips made on day 2, the 10 s clip of day 3 rejected, nothing after the cap', states === '2026-11-21#1:succeeded 2026-11-21#2:succeeded 2026-11-22#1:rejected', states);
const llm = one<{ n: number; real: number; cost: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(model != 'stub'),0) AS real, COALESCE(SUM(cost_usd),0) AS cost FROM llm_calls");
check('A5', 'llm_calls only stub, cost 0', llm.n > 0 && llm.real === 0 && llm.cost === 0, `${llm.n} calls, ${llm.real} not stub, cost ${llm.cost}`);

// 3. Alerts.
const kinds = all<{ kind: string; n: number; ok: number }>('SELECT kind, COUNT(*) AS n, SUM(delivered) AS ok FROM events GROUP BY kind ORDER BY kind');
const kindMap = new Map(kinds.map((k) => [k.kind, k]));
for (const k of ['ingest_failed', 'degraded', 'budget_cap', 'daily_summary']) {
  check(`A6-${k}`, `alert ${k} in events and at the capture server`, kindMap.has(k) && hits.some((h) => h.kind === k), `events ${kindMap.get(k)?.n ?? 0} (delivered ${kindMap.get(k)?.ok ?? 0}), server saw ${hits.filter((h) => h.kind === k).length}`);
}
const bad = kinds.filter((k) => ['tick_failed', 'snapshot_failed', 'disk_full', 'publish_needs_attention'].includes(k.kind));
check('A7', 'no tick_failed, snapshot_failed, disk_full or needs_attention alert', bad.length === 0, `kinds: ${kinds.map((k) => `${k.kind}=${k.n}`).join(' ')}`);
check('A7b', 'every event written during the 500 day is undelivered; every other one is delivered',
  all<{ ts: string; delivered: number }>('SELECT ts, delivered FROM events').every((e) => (localDateOf(new Date(e.ts), TZ) === OUTAGE_DAY) === (e.delivered === 0)), '');

// 4. Summaries and the daily ping.
const sums = all<{ ts: string; key: string; delivered: number }>("SELECT ts, key, delivered FROM events WHERE kind = 'daily_summary' ORDER BY id");
const kD = sums.filter((s) => s.key === D);
const kD1 = sums.filter((s) => s.key === addDays(D, 1));
check('A8', `summary for ${D} (sent during the 500 day): attempted, never delivered`, kD.length > 1 && kD.every((s) => !s.delivered), `${kD.length} attempts, ${kD.filter((s) => s.delivered).length} delivered`);
const gaps = kD.slice(1).map((s, i) => (Date.parse(s.ts) - Date.parse(kD[i].ts)) / 60000);
check('A9', 'summary retries are at least 15 minutes apart', gaps.length > 0 && gaps.every((g) => g >= 15), `min gap ${Math.min(...gaps)} min over ${gaps.length}`);
check('A10', `summary for ${addDays(D, 1)}: one attempt, delivered, after the outage (the first step also sent the summary for ${addDays(D, -1)}, before it)`, kD1.length === 1 && kD1[0].delivered === 1 && sums.filter((x) => x.key === addDays(D, -1)).length === 1, `${kD1.length} attempts, ${kD1.filter((s) => s.delivered).length} delivered`);
const text = one<{ message: string } | undefined>("SELECT message FROM events WHERE kind = 'daily_summary' AND delivered = 1 ORDER BY id DESC LIMIT 1")?.message ?? '';
check('A11', "delivered summary lists the four platforms, the spend line and the backup line", platforms.every((p) => text.includes(p)) && /Spend this month/.test(text) && /Backup:/.test(text), text.split('\n').slice(0, 3).join(' | '));
const daily = hits.filter((h) => h.path === '/daily');
const delivered = sums.filter((s) => s.delivered);
const sameTimes = daily.length === delivered.length && daily.every((h, i) => Math.abs(Date.parse(h.sim) - Date.parse(delivered[i].ts)) < 60_000); // the CLI clock runs on from --now by the real time elapsed
check('A12', 'daily ping only after a delivered summary: one ping per delivered summary, at its tick, none in the outage', daily.length === delivered.length && daily.length === 2 && daily.every((h) => h.status === 200) && sameTimes && !daily.some((h) => localDateOf(new Date(h.sim), TZ) === OUTAGE_DAY), `pings at ${daily.map((h) => h.sim).join(',')}; delivered summaries at ${delivered.map((x) => x.ts).join(',')}`);
check('A13', 'every request went to the capture server, on the three expected paths', hits.length > 0 && hits.every((h) => ['/discord', '/hc', '/daily'].includes(h.path)), [...new Set(hits.map((h) => h.path))].join(' '));

// 5. Housekeeping.
const attemptDirs: string[] = [];
for (const d of existsSync(dirs.out) ? readdirSync(dirs.out) : []) {
  if (d > addDays(D, 2)) continue; // D+3 was planned and produced at 21:00 on D+2; its housekeeping is the next night's
  for (const s of readdirSync(path.join(dirs.out, d))) for (const e of readdirSync(path.join(dirs.out, d, s))) if (/^attempt-/.test(e)) attemptDirs.push(`${d}/${s}/${e}`);
}
check('A14', 'no attempt folders left for slots of D..D+2', attemptDirs.length === 0, attemptDirs.join(' ') || 'none');
const renderLeft = (d: string) => (existsSync(path.join(dirs.out, d)) ? readdirSync(path.join(dirs.out, d)).flatMap((s) => readdirSync(path.join(dirs.out, d, s)).filter((f) => f.endsWith('.mp4')).map((f) => `${s}/${f}`)) : []);
check('A15', 'renders of D and D+1 removed (older than keepDays, all published); D+2 renders kept', renderLeft(D).length === 0 && renderLeft(addDays(D, 1)).length === 0 && renderLeft(addDays(D, 2)).length === platforms.length * 2, `D:${renderLeft(D).length} D+1:${renderLeft(addDays(D, 1)).length} D+2:${renderLeft(addDays(D, 2)).length}`);
const clips = existsSync(path.join(dirs.data, 'clips')) ? readdirSync(path.join(dirs.data, 'clips')).sort() : [];
const held = new Set(all<{ master_json: string }>("SELECT master_json FROM slots WHERE status IN ('ready','done') AND master_json IS NOT NULL").map((r) => JSON.parse(r.master_json).clipFile as string));
check('A16', 'clips: the two referenced clips kept, the rejected 10 s clip removed', held.size === 2 && [...held].every((f) => existsSync(path.join(dirs.data, f))) && !clips.includes('2026-11-22-1.mp4'), `held ${[...held].join(',')}; on disk ${clips.join(',')}`);
check('A17', 'the fault hit: the fault slot was served the 10 s clip and it was rejected', faultHit && spend.some((s) => s.slot_id === FAULT_SLOT && s.state === 'rejected'), `faultHit=${faultHit}`);
const reused = all<{ id: string; master_json: string }>('SELECT id, master_json FROM slots WHERE master_json IS NOT NULL').filter((r) => JSON.parse(r.master_json).reusedFrom);
check('A18', 'the fault slot and the next one reused stored clips', reused.map((r) => r.id).join() === '2026-11-22#1,2026-11-22#2,2026-11-23#1,2026-11-23#2', reused.map((r) => `${r.id}<-${JSON.parse(r.master_json).reusedFrom}`).join(' '));

// 6. Snapshot.
const snapDir = path.join(dirs.data, 'backup');
let snapOk = false, snapDetail = 'missing';
if (existsSync(path.join(snapDir, 'pipeline.db')) && existsSync(path.join(snapDir, 'ready'))) {
  const s = new DatabaseSync(path.join(snapDir, 'pipeline.db'), { readOnly: true });
  const ic = (s.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  const n = (s.prepare('SELECT COUNT(*) AS n FROM slots').get() as { n: number }).n;
  const ready = readFileSync(path.join(snapDir, 'ready'), 'utf8').trim();
  snapOk = ic === 'ok' && n > 0 && !Number.isNaN(Date.parse(ready));
  snapDetail = `integrity ${ic}, ${n} slots, ready=${ready}`;
  s.close();
}
check('A19', 'snapshot file and ready marker exist; the snapshot opens as SQLite', snapOk, snapDetail);
check('A20', 'every step exited 0', badExits === 0, `${badExits} non-zero of ${limit}`);

console.log('\n' + 'id'.padEnd(11) + 'result'.padEnd(7) + 'assertion  [detail]');
for (const r of rows) console.log(r.id.padEnd(11) + (r.ok ? 'PASS' : 'FAIL').padEnd(7) + r.what + '  [' + r.detail.slice(0, 260) + ']');
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} passed, real time ${seconds}s, workdir ${tmp}`);
console.log('alert events by kind: ' + kinds.map((k) => `${k.kind}=${k.n}(${k.ok} delivered)`).join(' '));
console.log('capture server: ' + Object.entries(Object.groupBy(hits, (h) => `${h.path} ${h.status}`)).map(([k, v]) => `${k}=${v!.length}`).join(', '));
const uniqueErr = [...new Set(errLines)];
console.log(`error-level or non-JSON stderr lines: ${errLines.length} (${uniqueErr.length} distinct)`);
for (const l of uniqueErr.slice(0, 12)) console.log('  ' + l);
writeFileSync(path.join(tmp, 'hits.json'), JSON.stringify(hits));
process.exit(rows.every((r) => r.ok) ? 0 : 1);
