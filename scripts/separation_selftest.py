"""Fast self-test of the separation post-processing (no AI models, a few seconds).
Run by scripts/smoke.mjs with the engine venv python. Exit code 1 on any failure."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
import separate as S  # noqa: E402

SR = S.MODEL_SR
t = np.arange(int(3.0 * SR)) / SR
rng = np.random.default_rng(0)


def stereo(x: np.ndarray) -> np.ndarray:
    return np.stack([x, x], axis=1).astype(np.float32)


# A sung phrase: smooth (raised-cosine) swell in and out like a real voice, no low end.
env = np.clip(np.sin(2 * np.pi * 0.5 * t), 0.0, None) ** 2
voice = stereo(0.3 * np.sin(2 * np.pi * 440 * t) * env)
bass = stereo(0.4 * np.sin(2 * np.pi * 55 * t))
hats = stereo(0.05 * rng.standard_normal(len(t)) * (np.mod(t, 0.25) < 0.02))            # HF clicks
mix = voice + bass + hats
failures = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(name)


# 1. Label swap is caught even for a model not in the known-swap table.
fixed = S.true_vocals("unknown-model.ckpt", mix - voice, mix)  # labels swapped on purpose
err = float(np.max(np.abs(fixed - voice)))
check("swapped vocal/instrumental labels are detected and corrected", err < 1e-4, f"max err {err:.1e}")
kept = S.true_vocals("unknown-model.ckpt", voice, mix)
check("correct labels are left alone", float(np.max(np.abs(kept - voice))) < 1e-6)

# 2. Moving drum hits out of the bass never loses or creates sound.
b2, h2 = S.move_intruder(bass + hats, hats, 250.0, 8.0)
n = min(len(b2), len(h2))
loss = float(np.max(np.abs((b2 + h2)[:n] - (bass + 2 * hats)[:n])))
check("bass cleanup is sum-preserving", loss < 1e-3, f"max diff {loss:.1e}")
lf_kept = np.sum(b2[:, 0] * bass[:n, 0]) / np.sum(bass[:n, 0] ** 2)
check("bass cleanup keeps the bass", 0.97 < lf_kept < 1.03, f"bass kept {lf_kept:.3f}")

# 3. The vocal bleed gate removes faint music but leaves the real voice.
leaky = voice + 0.01 * (bass + hats)
gated = S.vocal_bleed_gate(leaky, mix)
voice_kept = float(np.sum(gated[:, 0] * voice[: len(gated), 0]) / np.sum(voice[: len(gated), 0] ** 2))
leak_after = max(abs(float(np.sum((gated - voice[: len(gated)])[:, 0] * m[: len(gated), 0]) / np.sum(m[: len(gated), 0] ** 2)))
                 for m in (bass, hats))
check("bleed gate keeps the voice", voice_kept > 0.97, f"voice kept {voice_kept:.3f}")
check("bleed gate removes leaked music", leak_after < 0.002, f"leak 0.0100 -> {leak_after:.4f}")

# 4. Least-bleed combination keeps, per bin, the quieter estimate.
comb = S.min_mag_combine([voice + 0.05 * hats, voice + 0.2 * hats])
e1 = float(np.sum((comb - voice[: len(comb)]) ** 2))
worse = float(np.sum((0.2 * hats[: len(comb)]) ** 2))
check("min-magnitude combine is far cleaner than the leakier estimate", e1 < 0.25 * worse, f"{e1:.2e} vs {worse:.2e}")

# 5. Float output never clips.
tmp = Path(__file__).resolve().parent / "_selftest.wav"
S.write_float(tmp, stereo(np.full(100, 1.5)), SR)
import soundfile as sf  # noqa: E402

back = sf.read(tmp, dtype="float32")[0]
tmp.unlink(missing_ok=True)
check("float WAV keeps values above 1.0 (no clipping clicks)", abs(float(back.max()) - 1.5) < 1e-6)

print("separation self-test:", "ALL PASSED" if not failures else f"{len(failures)} FAILED")
sys.exit(1 if failures else 0)
