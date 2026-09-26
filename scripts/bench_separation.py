"""Stem-separation quality benchmark against ground truth (MUSDB18 7-second test set).

Runs engine/separate.py on each mixture and scores every stem against the real isolated part:
  SDR      10*log10(|true|^2 / |true - estimate|^2), per stem, in dB (higher = cleaner). This is the
           "uSDR" used by the Music Demixing challenges.
  bleed    vocals stem level during frames where the true vocals are silent, relative to the mix
           (lower = less music leaking into the vocals), in dB.
  crackle  5 ms frames where a stem has >10 dB more high-frequency energy than the true part
           (clicks, pops, musical noise), as a count per track.

Usage (engine venv python):
  python scripts/bench_separation.py --tracks 10 [--passes instruments,vocals] [--label name]
Results are appended to ~/.absolutesample/bench/results.jsonl.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

HOME = Path.home() / ".absolutesample"
BENCH = HOME / "bench"
ENGINE = Path(__file__).resolve().parents[1] / "engine" / "separate.py"
MODELS = HOME / "engine" / "models"


def sdr(ref: np.ndarray, est: np.ndarray) -> float:
    n = min(len(ref), len(est))
    ref, est = ref[:n], est[:n]
    num = float(np.sum(ref ** 2)) + 1e-8
    den = float(np.sum((ref - est) ** 2)) + 1e-8
    return 10.0 * np.log10(num / den)


def frames_db(x: np.ndarray, frame: int) -> np.ndarray:
    m = x.mean(axis=1) if x.ndim > 1 else x
    n = len(m) // frame
    e = (m[: n * frame].reshape(n, frame) ** 2).mean(axis=1)
    return 10.0 * np.log10(e + 1e-12)


def hf_db(x: np.ndarray, frame: int) -> np.ndarray:
    m = x.mean(axis=1) if x.ndim > 1 else x
    d2 = np.zeros_like(m)
    d2[2:] = m[2:] - 2 * m[1:-1] + m[:-2]
    return frames_db(d2, frame)


def vocal_bleed_db(true_voc: np.ndarray, est_voc: np.ndarray, mix: np.ndarray, sr: int) -> float | None:
    """Level of the vocal estimate, relative to the mix, where the real vocal is silent."""
    fr = int(0.05 * sr)
    tv = frames_db(true_voc, fr)
    ev = frames_db(est_voc, fr)
    mx = frames_db(mix, fr)
    n = min(len(tv), len(ev), len(mx))
    silent = (tv[:n] < mx[:n] - 45.0) & (mx[:n] > -50.0)
    if silent.sum() < 4:
        return None
    return float(np.mean(ev[:n][silent] - mx[:n][silent]))


def crackle_count(true: np.ndarray, est: np.ndarray, sr: int) -> int:
    fr = int(0.005 * sr)
    ht = hf_db(true, fr)
    he = hf_db(est, fr)
    n = min(len(ht), len(he))
    near = np.array([ht[max(0, i - 4): i + 5].max() for i in range(n)])
    return int(np.sum((he[:n] > near + 10.0) & (he[:n] > -70.0)))


def prepare(n_tracks: int) -> list[Path]:
    import musdb

    db = musdb.DB(root=str(BENCH / "musdb7"), subsets="test")
    out = []
    for t in db:
        d = BENCH / "tracks" / t.name.replace("/", "_")
        if not (d / "mixture.wav").exists():
            d.mkdir(parents=True, exist_ok=True)
            sf.write(d / "mixture.wav", t.audio, t.rate, subtype="FLOAT")
            for k in ("vocals", "drums", "bass", "other"):
                sf.write(d / f"{k}.wav", t.targets[k].audio, t.rate, subtype="FLOAT")
        # need audible vocals to score bleed and vocal SDR meaningfully
        v, _ = sf.read(d / "vocals.wav")
        if np.sqrt(np.mean(v ** 2)) > 0.01:
            out.append(d)
        if len(out) >= n_tracks:
            break
    return out


def estimates(out_dir: Path) -> dict[str, np.ndarray]:
    def rd(name: str):
        p = out_dir / f"{name}.wav"
        return sf.read(p, dtype="float32", always_2d=True)[0] if p.exists() else None

    est = {k: rd(k) for k in ("vocals", "drums", "bass", "guitar", "piano", "other")}
    other = None
    for k in ("guitar", "piano", "other"):
        if est[k] is not None:
            other = est[k] if other is None else other[: len(est[k])] + est[k][: len(other)]
    return {"vocals": est["vocals"], "drums": est["drums"], "bass": est["bass"], "other": other}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", type=int, default=10)
    ap.add_argument("--passes", default="instruments,vocals")
    ap.add_argument("--label", default="current")
    ap.add_argument("--extra", default="", help="extra args passed to separate.py")
    args = ap.parse_args()

    tracks = prepare(args.tracks)
    rows = []
    t_all = time.time()
    for d in tracks:
        out = BENCH / "runs" / args.label / d.name
        out.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        cmd = [sys.executable, str(ENGINE), "--input", str(d / "mixture.wav"), "--out", str(out),
               "--models-dir", str(MODELS), "--passes", args.passes] + (args.extra.split() if args.extra else [])
        r = subprocess.run(cmd, capture_output=True, text=True)
        if '"event": "done"' not in r.stdout:
            print("FAILED", d.name, r.stdout[-600:], r.stderr[-600:])
            continue
        secs = time.time() - t0
        mix = sf.read(d / "mixture.wav", dtype="float32", always_2d=True)[0]
        est = estimates(out)
        row = {"track": d.name, "seconds": round(secs, 1)}
        for k in ("vocals", "drums", "bass", "other"):
            ref = sf.read(d / f"{k}.wav", dtype="float32", always_2d=True)[0]
            if est[k] is None:
                continue
            row[f"sdr_{k}"] = round(sdr(ref, est[k]), 2)
            row[f"crackle_{k}"] = crackle_count(ref, est[k], 44100)
        tv = sf.read(d / "vocals.wav", dtype="float32", always_2d=True)[0]
        if est["vocals"] is not None:
            b = vocal_bleed_db(tv, est["vocals"], mix, 44100)
            row["bleed_vocals_db"] = None if b is None else round(b, 1)
        # stems should add back up to the mix
        tot = None
        for k in ("vocals", "drums", "bass", "other"):
            if est[k] is not None:
                tot = est[k] if tot is None else tot[: len(est[k])] + est[k][: len(tot)]
        row["sum_to_mix_sdr"] = round(sdr(mix, tot), 1) if tot is not None else None
        rows.append(row)
        print(json.dumps(row))

    def avg(key):
        vals = [r[key] for r in rows if r.get(key) is not None]
        return round(float(np.mean(vals)), 2) if vals else None

    def med(key):
        vals = [r[key] for r in rows if r.get(key) is not None]
        return round(float(np.median(vals)), 2) if vals else None

    summary = {"label": args.label, "passes": args.passes, "extra": args.extra, "tracks": len(rows),
               "minutes": round((time.time() - t_all) / 60, 1)}
    for k in ("vocals", "drums", "bass", "other"):
        summary[f"sdr_{k}"] = med(f"sdr_{k}")
        summary[f"crackle_{k}"] = avg(f"crackle_{k}")
    summary["bleed_vocals_db"] = avg("bleed_vocals_db")
    summary["sum_to_mix_sdr"] = avg("sum_to_mix_sdr")
    print("SUMMARY", json.dumps(summary))
    with open(BENCH / "results.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(summary) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
