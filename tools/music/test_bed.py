import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

BED = str(Path(__file__).with_name("bed.py"))
STYLES = ["lofi-keys", "warm-pad", "soft-pluck"]


def run(tmp_path, name, *args):
    out = tmp_path / name
    r = subprocess.run([sys.executable, BED, "--out", str(out), *args], capture_output=True, text=True)
    return r, out


def load(path):
    x, sr = sf.read(path, dtype="float64")
    return x, sr


@pytest.fixture(scope="module")
def a(tmp_path_factory):
    d = tmp_path_factory.mktemp("a")
    r, out = run(d, "a.wav", "--seed", "7", "--duration", "10")
    assert r.returncode == 0, r.stderr
    return r, out


def test_stdout_is_only_json(a):
    j = json.loads(a[0].stdout)
    assert set(j) == {"seed", "style", "bpm", "key", "durationMs", "peakDb", "rmsDb"}
    assert 84 <= j["bpm"] <= 104


def test_deterministic(a, tmp_path):
    _, b = run(tmp_path, "b.wav", "--seed", "7", "--duration", "10")
    assert a[1].read_bytes() == b.read_bytes()


def test_different_seeds_differ(a, tmp_path):
    _, b = run(tmp_path, "b.wav", "--seed", "8", "--duration", "10")
    assert a[1].read_bytes() != b.read_bytes()


def test_format_duration_level(a):
    x, sr = load(a[1])
    assert sr == 48000 and x.shape[1] == 2 and sf.info(a[1]).subtype == "PCM_16"
    assert abs(len(x) / sr - 10) < 0.01
    assert np.all(np.isfinite(x))
    assert 20 * np.log10(np.max(np.abs(x))) <= -3
    assert abs(20 * np.log10(np.sqrt(np.mean(x ** 2))) + 20) <= 3


def test_no_long_silence(a):
    x, sr = load(a[1])
    quiet = np.abs(x).max(axis=1) < 1e-3
    quiet[: sr // 10] = False
    run_len = best = 0
    for q in quiet:
        run_len = run_len + 1 if q else 0
        best = max(best, run_len)
    assert best < 0.4 * sr


def test_no_clicks_at_ends(a):
    x, _ = load(a[1])
    assert np.abs(x[0]).max() < 0.002 and np.abs(x[-1]).max() < 0.002


def test_stereo(a):
    x, _ = load(a[1])
    assert not np.array_equal(x[:, 0], x[:, 1])


@pytest.mark.parametrize("style", STYLES)
def test_every_style_renders(tmp_path, style):
    r, out = run(tmp_path, "s.wav", "--seed", "3", "--duration", "5", "--style", style)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["style"] == style
    x, _ = load(out)
    assert np.max(np.abs(x)) > 0.05


@pytest.mark.parametrize("args", [
    [], ["--seed", "x"], ["--seed", "1", "--duration", "4"], ["--seed", "1", "--duration", "31"],
    ["--seed", "1", "--style", "nope"], ["--seed", "-1"],
])
def test_bad_args_exit_2(tmp_path, args):
    r, _ = run(tmp_path, "z.wav", *args)
    assert r.returncode == 2 and r.stdout == "" and len(r.stderr.strip().splitlines()) == 1


def test_relative_out_exit_2():
    r = subprocess.run([sys.executable, BED, "--seed", "1", "--out", "rel.wav"], capture_output=True, text=True)
    assert r.returncode == 2 and r.stdout == ""


@pytest.mark.parametrize("seed", range(1, 7))
def test_brightness_share(tmp_path, seed):
    _, out = run(tmp_path, "s.wav", "--seed", str(seed))
    m = load(out)[0].mean(axis=1)
    p = np.abs(np.fft.rfft(m)) ** 2
    f = np.fft.rfftfreq(len(m), 1 / 48000)
    assert 0.02 <= p[f >= 2000].sum() / p.sum() <= 0.10
    assert p[f >= 8000].sum() / p.sum() < 0.01
