"""Procedural background bed: FM electric piano, pad, pluck, bass and soft drums, all numpy."""
import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf

SR = 48000
STYLES = {
    "lofi-keys": dict(comp="stab", pad=0.35, ep=1.0, bass=0.9, kick=0.8, snare=0.5, rim=0.0, hat=0.35),
    "warm-pad": dict(comp="sparse", pad=0.9, ep=0.6, bass=0.8, kick=0.5, snare=0.0, rim=0.0, hat=0.9),
    "soft-pluck": dict(comp="arp", pad=0.5, ep=0.7, bass=0.8, kick=0.6, snare=0.0, rim=0.5, hat=0.3),
}
BRIGHT = 1.0
MAJOR = [0, 2, 4, 5, 7, 9, 11]
PENTA = [0, 1, 2, 4, 5]  # scale degrees of the major pentatonic
KEYS = [("C", "Am", 0), ("D", "Bm", 2), ("F", "Dm", 5), ("G", "Em", 7), ("A", "F#m", 9)]
# 0-based diatonic degrees of the major scale; each chord is a seventh chord built on it
PROGS_MAJOR = [(0, 5, 3, 4), (0, 3, 5, 4), (0, 5, 1, 4), (3, 0, 4, 5)]
PROGS_MINOR = [(5, 3, 0, 4), (5, 0, 3, 4), (5, 1, 4, 0)]
STAB = [[(0, 3), (3, 2), (6, 2)], [(0, 4), (5, 2)], [(0, 2), (3, 3), (6, 2)]]
MELODY = [[(0, 3), (3, 2), (6, 2)], [(0, 2), (2, 2), (4, 4)], [(0, 4), (5, 1), (6, 2)], [(0, 3), (4, 2), (6, 2)]]
ARP = [[0, 1, 2, 3, 2, 1, 2, 1], [0, 2, 1, 3, 2, 3, 1, 2]]
KICKS = [[0, 4], [0, 3, 4], [0, 4, 7]]
BASS = [[(0, 3), (4, 3)], [(0, 5), (6, 2)]]


def env(n, att, rel):
    e = np.ones(n)
    a, r = min(int(att * SR), n), min(int(rel * SR), n)
    if a:
        e[:a] *= np.sin(np.linspace(0, np.pi / 2, a, endpoint=False)) ** 2
    if r:
        e[n - r:] *= np.cos(np.linspace(0, np.pi / 2, r)) ** 2
    return e


def tt(n):
    return np.arange(n) / SR


def epiano(f, dur, vel):
    n = int((dur + 0.05) * SR)
    t = tt(n)
    w = 2 * np.pi * f * t
    mod = 1.6 * vel * np.sin(w) * np.exp(-t * 3.5) + 0.12 * vel * np.sin(7 * w) * np.exp(-t * 18)
    y = np.sin(w + mod) * np.exp(-t * (1.8 + f / 400))
    for hf in (2600, 4200):  # bright tine attack, gone within ~80 ms
        y += BRIGHT * np.sin(2 * np.pi * f * max(1, round(hf / f)) * t) * np.exp(-t * 45)
    return y * env(n, 0.006, 0.05) * vel


def pad(f, dur, att):
    n = int((dur + 0.6) * SR)
    t = tt(n)
    y = np.zeros(n)
    for cents in (-4, 4):
        for h, a in ((1, 1.0), (2, 0.35), (3, 0.12)):
            y += a * np.sin(2 * np.pi * f * 2 ** (cents / 1200) * h * t)
    return y * env(n, att, 0.6) * 0.5


def pluck(f, dur, vel):
    n = int((dur + 0.05) * SR)
    t = tt(n)
    y = sum(np.sin(2 * np.pi * f * h * t) * h ** -1.3 * np.exp(-t * (3 + 2.5 * h)) for h in range(1, 7))
    y += BRIGHT * np.sin(2 * np.pi * f * max(1, round(3000 / f)) * t) * np.exp(-t * 45)
    return y * env(n, 0.005, 0.05) * vel


def bass(f, dur, vel):
    n = int((dur + 0.05) * SR)
    t = tt(n)
    y = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return y * env(n, 0.008, 0.05) * vel


def kick():
    n = int(0.3 * SR)
    t = tt(n)
    ph = 2 * np.pi * np.cumsum(45 + 75 * np.exp(-t * 28)) / SR
    return np.sin(ph) * np.exp(-t * 11) * env(n, 0.005, 0.05)


def hat(rng):
    n = int(0.07 * SR)
    return np.diff(rng.standard_normal(n + 2), 2) * np.exp(-tt(n) * 70) * env(n, 0.005, 0.02)


def snare(rng):
    n = int(0.18 * SR)
    t = tt(n)
    noise = np.convolve(rng.standard_normal(n), np.ones(6) / 6, "same")
    return (noise * 1.5 + np.sin(2 * np.pi * 180 * t) * np.exp(-t * 30)) * np.exp(-t * 22) * env(n, 0.005, 0.04)


def rim():
    n = int(0.06 * SR)
    t = tt(n)
    return (np.sin(2 * np.pi * 520 * t) + 0.6 * np.sin(2 * np.pi * 1210 * t)) * np.exp(-t * 70) * env(n, 0.005, 0.02)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def params(seed, style):
    rng = np.random.default_rng(seed)
    rng.integers(len(STYLES))  # draw kept so the other parameters are unchanged
    picked = list(STYLES)[seed % len(STYLES)]
    major, minor, off = KEYS[rng.integers(len(KEYS))]
    is_minor = bool(rng.integers(2))
    bpm = int(rng.integers(84, 105))
    progs = PROGS_MINOR if is_minor else PROGS_MAJOR
    prog = progs[rng.integers(len(progs))]
    return rng, style or picked, (minor if is_minor else major), off, bpm, prog


def render(seed, duration, style=None):
    rng, style, key, off, bpm, prog = params(seed, style)
    cfg = STYLES[style]
    n = round(duration * SR)
    N = n + SR
    L, R, S = np.zeros(N), np.zeros(N), np.zeros(N)

    def put(sig, t, pan, g, send=0.0):
        s = int(t * SR)
        if s >= N:
            return
        sig = sig[:N - s] * g
        a = (pan + 1) * np.pi / 4
        L[s:s + len(sig)] += sig * np.cos(a)
        R[s:s + len(sig)] += sig * np.sin(a)
        S[s:s + len(sig)] += sig * send

    beat = 60 / bpm
    step = beat / 2
    bar_len = 8 * step
    swing = rng.uniform(0.12, 0.28) * step
    tonic = 48 + off

    def sm(d):  # midi of scale degree d (may exceed one octave)
        return tonic + MAJOR[d % 7] + 12 * (d // 7)

    stab, mel, arp = STAB[rng.integers(3)], MELODY[rng.integers(4)], ARP[rng.integers(2)]
    kickp, bassp = KICKS[rng.integers(3)], BASS[rng.integers(2)]
    motif = [int(rng.integers(5, 10)) for _ in mel]
    lift = np.ceil(0.62 * duration / beat) * beat
    kick_s, hat_s, snare_s, rim_s = kick(), hat(rng), snare(rng), rim()

    def pidx_midi(i):
        return tonic + MAJOR[PENTA[i % 5]] + 12 * (i // 5)

    nbars = int(np.ceil(duration / bar_len))
    for b in range(nbars):
        r = prog[b % 4]
        chord = [sm(r + k) for k in (0, 2, 4, 6)]
        voic = list(chord)
        while max(voic) > 69:
            voic = [m - 12 for m in voic]
        b0 = b * bar_len
        for k, m in enumerate(chord):  # pad: whole bar
            put(pad(hz(m), bar_len, 0.12 if b == 0 else 0.25), b0, -0.4 + 0.27 * k, 0.14 * cfg["pad"], 0.6)
            if b0 >= lift - 1e-9:  # lift: extra pad voice an octave up
                put(pad(hz(m + 12), bar_len, 0.3), b0, 0.4 - 0.27 * k, 0.08 * cfg["pad"], 0.6)
        pits = list(motif)
        if b % 2 == 1:
            pits[-1] += int(rng.choice([-1, 1]))
        if b % 4 == 3:
            pits[1] += int(rng.choice([-2, 2]))
        for s in range(8):
            ts = b0 + s * step + (swing if s % 2 else 0)
            if b or s:
                ts += rng.uniform(-0.004, 0.004) * (ts > 0)
            ts = max(ts, 0.0)
            if ts >= duration:
                break
            v = lambda base: base * (1 + rng.uniform(-0.12, 0.12))
            after = ts >= lift
            if cfg["comp"] == "stab":
                for st, ln in stab:
                    if st == s:
                        for k, m in enumerate(voic):
                            put(epiano(hz(m), ln * step * 0.9, v(0.22)), ts, -0.35 + 0.2 * k, cfg["ep"])
            elif cfg["comp"] == "sparse" and s in (0, 4 if b % 2 else -1):
                for k, m in enumerate(voic[1:]):
                    put(epiano(hz(m), 3.5 * step, v(0.2)), ts, -0.3 + 0.3 * k, cfg["ep"], 0.4)
            elif cfg["comp"] == "arp":
                m = voic[arp[s] % 4] + (12 if arp[s] > 2 else 0)
                put(pluck(hz(m), 2 * step, v(0.4)), ts, -0.4 if s % 2 else 0.4, 0.6, 0.5)
            for (st, ln), p in zip(mel, pits):
                if st == s:
                    put(epiano(hz(pidx_midi(p)), ln * step * 0.95, v(0.3 * (1.15 if after else 1))), ts, 0.15, 0.7 * (1 + 0.4 * (cfg["comp"] != "stab")), 0.5)
            for st, ln in bassp:
                if st == s:
                    m = chord[0] - 12 if (st == 0 or b % 2) else chord[2] - 12
                    put(bass(hz(m), ln * step * 0.9, v(0.5)), ts, 0, cfg["bass"] * 0.45)
            if s in kickp:
                put(kick_s, ts, 0, cfg["kick"] * v(0.4))
            if s in (2, 6):
                put(snare_s, ts, -0.1, cfg["snare"] * v(0.14), 0.3)
                put(rim_s, ts, 0.1, cfg["rim"] * v(0.1))
            put(hat_s, ts, 0.25, cfg["hat"] * v(0.07 if s % 2 else 0.1) * (4 if after else 1.5))

    # short stereo reverb: decaying noise tails, different per channel, darkened
    fr = np.fft.rfftfreq(N, 1 / SR)
    m = int(0.7 * SR)
    ir = [rng.standard_normal(m) * np.exp(-tt(m) / 0.22) for _ in range(2)]
    ir = [np.fft.irfft(np.fft.rfft(x) / (1 + (np.fft.rfftfreq(m, 1 / SR) / 3000) ** 2), m) for x in ir]
    ir = [x / np.sqrt(np.sum(x ** 2)) * 0.5 for x in ir]
    Sf = np.fft.rfft(S)
    for ch, x in zip((L, R), ir):
        ch += np.fft.irfft(Sf * np.fft.rfft(x, N), N)[:N] * 0.9
    # warm master: low-pass ~11 kHz, gentle high-pass at 35 Hz
    g = 1 / np.sqrt(1 + (fr / 11000) ** 6) * fr ** 2 / (fr ** 2 + 35 ** 2)
    out = np.stack([np.fft.irfft(np.fft.rfft(c) * g, N)[:n] for c in (L, R)], axis=1)
    # ad shape: fast fade-in, 600 ms fade-out
    fi, fo = int(0.03 * SR), int(0.6 * SR)
    w = np.ones(n)
    w[:fi] = np.sin(np.linspace(0, np.pi / 2, fi, endpoint=False)) ** 2
    w[n - fo:] = np.cos(np.linspace(0, np.pi / 2, fo)) ** 2
    out *= w[:, None]
    # level: RMS -20 dBFS, soft-limit the peaks, then guarantee peak <= -3.5 dBFS
    target, ceil = 0.1, 10 ** (-3.5 / 20)
    for _ in range(3):
        out *= target / np.sqrt(np.mean(out ** 2))
        out = 0.6 * np.tanh(out / 0.6)
    out *= min(1.0, ceil / np.max(np.abs(out)))
    pcm = np.round(out * 32767).astype(np.int16)
    return pcm, style, bpm, key


def db(x):
    return round(float(20 * np.log10(max(x, 1e-9) / 32768)), 2)


def main():
    class P(argparse.ArgumentParser):
        def error(self, message):
            print(f"bed.py: {message}", file=sys.stderr)
            sys.exit(2)

    p = P(prog="bed.py")
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--duration", type=float, default=16.0)
    p.add_argument("--out", required=True)
    p.add_argument("--style", choices=list(STYLES))
    a = p.parse_args()
    if a.seed < 0:
        p.error("--seed must be >= 0")
    if not 5 <= a.duration <= 30:
        p.error("--duration must be between 5 and 30")
    if not os.path.isabs(a.out):
        p.error("--out must be an absolute path")
    pcm, style, bpm, key = render(a.seed, a.duration, a.style)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    sf.write(a.out, pcm, SR, subtype="PCM_16")
    f = pcm.astype(np.float64)
    print(json.dumps({"seed": a.seed, "style": style, "bpm": bpm, "key": key,
                      "durationMs": round(len(pcm) * 1000 / SR),
                      "peakDb": db(np.max(np.abs(f))), "rmsDb": db(np.sqrt(np.mean(f ** 2)))}))


if __name__ == "__main__":
    main()
