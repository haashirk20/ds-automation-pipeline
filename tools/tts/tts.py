"""Kokoro-82M TTS CLI: job JSON on stdin, result JSON (word timings) on stdout. See README.md."""
import contextlib
import json
import os
import sys

SAMPLE_RATE = 24000
VOICES = ("af_heart", "af_bella", "am_michael", "am_fenrir", "bf_emma", "bm_george")
REPO = "hexgrad/Kokoro-82M"
# KPipeline/KModel take no revision argument; _pin_revision patches their hf_hub_download instead.
REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"


class JobError(Exception):
    pass


def validate(job):
    if not isinstance(job, dict):
        raise JobError("job must be a JSON object")
    lines = job.get("lines")
    if not isinstance(lines, list) or not lines:
        raise JobError("lines must be a non-empty list")
    ids = set()
    for ln in lines:
        if not isinstance(ln, dict) or not isinstance(ln.get("id"), str) or not ln["id"]:
            raise JobError("each line needs a string id")
        if ln["id"] in ids:
            raise JobError(f"duplicate line id {ln['id']}")
        ids.add(ln["id"])
        if not isinstance(ln.get("text"), str) or not ln["text"].strip():
            raise JobError(f"line {ln['id']} needs non-empty text")
    voice = job.get("voice", "af_heart")
    if voice not in VOICES:
        raise JobError(f"voice must be one of {', '.join(VOICES)}")
    speed = job.get("speed", 1.0)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2:
        raise JobError("speed must be a number in 0.5..2")
    gap = job.get("gapMs", 180)
    if isinstance(gap, bool) or not isinstance(gap, int) or not 0 <= gap <= 5000:
        raise JobError("gapMs must be an integer in 0..5000")
    out = job.get("outWav")
    if not isinstance(out, str) or not os.path.isabs(out):
        raise JobError("outWav must be an absolute path")
    return {"lines": lines, "voice": voice, "speed": float(speed), "gapMs": gap, "outWav": out}


def _is_punct(text):
    return not any(c.isalnum() for c in text)


def merge_tokens(tokens):
    """tokens: [(text, start_s|None, end_s|None)] -> words [{text, start, end}] in seconds (None if unknown).
    Punctuation joins the preceding word; leading punctuation joins the next word."""
    words, prefix = [], ""
    for text, start, end in tokens:
        if not text.strip():
            continue
        if _is_punct(text):
            if words:
                words[-1]["text"] += text
                if end is not None:
                    words[-1]["end"] = end if words[-1]["end"] is None else max(words[-1]["end"], end)
            else:
                prefix += text
        else:
            words.append({"text": prefix + text, "start": start, "end": end})
            prefix = ""
    return words


def fill_missing(words, line_start, line_end):
    """Evenly spread words with unknown times between their known neighbours (ms ints, in place)."""
    i = 0
    while i < len(words):
        if words[i]["start"] is not None and words[i]["end"] is not None:
            i += 1
            continue
        j = i
        while j < len(words) and (words[j]["start"] is None or words[j]["end"] is None):
            j += 1
        lo = words[i - 1]["end"] if i else line_start
        hi = words[j]["start"] if j < len(words) else line_end
        step = (hi - lo) / (j - i)
        for k in range(i, j):
            words[k]["start"] = round(lo + step * (k - i))
            words[k]["end"] = round(lo + step * (k - i + 1))
        i = j
    return words


def clamp_words(words, line_start, line_end):
    """Force line_start <= start < end <= line_end and no overlap (needs line_end > line_start)."""
    prev = line_start
    for w in words:
        s = min(max(w["start"], prev), line_end - 1)
        e = min(max(w["end"], s + 1), line_end)
        w["start"], w["end"] = s, e
        prev = e
    return words


def ms(samples):
    return round(samples * 1000 / SAMPLE_RATE)


def build_line(line_id, tokens, offset_samples, n_samples):
    """tokens: [(text, start_s, end_s)] relative to the line's audio."""
    start, end = ms(offset_samples), ms(offset_samples + n_samples)
    words = merge_tokens(tokens)
    for w in words:
        for k in ("start", "end"):
            if w[k] is not None:
                w[k] = start + round(w[k] * 1000)
    fill_missing(words, start, end)
    if end > start:
        clamp_words(words, start, end)
    return {"id": line_id, "startMs": start, "endMs": end, "words": [
        {"text": w["text"], "startMs": w["start"], "endMs": w["end"]} for w in words]}


def _pin_revision():
    import functools
    from huggingface_hub import hf_hub_download
    import kokoro.model
    import kokoro.pipeline
    pinned = functools.partial(hf_hub_download, revision=REVISION)
    kokoro.model.hf_hub_download = pinned
    kokoro.pipeline.hf_hub_download = pinned


def _pipelines(voices):
    from kokoro import KPipeline
    _pin_revision()
    return {lang: KPipeline(lang_code=lang, repo_id=REPO) for lang in sorted({v[0] for v in voices})}


def synthesize(job):
    import numpy as np
    import soundfile as sf
    pipe = _pipelines([job["voice"]])[job["voice"][0]]
    gap = np.zeros(round(job["gapMs"] * SAMPLE_RATE / 1000), dtype=np.float32)
    parts, lines, total = [], [], 0
    for n, ln in enumerate(job["lines"]):
        if n and len(gap):
            parts.append(gap)
            total += len(gap)
        audio, tokens = [], []
        for r in pipe(ln["text"], voice=job["voice"], speed=job["speed"]):
            if r.audio is None:
                continue
            a = r.audio.numpy().astype(np.float32)
            base = sum(len(x) for x in audio) / SAMPLE_RATE  # a long line comes back in chunks
            tokens += [(t.text, None if t.start_ts is None else t.start_ts + base,
                        None if t.end_ts is None else t.end_ts + base) for t in (r.tokens or [])]
            audio.append(a)
        n_samples = sum(len(x) for x in audio)
        lines.append(build_line(ln["id"], tokens, total, n_samples))
        parts += audio
        total += n_samples
    os.makedirs(os.path.dirname(job["outWav"]), exist_ok=True)
    sf.write(job["outWav"], np.concatenate(parts), SAMPLE_RATE, subtype="PCM_16", format="WAV")
    return {"durationMs": ms(total), "sampleRate": SAMPLE_RATE, "lines": lines}


def main():
    if sys.argv[1:] == ["--warm"]:
        with contextlib.redirect_stdout(sys.stderr):
            for lang, p in _pipelines(VOICES).items():
                for v in VOICES:
                    if v[0] == lang:
                        p.load_voice(v)
        return 0
    try:
        job = validate(json.load(sys.stdin))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"invalid JSON: {e}", file=sys.stderr)
        return 2
    except JobError as e:
        print(str(e), file=sys.stderr)
        return 2
    with contextlib.redirect_stdout(sys.stderr):  # libraries print() warnings
        result = synthesize(job)
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
