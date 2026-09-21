#!/usr/bin/env python
"""AbsoluteSample AI separation engine.

Runs a multi-pass, fully local, fully free instrument separation chain and
reports progress as JSON lines on stdout. Invoked by the Rust backend (and the
CLI); never imported by the frontend.

Passes (run in this order when requested; "instruments" is always run first):
  instruments  Demucs v4 htdemucs_6s      -> vocals, drums, bass, guitar, piano, other
  vocals       BS-Roformer (viperx 12.97) -> refined vocals, ensembled with Demucs vocals;
                                             the difference is pushed into "other" so the
                                             stems still sum to the original mix
  lead         Mel-Band Roformer karaoke  -> lead_vocals + backing_vocals from the vocals stem
  drums        MDX23C DrumSep             -> kick, snare, toms, hihat, ride, crash from the drums stem
  tag          AudioSet AST classifier    -> tags + soundsLike for every top-level stem (never fatal)

Protocol (stdout, one JSON object per line):
  {"event":"device","device":"cuda|cpu","gpu":"..."}
  {"event":"progress","pass":"<pass>","percent":<0-100 or -1>,"message":"..."}
  {"event":"pass_done","pass":"<pass>","seconds":<float>}
  {"event":"pass_failed","pass":"<pass>","error":"..."}     (chain continues)
  {"event":"done","stems":[{"key","label","group","parent","path","model","order"}],"device":"cuda|cpu"}
  {"event":"fatal","error":"..."}                            (exit code 1)
"""
from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

MODELS = {
    "instruments": "htdemucs_6s.yaml",
    "vocals": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "lead": "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    "drums": "MDX23C-DrumSep-aufr33-jarredou.ckpt",
}

# key -> (label, group, order)
STEM_META = {
    "vocals": ("Vocals", "vocals", 10),
    "lead_vocals": ("Lead vocals", "vocals", 11),
    "backing_vocals": ("Backing vocals", "vocals", 12),
    "drums": ("Drums", "drums", 20),
    "kick": ("Kick", "drums", 21),
    "snare": ("Snare", "drums", 22),
    "toms": ("Toms", "drums", 23),
    "hihat": ("Hi-hat", "drums", 24),
    "ride": ("Ride", "drums", 25),
    "crash": ("Crash", "drums", 26),
    "bass": ("Bass", "bass", 30),
    "guitar": ("Guitar", "guitar", 40),
    "piano": ("Piano / Keys", "keys", 50),
    "other": ("Other / Synths & FX", "other", 60),
}

PARENT = {
    "lead_vocals": "vocals", "backing_vocals": "vocals",
    "kick": "drums", "snare": "drums", "toms": "drums", "hihat": "drums", "ride": "drums", "crash": "drums",
}

STEM_MODEL = {
    "lead_vocals": MODELS["lead"], "backing_vocals": MODELS["lead"],
    "kick": MODELS["drums"], "snare": MODELS["drums"], "toms": MODELS["drums"],
    "hihat": MODELS["drums"], "ride": MODELS["drums"], "crash": MODELS["drums"],
}


def apply_low_priority() -> None:
    """Best-effort: fewer CPU threads and a below-normal process priority on Windows."""
    import torch

    torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))
    try:
        ctypes.windll.kernel32.SetPriorityClass(-1, 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
    except Exception:
        pass


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def progress(pass_name: str, percent: float, message: str) -> None:
    emit({"event": "progress", "pass": pass_name, "percent": round(float(percent), 1), "message": message})


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data, sr


def write_wav(path: Path, data: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(data, -1.0, 1.0), sr, subtype="PCM_24")


def match_len(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    n = min(len(a), len(b))
    return a[:n], b[:n]


class _ProgressHook(logging.Handler):
    def __init__(self, pass_name: str):
        super().__init__(level=logging.INFO)
        self.pass_name = pass_name

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        msg = record.getMessage()
        low = msg.lower()
        if "download" in low or "chunk" in low or "processing" in low or "%" in msg:
            progress(self.pass_name, -1, msg[:120])


def make_separator(model_dir: Path, out_dir: Path, pass_name: str, device_pref: str):
    from audio_separator.separator import Separator

    sep = Separator(
        log_level=logging.INFO,
        model_file_dir=str(model_dir),
        output_dir=str(out_dir),
        output_format="WAV",
        # Quality first: no input normalization (keeps original levels and headroom),
        # no fp16 autocast (avoids quantization buzz on older GPUs), more Demucs shifts
        # and overlap for cleaner seams. Slower, but audibly cleaner.
        normalization_threshold=1.0,
        amplification_threshold=0.0,
        use_autocast=False,
        demucs_params={"segment_size": "Default", "shifts": 2, "overlap": 0.4, "segments_enabled": True},
        mdxc_params={"segment_size": 256, "override_model_segment_size": False, "batch_size": 1, "overlap": 8, "pitch_shift": 0},
    )
    sep.logger.addHandler(_ProgressHook(pass_name))
    return sep


def run_model(sep, model_file: str, input_path: Path, pass_name: str) -> dict[str, Path]:
    """Run one model on one file; returns {stem_name_lower: path}."""
    progress(pass_name, 5, f"Loading {model_file}")
    sep.load_model(model_filename=model_file)
    progress(pass_name, 20, "Separating")
    outputs = sep.separate(str(input_path))
    result: dict[str, Path] = {}
    for out in outputs:
        p = Path(out)
        if not p.is_absolute():
            p = Path(sep.output_dir) / p
        name = p.stem
        # audio-separator names files "<input>_(Stem)_<model>.wav"
        stem = name.split("_(")[-1].split(")")[0].lower() if "_(" in name else name.lower()
        result[stem] = p
    progress(pass_name, 95, "Writing")
    return result


def pass_instruments(sep_factory, inp: Path, out: Path, sr: int, stems: dict[str, Path]) -> None:
    sep = sep_factory("instruments")
    res = run_model(sep, MODELS["instruments"], inp, "instruments")
    for key in ("vocals", "drums", "bass", "guitar", "piano", "other"):
        if key not in res:
            raise RuntimeError(f"Demucs did not return {key!r} (got {sorted(res)})")
        data, _ = read_wav(res[key])
        write_wav(out / f"{key}.wav", data, sr)
        stems[key] = out / f"{key}.wav"


def pass_vocals(sep_factory, inp: Path, sr: int, stems: dict[str, Path]) -> None:
    sep = sep_factory("vocals")
    res = run_model(sep, MODELS["vocals"], inp, "vocals")
    rof_key = next((k for k in res if "vocal" in k and "instrument" not in k), None)
    if rof_key is None:
        raise RuntimeError(f"Roformer returned {sorted(res)}")
    rof, _ = read_wav(res[rof_key])
    dem, _ = read_wav(stems["vocals"])
    other, _ = read_wav(stems["other"])
    rof, dem = match_len(rof, dem)
    other = other[: len(dem)]
    # Use the Roformer vocals outright: averaging two models that are not sample-aligned
    # phases and smears. Conserve the mix by moving the difference into "other".
    other = other + (dem - rof)
    write_wav(stems["vocals"], rof, sr)
    write_wav(stems["other"], other, sr)


def pass_lead(sep_factory, out: Path, sr: int, stems: dict[str, Path]) -> None:
    sep = sep_factory("lead")
    res = run_model(sep, MODELS["lead"], stems["vocals"], "lead")
    lead_key = next((k for k in res if "vocal" in k), None)
    back_key = next((k for k in res if k != lead_key), None)
    if lead_key is None or back_key is None:
        raise RuntimeError(f"karaoke model returned {sorted(res)}")
    lead, _ = read_wav(res[lead_key])
    back, _ = read_wav(res[back_key])
    write_wav(out / "lead_vocals.wav", lead, sr)
    write_wav(out / "backing_vocals.wav", back, sr)
    stems["lead_vocals"] = out / "lead_vocals.wav"
    stems["backing_vocals"] = out / "backing_vocals.wav"


def pass_drums(sep_factory, out: Path, sr: int, stems: dict[str, Path]) -> None:
    sep = sep_factory("drums")
    res = run_model(sep, MODELS["drums"], stems["drums"], "drums")
    mapping = {"kick": "kick", "snare": "snare", "toms": "toms", "hh": "hihat", "hihat": "hihat", "ride": "ride", "crash": "crash"}
    found = 0
    for k, p in res.items():
        key = mapping.get(k)
        if not key:
            continue
        data, _ = read_wav(p)
        write_wav(out / f"{key}.wav", data, sr)
        stems[key] = out / f"{key}.wav"
        found += 1
    if found == 0:
        raise RuntimeError(f"drum model returned {sorted(res)}")


def ensure_headroom(stems: dict[str, Path], sr: int, ceiling: float = 0.98) -> float:
    """If any stem exceeds the ceiling, scale ALL stems by the same factor so nothing clips on
    the 24-bit write and the stems still sum to (a scaled copy of) the mix. Returns the gain."""
    peak = 0.0
    data: dict[str, np.ndarray] = {}
    for key, path in stems.items():
        d, _ = read_wav(path)
        data[key] = d
        peak = max(peak, float(np.abs(d).max()) if d.size else 0.0)
    if peak <= ceiling or peak == 0.0:
        return 1.0
    gain = ceiling / peak
    for key, d in data.items():
        write_wav(stems[key], d * gain, sr)
    return gain


# ---------------------------------------------------------------------------
# Tag pass: what does each stem actually sound like?

TAG_MODEL = "MIT/ast-finetuned-audioset-10-10-0.4593"

# AudioSet label -> instrument family shown to the user.
FAMILIES = {
    "Strings": ["Violin, fiddle", "Cello", "Viola", "Bowed string instrument", "String section", "Orchestra", "Pizzicato", "Double bass"],
    "Guitar": ["Guitar", "Acoustic guitar", "Electric guitar", "Bass guitar", "Steel guitar, slide guitar", "Banjo", "Ukulele", "Mandolin", "Strum"],
    "Keys": ["Piano", "Electric piano", "Keyboard (musical)", "Organ", "Electronic organ", "Hammond organ", "Harpsichord", "Rhodes piano", "Clavinet"],
    "Synth": ["Synthesizer", "Electronic music", "Techno", "House music", "Trance music", "Theremin", "Sampler"],
    "Brass/Winds": ["Trumpet", "Trombone", "Brass instrument", "French horn", "Saxophone", "Clarinet", "Flute", "Harmonica", "Wind instrument, woodwind instrument", "Oboe", "Bagpipes"],
    "Vocals": ["Singing", "Male singing", "Female singing", "Child singing", "Choir", "Rapping", "Humming", "Yodeling", "Chant", "A capella", "Speech", "Vocal music"],
    "Drums": ["Drum", "Drum kit", "Snare drum", "Bass drum", "Hi-hat", "Cymbal", "Percussion", "Tabla", "Tambourine", "Drum machine", "Rimshot"],
    "Accordion": ["Accordion"],
    "Harp": ["Harp"],
    "Bells": ["Glockenspiel", "Vibraphone", "Marimba, xylophone", "Bell", "Tubular bells", "Chime", "Steelpan"],
}
BUCKET_FAMILY = {"vocals": "Vocals", "drums": "Drums", "bass": "Guitar", "guitar": "Guitar", "piano": "Keys", "other": None}
GENERIC = {"Music", "Musical instrument", "Silence", "Sound effect", "Effects unit", "Song", "Theme music", "Background music",
           "Plucked string instrument", "Hum", "Throbbing", "Noise", "Inside, small room", "Mantra", "Narration, monologue"}


def band_limited_leakage(a: np.ndarray, b: np.ndarray, sr: int, lo: float = 200.0, hi: float = 5000.0) -> float:
    """Correlation-based leakage estimate between two mono signals, band-limited via an FFT mask."""
    n = min(len(a), len(b))
    if n < 2:
        return 0.0
    a = a[:n].astype(np.float64)
    b = b[:n].astype(np.float64)
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    mask = (freqs >= lo) & (freqs <= hi)
    a_f = np.fft.irfft(np.fft.rfft(a) * mask, n=n)
    b_f = np.fft.irfft(np.fft.rfft(b) * mask, n=n)
    if a_f.std() < 1e-9 or b_f.std() < 1e-9:
        return 0.0
    corr = float(np.corrcoef(a_f, b_f)[0, 1])
    if np.isnan(corr):
        return 0.0
    return max(0.0, corr)


def pass_tag(stems: dict[str, Path], device: str) -> dict[str, dict]:
    import librosa
    import torch
    from transformers import ASTFeatureExtractor, ASTForAudioClassification

    fe = ASTFeatureExtractor.from_pretrained(TAG_MODEL)
    model = ASTForAudioClassification.from_pretrained(TAG_MODEL).eval().to(device)
    label_of = model.config.id2label
    out: dict[str, dict] = {}
    keys = [k for k in ("vocals", "drums", "bass", "guitar", "piano", "other") if k in stems]

    # 30 s mono windows (native sample rate) for the leakage estimate.
    leak_win: dict[str, tuple[np.ndarray, int]] = {}
    for key in keys:
        d, sr0 = read_wav(stems[key])
        mono = d.mean(axis=1)
        leak_win[key] = (mono[: int(30 * sr0)], sr0)

    for n, key in enumerate(keys):
        progress("tag", 100.0 * n / max(1, len(keys)), f"Listening to {key}")
        y, sr = read_wav(stems[key])
        y = librosa.resample(y.mean(axis=1), orig_sr=sr, target_sr=16000)
        win = 160000
        wins = [y[i:i + win] for i in range(0, len(y), win)]
        wins = [w for w in wins if len(w) > 16000 and float(np.sqrt((w ** 2).mean())) > 1e-3]
        # Classification only: the model is level sensitive, so peak-normalize each window.
        wins = [w / max(float(np.abs(w).max()), 1e-6) * 0.9 for w in wins]
        if not wins:
            out[key] = {
                "tags": [], "soundsLike": None, "displayLabel": STEM_META[key][0],
                "detections": [], "confidence": {"score": 0.0, "reasons": ["no signal in this stem"]},
            }
            continue
        probs = []
        for w in wins[:24]:
            x = fe(w, sampling_rate=16000, return_tensors="pt")
            with torch.no_grad():
                logits = model(**{k: v.to(device) for k, v in x.items()}).logits[0]
            probs.append(torch.sigmoid(logits).cpu())
        p = torch.stack(probs).mean(0)
        scored = sorted(((label_of[i], float(p[i])) for i in range(len(p))), key=lambda t: -t[1])
        tags = [{"label": l, "score": round(s, 3)} for l, s in scored if l not in GENERIC][:5]
        fam_scores = {fam: max(float(p[i]) for i in range(len(p)) if label_of[i] in labels) for fam, labels in FAMILIES.items()}
        own = BUCKET_FAMILY.get(key)
        # Vocal bleed is common in instrument stems; only call an instrument stem "Vocals" when it is unmistakable.
        candidates = {f: v for f, v in fam_scores.items() if not (f == "Vocals" and own != "Vocals" and v < 0.35)}
        ranked = sorted(candidates.items(), key=lambda t: -t[1])
        best_fam, best = ranked[0]
        own_score = fam_scores.get(own, 0.0) if own else 0.0
        sounds_like = None
        if best >= 0.06 and best_fam != own and best >= 1.3 * own_score:
            sounds_like = best_fam

        # displayLabel: vocals/drums buckets never get renamed.
        if key in ("vocals", "drums"):
            display_label = STEM_META[key][0]
        elif best_fam != own and best >= 0.06 and best >= 1.3 * own_score:
            display_label = best_fam
        elif (
            len(ranked) >= 2
            and ranked[0][1] >= 0.08 and ranked[1][1] >= 0.08
            and min(ranked[0][1], ranked[1][1]) / max(ranked[0][1], ranked[1][1]) >= 0.75
        ):
            display_label = f"{ranked[0][0]} + {ranked[1][0]}"
        else:
            display_label = STEM_META[key][0]

        detections = tags

        # Leakage: this stem vs "other" (band-limited correlation on a 30 s window).
        leakage = 0.0
        if key != "other" and "other" in leak_win:
            a, sr_a = leak_win[key]
            b, sr_b = leak_win["other"]
            if sr_a == sr_b:
                leakage = band_limited_leakage(a, b, sr_a)

        family_component = 1.0 if best_fam == own else 0.5
        score = 0.5 * min(best / 0.5, 1.0) + 0.3 * (1.0 - leakage) + 0.2 * family_component
        score = max(0.0, min(1.0, score))
        reasons = []
        if best >= 0.06:
            reasons.append(f"strong {best_fam} tag {best:.2f}")
        else:
            reasons.append(f"weak tag signal {best:.2f}")
        if key == "other":
            pass
        elif leakage >= 0.15:
            reasons.append(f"some leakage into Other {leakage:.2f}")
        else:
            reasons.append(f"little leakage into Other {leakage:.2f}")
        reasons.append("family matches bucket" if best_fam == own else "family differs from bucket")

        out[key] = {
            "tags": tags,
            "soundsLike": sounds_like,
            "displayLabel": display_label,
            "detections": detections,
            "confidence": {"score": round(score, 3), "reasons": reasons},
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--passes", default="instruments,vocals,lead,drums,tag")
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--low-priority", action="store_true")
    args = ap.parse_args()

    inp = Path(args.input).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    work = out / "_work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    model_dir = Path(args.models_dir)
    model_dir.mkdir(parents=True, exist_ok=True)

    passes = [p.strip() for p in args.passes.split(",") if p.strip()]

    import torch

    if args.low_priority:
        apply_low_priority()

    device = "cuda" if (args.device != "cpu" and torch.cuda.is_available()) else "cpu"
    emit({"event": "device", "device": device, "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None})

    def sep_factory(pass_name: str):
        return make_separator(model_dir, work / pass_name, pass_name, device)

    _, sr = read_wav(inp)
    stems: dict[str, Path] = {}

    t0 = time.time()
    try:
        pass_instruments(sep_factory, inp, out, sr, stems)
        emit({"event": "pass_done", "pass": "instruments", "seconds": round(time.time() - t0, 1)})
    except Exception as e:  # noqa: BLE001
        emit({"event": "fatal", "error": f"instruments pass failed: {e}"})
        return 1

    optional = [
        ("vocals", lambda: pass_vocals(sep_factory, inp, sr, stems)),
        ("lead", lambda: pass_lead(sep_factory, out, sr, stems)),
        ("drums", lambda: pass_drums(sep_factory, out, sr, stems)),
    ]
    for name, fn in optional:
        if name not in passes:
            continue
        t0 = time.time()
        try:
            fn()
            emit({"event": "pass_done", "pass": name, "seconds": round(time.time() - t0, 1)})
        except Exception as e:  # noqa: BLE001
            emit({"event": "pass_failed", "pass": name, "error": str(e)[:400]})

    gain = ensure_headroom(stems, sr)
    if gain < 1.0:
        emit({"event": "progress", "pass": "headroom", "percent": 100, "message": f"Applied shared gain {gain:.3f} to avoid clipping"})

    tag_info: dict[str, dict] = {}
    if "tag" in passes:
        t0 = time.time()
        try:
            tag_info = pass_tag(stems, device)
            emit({"event": "pass_done", "pass": "tag", "seconds": round(time.time() - t0, 1)})
        except Exception as e:  # noqa: BLE001
            emit({"event": "pass_failed", "pass": "tag", "error": str(e)[:400]})

    shutil.rmtree(work, ignore_errors=True)

    listing = []
    for key, path in stems.items():
        label, group, order = STEM_META[key]
        info = tag_info.get(key)
        if info is None:
            parent_key = PARENT.get(key)
            parent_info = tag_info.get(parent_key) if parent_key else None
            confidence = parent_info["confidence"] if parent_info else None
            display_label = label
            detections: list[dict] = []
            tags: list[dict] = []
            sounds_like = None
        else:
            confidence = info["confidence"]
            display_label = info["displayLabel"]
            detections = info["detections"]
            tags = info["tags"]
            sounds_like = info["soundsLike"]
        listing.append({
            "key": key,
            "label": label,
            "group": group,
            "parent": PARENT.get(key),
            "path": str(path),
            "model": STEM_MODEL.get(key, MODELS["instruments"]),
            "order": order,
            "tags": tags,
            "soundsLike": sounds_like,
            "displayLabel": display_label,
            "detections": detections,
            "confidence": confidence,
        })
    listing.sort(key=lambda s: s["order"])
    emit({"event": "done", "stems": listing, "device": device})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit({"event": "fatal", "error": str(e)[:600]})
        sys.exit(1)
