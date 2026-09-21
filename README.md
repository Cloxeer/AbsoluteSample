# AbsoluteSample

A desktop proof-of-concept that pulls audio from a YouTube link, trims a loop without re-encoding,
splits it into four mechanical (non-AI) stems with Linkwitz-Riley crossovers and Mid/Side processing,
and inspects the loop's transients, BPM and beat grid. Built with Tauri v2 (Rust) and React.

## Layout

```
absolutesample/
├── apps/desktop/
│   ├── src/                 React 18 + TypeScript + Tailwind UI (neumorphic dark dashboard)
│   │   ├── components/      neumorphic/, stems/, waveform/, layout/
│   │   ├── hooks/           useAudioEngine (pipeline state), useSyncPlayback (multi-track sync + gain matrix)
│   │   ├── lib/             backend.ts (Tauri invoke), backend.mock.ts (browser-only dev), events, format
│   │   └── views/           SlicerTab (Stem Slicer & Downloader), InspectorTab (Loop & Beat Matrix)
│   ├── src-tauri/
│   │   ├── src/audio/       downloader.rs (yt-dlp), slicer.rs (-c copy trim, beat slicing),
│   │   │                    dsp_filters.rs (LR4 stem graph), analysis.rs (onset/BPM), workspace.rs
│   │   ├── src/commands.rs  Tauri commands, src/pipeline.rs (shared with CLI), src/bin/cli.rs
│   │   └── tauri.conf.json
│   └── public/fixtures/     output of the seed run, used by the browser-only mock backend
├── docs/CONTRACT.md         authoritative frontend/backend API contract
├── test-seed.sh             end-to-end test (fetch → trim 0:30–0:45 → 4 stems → verify)
└── README.md
```

## Prerequisites

| Tool | Notes |
|---|---|
| Node 22 + pnpm 10 | frontend |
| Rust stable | `rustup` (MSVC toolchain preferred; GNU + WinLibs mingw works without admin rights) |
| ffmpeg / ffprobe 6+ | on `PATH` |
| yt-dlp | on `PATH`, or set `YTDLP_PATH` |

The app checks all of these at startup and shows status pills in the header.

## Run

```bash
pnpm install
pnpm dev            # browser-only UI at http://localhost:1420 (uses public/fixtures via the mock backend)
pnpm tauri dev      # full desktop app (real yt-dlp / ffmpeg pipeline)
pnpm test           # frontend unit tests (vitest)
```

Rust only:

```bash
cd apps/desktop/src-tauri
cargo test --no-default-features --lib
cargo run --release --no-default-features --bin absolutesample-cli -- run \
  --url https://youtu.be/nRKgT3d6xoE --start 30 --end 45 --out ../../../test-output
```

The `tauri-app` cargo feature (default on) gates everything that needs the Tauri runtime. The CLI and
unit tests build with `--no-default-features` so they only need ffmpeg and a linker.

## Pipeline

1. **Fetch**: `yt-dlp -f bestaudio` saves `source.<ext>` untouched; ffprobe reads metadata; a `source.wav`
   decode is produced for the browser waveform.
2. **Trim**: `ffmpeg -ss S -to E -c copy` cuts the loop at packet granularity with zero re-encode, then
   decodes `loop.wav` for the DSP stage.
3. **Stems**: one ffmpeg `filter_complex` run. Each crossover is a Linkwitz-Riley 4th order filter
   (two cascaded Q=0.7071 Butterworth 2nd-order sections).
   * `01_drums_sub`   LP 130 Hz
   * `02_bass_lowmid` HP 130 Hz → LP 800 Hz
   * `03_mid_vocals`  HP 800 Hz → LP 4.5 kHz → Mid channel (L+R)/2, which cancels side-panned instruments
   * `04_highs_air`   HP 4.5 kHz → `stereotools` mid down / side up for width
   Outputs are 44.1 kHz 24-bit PCM. Peak and RMS come from `astats`.
4. **Analyze** (pure Rust): mono 22.05 kHz decode, log-energy onset envelope (1024/256), half-wave
   rectified flux, peak picking with a 50 ms gap, autocorrelation tempo search 60–200 BPM with
   parabolic refinement and octave disambiguation, and a beat grid anchored on the strongest onset.

Work files live under `%LOCALAPPDATA%/AbsoluteSample/work/<video id>/`.

## Test

```bash
./test-seed.sh
```

Builds the CLI, runs the Rust unit tests, executes the seed pipeline on `https://youtu.be/nRKgT3d6xoE`
(0:30–0:45) and asserts that all four stem WAVs exist, are non-empty, decode with zero ffmpeg errors,
match the expected duration, and carry signal.
