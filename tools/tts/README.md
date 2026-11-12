# tts
Kokoro-82M (CPU) text-to-speech with exact word timings. Python 3.12, managed by uv.
Run: `uv run --project tools/tts python tools/tts/tts.py < job.json > result.json`
Warm the HF cache (Docker build): `uv run --project tools/tts python tools/tts/tts.py --warm`
In: `{"lines":[{"id":"hook","text":"..."}],"voice":"af_heart","speed":1.0,"gapMs":180,"outWav":"/abs/voice.wav"}`
Voices: af_heart af_bella am_michael am_fenrir bf_emma bm_george. Writes mono 24 kHz 16-bit WAV to outWav.
Out: `{"durationMs":int,"sampleRate":24000,"lines":[{"id","startMs","endMs","words":[{"text","startMs","endMs"}]}]}`
Times are ms from the start of the file; punctuation is merged into the preceding word.
Bad input: one line on stderr, exit 2. Only the JSON goes to stdout; logs go to stderr.
Test: `uv run --project tools/tts pytest tools/tts -q` (includes one slow real-model test).
