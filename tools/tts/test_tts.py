import json
import os
import subprocess
import sys
import wave

import pytest

import tts

HERE = os.path.dirname(os.path.abspath(__file__))


def good(**kw):
    return {"lines": [{"id": "a", "text": "Hi"}], "outWav": "/tmp/x.wav", **kw}


def test_merge_punctuation():
    toks = [("Hello", 0.0, 0.4), (",", 0.4, 0.45), ("world", 0.5, 0.9), ("!", 0.9, None)]
    w = tts.merge_tokens(toks)
    assert [(x["text"], x["start"], x["end"]) for x in w] == [("Hello,", 0.0, 0.45), ("world!", 0.5, 0.9)]


def test_leading_punctuation_joins_next_word():
    assert tts.merge_tokens([('"', None, None), ("Hi", 0.0, 0.2)])[0]["text"] == '"Hi'


def test_interpolation():
    w = [{"text": "a", "start": 0, "end": 100}, {"text": "b", "start": None, "end": None},
         {"text": "c", "start": None, "end": None}, {"text": "d", "start": 400, "end": 500}]
    tts.fill_missing(w, 0, 500)
    assert [(x["start"], x["end"]) for x in w] == [(0, 100), (100, 250), (250, 400), (400, 500)]


def test_interpolation_edges():
    w = [{"text": "a", "start": None, "end": None}, {"text": "b", "start": None, "end": None}]
    tts.fill_missing(w, 1000, 1400)
    assert [(x["start"], x["end"]) for x in w] == [(1000, 1200), (1200, 1400)]


def test_gap_offsets_and_invariants():
    toks = [("one", 0.0, 0.5), ("two", 0.4, 0.5), (".", 0.5, 0.6)]  # overlap + shared end
    ln = tts.build_line("b", toks, 24000 + 4320, 24000)  # line 1 s long, starts after 1 s + 180 ms
    assert (ln["startMs"], ln["endMs"]) == (1180, 2180)
    prev = ln["startMs"]
    for w in ln["words"]:
        assert prev <= w["startMs"] < w["endMs"] <= ln["endMs"]
        prev = w["endMs"]
    assert ln["words"][0]["startMs"] == 1180 and ln["words"][1]["text"] == "two."


def test_words_clamped_to_line():
    ln = tts.build_line("x", [("a", 0.0, 0.1), ("b", 0.9, 2.0)], 0, 12000)  # 500 ms line
    assert ln["words"][-1]["endMs"] == 500


@pytest.mark.parametrize("patch", [
    {"voice": "nope"}, {"outWav": "rel.wav"}, {"outWav": None}, {"lines": []},
    {"lines": [{"id": "a", "text": " "}]}, {"lines": [{"id": "a", "text": "x"}, {"id": "a", "text": "y"}]},
    {"speed": 9}, {"gapMs": -1}, {"gapMs": 1.5},
])
def test_rejects_bad_job(patch):
    with pytest.raises(tts.JobError):
        tts.validate(good(**patch))


def test_accepts_all_voices():
    for v in tts.VOICES:
        assert tts.validate(good(voice=v))["voice"] == v


def run(stdin):
    return subprocess.run([sys.executable, os.path.join(HERE, "tts.py")], input=stdin,
                          capture_output=True, text=True)


def test_cli_bad_input_exit_2():
    for bad in ["not json", json.dumps(good(voice="x"))]:
        r = run(bad)
        assert r.returncode == 2 and r.stdout == "" and len(r.stderr.strip().splitlines()) == 1


@pytest.mark.slow
def test_real_model(tmp_path):
    out = tmp_path / "v.wav"
    job = {"lines": [{"id": "one", "text": "Hello there, world."}, {"id": "two", "text": "This is a test."}],
           "voice": "af_heart", "speed": 1.0, "gapMs": 180, "outWav": str(out)}
    r = run(json.dumps(job))
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    with wave.open(str(out)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (24000, 1, 2)
        wav_ms = w.getnframes() * 1000 / 24000
    assert abs(wav_ms - res["durationMs"]) <= 20
    assert [l["id"] for l in res["lines"]] == ["one", "two"]
    assert res["lines"][1]["startMs"] - res["lines"][0]["endMs"] == 180
    assert res["lines"][-1]["endMs"] == res["durationMs"]
    for ln in res["lines"]:
        assert ln["words"]
        prev = ln["startMs"]
        for w in ln["words"]:
            assert prev <= w["startMs"] < w["endMs"] <= ln["endMs"]
            prev = w["endMs"]
