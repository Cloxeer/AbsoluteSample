#!/usr/bin/env python
"""AbsoluteSample notes engine.

Runs Basic Pitch (free, local, ONNX backend) on a wav and writes note/MIDI
data plus a key and chord analysis. Invoked by the Rust backend; never
imported by the frontend.

Usage:
  notes.py --input <wav> --out <dir> [--bpm <float>]

Output files (in <dir>, named after the input stem):
  <stem>.notes.json  {notes, key, chords, scale, bpm?}
  <stem>.mid

Protocol (stdout, one JSON line):
  {"event":"done","json":"<path>","mid":"<path>"}
  {"event":"fatal","error":"..."}   (exit code 1)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
logging.getLogger("tensorflow").setLevel(logging.ERROR)

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles.
KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# Chord templates as pitch-class sets (root-relative semitone offsets).
CHORD_TEMPLATES = {
    "maj": [0, 4, 7],
    "min": [0, 3, 7],
    "dim": [0, 3, 6],
    "maj7": [0, 4, 7, 11],
    "min7": [0, 3, 7, 10],
    "dom7": [0, 4, 7, 10],
}
CHORD_SUFFIX = {"maj": "", "min": "m", "dim": "dim", "maj7": "maj7", "min7": "m7", "dom7": "7"}
# Preference order when scores tie (richer/more specific chords first is not desired;
# simple triads should win on ties over their extended supersets).
CHORD_ORDER = ["maj", "min", "dom7", "maj7", "min7", "dim"]

MAJOR_SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE_STEPS = [0, 2, 3, 5, 7, 8, 10]


def midi_to_name(m: int) -> str:
    name = NOTE_NAMES[m % 12]
    octave = m // 12 - 1
    return f"{name}{octave}"


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def detect_key(notes: list[dict]) -> dict:
    hist = np.zeros(12)
    for n in notes:
        dur = max(0.0, n["endSec"] - n["startSec"])
        hist[n["midi"] % 12] += dur
    if hist.sum() <= 0:
        return {"tonic": "C", "mode": "major", "confidence": 0.0}
    hist = hist / hist.sum()
    best = None
    for mode, profile in (("major", KS_MAJOR), (("minor"), KS_MINOR)):
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


def scale_for_key(key: dict) -> list[str]:
    tonic = NOTE_NAMES.index(key["tonic"])
    steps = MAJOR_SCALE_STEPS if key["mode"] == "major" else MINOR_SCALE_STEPS
    return [NOTE_NAMES[(tonic + s) % 12] for s in steps]


def detect_chords(notes: list[dict], bpm: float | None, total_dur: float) -> list[dict]:
    beat_len = 60.0 / bpm if bpm else 0.5
    if total_dur <= 0 or beat_len <= 0:
        return []
    n_beats = int(np.ceil(total_dur / beat_len))
    raw: list[dict] = []
    for i in range(n_beats):
        b0, b1 = i * beat_len, (i + 1) * beat_len
        weights = np.zeros(12)
        for n in notes:
            overlap = min(n["endSec"], b1) - max(n["startSec"], b0)
            if overlap > 0:
                weights[n["midi"] % 12] += overlap
        if weights.sum() <= 0:
            raw.append({"startSec": b0, "endSec": b1, "name": None, "notes": []})
            continue
        pcs = weights / weights.sum()
        best = None
        for root in range(12):
            for tname in CHORD_ORDER:
                offsets = CHORD_TEMPLATES[tname]
                template = np.zeros(12)
                for o in offsets:
                    template[(root + o) % 12] = 1.0
                template = template / template.sum()
                sim = float(1.0 - np.linalg.norm(pcs - template) / np.sqrt(2.0))
                if best is None or sim > best[0]:
                    best = (sim, root, tname)
        sim, root, tname = best
        if sim < 0.6:
            raw.append({"startSec": b0, "endSec": b1, "name": None, "notes": []})
            continue
        root_name = NOTE_NAMES[root]
        chord_name = f"{root_name}{CHORD_SUFFIX[tname]}"
        chord_notes = [NOTE_NAMES[(root + o) % 12] for o in CHORD_TEMPLATES[tname]]
        raw.append({"startSec": b0, "endSec": b1, "name": chord_name, "notes": chord_notes})

    merged: list[dict] = []
    for c in raw:
        if c["name"] is None:
            continue
        if merged and merged[-1]["name"] == c["name"] and abs(merged[-1]["endSec"] - c["startSec"]) < 1e-6:
            merged[-1]["endSec"] = c["endSec"]
        else:
            merged.append(dict(c))
    return merged


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bpm", type=float, default=None)
    args = ap.parse_args()

    inp = Path(args.input).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    stem = inp.stem

    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    model_output, midi_data, note_events = predict(str(inp), ICASSP_2022_MODEL_PATH)

    notes = []
    for start_sec, end_sec, midi_pitch, velocity, _pitch_bend in note_events:
        midi_pitch = int(midi_pitch)
        notes.append({
            "startSec": round(float(start_sec), 4),
            "endSec": round(float(end_sec), 4),
            "midi": midi_pitch,
            "name": midi_to_name(midi_pitch),
            "velocity": round(max(0.0, min(1.0, float(velocity) / 127.0)), 3),
        })
    notes.sort(key=lambda n: n["startSec"])

    total_dur = max((n["endSec"] for n in notes), default=0.0)
    key = detect_key(notes)
    scale = scale_for_key(key)
    chords = detect_chords(notes, args.bpm, total_dur)

    result = {
        "notes": notes,
        "key": key,
        "chords": chords,
        "scale": scale,
    }
    if args.bpm is not None:
        result["bpm"] = args.bpm

    json_path = out / f"{stem}.notes.json"
    mid_path = out / f"{stem}.mid"
    json_path.write_text(json.dumps(result), encoding="utf-8")
    midi_data.write(str(mid_path))

    emit({"event": "done", "json": str(json_path), "mid": str(mid_path)})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit({"event": "fatal", "error": str(e)[:600]})
        sys.exit(1)
