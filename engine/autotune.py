#!/usr/bin/env python
"""AbsoluteSample autotune engine.

Analyzes pitch (WORLD vocoder) and applies pitch-correction edits while
preserving timbre. Invoked by the Rust backend (and the CLI); never imported
by the frontend.

Usage:
  autotune.py --mode analyze --input <wav>
  autotune.py --mode apply --input <wav> --edits <json_path> [--out <wav>]

Protocol (stdout, one JSON line):
  analyze: {"event":"done","sampleRate":...,"hopSec":...,"f0":[...],"notes":[...],"key":{...}}
  apply:   {"event":"done","path":"<wav>"}
  fatal:   {"event":"fatal","error":"..."}   (exit code 1)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load_mono(path: str, sr_target: int = 44100) -> tuple[np.ndarray, int]:
    import librosa

    y, sr = librosa.load(path, sr=sr_target, mono=True)
    return y.astype(np.float64), sr


def hz_to_midi(hz: np.ndarray) -> np.ndarray:
    out = np.zeros_like(hz)
    voiced = hz > 0
    out[voiced] = 69.0 + 12.0 * np.log2(hz[voiced] / 440.0)
    return out


def cents_dev(midi: np.ndarray) -> np.ndarray:
    return (midi - np.round(midi)) * 100.0


def compute_world(y: np.ndarray, fs: int):
    import pyworld as pw

    f0, t = pw.harvest(y, fs)
    sp = pw.cheaptrick(y, f0, t, fs)
    ap = pw.d4c(y, f0, t, fs)
    return f0, t, sp, ap


def krumhansl_key(midi_series: np.ndarray, voiced: np.ndarray) -> dict:
    hist = np.zeros(12)
    for m, v in zip(midi_series, voiced):
        if v:
            hist[int(round(m)) % 12] += 1.0
    if hist.sum() <= 0:
        return {"tonic": "C", "mode": "major", "confidence": 0.0}
    hist = hist / hist.sum()
    best = None
    for mode, profile in (("major", KS_MAJOR), ("minor", KS_MINOR)):
        prof = np.array(profile)
        prof = prof / prof.sum()
        for tonic in range(12):
            rotated = np.roll(prof, tonic)
            corr = float(np.corrcoef(hist, rotated)[0, 1])
            if np.isnan(corr):
                corr = 0.0
            if best is None or corr > best[0]:
                best = (corr, tonic, mode)
    corr, tonic, mode = best
    confidence = max(0.0, min(1.0, (corr + 1.0) / 2.0))
    return {"tonic": NOTE_NAMES[tonic], "mode": mode, "confidence": round(confidence, 3)}


def analyze(inp: Path) -> int:
    y, fs = load_mono(str(inp))
    f0, t, _sp, _ap = compute_world(y, fs)

    # Thin harvest's ~5ms hop to ~10ms for a lighter payload.
    stride = 2
    t_thin = t[::stride]
    f0_thin = f0[::stride]

    midi = hz_to_midi(f0_thin)
    cents = cents_dev(midi)
    voiced = f0_thin > 0

    f0_list = [
        {
            "t": round(float(tt), 4),
            "hz": round(float(hz), 3),
            "midi": round(float(m), 3) if v else None,
            "cents": round(float(c), 1) if v else None,
            "voiced": bool(v),
        }
        for tt, hz, m, c, v in zip(t_thin, f0_thin, midi, cents, voiced)
    ]

    hop_sec = float(t_thin[1] - t_thin[0]) if len(t_thin) > 1 else 0.01

    # Segment voiced runs into notes.
    notes: list[dict] = []
    run_start = None
    run_midis: list[float] = []
    run_voiced_flags: list[bool] = []

    def flush(end_idx: int) -> None:
        nonlocal run_start, run_midis, run_voiced_flags
        if run_start is None or not run_midis:
            run_start, run_midis, run_voiced_flags = None, [], []
            return
        start_sec = float(t_thin[run_start])
        end_sec = float(t_thin[end_idx]) if end_idx < len(t_thin) else float(t_thin[-1]) + hop_sec
        if end_sec - start_sec >= 0.08:
            med_midi = float(np.median(run_midis))
            med_cents = (med_midi - round(med_midi)) * 100.0
            confidence = float(np.mean(run_voiced_flags)) if run_voiced_flags else 0.0
            notes.append({
                "startSec": round(start_sec, 4),
                "endSec": round(end_sec, 4),
                "midi": int(round(med_midi)),
                "cents": round(med_cents, 1),
                "confidence": round(confidence, 3),
            })
        run_start, run_midis, run_voiced_flags = None, [], []

    prev_midi = None
    for i, (m, v) in enumerate(zip(midi, voiced)):
        if not v:
            flush(i)
            prev_midi = None
            continue
        if run_start is None:
            run_start = i
            run_midis, run_voiced_flags = [], []
        elif prev_midi is not None and abs((m - prev_midi) * 100.0) > 70.0:
            flush(i)
            run_start = i
            run_midis, run_voiced_flags = [], []
        run_midis.append(float(m))
        run_voiced_flags.append(True)
        prev_midi = m
    flush(len(t_thin))

    key = krumhansl_key(midi, voiced)

    emit({
        "event": "done",
        "sampleRate": fs,
        "hopSec": round(hop_sec, 5),
        "f0": f0_list,
        "notes": notes,
        "key": key,
    })
    return 0


def moving_average(x: np.ndarray, window: int) -> np.ndarray:
    if window <= 1:
        return x
    kernel = np.ones(window) / window
    pad = window // 2
    xp = np.pad(x, (pad, pad), mode="edge")
    return np.convolve(xp, kernel, mode="valid")[: len(x)]


def nearest_scale_midi(midi: float, scale: list[int] | None) -> float:
    if not scale:
        return round(midi)
    base = int(np.floor(midi))
    candidates = []
    for octave_shift in (-1, 0, 1):
        for pc in scale:
            candidates.append(base - (base % 12) + pc + 12 * octave_shift)
    best = min(candidates, key=lambda c: abs(c - midi))
    return float(best)


def apply_edits(inp: Path, edits_path: Path, out_path: Path | None) -> int:
    edits = json.loads(Path(edits_path).read_text(encoding="utf-8"))
    snap_strength = float(edits.get("snapStrength", 1.0))
    scale = edits.get("scale")
    transition_ms = float(edits.get("transitionMs", 40.0))
    note_edits = edits.get("notes", [])

    y, fs = load_mono(str(inp))
    f0, t, sp, ap = compute_world(y, fs)

    orig_midi = hz_to_midi(f0)
    voiced = f0 > 0

    target_midi = orig_midi.copy()
    for i in range(len(t)):
        if not voiced[i]:
            continue
        tt = float(t[i])
        override = None
        for ne in note_edits:
            if ne["startSec"] <= tt < ne["endSec"]:
                override = float(ne["targetMidi"])
                break
        if override is not None:
            target_midi[i] = override
        else:
            target_midi[i] = nearest_scale_midi(float(orig_midi[i]), scale)

    hop_sec = float(t[1] - t[0]) if len(t) > 1 else 0.005
    window = max(1, int(round((transition_ms / 1000.0) / hop_sec)))
    smoothed_target = moving_average(target_midi, window)

    blended_midi = orig_midi + (smoothed_target - orig_midi) * snap_strength
    new_f0 = np.zeros_like(f0)
    for i in range(len(f0)):
        if voiced[i]:
            new_f0[i] = float(f0[i]) * (2.0 ** ((blended_midi[i] - orig_midi[i]) / 12.0))

    import pyworld as pw

    y_out = pw.synthesize(new_f0, sp, ap, fs)

    if out_path is None:
        out_path = inp.parent / f"{inp.stem}_tuned.wav"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), np.clip(y_out, -1.0, 1.0), fs, subtype="PCM_24")

    emit({"event": "done", "path": str(out_path)})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["analyze", "apply"])
    ap.add_argument("--input", required=True)
    ap.add_argument("--edits", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    inp = Path(args.input).resolve()

    if args.mode == "analyze":
        return analyze(inp)

    if not args.edits:
        raise SystemExit("--edits is required for --mode apply")
    out_path = Path(args.out).resolve() if args.out else None
    return apply_edits(inp, Path(args.edits).resolve(), out_path)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit({"event": "fatal", "error": str(e)[:600]})
        sys.exit(1)
