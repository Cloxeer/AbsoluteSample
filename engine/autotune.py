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
    f0 = clean_voicing(f0.astype(np.float64), frame_db(audio, len(f0)))
    times = np.arange(len(f0)) * (CREPE_HOP / CREPE_SR)
    return times.astype(np.float64), f0, conf.astype(np.float64)


# Loudness gating. CREPE happily tracks a reverb/echo tail (it is periodic), so a
# note would keep going after the singer stopped. These thresholds remove that.
GATE_FLOOR_DB = -55.0      # absolute silence floor (dBFS)
GATE_BELOW_PEAK_DB = 38.0  # frames this far under the loud part of the file are silence
TAIL_DB = 15.0             # trailing frames this far under their phrase's peak are reverb
EDGE_OUTLIER_CENTS = 150.0 # onset/offset frames this far off the phrase are glitches
EDGE_MAX_FRAMES = 6        # at most 60 ms trimmed at each edge


def frame_db(audio: np.ndarray, n_frames: int, win: int = 400) -> np.ndarray:
    """RMS level in dBFS per CREPE frame (centered 25 ms window)."""
    pad = np.pad(audio.astype(np.float64), (win // 2, win // 2))
    out = np.full(n_frames, -120.0)
    for i in range(n_frames):
        seg = pad[i * CREPE_HOP: i * CREPE_HOP + win]
        if seg.size:
            rms = float(np.sqrt(np.mean(seg * seg)))
            out[i] = 20.0 * np.log10(rms) if rms > 1e-9 else -120.0
    return out


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index pairs of consecutive True runs."""
    runs, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


STOP_DROP_DB = 6.0   # level falls at least this much...
STOP_WITHIN = 8      # ...within 80 ms...
STOP_RECOVER_DB = 4.0  # ...and never climbs back within this much of where it was


def _sudden_stop(db: np.ndarray, s: int, e: int) -> int | None:
    """Index where a phrase ends abruptly (dry voice stops, reverb remains)."""
    for i in range(s + 5, e - STOP_WITHIN):
        before = float(np.max(db[max(s, i - 3): i + 1]))
        after = float(db[i + STOP_WITHIN])
        if before - after < STOP_DROP_DB:
            continue
        rest = db[i + STOP_WITHIN: e]
        if float(np.max(rest)) >= before - STOP_RECOVER_DB:
            continue
        # A held soft note stays level; a reverb tail keeps fading (>= 10 dB/s).
        if rest.size >= 3:
            slope = np.polyfit(np.arange(rest.size) * (CREPE_HOP / CREPE_SR), rest, 1)[0]
            if slope > -10.0:
                continue
        # End the note where the level has actually fallen, not where the fall began.
        j = i + 1
        while j < i + STOP_WITHIN and db[j] >= before - 3.0:
            j += 1
        return j
    return None


def clean_voicing(f0: np.ndarray, db: np.ndarray) -> np.ndarray:
    """Unvoice silence, reverb tails and onset/offset pitch glitches."""
    f0 = f0.copy()
    voiced = f0 > 0
    if not np.any(voiced):
        return f0
    loud = np.percentile(db[voiced], 95)
    gate = max(GATE_FLOOR_DB, loud - GATE_BELOW_PEAK_DB)
    f0[db < gate] = 0.0

    midi = hz_to_midi(f0)
    for s, e in _runs(f0 > 0):
        # Reverb tail: drop trailing frames far below this phrase's peak level.
        peak = float(np.max(db[s:e]))
        while e - s > 1 and db[e - 1] < peak - TAIL_DB:
            e -= 1
            f0[e] = 0.0
        # The singer stopping shows up as a sudden level drop that never recovers;
        # everything after it is room sound, even if it still has a pitch.
        cut = _sudden_stop(db, s, e)
        if cut is not None:
            f0[cut:e] = 0.0
            e = cut
        # Onset/offset glitches: edge frames far from the nearby stable pitch.
        n = e - s
        if n < 4:
            continue
        head_ref = float(np.median(midi[s + min(n - 1, EDGE_MAX_FRAMES): s + min(n, EDGE_MAX_FRAMES + 8)]))
        for i in range(s, min(e, s + EDGE_MAX_FRAMES)):
            if abs(midi[i] - head_ref) * 100.0 > EDGE_OUTLIER_CENTS:
                f0[i] = 0.0
            else:
                break
        tail_ref = float(np.median(midi[max(s, e - EDGE_MAX_FRAMES - 8): max(s + 1, e - EDGE_MAX_FRAMES)]))
        for i in range(e - 1, max(s, e - EDGE_MAX_FRAMES) - 1, -1):
            if abs(midi[i] - tail_ref) * 100.0 > EDGE_OUTLIER_CENTS:
                f0[i] = 0.0
            else:
                break

    # Leftover reverb fragments: a piece that starts shortly after a louder
    # phrase, much quieter, with no attack of its own, and only fades.
    hop_sec = CREPE_HOP / CREPE_SR
    prev_peak, prev_end = None, -1
    for s, e in _runs(f0 > 0):
        seg = db[s:e]
        peak = float(np.max(seg))
        if e - s < 5:  # isolated blip under 50 ms: noise, not a sung note
            f0[s:e] = 0.0
            continue
        is_tail = False
        if prev_peak is not None and (s - prev_end) * hop_sec < 0.5 and peak < prev_peak - 8.0:
            no_attack = int(np.argmax(seg)) <= 2
            fading = seg.size < 3 or np.polyfit(np.arange(seg.size) * hop_sec, seg, 1)[0] < -10.0
            is_tail = no_attack and fading
        if is_tail:
            f0[s:e] = 0.0
            prev_end = e  # a tail can be split in several fragments; keep chaining
        else:
            prev_peak, prev_end = peak, e
    return f0


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

    # A note ends when the pitch leaves the note's own center by more than
    # SPLIT_CENTS for SPLIT_FRAMES in a row (so a scoop or a step up/down becomes a
    # new note, while vibrato inside a note does not).
    SPLIT_CENTS = 60.0
    SPLIT_FRAMES = 4
    away: list[int] = []
    for i in range(len(f0)):
        if not voiced[i]:
            run.extend(away)
            away.clear()
            flush()
            continue
        if len(run) >= 3:
            center = float(np.median(midi[run[-25:]]))
            if abs(midi[i] - center) * 100.0 > SPLIT_CENTS:
                away.append(i)
                if len(away) >= SPLIT_FRAMES:
                    flush()
                    run.extend(away)
                    away.clear()
                continue
        run.extend(away)
        away.clear()
        run.append(i)
    run.extend(away)
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

    shift_semi = compute_shift(t, orig_midi, voiced, note_edits, snap_strength, transition_ms, scale,
                               bool(edits.get("correctAll", False)))

    # WORLD's own f0 (the one the envelope was estimated with) is scaled, which
    # keeps the vocoder coherent; frames WORLD thinks are unvoiced stay unvoiced.
    new_f0 = w_f0 * (2.0 ** (shift_semi / 12.0))
    y_world = pw.synthesize(new_f0, sp, ap, fs)
    y_out = blend_original(y, y_world, t, shift_semi, fs)
    if out_path is None:
        out_path = inp.parent / f"{inp.stem}_tuned.wav"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), np.clip(y_out, -1.0, 1.0), fs, subtype="PCM_24")
    del sp, ap, w_f0, new_f0, shift_semi, orig_midi, y_out, y_world, y
    cleanup_torch()
    emit({"event": "done", "path": str(out_path)})
    return 0


def compute_shift(
    t: np.ndarray,
    orig_midi: np.ndarray,
    voiced: np.ndarray,
    note_edits: list[dict],
    snap_strength: float,
    transition_ms: float,
    scale: list[int] | None,
    correct_all: bool = False,
) -> np.ndarray:
    """Per-frame pitch shift in semitones.

    An edited note is moved as a whole by (targetMidi - sourceMidi), so its
    center lands exactly on the target (0 cents) no matter the Retune Speed.
    Retune Speed (snap_strength) then only decides how much of the note's own
    wobble around that center is flattened. Untouched notes get no shift.
    """
    n = len(t)
    step = np.zeros(n)
    corr_target = np.full(n, np.nan)
    edited = np.zeros(n, dtype=bool)
    for ne in note_edits:
        idx = np.where((t >= float(ne["startSec"])) & (t < float(ne["endSec"])) & voiced)[0]
        if idx.size == 0:
            continue
        src = ne.get("sourceMidi")
        src = float(src) if src is not None else float(np.median(orig_midi[idx]))
        tgt = float(ne["targetMidi"])
        step[idx] = tgt - src
        corr_target[idx] = tgt
        edited[idx] = True
    if correct_all:
        for i in np.where(voiced & ~edited)[0]:
            corr_target[i] = nearest_scale_midi(float(orig_midi[i]), scale)

    # Unvoiced frames borrow the next voiced frame's step, so smoothing ramps
    # happen in the gaps instead of at the start of a note.
    nxt = 0.0
    for i in range(n - 1, -1, -1):
        if voiced[i]:
            nxt = step[i]
        else:
            step[i] = nxt

    hop_sec = float(t[1] - t[0]) if n > 1 else 0.005
    window = max(1, int(round((transition_ms / 1000.0) / hop_sec)))
    step_s = moving_average(step, window)
    pitched = orig_midi + step_s
    corr = np.where(np.isnan(corr_target), 0.0, (np.nan_to_num(corr_target) - pitched) * snap_strength)
    corr[~voiced] = 0.0
    shift = step_s + moving_average(corr, window)
    shift[~voiced] = 0.0
    return shift


def blend_original(y: np.ndarray, y_world: np.ndarray, t: np.ndarray, shift: np.ndarray, fs: int) -> np.ndarray:
    """Use the untouched original audio wherever no correction happens.

    The vocoder only replaces the frames that are actually retuned, with 20 ms
    crossfades, so untouched parts keep 100% of the original quality.
    """
    m = min(len(y), len(y_world))
    y_world = y_world[:m]
    y = y[:m]
    g = np.clip(np.abs(shift) / 0.02, 0.0, 1.0)
    hop_sec = float(t[1] - t[0]) if len(t) > 1 else 0.005
    g = moving_average(g, max(1, int(round(0.02 / hop_sec))))
    g_s = np.interp(np.arange(m) / fs, t, g)
    return y * (1.0 - g_s) + y_world * g_s


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
