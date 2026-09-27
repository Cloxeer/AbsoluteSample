#!/usr/bin/env python
"""AbsoluteSample AI separation engine (local, free).

Quality choices were measured on the MUSDB18 test set with scripts/bench_separation.py; see
docs/CONTRACT.md v10/v11.

Chain (all on in-memory float32 audio, models kept in a reusable pool):
  vocals       viperx BS-Roformer 1297 (+ unwa revive v2 in "full" quality), combined bin-by-bin
               keeping the quieter bin, then a soft bleed gate. instrumental = mix - vocals (exact)
  instruments  on the INSTRUMENTAL: BS-Roformer SW -> drums, guitar, piano (+ bass in "quick");
               "full" takes bass from htdemucs_ft. Drum hits above 250 Hz moved out of the bass.
               other = the exact remainder (a recipe, not a file)
  substems     on request: lead vocals (karaoke Roformer; backing = vocals - lead, a recipe) or the
               drum kit (MDX23C DrumSep)
  enhance      the full chain on a region (+-4 s context), crossfaded into the stored stems
Stored stems are FLAC 24-bit scaled by one shared mixGain (<= 1) so nothing clips; derived stems
("other", "backing_vocals", karaoke "instrumental") are recipes: plus/minus of other stems and the mix.

Modes:
  server   `separate.py --serve --models-dir DIR [--device auto] [--low-priority]`
           JSON request per stdin line, JSON events per stdout line (protocol: docs/CONTRACT.md v11)
  one-shot `separate.py --input MIX --out DIR --models-dir DIR [--quality quick|full] [--mode karaoke --lead]`
           runs one split and exits (CLI, benchmarks); same events without ids.
"""
from __future__ import annotations

import argparse
import ctypes
import gc
import json
import logging
import os
import re
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

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
    "instrumental": ("Instrumental", "other", 5),
}
PARENT = {
    "lead_vocals": "vocals", "backing_vocals": "vocals",
    "kick": "drums", "snare": "drums", "toms": "drums", "hihat": "drums", "ride": "drums", "crash": "drums",
}
KIT = ("kick", "snare", "toms", "hihat", "ride", "crash")
STORED_TOP = ("vocals", "drums", "bass", "guitar", "piano")

MODELS = {
    "vocals": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "vocals2": "bs_roformer_vocals_revive_v2_unwa.ckpt",
    "instruments": "BS-Roformer-SW.ckpt",
    "bass": "htdemucs_ft.yaml",
    "lead": "bs_roformer_karaoke_frazer_becruily.ckpt",
    "drums": "MDX23C-DrumSep-aufr33-jarredou.ckpt",
}
LOAD_SETS = {"quick": ["vocals", "instruments"], "full": ["vocals", "vocals2", "instruments", "bass"]}
# Models whose file labelled "Vocals" by audio-separator 0.47 actually holds the instrumental.
LABEL_SWAPPED = {MODELS["vocals2"], "bs_roformer_vocals_resurrection_unwa.ckpt"}
# Downloaded by earlier versions, no longer used: removed to save ~2.5 GB.
OBSOLETE_MODEL_FILES = [
    "melband_roformer_big_beta6x.ckpt", "melband_roformer_big_beta6x.yaml",
    "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt", "config_mel_band_roformer_kim_ft2_bleedless_unwa.yaml",
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt", "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.yaml",
    "bs_roformer_vocals_resurrection_unwa.ckpt", "config_bs_roformer_vocals_resurrection_unwa.yaml",
    "htdemucs_6s.yaml", "5c90dfd2-34c22ccb.th",
    "config_melbandroformer_big_beta6x.yaml", "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956_config.yaml",
]

MODEL_SR = 44100
VOCAL_GATE_DB = -18.0      # vocal bins this far under the instrumental are treated as bleed
BASS_CLEAN_ABOVE_HZ = 250.0
BASS_CLEAN_STRENGTH = 8.0
ENHANCE_CONTEXT_SEC = 4.0  # models need context: process this much extra on each side
CROSSFADE_SEC = 0.1
PEAK_CEILING = 0.999       # FLAC 24-bit is fixed point: keep every stored stem under this
# Roformer window overlap per quality. Measured on MUSDB18: overlap 2 halves the time of the
# Roformer passes for ~0.1 dB; Enhance and "full" keep 4 (same SDR as 8).
QUICK_OVERLAP = 2


# ---------------------------------------------------------------------------
# DSP (measured on MUSDB18; see docs/CONTRACT.md v10)

def _stft(x: np.ndarray, n_fft: int, hop: int):
    import torch

    win = torch.hann_window(n_fft)
    return torch.stft(torch.from_numpy(np.ascontiguousarray(x.T)).float(), n_fft, hop, window=win, return_complex=True)


def _istft(S, n: int, n_fft: int, hop: int) -> np.ndarray:
    import torch

    win = torch.hann_window(n_fft)
    return torch.istft(S, n_fft, hop, window=win, length=n).T.numpy().astype(np.float32)


def low_band_ratio_db(x: np.ndarray, mix: np.ndarray, below_hz: float = 150.0) -> float:
    """Energy under `below_hz` of x relative to the mix's (dB). Vocals have almost none."""
    X, M = _stft(x, 4096, 1024), _stft(mix, 4096, 1024)
    k = int(below_hz / (MODEL_SR / 4096)) + 1
    ex = float((X[:, 1:k].abs() ** 2).sum()) + 1e-12
    em = float((M[:, 1:k].abs() ** 2).sum()) + 1e-12
    return 10.0 * np.log10(ex / em)


def true_vocals(model: str, labelled_vocals: np.ndarray, mix: np.ndarray) -> np.ndarray:
    """The model's real vocal estimate: undo a known label swap, and cross-check physically
    (the vocal stem must have far less low end than the instrumental)."""
    cand = mix - labelled_vocals if model in LABEL_SWAPPED else labelled_vocals
    other = mix - cand
    lv, lo = low_band_ratio_db(cand, mix), low_band_ratio_db(other, mix)
    if lv > lo + 10.0:  # clearly the instrumental: labels are the other way round
        progress("vocals", -1, f"{model}: outputs looked swapped (low end {lv:.0f} vs {lo:.0f} dB); corrected")
        cand = other
    return cand


def min_mag_combine(estimates: list[np.ndarray]) -> np.ndarray:
    """Per time-frequency bin keep the estimate with the SMALLEST magnitude: only what every
    model agrees is voice survives (least bleed)."""
    import torch

    n = min(len(e) for e in estimates)
    S = torch.stack([_stft(e[:n], 2048, 512) for e in estimates])
    idx = S.abs().argmin(0, keepdim=True)
    return _istft(torch.gather(S, 0, idx)[0], n, 2048, 512)


def vocal_bleed_gate(v: np.ndarray, mix: np.ndarray, thr_db: float = VOCAL_GATE_DB, floor_db: float = -30.0) -> np.ndarray:
    """Soft spectral gate: vocal bins more than |thr_db| under the instrumental are mostly music
    that leaked in. They fade (12 dB knee, time-smoothed so no musical noise) toward floor_db."""
    import torch

    n = min(len(v), len(mix))
    V, I = _stft(v[:n], 2048, 512), _stft(mix[:n] - v[:n], 2048, 512)
    ratio_db = 20 * torch.log10((V.abs() + 1e-9) / (I.abs() + 1e-9))
    g = 10 ** (torch.clamp((ratio_db - thr_db) / 12.0, -1.0, 0.0) * (-floor_db) / 20)
    g = torch.nn.functional.avg_pool1d(g.reshape(-1, 1, g.shape[-1]), 5, 1, 2, count_include_pad=False).reshape(g.shape)
    return _istft(V * g, n, 2048, 512)


def move_intruder(target: np.ndarray, intruder: np.ndarray, above_hz: float, strength: float) -> tuple[np.ndarray, np.ndarray]:
    """Moves from `target` the bins above `above_hz` where `intruder` is louder (soft mask) into
    `intruder`. Sum preserving. Used to take drum hits out of the bass."""
    import torch

    n = min(len(target), len(intruder))
    T, I = _stft(target[:n], 4096, 1024), _stft(intruder[:n], 4096, 1024)
    pt, pi = T.abs() ** 2, I.abs() ** 2
    keep = pt / (pt + strength * pi + 1e-12)
    f = torch.linspace(0, MODEL_SR / 2, keep.shape[1])[None, :, None]
    keep = torch.where(f < above_hz, torch.ones_like(keep), keep)
    Tn = T * keep
    return _istft(Tn, n, 4096, 1024), intruder[:n] + _istft(T - Tn, n, 4096, 1024)



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


def pass_tag(pool: "ModelPool", stems: dict[str, tuple[np.ndarray, int]]) -> dict[str, dict]:
    """AudioSet tags per top-level stem (in-memory audio)."""
    import librosa
    import torch

    fe, model = pool.tagger()
    device = pool.device
    label_of = model.config.id2label
    out: dict[str, dict] = {}
    keys = [k for k in ("vocals", "drums", "bass", "guitar", "piano", "other") if k in stems]

    # 30 s mono windows (native sample rate) for the leakage estimate.
    leak_win: dict[str, tuple[np.ndarray, int]] = {}
    for key in keys:
        d, sr0 = stems[key]
        mono = d.mean(axis=1)
        leak_win[key] = (mono[: int(30 * sr0)], sr0)

    for n, key in enumerate(keys):
        progress("tag", 100.0 * n / max(1, len(keys)), f"Listening to {key}")
        y, sr = stems[key]
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




# ---------------------------------------------------------------------------
# Events

_JOB_ID: str | None = None  # id of the request being served (server mode); None in one-shot mode


def emit(obj: dict) -> None:
    if _JOB_ID is not None and "id" not in obj:
        obj = {**obj, "id": _JOB_ID}
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def progress(pass_name: str, percent: float, message: str) -> None:
    emit({"event": "progress", "pass": pass_name, "percent": round(float(percent), 1), "message": message})


def peak_rss_mb() -> float | None:
    try:
        import psutil

        info = psutil.Process().memory_info()
        return round((getattr(info, "peak_wset", None) or info.rss) / 2**20, 1)
    except Exception:  # noqa: BLE001
        return None


def vram_mb() -> int | None:
    try:
        import torch

        if torch.cuda.is_available():
            return int(torch.cuda.memory_reserved() / 2**20)
    except Exception:  # noqa: BLE001
        pass
    return None


def cleanup_torch() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def set_low_priority(low: bool) -> None:
    """Fewer CPU threads and a below-normal process priority (Windows) while a game might be running."""
    import torch

    torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2) if low else min(4, os.cpu_count() or 4))
    try:
        ctypes.windll.kernel32.SetPriorityClass(-1, 0x4000 if low else 0x20)  # BELOW_NORMAL / NORMAL
    except Exception:  # noqa: BLE001
        pass


def prune_obsolete_models(model_dir: Path) -> None:
    freed = 0
    for name in OBSOLETE_MODEL_FILES:
        f = model_dir / name
        try:
            if f.is_file():
                freed += f.stat().st_size
                f.unlink()
        except OSError:
            pass
    if freed:
        progress("cleanup", 100, f"Removed unused models ({freed / 2**30:.1f} GB freed)")


# ---------------------------------------------------------------------------
# Audio I/O. Stems are FLAC 24-bit; everything in memory is float32 (n, 2).

def read_audio(path: Path | str, start: int | None = None, stop: int | None = None) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True, start=start or 0, stop=stop)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    return data[:, :2], sr


def write_float(path: Path, data: np.ndarray, sr: int) -> None:
    """32-bit float WAV (model inputs and one-shot/bench scratch)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data.astype(np.float32), sr, subtype="FLOAT")


def write_stem(path: Path, data: np.ndarray, sr: int) -> None:
    """Stored stem: FLAC 24-bit (lossless, ~half the size of WAV). Callers keep it under PEAK_CEILING."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(data, -1.0, 1.0).astype(np.float32), sr, format="FLAC", subtype="PCM_24")


def peak(x: np.ndarray) -> float:
    return float(np.abs(x).max()) if x.size else 0.0


def fit_len(x: np.ndarray, n: int) -> np.ndarray:
    if len(x) >= n:
        return x[:n]
    return np.concatenate([x, np.zeros((n - len(x), x.shape[1]), dtype=x.dtype)])


def resample(x: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    if sr_from == sr_to:
        return x
    import librosa

    return np.stack([librosa.resample(x[:, c], orig_sr=sr_from, target_sr=sr_to, res_type="soxr_hq") for c in range(x.shape[1])], axis=1).astype(np.float32)


def next_version_path(out: Path, key: str, current: str | None) -> Path:
    """<key>.flac -> <key>.1.flac -> <key>.2.flac ... (new URL => players never serve stale audio)."""
    n = 0
    if current:
        m = re.search(rf"{re.escape(key)}\.(\d+)\.flac$", Path(current).name)
        n = int(m.group(1)) + 1 if m else 1
    return out / (f"{key}.flac" if n == 0 else f"{key}.{n}.flac")


# ---------------------------------------------------------------------------
# Model pool: each model is loaded once and reused for every job while the process lives.

class _ProgressHook(logging.Handler):
    pass_name = "separate"

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        msg = record.getMessage()
        low = msg.lower()
        if "download" in low or "%" in msg:
            progress(self.pass_name, -1, msg[:120])


_HOOK = _ProgressHook(level=logging.INFO)


class ModelPool:
    def __init__(self, model_dir: Path, device: str, autocast: bool = True, overlap: int = 4):
        self.model_dir = model_dir
        self.device = device
        self.autocast = autocast
        self.overlap = overlap
        self.tmp = model_dir.parent / "tmp"
        self._seps: dict[str, object] = {}
        self._tagger = None

    def names(self) -> list[str]:
        return list(self._seps)

    def _new_separator(self, out_dir: Path):
        from audio_separator.separator import Separator

        sep = Separator(
            log_level=logging.INFO,
            model_file_dir=str(self.model_dir),
            output_dir=str(out_dir),
            output_format="WAV",
            # No input normalization (keeps levels; stems must sum to the mix). fp16 + overlap 4
            # measured identical SDR to fp32 + overlap 8, ~3x faster.
            normalization_threshold=1.0,
            amplification_threshold=0.0,
            use_autocast=self.autocast,
            demucs_params={"segment_size": "Default", "shifts": 2, "overlap": 0.4, "segments_enabled": True},
            mdxc_params={"segment_size": 256, "override_model_segment_size": False, "batch_size": 1, "overlap": self.overlap, "pitch_shift": 0},
        )
        sep.logger.addHandler(_HOOK)
        return sep

    def get(self, model: str, pass_name: str):
        sep = self._seps.get(model)
        if sep is not None:
            return sep
        out_dir = self.tmp / re.sub(r"[^A-Za-z0-9_.-]", "_", model)
        out_dir.mkdir(parents=True, exist_ok=True)
        sep = self._new_separator(out_dir)
        progress(pass_name, 5, f"Loading {model}")
        try:
            sep.load_model(model_filename=model)
        except Exception as e:  # noqa: BLE001  corrupt/incomplete download: delete and retry once
            progress(pass_name, -1, f"Model load failed ({str(e)[:80]}); re-downloading")
            f = self.model_dir / model
            if f.exists():
                f.unlink()
            sep.load_model(model_filename=model)
        self._seps[model] = sep
        return sep

    def run(self, model: str, audio: np.ndarray, pass_name: str, quality: str = "full") -> dict[str, np.ndarray]:
        """Separate in-memory 44.1 kHz audio; returns {stem_name_lower: audio} (same length)."""
        sep = self.get(model, pass_name)
        _HOOK.pass_name = pass_name
        inst = getattr(sep, "model_instance", None)
        if inst is not None and hasattr(inst, "overlap") and model.endswith(".ckpt"):
            inst.overlap = QUICK_OVERLAP if quality == "quick" else self.overlap
        inp = self.tmp / f"in_{uuid.uuid4().hex}.wav"
        write_float(inp, audio, MODEL_SR)
        try:
            outs = sep.separate(str(inp))
        finally:
            inp.unlink(missing_ok=True)
        result: dict[str, np.ndarray] = {}
        for o in outs:
            p = Path(o) if Path(o).is_absolute() else Path(sep.output_dir) / o
            stem = p.stem.split("_(")[-1].split(")")[0].lower() if "_(" in p.stem else p.stem.lower()
            result[stem] = fit_len(read_audio(p)[0], len(audio))
            p.unlink(missing_ok=True)
        return result

    def tagger(self):
        if self._tagger is None:
            from transformers import ASTFeatureExtractor, ASTForAudioClassification

            fe = ASTFeatureExtractor.from_pretrained(TAG_MODEL)
            model = ASTForAudioClassification.from_pretrained(TAG_MODEL).eval().to(self.device)
            self._tagger = (fe, model)
        return self._tagger

    def clear(self) -> None:
        self._seps.clear()
        self._tagger = None
        cleanup_torch()


# ---------------------------------------------------------------------------
# Chains (44.1 kHz float32 in, float32 out)

def vocals_chain(pool: ModelPool, mix: np.ndarray, quality: str) -> np.ndarray:
    keys = ["vocals"] if quality == "quick" else ["vocals", "vocals2"]
    estimates = []
    for i, k in enumerate(keys):
        model = MODELS[k]
        progress("vocals", 10 + 40 * i, f"Separating vocals ({i + 1}/{len(keys)})")
        res = pool.run(model, mix, "vocals", quality)
        lab = next((r for r in res if "vocal" in r and "instrument" not in r), None)
        if lab is None:
            raise RuntimeError(f"{model} returned {sorted(res)}")
        estimates.append(true_vocals(model, res[lab], mix))
    progress("vocals", 92, "Removing bleed")
    v = min_mag_combine(estimates) if len(estimates) > 1 else estimates[0]
    return fit_len(vocal_bleed_gate(v, mix), len(mix))


def instruments_chain(pool: ModelPool, inst: np.ndarray, quality: str) -> dict[str, np.ndarray]:
    progress("instruments", 10, "Separating drums, bass, guitar, piano")
    res = pool.run(MODELS["instruments"], inst, "instruments", quality)
    wanted = ("drums", "guitar", "piano") + (("bass",) if quality == "quick" else ())
    out: dict[str, np.ndarray] = {}
    for key in wanted:
        k = next((r for r in res if r == key or r.startswith(key)), None)
        if k is None:
            raise RuntimeError(f"SW did not return {key!r} (got {sorted(res)})")
        out[key] = res[k]
    if quality != "quick":
        progress("instruments", 60, "Separating bass")
        bres = pool.run(MODELS["bass"], inst, "instruments")
        if "bass" not in bres:
            raise RuntimeError(f"bass model returned {sorted(bres)}")
        out["bass"] = bres["bass"]
    progress("instruments", 92, "Removing drum hits from the bass")
    bass, drums = move_intruder(out["bass"], out["drums"], BASS_CLEAN_ABOVE_HZ, BASS_CLEAN_STRENGTH)
    out["bass"], out["drums"] = fit_len(bass, len(inst)), fit_len(drums, len(inst))
    return out


def lead_chain(pool: ModelPool, vocals: np.ndarray) -> np.ndarray:
    res = pool.run(MODELS["lead"], vocals, "lead")
    k = next((r for r in res if "vocal" in r and "back" not in r and "instrument" not in r), None)
    if k is None:
        raise RuntimeError(f"karaoke model returned {sorted(res)}")
    lead = res[k]
    back = vocals - lead
    # The lead is the dominant voice: if the "lead" output is the quieter one, labels are swapped.
    return back if float(np.mean(lead ** 2)) < float(np.mean(back ** 2)) else lead


def kit_chain(pool: ModelPool, drums: np.ndarray) -> dict[str, np.ndarray]:
    res = pool.run(MODELS["drums"], drums, "drums")
    mapping = {"kick": "kick", "snare": "snare", "toms": "toms", "hh": "hihat", "hihat": "hihat", "ride": "ride", "crash": "crash"}
    out = {mapping[k]: v for k, v in res.items() if k in mapping}
    if not out:
        raise RuntimeError(f"drum model returned {sorted(res)}")
    return out


# ---------------------------------------------------------------------------
# Stem entries

def entry(key: str, path: Path | None, model: str, derived: dict | None = None) -> dict:
    label, group, order = STEM_META[key]
    return {"key": key, "label": label, "group": group, "parent": PARENT.get(key), "path": str(path) if path else "",
            "model": model, "order": order, "derived": derived}


def other_recipe(mix_gain: float) -> dict:
    return {"plus": ["mix"], "minus": list(STORED_TOP), "mixGain": mix_gain}


def backing_recipe() -> dict:
    return {"plus": ["vocals"], "minus": ["lead_vocals"], "mixGain": None}


# ---------------------------------------------------------------------------
# Jobs

def job_split(pool: ModelPool, req: dict) -> dict:
    mix_path = Path(req["input"])
    out = Path(req["out"])
    out.mkdir(parents=True, exist_ok=True)
    quality = req.get("quality", "quick")
    mix_orig, sr = read_audio(mix_path)
    mix = resample(mix_orig, sr, MODEL_SR)
    model_names = {"vocals": MODELS["vocals"] if quality == "quick" else f"{MODELS['vocals']} + {MODELS['vocals2']}",
                   "bass": MODELS["instruments"] if quality == "quick" else MODELS["bass"]}

    t0 = time.time()
    vocals = vocals_chain(pool, mix, quality)
    vocals_o = fit_len(resample(vocals, MODEL_SR, sr), len(mix_orig))
    # Early listen: write the vocals now with their own safe gain; rewritten below only if the
    # final shared gain differs.
    early_gain = min(1.0, PEAK_CEILING / max(peak(vocals_o), 1e-9))
    vpath = out / "vocals.flac"
    write_stem(vpath, vocals_o * early_gain, sr)
    emit({"event": "pass_done", "pass": "vocals", "seconds": round(time.time() - t0, 1)})
    emit({"event": "stem_ready", "stem": entry("vocals", vpath, model_names["vocals"])})

    t0 = time.time()
    parts = instruments_chain(pool, mix - vocals, quality)
    del mix
    parts_o = {k: fit_len(resample(v, MODEL_SR, sr), len(mix_orig)) for k, v in parts.items()}
    del parts
    gain = min(1.0, PEAK_CEILING / max(max(peak(v) for v in [vocals_o, *parts_o.values()]), 1e-9))
    if abs(gain - early_gain) > 1e-9:
        # The shared gain changed: rewrite the vocals under a new name and re-announce them, so
        # nobody keeps (or measures derived stems against) the early file.
        new_vpath = next_version_path(out, "vocals", str(vpath))
        write_stem(new_vpath, vocals_o * gain, sr)
        vpath.unlink(missing_ok=True)
        vpath = new_vpath
        emit({"event": "stem_ready", "stem": entry("vocals", vpath, model_names["vocals"])})
    paths = {"vocals": vpath}
    for key in ("drums", "bass", "guitar", "piano"):
        paths[key] = out / f"{key}.flac"
        write_stem(paths[key], parts_o[key] * gain, sr)
    emit({"event": "pass_done", "pass": "instruments", "seconds": round(time.time() - t0, 1)})

    stems = [entry("vocals", paths["vocals"], model_names["vocals"]),
             entry("drums", paths["drums"], MODELS["instruments"]),
             entry("bass", paths["bass"], model_names["bass"]),
             entry("guitar", paths["guitar"], MODELS["instruments"]),
             entry("piano", paths["piano"], MODELS["instruments"]),
             entry("other", None, MODELS["instruments"], other_recipe(gain))]
    for s in stems[1:]:
        emit({"event": "stem_ready", "stem": s})

    if req.get("tag", True):
        t0 = time.time()
        try:
            arrays = {"vocals": vocals_o, **parts_o}
            arrays["other"] = mix_orig - sum(arrays.values())
            info = pass_tag(pool, {k: (v, sr) for k, v in arrays.items()})
            for s in stems:
                s.update(info.get(s["key"], {}))
            emit({"event": "pass_done", "pass": "tag", "seconds": round(time.time() - t0, 1)})
        except Exception as e:  # noqa: BLE001  tagging is optional
            emit({"event": "pass_failed", "pass": "tag", "error": str(e)[:400]})
    return {"stems": stems, "device": pool.device, "quality": quality, "mixPath": str(mix_path), "mixGain": gain, "enhanced": []}


def job_substems(pool: ModelPool, req: dict) -> dict:
    parent = req["parent"]
    src = Path(req["input"])
    out = Path(req["out"])
    x_o, sr = read_audio(src)
    x = resample(x_o, sr, MODEL_SR)
    t0 = time.time()
    if parent == "vocals":
        lead = fit_len(resample(lead_chain(pool, x), MODEL_SR, sr), len(x_o))
        if peak(lead) > PEAK_CEILING:  # keep lead + backing == vocals exact: never scale the lead alone
            lead = np.clip(lead, -PEAK_CEILING, PEAK_CEILING)
        p = out / "lead_vocals.flac"
        write_stem(p, lead, sr)
        children = [entry("lead_vocals", p, MODELS["lead"]), entry("backing_vocals", None, MODELS["lead"], backing_recipe())]
        emit({"event": "pass_done", "pass": "lead", "seconds": round(time.time() - t0, 1)})
    elif parent == "drums":
        kit = {k: fit_len(resample(v, MODEL_SR, sr), len(x_o)) for k, v in kit_chain(pool, x).items()}
        f = min(1.0, PEAK_CEILING / max(max(peak(v) for v in kit.values()), 1e-9))
        children = []
        for k in KIT:
            if k in kit:
                p = out / f"{k}.flac"
                write_stem(p, kit[k] * f, sr)
                children.append(entry(k, p, MODELS["drums"]))
        emit({"event": "pass_done", "pass": "drums", "seconds": round(time.time() - t0, 1)})
    else:
        raise ValueError(f"unknown parent {parent!r}")
    for c in children:
        emit({"event": "stem_ready", "stem": c})
    return {"stems": children}


def job_enhance(pool: ModelPool, req: dict) -> dict:
    """Full-quality chain on [start, end] (+ context), crossfaded into every stored stem."""
    mix_path = Path(req["input"])
    out = Path(req["out"])
    gain = float(req.get("mixGain", 1.0))
    stems = [dict(s) for s in req["stems"]]
    by_key = {s["key"]: s for s in stems}
    info = sf.info(str(mix_path))
    sr, n_total = info.samplerate, info.frames
    start, end = float(req["start"]), float(req["end"])
    if not (0 <= start < end):
        raise ValueError("enhance needs 0 <= start < end")
    s0 = max(0, int((start - ENHANCE_CONTEXT_SEC) * sr))
    e0 = min(n_total, int((end + ENHANCE_CONTEXT_SEC) * sr))
    seg_o, _ = read_audio(mix_path, s0, e0)
    seg = resample(seg_o, sr, MODEL_SR)

    t0 = time.time()
    vocals = vocals_chain(pool, seg, "full")
    emit({"event": "pass_done", "pass": "vocals", "seconds": round(time.time() - t0, 1)})
    t0 = time.time()
    parts = instruments_chain(pool, seg - vocals, "full")
    emit({"event": "pass_done", "pass": "instruments", "seconds": round(time.time() - t0, 1)})
    new = {"vocals": vocals, **parts}
    if "lead_vocals" in by_key:
        new["lead_vocals"] = lead_chain(pool, vocals)
    if any(k in by_key for k in KIT):
        new.update(kit_chain(pool, parts["drums"]))
    n = e0 - s0
    new = {k: fit_len(resample(v, MODEL_SR, sr), n) * gain for k, v in new.items()}

    # Crossfade weights: 0 -> 1 over CROSSFADE_SEC at each edge (no fade at the file edges).
    w = np.ones(n, dtype=np.float32)
    f = min(int(CROSSFADE_SEC * sr), n // 4)
    if s0 > 0:
        w[:f] = np.linspace(0.0, 1.0, f, dtype=np.float32)
    if e0 < n_total:
        w[n - f:] = np.linspace(1.0, 0.0, f, dtype=np.float32)
    w = w[:, None]

    progress("enhance", 95, "Blending into your stems")
    spliced: dict[str, np.ndarray] = {}
    top = 0.0
    for key, x_new in new.items():
        s = by_key.get(key)
        if s is None or not s.get("path"):
            continue
        x, _ = read_audio(s["path"])
        x[s0:e0] = x[s0:e0] * (1.0 - w) + x_new * w
        spliced[key] = x
        top = max(top, peak(x))
    factor = min(1.0, PEAK_CEILING / max(top, 1e-9))
    if factor < 1.0:
        # Rare: the better separation is louder somewhere. Scale EVERY stored stem so all
        # relations (sum to the mix, lead + backing = vocals) stay exact.
        for s in stems:
            if s.get("path") and s["key"] not in spliced:
                x, _ = read_audio(s["path"])
                spliced[s["key"]] = x
        gain *= factor
    for key, x in spliced.items():
        s = by_key[key]
        q = next_version_path(out, key, s["path"])
        write_stem(q, x * factor, sr)
        if Path(s["path"]) != q:
            Path(s["path"]).unlink(missing_ok=True)
        s["path"] = str(q)
    for s in stems:
        if s.get("derived") and "mix" in s["derived"].get("plus", []):
            s["derived"] = {**s["derived"], "mixGain": gain}
    enhanced = merge_regions(list(req.get("enhanced") or []) + [{"start": s0 / sr, "end": e0 / sr}])
    return {"stems": stems, "device": pool.device, "quality": req.get("quality", "quick"), "mixPath": str(mix_path),
            "mixGain": gain, "enhanced": enhanced}


def merge_regions(regions: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in sorted(regions, key=lambda r: r["start"]):
        if out and r["start"] <= out[-1]["end"]:
            out[-1]["end"] = max(out[-1]["end"], r["end"])
        else:
            out.append({"start": round(r["start"], 3), "end": round(r["end"], 3)})
    return out


def job_karaoke(pool: ModelPool, req: dict) -> dict:
    mix_path = Path(req["input"])
    out = Path(req["out"])
    out.mkdir(parents=True, exist_ok=True)
    mix_orig, sr = read_audio(mix_path)
    mix = resample(mix_orig, sr, MODEL_SR)
    t0 = time.time()
    vocals = vocals_chain(pool, mix, "quick")
    del mix
    vocals_o = fit_len(resample(vocals, MODEL_SR, sr), len(mix_orig))
    gain = min(1.0, PEAK_CEILING / max(peak(vocals_o), 1e-9))
    vpath = out / "vocals.flac"
    write_stem(vpath, vocals_o * gain, sr)
    stems = [entry("instrumental", None, MODELS["vocals"], {"plus": ["mix"], "minus": ["vocals"], "mixGain": gain}),
             entry("vocals", vpath, MODELS["vocals"])]
    stems[0]["parent"] = None
    emit({"event": "pass_done", "pass": "vocals", "seconds": round(time.time() - t0, 1)})
    for s in stems:
        emit({"event": "stem_ready", "stem": s})
    if req.get("lead"):
        t0 = time.time()
        try:
            lead = fit_len(resample(lead_chain(pool, vocals), MODEL_SR, sr), len(mix_orig)) * gain
            lp = out / "lead_vocals.flac"
            write_stem(lp, np.clip(lead, -PEAK_CEILING, PEAK_CEILING), sr)
            stems += [entry("lead_vocals", lp, MODELS["lead"]), entry("backing_vocals", None, MODELS["lead"], backing_recipe())]
            emit({"event": "pass_done", "pass": "lead", "seconds": round(time.time() - t0, 1)})
        except Exception as e:  # noqa: BLE001
            emit({"event": "pass_failed", "pass": "lead", "error": str(e)[:400]})
    return {"stems": stems, "device": pool.device, "quality": "quick", "mixPath": str(mix_path), "mixGain": gain, "enhanced": []}


JOBS = {"split": job_split, "substems": job_substems, "enhance": job_enhance, "karaoke": job_karaoke}


# ---------------------------------------------------------------------------
# Server and one-shot entry points

def serve(pool: ModelPool, low_priority: bool) -> int:
    global _JOB_ID
    set_low_priority(low_priority)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"event": "error", "id": None, "error": "bad request line"})
            continue
        _JOB_ID = str(req.get("id", ""))
        cmd = req.get("cmd")
        t0 = time.time()
        try:
            if cmd == "load":
                for k in LOAD_SETS.get(req.get("set", "quick"), LOAD_SETS["quick"]):
                    pool.get(MODELS[k], "load")
                emit({"event": "loaded", "models": pool.names(), "vramMb": vram_mb()})
            elif cmd == "unload":
                pool.clear()
                emit({"event": "unloaded", "vramMb": vram_mb()})
            elif cmd == "status":
                emit({"event": "status", "models": pool.names(), "vramMb": vram_mb()})
            elif cmd == "shutdown":
                pool.clear()
                emit({"event": "bye"})
                return 0
            elif cmd in JOBS:
                if "lowPriority" in req:
                    set_low_priority(bool(req["lowPriority"]))
                result = JOBS[cmd](pool, req)
                cleanup_torch()
                emit({"event": "done", **result, "seconds": round(time.time() - t0, 1), "peakRssMb": peak_rss_mb()})
            else:
                emit({"event": "error", "error": f"unknown cmd {cmd!r}"})
        except Exception as e:  # noqa: BLE001  a failed job never takes the server down
            cleanup_torch()
            emit({"event": "error", "error": f"{cmd} failed: {str(e)[:500]}"})
        finally:
            _JOB_ID = None
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--input")
    ap.add_argument("--out")
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--low-priority", action="store_true")
    ap.add_argument("--mode", default="full", choices=["full", "karaoke"])
    ap.add_argument("--lead", action="store_true")
    ap.add_argument("--quality", default="full", choices=["quick", "full"])
    ap.add_argument("--passes", default="", help="one-shot: add 'lead'/'drums' to also split sub-parts; 'tag' to tag")
    ap.add_argument("--no-autocast", dest="autocast", action="store_false")
    ap.add_argument("--overlap", type=int, default=4)
    args = ap.parse_args()

    import torch

    device = "cuda" if (args.device != "cpu" and torch.cuda.is_available()) else "cpu"
    model_dir = Path(args.models_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    prune_obsolete_models(model_dir)
    pool = ModelPool(model_dir, device, autocast=args.autocast, overlap=args.overlap)
    gpu = torch.cuda.get_device_name(0) if device == "cuda" else None

    if args.serve:
        emit({"event": "ready", "device": device, "gpu": gpu})
        return serve(pool, args.low_priority)

    # One-shot (CLI, benchmarks): same jobs, no ids.
    set_low_priority(args.low_priority)
    emit({"event": "device", "device": device, "gpu": gpu})
    t0 = time.time()
    passes = {p.strip() for p in args.passes.split(",") if p.strip()}
    if args.mode == "karaoke":
        result = job_karaoke(pool, {"input": args.input, "out": args.out, "lead": args.lead})
    else:
        result = job_split(pool, {"input": args.input, "out": args.out, "quality": args.quality, "tag": "tag" in passes})
        for parent, flag in (("vocals", "lead"), ("drums", "drums")):
            if flag in passes:
                src = next(s["path"] for s in result["stems"] if s["key"] == parent)
                try:
                    result["stems"] += job_substems(pool, {"parent": parent, "input": src, "out": args.out})["stems"]
                except Exception as e:  # noqa: BLE001
                    emit({"event": "pass_failed", "pass": flag, "error": str(e)[:400]})
    emit({"event": "done", **result})
    emit({"event": "metrics", "seconds": round(time.time() - t0, 3), "peakRssMb": peak_rss_mb(), "device": device})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit({"event": "fatal", "error": str(e)[:600]})
        sys.exit(1)
