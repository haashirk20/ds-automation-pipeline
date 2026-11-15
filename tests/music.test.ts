import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fresh } from './helpers.ts';
import { musicGainDb, musicRoot, pickTrack, sweepMusic } from '../src/music/tracks.ts';
import { ugcMusicVolume } from '../templates/music-volume.ts';

const m = { gainDb: -20, duckDb: -10, duckUntilMs: 5000 };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('ugcMusicVolume: base, duck, ramp, fades, clamp, no duck', () => {
  const lin = (db: number) => 10 ** (db / 20);
  close(ugcMusicVolume(2000, 15000, m), lin(-30)); // ducked
  close(ugcMusicVolume(8000, 15000, m), lin(-20)); // after the duck
  const mid = ugcMusicVolume(5075, 15000, m); // half way up the ramp
  assert.ok(mid > lin(-30) && mid < lin(-20));
  close(ugcMusicVolume(5075, 15000, m), lin(-25)); // half way
  close(ugcMusicVolume(5150, 15000, m), lin(-20)); // ramp done
  close(ugcMusicVolume(0, 15000, m), 0); // fade in starts silent
  close(ugcMusicVolume(150, 15000, { ...m, duckUntilMs: 0 }), lin(-20) * 0.5);
  close(ugcMusicVolume(15000, 15000, m), 0); // fade out ends silent
  close(ugcMusicVolume(14700, 15000, m), lin(-20) * 0.5);
  close(ugcMusicVolume(2000, 15000, { gainDb: 6, duckDb: 0, duckUntilMs: 0 }), 1); // never above 1
  close(ugcMusicVolume(2000, 15000, { ...m, duckUntilMs: 0 }), lin(-20)); // no duck
});

test('musicGainDb: lands on -14 LUFS plus the offset, clamped to [-40, 0]', () => {
  const t = (lufs: number) => ({ sha256: 'a', name: 'n', file: '/x', lufs });
  assert.equal(musicGainDb(t(-14), -18), -18);
  assert.equal(musicGainDb(t(-20), -18), -12);
  assert.equal(musicGainDb(t(-30), -5), 0);
  assert.equal(musicGainDb(t(-5), -40), -40);
});

const insert = (db: ReturnType<typeof fresh>, sha: string, o: { selected?: number; last?: string | null; created?: string; deleted?: string | null; file?: string } = {}) =>
  db.prepare('INSERT INTO music_tracks (sha256, name, file, seconds, lufs, selected, last_used_at, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sha, `t-${sha[0]}`, o.file ?? `music/${sha}.m4a`, 30, -16, o.selected ?? 1, o.last ?? null, o.created ?? '2026-11-01T00:00:00Z', o.deleted ?? null);
const sha = (c: string) => c.repeat(64);
const put = (c: string) => { mkdirSync(musicRoot(), { recursive: true }); writeFileSync(path.join(musicRoot(), `${sha(c)}.m4a`), 'x'); };

test('pickTrack: never-used first, then least recently used; skips unticked, deleted, missing and escaping files', () => {
  const db = fresh();
  assert.equal(pickTrack(db), null);
  for (const c of 'abcdef') put(c);
  insert(db, sha('a'), { last: '2026-11-10T00:00:00Z' });
  insert(db, sha('b'), { last: '2026-11-05T00:00:00Z' });
  insert(db, sha('c'), { selected: 0 });
  insert(db, sha('d'), { deleted: '2026-11-02T00:00:00Z' });
  insert(db, sha('e'), { file: '../../etc/passwd' });
  assert.equal(pickTrack(db)?.sha256, sha('b'));
  insert(db, sha('f'), { created: '2026-11-03T00:00:00Z' });
  const t = pickTrack(db)!;
  assert.equal(t.sha256, sha('f')); // never used beats used
  assert.equal(t.file, path.join(musicRoot(), `${sha('f')}.m4a`));
  insert(db, sha('9')); // row without a file
  db.prepare('UPDATE music_tracks SET last_used_at = ? WHERE sha256 = ?').run('2026-11-12T00:00:00Z', sha('f'));
  assert.equal(pickTrack(db)?.sha256, sha('b'));
});

test('sweepMusic: removes old incoming, .part and orphan files; keeps live tracks and fresh files', () => {
  const db = fresh();
  const now = new Date('2026-11-14T12:00:00Z');
  const root = musicRoot();
  mkdirSync(path.join(root, '.incoming'), { recursive: true });
  const old = new Date('2026-11-10T00:00:00Z');
  const mk = (f: string, when: Date) => { writeFileSync(f, 'x'); utimesSync(f, when, when); };
  mk(path.join(root, '.incoming', 'old'), old);
  mk(path.join(root, '.incoming', 'new'), new Date('2026-11-14T11:00:00Z'));
  mk(path.join(root, 'u.part'), old);
  mk(path.join(root, `${sha('a')}.m4a`), old); // live
  mk(path.join(root, `${sha('b')}.m4a`), old); // orphan
  mk(path.join(root, `${sha('c')}.m4a`), old); // row deleted
  mk(path.join(root, `${sha('d')}.m4a`), new Date('2026-11-14T11:30:00Z')); // orphan, younger than an hour: kept
  insert(db, sha('a'));
  insert(db, sha('c'), { deleted: '2026-11-11T00:00:00Z' });
  const r = sweepMusic(db, now);
  assert.deepEqual(r, { removed: 4, errors: [] });
  assert.ok(existsSync(path.join(root, `${sha('a')}.m4a`)) && existsSync(path.join(root, '.incoming', 'new')));
  assert.ok(!existsSync(path.join(root, `${sha('b')}.m4a`)) && !existsSync(path.join(root, 'u.part')));
  assert.ok(existsSync(path.join(root, `${sha('d')}.m4a`)));
});
