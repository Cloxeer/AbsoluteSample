"""Fake `separate.py --serve` for the EngineServer unit tests (engine_server.rs).

Speaks the contract v11 server protocol without loading any model.
"""
import json
import os
import sys

models = []


def emit(**obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def stem(key, derived=None):
    return {"key": key, "label": key.title(), "group": key, "parent": None,
            "path": "" if derived else f"C:/fake/{key}.flac", "model": "fake", "order": 10,
            "derived": derived}


emit(event="ready", device="cpu", gpu=None)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    rid, cmd = req.get("id"), req.get("cmd")
    if cmd == "load":
        models = ["quick-vocals", "quick-inst"]
        emit(event="loaded", id=rid, models=models, vramMb=2048)
    elif cmd == "unload":
        models = []
        emit(event="unloaded", id=rid, vramMb=0)
    elif cmd == "status":
        emit(event="status", id=rid, models=models, vramMb=2048 if models else 0)
    elif cmd == "split":
        emit(event="progress", id="someone-else", **{"pass": "vocals"}, percent=1, message="noise")
        emit(event="progress", id=rid, **{"pass": "vocals"}, percent=10, message="Separating vocals")
        emit(event="stem_ready", id=rid, stem=stem("vocals"))
        emit(event="pass_done", id=rid, **{"pass": "vocals"}, seconds=1.0)
        emit(event="stem_ready", id=rid, stem=stem("drums"))
        emit(event="done", id=rid, device="cpu", quality=req.get("quality"), mixPath=req.get("input"),
             mixGain=0.9, enhanced=[],
             stems=[stem("vocals"), stem("drums"),
                    stem("other", {"plus": ["mix"], "minus": ["vocals", "drums"], "mixGain": 0.9})])
    elif cmd == "crash":
        emit(event="progress", id=rid, **{"pass": "vocals"}, percent=5, message="about to crash")
        sys.stderr.write("boom: simulated crash\n")
        sys.stderr.flush()
        os._exit(3)
    elif cmd == "shutdown":
        emit(event="bye", id=rid)
        sys.exit(0)
    else:
        emit(event="error", id=rid, error=f"unknown cmd {cmd!r}")
