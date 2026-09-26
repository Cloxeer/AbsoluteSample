#!/usr/bin/env python
"""Bounded engine smoke test with a memory watchdog.

Generates a 3s tone, runs autotune analyze on it, and KILLS + FAILS the run if
the engine's peak RAM exceeds the cap or it runs too long. This is the guard
that stops us shipping code that can exhaust the machine's memory.

Exit 0 = pass (or skipped because the engine venv is absent). Exit 1 = fail.
"""
import json, os, subprocess, sys, tempfile, time
from pathlib import Path

CAP_GB = float(os.environ.get("SMOKE_RAM_CAP_GB", "3.0"))
CAP_SEC = float(os.environ.get("SMOKE_TIME_CAP_SEC", "120"))

home = Path(os.environ.get("USERPROFILE", str(Path.home()))) / ".absolutesample"
venv_py = home / "engine" / "venv" / "Scripts" / "python.exe"
script = Path(__file__).resolve().parent.parent / "engine" / "autotune.py"

if not venv_py.exists():
    print(f"[smoke] engine venv not found at {venv_py}; skipping engine smoke (frontend/rust tests still gate).")
    sys.exit(0)

try:
    import numpy as np, soundfile as sf  # noqa
except Exception:
    # Use the venv to make the tone instead.
    pass

tmp = Path(tempfile.mkdtemp(prefix="assmoke_"))
tone = tmp / "tone.wav"
gen = (
    "import numpy as np,soundfile as sf;"
    "sr=16000;t=np.arange(int(3*sr))/sr;"
    "x=0.5*np.sin(2*np.pi*220*t)+0.2*np.sin(2*np.pi*440*t);"
    f"sf.write(r'{tone}',x.astype('float32'),sr)"
)
r = subprocess.run([str(venv_py), "-c", gen], capture_output=True, text=True)
if r.returncode != 0 or not tone.exists():
    print("[smoke] FAIL: could not generate tone\n" + r.stderr[-500:])
    sys.exit(1)

try:
    import psutil
except Exception:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "psutil"])
    import psutil

args = [str(venv_py), str(script), "--mode", "analyze", "--input", str(tone)]
t0 = time.time()
proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
ps = psutil.Process(proc.pid)
peak = 0
killed = None
while proc.poll() is None:
    try:
        rss = ps.memory_info().rss
        for c in ps.children(recursive=True):
            rss += c.memory_info().rss
        peak = max(peak, rss)
    except Exception:
        pass
    if peak > CAP_GB * 1e9:
        killed = f"RAM exceeded {CAP_GB} GB (peak {peak/1e9:.2f} GB)"
        break
    if time.time() - t0 > CAP_SEC:
        killed = f"time exceeded {CAP_SEC}s"
        break
    time.sleep(0.1)

if killed:
    try:
        for c in ps.children(recursive=True):
            c.kill()
        proc.kill()
    except Exception:
        pass
    print(f"[smoke] FAIL: engine {killed}")
    sys.exit(1)

secs = time.time() - t0
print(f"[smoke] PASS: engine analyze {secs:.1f}s, peak {peak/1e9:.2f} GB (caps {CAP_GB} GB / {CAP_SEC}s)")
sys.exit(0)
