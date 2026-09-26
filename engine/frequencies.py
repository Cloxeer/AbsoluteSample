#!/usr/bin/env python
"""AbsoluteSample frequencies engine.

Computes an averaged spectrum, band energies, and tuning analysis for a wav.
Invoked by the Rust backend (and the CLI); never imported by the frontend.

Usage:
  frequencies.py --input <wav> [--bpm <float>]

Protocol (stdout, one JSON line):
  {"event":"done","spectrum":[...],"bands":[...],"tuning":{...},"key":{...},"durationSec":...}
  {"event":"fatal","error":"..."}   (exit code 1)
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]

BANDS = [
    ("sub", "Sub", 20.0, 60.0),
    ("bass", "Bass", 60.0, 250.0),
    ("lowMid", "Low mid", 250.0, 500.0),
    ("mid", "Mid", 500.0, 2000.0),
    ("highMid", "High mid", 2000.0, 4000.0),
    ("presence", "Presence", 4000.0, 6000.0),
    ("air", "Air", 6000.0, 20000.0),
]


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def emit_metrics(start_time: float) -> None:
    try:
        peak_mb = None
        try:
            import psutil

            info = psutil.Process().memory_info()
            peak = getattr(info, "peak_wset", None) or info.rss
            peak_mb = round(peak / (1024 * 1024), 1)
        except Exception:  # noqa: BLE001
            peak_mb = None
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"
        emit({"event": "metrics", "seconds": round(time.time() - start_time, 3), "peakRssMb": peak_mb, "device": device})
    except Exception:  # noqa: BLE001
        pass


def midi_to_name(m: int) -> str:
    name = NOTE_NAMES[m % 12]
    octave = m // 12 - 1
    return f"{name}{octave}"


def detect_key(y: np.ndarray, sr: int) -> dict:
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    hist = chroma.mean(axis=1)
    if hist.sum() <= 0:
        return {"tonic": "C", "mode": "major", "confidence": 0.0, "camelot": "8B"}
    hist = hist / hist.sum()
    best = None
    for mode, profile, camelot in (("major", KS_MAJOR, CAMELOT_MAJOR), ("minor", KS_MINOR, CAMELOT_MINOR)):
        prof = np.array(profile)
        prof = prof / prof.sum()
        for tonic in range(12):
            rotated = np.roll(prof, tonic)
            corr = float(np.corrcoef(hist, rotated)[0, 1])
            if np.isnan(corr):
                corr = 0.0
            if best is None or corr > best[0]:
                best = (corr, tonic, mode, camelot[tonic])
    corr, tonic, mode, camelot_code = best
    confidence = max(0.0, min(1.0, (corr + 1.0) / 2.0))
    return {"tonic": NOTE_NAMES[tonic], "mode": mode, "confidence": round(confidence, 3), "camelot": camelot_code}


def main() -> int:
    start_time = time.time()
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--bpm", type=float, default=None)
    args = ap.parse_args()

    import librosa

    y, sr = librosa.load(args.input, sr=44100, mono=True)
    duration_sec = float(len(y) / sr) if sr else 0.0

    # --- averaged magnitude spectrum, resampled to ~120 log-spaced bins ---
    n_fft, hop = 4096, 1024
    stft = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    mag = stft.mean(axis=1)
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)

    n_bins = 120
    log_freqs = np.geomspace(20.0, min(20000.0, sr / 2.0), n_bins)
    mag_interp = np.interp(log_freqs, freqs, mag)
    db = 20.0 * np.log10(np.maximum(mag_interp, 1e-12))
    db = db - db.max()
    db = np.maximum(db, -120.0)
    spectrum = [{"hz": round(float(f), 2), "db": round(float(d), 2)} for f, d in zip(log_freqs, db)]

    # --- band energies from the full-resolution spectrum (not the resampled one) ---
    lin_db = 20.0 * np.log10(np.maximum(mag, 1e-12))
    lin_db = lin_db - lin_db.max()
    energy = mag ** 2
    total_energy = float(energy.sum()) or 1.0
    bands = []
    for key, name, lo, hi in BANDS:
        mask = (freqs >= lo) & (freqs < hi)
        if mask.any():
            band_db = float(np.maximum(lin_db[mask], -120.0).mean())
            share_pct = float(energy[mask].sum() / total_energy * 100.0)
        else:
            band_db = -120.0
            share_pct = 0.0
        bands.append({
            "key": key, "name": name, "lowHz": lo, "highHz": hi,
            "db": round(band_db, 2), "sharePct": round(share_pct, 2),
        })

    # --- tuning ---
    f0, voiced_flag, _voiced_prob = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7"), sr=sr,
    )
    voiced_f0 = f0[np.isfinite(f0) & (voiced_flag if voiced_flag is not None else np.isfinite(f0))]

    def cents_off(hz: np.ndarray, ref_a4: float) -> np.ndarray:
        midi = 69.0 + 12.0 * np.log2(hz / ref_a4)
        nearest = np.round(midi)
        return (midi - nearest) * 100.0

    tuning: dict = {
        "referenceHz": 440.0, "avgCentsOff": 0.0, "inTunePct": 0.0,
        "estimatedRefHz": 440.0, "perNote": [],
    }
    if voiced_f0.size > 0:
        cents = cents_off(voiced_f0, 440.0)
        avg_cents_off = float(np.mean(cents))
        in_tune_pct = float(np.mean(np.abs(cents) <= 15.0) * 100.0)

        best_ref, best_err = 440.0, None
        ref_candidates = np.arange(430.0, 450.01, 0.5)
        for ref in ref_candidates:
            c = cents_off(voiced_f0, float(ref))
            err = float(np.mean(np.abs(c)))
            if best_err is None or err < best_err:
                best_err, best_ref = err, float(ref)

        midi_round = np.round(69.0 + 12.0 * np.log2(voiced_f0 / 440.0)).astype(int)
        per_note: dict[int, list[float]] = {}
        for m, c in zip(midi_round, cents):
            per_note.setdefault(int(m), []).append(float(c))
        per_note_list = [
            {"name": midi_to_name(m), "cents": round(float(np.mean(v)), 1), "count": len(v)}
            for m, v in per_note.items()
        ]
        per_note_list.sort(key=lambda n: -n["count"])

        tuning = {
            "referenceHz": 440.0,
            "avgCentsOff": round(avg_cents_off, 1),
            "inTunePct": round(in_tune_pct, 1),
            "estimatedRefHz": round(best_ref, 1),
            "perNote": per_note_list[:12],
        }

    key = detect_key(y, sr)

    emit({
        "event": "done",
        "spectrum": spectrum,
        "bands": bands,
        "tuning": tuning,
        "key": key,
        "durationSec": round(duration_sec, 3),
    })
    emit_metrics(start_time)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit({"event": "fatal", "error": str(e)[:600]})
        sys.exit(1)
