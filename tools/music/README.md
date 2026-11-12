# music
Procedural background bed for the ads: numpy synthesis, no samples, no downloads. Same seed gives identical bytes.

    uv run --project tools/music python tools/music/bed.py --seed 12345 --duration 16 --out /abs/path/bed.wav

Writes stereo 48 kHz 16-bit WAV, prints one JSON line: seed, style, bpm, key, durationMs, peakDb, rmsDb.
Styles: lofi-keys, warm-pad, soft-pluck (`--style` overrides the seed's pick). Duration 5-30 s. Bad arguments exit 2.
Level about -20 dBFS RMS, peak at or below -3 dBFS. Tests: `uv run --project tools/music pytest tools/music`.
