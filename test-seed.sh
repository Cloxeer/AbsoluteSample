#!/usr/bin/env bash
# AbsoluteSample — end-to-end seed test.
# Pulls the seed YouTube link, trims 0:30–0:45, splits into 4 LR4/Mid-Side stems,
# and verifies every stem exists, is non-zero, decodes cleanly, and carries signal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_URL="${SEED_URL:-https://youtu.be/nRKgT3d6xoE}"
START="${START:-30}"
END="${END:-45}"
OUT="${OUT:-$ROOT/test-output}"
TAURI_DIR="$ROOT/apps/desktop/src-tauri"
export PATH="$HOME/.cargo/bin:$LOCALAPPDATA/Microsoft/WinGet/Links:$PATH"
# Prefer MSVC when its linker exists; otherwise use the GNU toolchain + WinLibs mingw (no admin needed).
MINGW="$LOCALAPPDATA/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin"
if ls "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC" >/dev/null 2>&1; then
  TOOLCHAIN=""
else
  TOOLCHAIN="+stable-x86_64-pc-windows-gnu"; export PATH="$MINGW:$PATH"
fi
CARGO_FLAGS="--release --no-default-features"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== [1/5] Toolchain"
for t in cargo ffmpeg ffprobe yt-dlp; do
  if command -v "$t" >/dev/null 2>&1; then pass "$t: $($t --version 2>&1 | head -1 | cut -c1-60)"; else fail "$t missing"; fi
done
[ "$FAILED" = 0 ] || { echo "toolchain incomplete"; exit 1; }

echo "== [2/5] Build CLI"
( cd "$TAURI_DIR" && cargo $TOOLCHAIN build $CARGO_FLAGS --bin absolutesample-cli 2>&1 | tail -2 )
CLI="$TAURI_DIR/target/release/absolutesample-cli.exe"
[ -x "$CLI" ] || CLI="$TAURI_DIR/target/release/absolutesample-cli"
pass "built $CLI"

echo "== [3/5] Rust unit tests"
( cd "$TAURI_DIR" && cargo $TOOLCHAIN test $CARGO_FLAGS --lib 2>&1 | grep -E "^test result|running" )

ENGINE="${ENGINE:-auto}"   # auto | ai | bands
if [ "$ENGINE" = auto ]; then
  if "$CLI" engine status 2>/dev/null | grep -q '"installed": *true'; then ENGINE=ai; else ENGINE=bands; fi
fi
echo "== [4/5] Pipeline: fetch -> trim ${START}s..${END}s -> split (engine: $ENGINE) -> analyze"
rm -rf "$OUT"; mkdir -p "$OUT"
"$CLI" run --url "$SEED_URL" --start "$START" --end "$END" --out "$OUT" --engine "$ENGINE" > "$OUT/run.log"
[ -f "$OUT/manifest.json" ] && pass "manifest.json written" || fail "manifest.json missing"

echo "== [5/5] Verify stems"
EXPECT_DUR=$(( END - START ))
for stem in 01_drums_sub 02_bass_lowmid 03_mid_vocals 04_highs_air; do
  f="$OUT/$stem.wav"
  if [ ! -f "$f" ]; then fail "$stem.wav missing"; continue; fi
  bytes=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")
  [ "$bytes" -gt 0 ] && pass "$stem.wav exists ($bytes bytes)" || fail "$stem.wav is empty"
  # playback integrity: full decode with error-level logging must produce zero errors
  errs=$(ffmpeg -v error -i "$f" -f null - 2>&1 | wc -l)
  [ "$errs" -eq 0 ] && pass "$stem.wav decodes cleanly" || fail "$stem.wav decode errors: $errs"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  awk -v d="$dur" -v e="$EXPECT_DUR" 'BEGIN{exit !(d>e-0.6 && d<e+0.6)}' \
    && pass "$stem.wav duration ${dur}s (expected ~${EXPECT_DUR}s)" || fail "$stem.wav duration ${dur}s off"
  rms=$(ffmpeg -i "$f" -af "astats=measure_overall=RMS_level:measure_perchannel=none" -f null - 2>&1 | grep -E "RMS level dB" | tail -1 | awk '{print $NF}')
  awk -v r="$rms" 'BEGIN{exit !(r > -70)}' && pass "$stem.wav carries signal (RMS ${rms} dB)" || fail "$stem.wav silent (RMS ${rms})"
done
MANIFEST="$OUT/manifest.json"; command -v cygpath >/dev/null 2>&1 && MANIFEST="$(cygpath -w "$MANIFEST")"
bpm=$(python -c "import json;m=json.load(open(r'$MANIFEST'));print(m['analysis']['bpm'], m['analysis']['confidence'], len(m['analysis']['transients']))" 2>/dev/null || true)
[ -n "$bpm" ] && pass "analysis: bpm/confidence/transients = $bpm" || fail "analysis missing"

if [ "$ENGINE" = ai ]; then
  echo "== [5b] Verify AI instrument stems"
  for stem in vocals drums bass guitar piano other; do
    f="$OUT/instruments/$stem.wav"
    if [ ! -f "$f" ]; then fail "instruments/$stem.wav missing"; continue; fi
    bytes=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")
    [ "$bytes" -gt 0 ] && pass "instruments/$stem.wav exists ($bytes bytes)" || fail "instruments/$stem.wav empty"
    errs=$(ffmpeg -v error -i "$f" -f null - 2>&1 | wc -l)
    [ "$errs" -eq 0 ] && pass "instruments/$stem.wav decodes cleanly" || fail "instruments/$stem.wav decode errors"
  done
  # vocals + drums + bass + guitar + piano + other must reconstruct the loop (null test): residual well below the mix
  if [ -f "$OUT/loop.wav" ] && [ -f "$OUT/instruments/other.wav" ]; then
    resid=$(ffmpeg -i "$OUT/loop.wav" -i "$OUT/instruments/vocals.wav" -i "$OUT/instruments/drums.wav" -i "$OUT/instruments/bass.wav" -i "$OUT/instruments/guitar.wav" -i "$OUT/instruments/piano.wav" -i "$OUT/instruments/other.wav"       -filter_complex "[1][2][3][4][5][6]amix=inputs=6:normalize=0[sum];[0][sum]amerge,pan=stereo|c0=c0-c2|c1=c1-c3,astats=measure_overall=RMS_level:measure_perchannel=none" -f null - 2>&1 | grep "RMS level dB" | tail -1 | awk '{print $NF}')
    awk -v r="$resid" 'BEGIN{exit !(r < -27)}' && pass "null test: stems sum back to the loop (residual ${resid} dB)" || fail "null test residual ${resid} dB (expected < -27; stems carry a shared 0.98 headroom gain)"
  fi
  kit=$(ls "$OUT"/instruments/{kick,snare,hihat,lead_vocals}.wav 2>/dev/null | wc -l)
  [ "$kit" -ge 3 ] && pass "second-pass stems present ($kit of kick/snare/hihat/lead_vocals)" || fail "second-pass stems missing"
fi

if [ "$FAILED" = 0 ]; then echo; echo "ALL CHECKS PASSED — output in $OUT"; else echo; echo "SOME CHECKS FAILED"; exit 1; fi
