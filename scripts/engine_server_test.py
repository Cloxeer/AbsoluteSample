"""Integration test of the separation engine server with the real models (GPU if available).

Runs `engine/separate.py --serve` on a generated 12 s song and checks the whole v11 protocol:
load, quick split (vocals ready early), FLAC + derived stems, sub-parts, enhance (versioned files,
untouched audio outside the region, seamless blend), karaoke, errors, unload (memory freed), shutdown.
Run with the engine venv python. Exit code 1 on any failure. Takes about a minute.
"""
from __future__ import annotations

import json
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
MODELS = Path.home() / ".absolutesample" / "engine" / "models"
SR = 44100
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)
    if not ok:
        failures.append(name)


def make_song(path: Path) -> np.ndarray:
    t = np.arange(12 * SR) / SR
    rng = np.random.default_rng(1)
    f = 220 * 2 ** ((np.floor(t / 1.5) % 4) * 2 / 12) * (1 + 0.004 * np.sin(2 * np.pi * 5 * t))
    ph = np.cumsum(2 * np.pi * f / SR)
    voice = sum((0.4 / k) * np.sin(k * ph) for k in range(1, 10)) * (np.sin(np.pi * (t % 1.5) / 1.5) ** 2) * 0.35
    bass = 0.3 * np.sin(2 * np.pi * 55 * t)
    kick = 0.6 * np.sin(2 * np.pi * 60 * t * np.exp(-8 * (t % 0.5))) * np.exp(-10 * (t % 0.5))
    hats = 0.05 * rng.standard_normal(len(t)) * np.exp(-60 * (t % 0.25))
    mix = voice + bass + kick + hats
    mix = np.stack([mix, mix * 0.98], axis=1).astype(np.float32)
    sf.write(str(path), mix, SR, subtype="PCM_24")
    return sf.read(str(path), dtype="float32", always_2d=True)[0]


class Server:
    def __init__(self) -> None:
        self.p = subprocess.Popen(
            [sys.executable, str(ROOT / "engine" / "separate.py"), "--serve", "--models-dir", str(MODELS)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.q: queue.Queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.n = 0

    def _read(self) -> None:
        for line in self.p.stdout:
            try:
                self.q.put(json.loads(line))
            except json.JSONDecodeError:
                pass
        self.q.put({"event": "__eof__"})

    def wait(self, event: str, timeout: float = 600) -> list[dict]:
        seen = []
        end = time.time() + timeout
        while time.time() < end:
            e = self.q.get(timeout=max(0.1, end - time.time()))
            seen.append(e)
            if e.get("event") in (event, "error", "fatal", "__eof__"):
                return seen
        raise TimeoutError(event)

    def call(self, cmd: dict, final: str) -> tuple[list[dict], float]:
        self.n += 1
        cmd = {"id": f"r{self.n}", **cmd}
        t0 = time.time()
        self.p.stdin.write(json.dumps(cmd) + "\n")
        self.p.stdin.flush()
        ev = self.wait(final)
        return ev, time.time() - t0


def derived_audio(stem: dict, files: dict[str, np.ndarray], mix: np.ndarray) -> np.ndarray:
    d = stem["derived"]
    acc = np.zeros_like(mix)
    for k in d["plus"]:
        acc = acc + (mix * d["mixGain"] if k == "mix" else files[k])
    for k in d["minus"]:
        acc = acc - files[k]
    return acc


def main() -> int:
    if not MODELS.exists():
        print("SKIP engine server test: models folder not found")
        return 0
    tmp = Path(tempfile.mkdtemp(prefix="as_engine_test_"))
    mix_path = tmp / "source.wav"
    mix = make_song(mix_path)
    out = tmp / "instruments"
    s = Server()
    try:
        ready = s.wait("ready", 180)[-1]
        check("server says ready", ready.get("event") == "ready", str(ready.get("device")))

        ev, secs = s.call({"cmd": "load", "set": "quick"}, "loaded")
        last = ev[-1]
        loaded_vram = last.get("vramMb") or 0
        check("load quick set", last.get("event") == "loaded" and len(last.get("models", [])) == 2, f"{secs:.1f}s, {last.get('models')}, VRAM {loaded_vram} MB")

        ev, secs = s.call({"cmd": "split", "input": str(mix_path), "out": str(out), "quality": "quick"}, "done")
        done = ev[-1]
        check("quick split completes", done.get("event") == "done", f"{secs:.1f}s" if done.get("event") == "done" else str(done)[:300])
        if done.get("event") != "done":
            return 1
        names = [e["event"] + (":" + e.get("pass", e.get("stem", {}).get("key", "")) if e["event"] in ("pass_done", "stem_ready") else "") for e in ev]
        i_voc = names.index("stem_ready:vocals") if "stem_ready:vocals" in names else 10**9
        i_inst = names.index("pass_done:instruments") if "pass_done:instruments" in names else -1
        check("vocals are playable before the instruments finish", i_voc < i_inst, f"event order {names[:8]}")
        check("every reply carries the request id", all(e.get("id") == "r2" for e in ev))
        stems = {st["key"]: st for st in done["stems"]}
        check("quick split gives the six top-level stems", sorted(stems) == sorted(["vocals", "drums", "bass", "guitar", "piano", "other"]))
        check("'other' is a recipe, not a file", stems["other"]["path"] == "" and stems["other"]["derived"]["plus"] == ["mix"])
        files = {}
        for k, st in stems.items():
            if st["path"]:
                info = sf.info(st["path"])
                x = sf.read(st["path"], dtype="float32", always_2d=True)[0]
                files[k] = x
                check(f"{k} is FLAC 24-bit, full length, not clipped",
                      info.format == "FLAC" and info.subtype == "PCM_24" and len(x) == len(mix) and float(np.abs(x).max()) <= 0.9991,
                      f"{info.format}/{info.subtype} len {len(x)} peak {np.abs(x).max():.3f}")
        other = derived_audio(stems["other"], files, mix)
        total = sum(files.values()) + other
        err = float(np.abs(total - mix * done["mixGain"]).max())
        check("stems + derived other rebuild the mix exactly", err < 1e-4, f"max err {err:.1e}")
        wav_equiv = len(mix) * 2 * 4 * 5
        disk = sum(Path(st["path"]).stat().st_size for st in stems.values() if st["path"])
        check("stems take less space than float WAV", disk < 0.6 * wav_equiv, f"{disk / 2**20:.1f} MB vs {wav_equiv / 2**20:.1f} MB")

        ev, secs = s.call({"cmd": "substems", "parent": "vocals", "input": stems["vocals"]["path"], "out": str(out), "mixGain": done["mixGain"]}, "done")
        sub = ev[-1]
        ok = sub.get("event") == "done"
        check("split lead & backing on request", ok, f"{secs:.1f}s" if ok else str(sub)[:300])
        if ok:
            kids = {c["key"]: c for c in sub["stems"]}
            check("backing vocals are a recipe (vocals - lead)", kids["backing_vocals"]["derived"] == {"plus": ["vocals"], "minus": ["lead_vocals"], "mixGain": None} and kids["backing_vocals"]["parent"] == "vocals")
            stems.update(kids)

        ev, secs = s.call({"cmd": "substems", "parent": "drums", "input": stems["drums"]["path"], "out": str(out), "mixGain": done["mixGain"]}, "done")
        sub = ev[-1]
        ok = sub.get("event") == "done"
        check("split drum kit on request", ok and len(sub["stems"]) >= 4, f"{secs:.1f}s, {[c['key'] for c in sub.get('stems', [])]}" if ok else str(sub)[:300])
        if ok:
            stems.update({c["key"]: c for c in sub["stems"]})

        before = {k: sf.read(st["path"], dtype="float32", always_2d=True)[0] for k, st in stems.items() if st["path"]}
        old_paths = {k: st["path"] for k, st in stems.items() if st["path"]}
        ev, secs = s.call({"cmd": "enhance", "input": str(mix_path), "out": str(out), "start": 5.0, "end": 6.0,
                           "stems": list(stems.values()), "mixGain": done["mixGain"], "enhanced": []}, "done")
        enh = ev[-1]
        ok = enh.get("event") == "done"
        check("enhance a 1 s region", ok, f"{secs:.1f}s" if ok else str(enh)[:300])
        if ok:
            new = {st["key"]: st for st in enh["stems"]}
            s0, e0 = int(1.0 * SR), int(10.0 * SR)  # 5-4 s .. 6+4 s
            changed = [k for k in before if new[k]["path"] != old_paths[k]]
            check("enhanced stems get new versioned files, old ones removed",
                  set(changed) == set(before) and all(not Path(old_paths[k]).exists() for k in changed) and all(".1.flac" in new[k]["path"] for k in changed),
                  f"{[Path(new[k]['path']).name for k in changed]}")
            worst_out, worst_jump = 0.0, 0.0
            for k in before:
                x = sf.read(new[k]["path"], dtype="float32", always_2d=True)[0]
                outside = np.concatenate([np.abs(x[:s0] - before[k][:s0]).ravel(), np.abs(x[e0:] - before[k][e0:]).ravel()])
                worst_out = max(worst_out, float(outside.max()) if outside.size else 0.0)
                for edge in (s0, e0):
                    seg = x[edge - 200: edge + 200, 0]
                    ref = before[k][edge - 200: edge + 200, 0]
                    worst_jump = max(worst_jump, float(np.abs(np.diff(seg)).max()) - float(np.abs(np.diff(ref)).max()))
            check("audio outside the enhanced region is untouched", worst_out == 0.0, f"max diff {worst_out:.1e}")
            check("no click where the enhanced part blends in", worst_jump < 0.01, f"extra jump {worst_jump:.4f}")
            files2 = {k: sf.read(st["path"], dtype="float32", always_2d=True)[0] for k, st in new.items() if st["path"]}
            top = sum(files2[k] for k in ("vocals", "drums", "bass", "guitar", "piano")) + derived_audio(new["other"], files2, mix)
            check("after enhance the stems still rebuild the mix", float(np.abs(top - mix * enh["mixGain"]).max()) < 1e-4)
            check("enhanced region is reported", enh.get("enhanced") == [{"start": 1.0, "end": 10.0}], str(enh.get("enhanced")))

        ev, secs = s.call({"cmd": "karaoke", "input": str(mix_path), "out": str(tmp / "karaoke"), "lead": True}, "done")
        kar = ev[-1]
        ok = kar.get("event") == "done"
        keys = sorted(st["key"] for st in kar.get("stems", []))
        check("karaoke with lead/backing", ok and keys == ["backing_vocals", "instrumental", "lead_vocals", "vocals"], f"{secs:.1f}s {keys}")

        ev, _ = s.call({"cmd": "nonsense"}, "done")
        check("a bad request returns an error, server keeps running", ev[-1].get("event") == "error")
        ev, _ = s.call({"cmd": "split", "input": str(tmp / "missing.wav"), "out": str(out)}, "done")
        check("a failed job returns an error", ev[-1].get("event") == "error")
        ev, _ = s.call({"cmd": "status"}, "status")
        check("server still answers after errors", ev[-1].get("event") == "status" and len(ev[-1].get("models", [])) >= 2, str(ev[-1].get("models")))

        ev, _ = s.call({"cmd": "unload"}, "unloaded")
        un = ev[-1]
        check("unload frees GPU memory", un.get("event") == "unloaded" and (un.get("vramMb") is None or un["vramMb"] < max(200, loaded_vram * 0.2)),
              f"{loaded_vram} MB -> {un.get('vramMb')} MB")
        ev, _ = s.call({"cmd": "shutdown"}, "bye")
        s.p.wait(timeout=30)
        check("shutdown exits cleanly", ev[-1].get("event") == "bye" and s.p.returncode == 0, f"exit {s.p.returncode}")
    finally:
        if s.p.poll() is None:
            s.p.kill()
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)
    print("engine server test:", "ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
