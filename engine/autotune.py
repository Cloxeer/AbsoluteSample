#!/usr/bin/env python
"""AbsoluteSample autotune engine.

Pitch detection uses CREPE (a neural monophonic pitch tracker) with a
periodicity/confidence gate and median smoothing, so the reported notes are
accurate and unvoiced frames are left empty instead of guessed. Resynthesis
uses the WORLD vocoder driven by the CREPE pitch track, which preserves the
original timbre (non-robotic) while retuning.

Invoked by the Rust backend (and the CLI); never imported by the frontend.

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
import os
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

CREPE_SR = 16000
CREPE_HOP = 160          # 10 ms frames
CREPE_FMIN = 50.0
CREPE_FMAX = 1100.0
CONF_THRESHOLD = 0.5
_DEVICE = "cpu"  # set to the real device when CREPE (torch) actually runs     # periodicity below this is treated as unvoiced


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _peak_rss_mb() -> float | None:
    try:
        import psutil

        proc = psutil.Process()
        info = proc.memory_info()
        peak = getattr(info, "peak_wset", None) or info.rss
        return round(peak / (1024 * 1024), 1)
    except Exception:  # noqa: BLE001
        return None


def emit_metrics(start_time: float) -> None:
    # Do NOT import torch here: the light apply paths (region + pitch cache) use
    # only pyworld, and importing torch would build a ~1GB CUDA context for nothing.
    tmod = sys.modules.get("torch")
    if tmod is not None:
        try:
            device = "cuda" if tmod.cuda.is_available() else "cpu"
        except Exception:  # noqa: BLE001
            device = _DEVICE
    else:
        device = _DEVICE
    try:
        emit({
            "event": "metrics",
            "seconds": round(time.time() - start_time, 3),
            "peakRssMb": _peak_rss_mb(),
            "device": device,
        })
    except Exception:  # noqa: BLE001
        pass


def cleanup_torch() -> None:
    tmod = sys.modules.get("torch")
    if tmod is None:
        return
    try:
        if tmod.cuda.is_available():
            tmod.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def load_mono(path: str, sr_target: int) -> np.ndarray:
    import librosa

    y, _ = librosa.load(path, sr=sr_target, mono=True)
    return y.astype(np.float32)


def hz_to_midi(hz: np.ndarray) -> np.ndarray:
    out = np.zeros_like(hz, dtype=np.float64)
    voiced = hz > 0
    out[voiced] = 69.0 + 12.0 * np.log2(hz[voiced] / 440.0)
    return out


def crepe_f0(path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (times_sec, f0_hz, confidence) at 10 ms hop.

    Unvoiced / low-confidence frames have f0_hz == 0. Uses CREPE 'full' on GPU
    when available, with median filtering of both periodicity and pitch.
    """
    import torch
    import torchcrepe

    audio = load_mono(path, CREPE_SR)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tensor = torch.tensor(audio)[None]
    pitch, periodicity = torchcrepe.predict(
        tensor,
        CREPE_SR,
        CREPE_HOP,
        fmin=CREPE_FMIN,
        fmax=CREPE_FMAX,
        model="full",
        return_periodicity=True,
        batch_size=1024,
        device=device,
    )
    # Smooth periodicity, gate pitch on it, then smooth pitch. These are the
    # torchcrepe-recommended cleanup steps that remove octave spikes.
    periodicity = torchcrepe.filter.median(periodicity, 3)
    pitch = torchcrepe.threshold.At(CONF_THRESHOLD)(pitch, periodicity)
    pitch = torchcrepe.filter.median(pitch, 3)

    f0 = pitch[0].cpu().numpy()
    conf = periodicity[0].cpu().numpy()
    f0 = np.nan_to_num(f0, nan=0.0)
    f0[conf < CONF_THRESHOLD] = 0.0
    times = np.arange(len(f0)) * (CREPE_HOP / CREPE_SR)
    return times.astype(np.float64), f0.astype(np.float64), conf.astype(np.float64)


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
        prof = np.array(profile) / np.sum(profile)
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


def segment_notes(times: np.ndarray, f0: np.ndarray, conf: np.ndarray) -> list[dict]:
    """Group confident voiced frames into notes; split on gaps or >70 cent jumps."""
    midi = hz_to_midi(f0)
    voiced = f0 > 0
    hop = float(times[1] - times[0]) if len(times) > 1 else 0.01
    notes: list[dict] = []
    run: list[int] = []

    def flush() -> None:
        if len(run) < 2:
            run.clear()
            return
        seg_midi = midi[run]
        start = float(times[run[0]])
        end = float(times[run[-1]]) + hop
        if end - start < 0.08:
            run.clear()
            return
        med = float(np.median(seg_midi))
        notes.append({
            "startSec": round(start, 4),
            "endSec": round(end, 4),
            "midi": int(round(med)),
            "cents": round((med - round(med)) * 100.0, 1),
            "confidence": round(float(np.mean(conf[run])), 3),
        })
        run.clear()

    prev = None
    for i in range(len(f0)):
        if not voiced[i]:
            flush()
            prev = None
            continue
        if prev is not None and abs((midi[i] - prev) * 100.0) > 70.0:
            flush()
        run.append(i)
        prev = midi[i]
    flush()
    return notes


def analyze(inp: Path, start_time: float) -> int:
    times, f0, conf = crepe_f0(str(inp))
    midi = hz_to_midi(f0)
    voiced = f0 > 0
    hop_sec = float(times[1] - times[0]) if len(times) > 1 else 0.01

    f0_list = []
    for tt, hz, m, c, v in zip(times, f0, midi, conf, voiced):
        f0_list.append({
            "t": round(float(tt), 4),
            "hz": round(float(hz), 3) if v else 0.0,
            "midi": round(float(m), 3) if v else None,
            "cents": round(float((m - round(m)) * 100.0), 1) if v else None,
            "conf": round(float(c), 3),
            "voiced": bool(v),
        })

    notes = segment_notes(times, f0, conf)
    key = krumhansl_key(midi, voiced)

    del times, f0, conf, midi, voiced
    cleanup_torch()

    emit({
        "event": "done",
        "sampleRate": CREPE_SR,
        "hopSec": round(hop_sec, 5),
        "f0": f0_list,
        "notes": notes,
        "key": key,
    })
    emit_metrics(start_time)
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
    return float(min(candidates, key=lambda c: abs(c - midi)))


def _load_region(inp: Path, fs: int, region_start: float | None, region_end: float | None) -> np.ndarray:
    """Load only [region_start, region_end) seconds (or the whole file) as float64 mono at fs."""
    if region_start is None and region_end is None:
        return load_mono(str(inp), fs).astype(np.float64)
    info = sf.info(str(inp))
    src_sr = info.samplerate
    start_frame = int(round((region_start or 0.0) * src_sr))
    stop_frame = int(round(region_end * src_sr)) if region_end is not None else None
    data, read_sr = sf.read(str(inp), start=max(0, start_frame), stop=stop_frame, dtype="float32", always_2d=True)
    y = data.mean(axis=1)
    if read_sr != fs:
        import librosa

        y = librosa.resample(y, orig_sr=read_sr, target_sr=fs)
    return y.astype(np.float64)


def _cached_pitch(pitch_cache_path: Path, region_start: float | None, region_end: float | None) -> tuple[np.ndarray, np.ndarray] | None:
    """Load {times, midi, voiced} arrays from an analyze-shaped pitch cache JSON, sliced to the region."""
    try:
        data = json.loads(Path(pitch_cache_path).read_text(encoding="utf-8"))
        f0_list = data["f0"]
    except Exception:  # noqa: BLE001
        return None
    times = np.array([f["t"] for f in f0_list], dtype=np.float64)
    midi = np.array([f["midi"] if f["midi"] is not None else 0.0 for f in f0_list], dtype=np.float64)
    voiced = np.array([bool(f["voiced"]) for f in f0_list], dtype=bool)
    if region_start is not None or region_end is not None:
        lo = region_start if region_start is not None else times[0]
        hi = region_end if region_end is not None else times[-1] + 1.0
        mask = (times >= lo) & (times < hi)
        times = times[mask] - lo
        midi = midi[mask]
        voiced = voiced[mask]
    return times, midi, voiced


def apply_edits(
    inp: Path,
    edits_path: Path,
    out_path: Path | None,
    region_start: float | None = None,
    region_end: float | None = None,
    pitch_cache: Path | None = None,
) -> int:
    import pyworld as pw

    edits = json.loads(Path(edits_path).read_text(encoding="utf-8"))
    snap_strength = float(edits.get("snapStrength", 1.0))
    scale = edits.get("scale")
    transition_ms = float(edits.get("transitionMs", 40.0))
    note_edits = edits.get("notes", [])

    fs = 44100
    # WORLD provides the spectral envelope + aperiodicity for natural resynthesis.
    y = _load_region(inp, fs, region_start, region_end)
    w_f0, t, sp, ap = _world(y, fs)
    del y

    # CREPE provides the accurate pitch track; reuse a cached one when given, else recompute.
    cached = _cached_pitch(pitch_cache, region_start, region_end) if pitch_cache else None
    if cached is not None:
        c_times, c_midi, c_voiced = cached
    else:
        c_times, c_f0, _conf = crepe_f0(str(inp))
        c_midi = hz_to_midi(c_f0)
        c_voiced = c_f0 > 0
        if region_start is not None or region_end is not None:
            lo = region_start if region_start is not None else c_times[0]
            hi = region_end if region_end is not None else c_times[-1] + 1.0
            mask = (c_times >= lo) & (c_times < hi)
            c_times = c_times[mask] - lo
            c_midi = c_midi[mask]
            c_voiced = c_voiced[mask]
        del _conf
    orig_midi = _interp_midi(t, c_times, c_midi, c_voiced)
    voiced = orig_midi > 0

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
        target_midi[i] = override if override is not None else nearest_scale_midi(float(orig_midi[i]), scale)

    hop_sec = float(t[1] - t[0]) if len(t) > 1 else 0.005
    window = max(1, int(round((transition_ms / 1000.0) / hop_sec)))
    smoothed = moving_average(target_midi, window)
    blended = orig_midi + (smoothed - orig_midi) * snap_strength

    new_f0 = np.zeros_like(w_f0)
    for i in range(len(new_f0)):
        if voiced[i]:
            base = 440.0 * 2.0 ** ((orig_midi[i] - 69.0) / 12.0)
            new_f0[i] = base * (2.0 ** ((blended[i] - orig_midi[i]) / 12.0))

    y_out = pw.synthesize(new_f0, sp, ap, fs)
    if out_path is None:
        out_path = inp.parent / f"{inp.stem}_tuned.wav"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), np.clip(y_out, -1.0, 1.0), fs, subtype="PCM_24")
    del sp, ap, w_f0, new_f0, target_midi, smoothed, blended, orig_midi, y_out
    cleanup_torch()
    emit({"event": "done", "path": str(out_path)})
    return 0


def _world(y: np.ndarray, fs: int):
    import pyworld as pw

    f0, t = pw.harvest(y, fs)
    sp = pw.cheaptrick(y, f0, t, fs)
    ap = pw.d4c(y, f0, t, fs)
    return f0, t, sp, ap


def _interp_midi(t_target: np.ndarray, t_src: np.ndarray, midi_src: np.ndarray, voiced_src: np.ndarray) -> np.ndarray:
    """Interpolate the (voiced-only) CREPE midi track onto WORLD's frame times.

    Frames whose nearest CREPE frame is unvoiced stay 0 (unvoiced)."""
    out = np.zeros_like(t_target)
    if not np.any(voiced_src):
        return out
    vt = t_src[voiced_src]
    vm = midi_src[voiced_src]
    interp = np.interp(t_target, vt, vm, left=vm[0], right=vm[-1])
    # Mark a target frame unvoiced if the nearest source frame is unvoiced.
    nearest = np.clip(np.searchsorted(t_src, t_target), 0, len(t_src) - 1)
    for i, ni in enumerate(nearest):
        lo = max(0, ni - 1)
        hi = min(len(t_src) - 1, ni + 1)
        out[i] = interp[i] if (voiced_src[lo] or voiced_src[ni] or voiced_src[hi]) else 0.0
    return out


def main() -> int:
    start_time = time.time()

    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["analyze", "apply"])
    ap.add_argument("--input", required=True)
    ap.add_argument("--edits", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--region-start", type=float, default=None)
    ap.add_argument("--region-end", type=float, default=None)
    ap.add_argument("--pitch-cache", default=None)
    args = ap.parse_args()

    inp = Path(args.input).resolve()
    if args.mode == "analyze":
        return analyze(inp, start_time)
    if not args.edits:
        raise SystemExit("--edits is required for --mode apply")
    out_path = Path(args.out).resolve() if args.out else None
    pitch_cache = Path(args.pitch_cache).resolve() if args.pitch_cache else None
    rc = apply_edits(inp, Path(args.edits).resolve(), out_path, args.region_start, args.region_end, pitch_cache)
    emit_metrics(start_time)
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit({"event": "fatal", "error": str(e)[:600]})
        sys.exit(1)
