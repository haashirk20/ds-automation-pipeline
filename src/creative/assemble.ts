import path from 'node:path';
import { Edl, MOTIONS, type Brief, type Script } from '../contracts.ts';
import type { TtsResult } from '../tts/index.ts';

export class ScriptTooLongError extends Error {
  constructor(speechEndMs: number) {
    super(`voice-over ends at ${speechEndMs} ms, past the 14800 ms limit`);
    this.name = 'ScriptTooLongError';
  }
}

export type AssembleInput = {
  slotId: string;
  brief: Brief;
  script: Script;
  template: Edl['template'];
  palette: Edl['palette'];
  tts: TtsResult;
  voiceSrc: string;
  musicSrc: string | null;
  musicGainDb: number;
  dataDir: string;
  ai: Edl['ai'];
};

const words = (s: string) => s.split(/\s+/).filter(Boolean);

// One spoken line per beat: id = beat kind, text = the chunks' `say` strings joined by a space.
export function ttsLines(script: Script): { id: string; text: string }[] {
  return script.beats.map((b) => ({ id: b.kind, text: b.chunks.map((c) => c.say).join(' ') }));
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h;
}

type Timed = { text: string; startMs: number; endMs: number };

// Splits [start,end] across items in proportion to their weights.
function spread(texts: string[], weights: number[], start: number, end: number): Timed[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return texts.map((text, i) => {
    const s = start + ((end - start) * acc) / total;
    acc += weights[i];
    return { text, startMs: Math.round(s), endMs: Math.round(start + ((end - start) * acc) / total) };
  });
}

export function assembleEdl(input: AssembleInput): Edl {
  const { brief, script, tts } = input;
  const speechEnd = Math.max(0, ...tts.lines.map((l) => l.endMs));
  if (speechEnd > 14800) throw new ScriptTooLongError(speechEnd);
  const durationMs = speechEnd <= 13800 ? 15000 : Math.min(16000, speechEnd + 1200);

  const lineOf = (id: string) => {
    const l = tts.lines.find((x) => x.id === id);
    if (!l) throw new Error(`no TTS line for beat ${id}`);
    return l;
  };
  const shotOf = (id: string) => {
    const s = brief.shots.find((x) => x.id === id);
    if (!s) throw new Error(`unknown shot id ${id}`);
    return s;
  };

  const starts = script.beats.map((b, i) => (i === 0 ? 0 : Math.max(0, lineOf(b.kind).startMs - 120)));
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + 1);
  const ends = starts.map((_, i) => (i + 1 < starts.length ? starts[i + 1] : durationMs));

  const captions: Edl['captions'] = [];
  const capBeat: number[] = [];
  script.beats.forEach((beat, bi) => {
    const line = lineOf(beat.kind);
    const counts = beat.chunks.map((c) => words(c.say).length);
    const exact = counts.reduce((a, b) => a + b, 0) === line.words.length;
    const chunkTimes = spread(beat.chunks.map((c) => c.say), counts, line.startMs, line.endMs);
    let at = 0;
    beat.chunks.forEach((chunk, ci) => {
      const spoken = exact ? line.words.slice(at, at + counts[ci]) : null;
      at += counts[ci];
      const startMs = spoken ? spoken[0].startMs : chunkTimes[ci].startMs;
      const endMs = spoken ? spoken[spoken.length - 1].endMs : chunkTimes[ci].endMs;
      const shown = words(chunk.show);
      const timed =
        spoken && spoken.length === shown.length
          ? shown.map((text, i) => ({ text, startMs: spoken[i].startMs, endMs: spoken[i].endMs }))
          : spread(shown, shown.map((w) => w.length), startMs, endMs);
      captions.push({ startMs, endMs, words: timed });
      capBeat.push(bi);
    });
  });
  captions.forEach((c, i) => {
    const next = captions[i + 1]?.startMs ?? Infinity;
    const limit = Math.min(c.endMs + 350, next - 60, ends[capBeat[i]]);
    c.endMs = Math.max(c.endMs, Math.round(limit)); // never shorten, even if the next caption is close
  });

  const motions = MOTIONS.filter((m) => m !== 'still');
  const offset = hash(input.slotId);
  let k = 0;
  const beats = script.beats.map((beat, bi) => {
    const n = beat.shotIds.length;
    const span = ends[bi] - starts[bi];
    return {
      kind: beat.kind,
      startMs: starts[bi],
      endMs: ends[bi],
      shots: beat.shotIds.map((id, i) => {
        const s = shotOf(id);
        return {
          src: path.resolve(input.dataDir, s.file),
          width: s.width,
          height: s.height,
          crop: s.crop,
          kind: s.kind,
          startMs: starts[bi] + Math.floor((span * i) / n),
          endMs: i === n - 1 ? ends[bi] : starts[bi] + Math.floor((span * (i + 1)) / n),
          motion: motions[(offset + k++) % motions.length],
        };
      }),
    };
  });

  const endShot = shotOf(script.beats.find((b) => b.kind === 'cta')!.shotIds[0]);
  return Edl.parse({
    version: 1,
    slotId: input.slotId,
    template: input.template,
    palette: input.palette,
    durationMs,
    headline: script.hook.headline,
    beats,
    captions,
    endCard: {
      title: brief.product.title,
      priceText: brief.product.priceText,
      shopName: brief.shop.name,
      shopDomain: brief.shop.domain,
      disclosures: brief.disclosures,
      shotSrc: path.resolve(input.dataDir, endShot.file),
      shotWidth: endShot.width,
      shotHeight: endShot.height,
      shotCrop: endShot.crop,
    },
    audio: { voiceSrc: input.voiceSrc, musicSrc: input.musicSrc, musicGainDb: input.musicGainDb },
    ai: input.ai,
  });
}
