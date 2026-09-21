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

## AI instrument separation (free, local)

"Split" runs four open-source models on your GPU (or CPU), chained so each pass refines the last:

| Pass | Model | Output |
|---|---|---|
| Instruments | Demucs v4 `htdemucs_6s` | vocals, drums, bass, guitar, piano, other |
| Vocals refine | BS-Roformer (viperx, SDR 12.97) | ensembled with the Demucs vocals; what leaves the vocals goes back into "other" so the stems still sum to the mix |
| Lead and backing | Mel-Band Roformer karaoke | lead vocals, backing vocals |
| Drum kit | MDX23C DrumSep | kick, snare, toms, hi-hat, ride, crash |
| Tags | AudioSet AST classifier | what each stem actually sounds like; a stem labelled Guitar that scores Cello and Bowed string higher is shown as "sounds like Strings" |

The engine is a Python 3.12 virtualenv the app installs on first use into `~/.absolutesample/engine`
(PyTorch CUDA plus `audio-separator`, about 4.5 GB; model weights about 1.5 GB download once).
Click "Install engine" in the app or run:

```bash
apps/desktop/src-tauri/target/release/absolutesample-cli.exe engine install
```

Timings on an RTX 2070 Super: a 15 s loop in about 20 s, a full 3 minute song in about 2.5 minutes.
The old crossover splitter is still available as "Quick EQ bands".

## What changed in v6

- Drop a WAV, FLAC or MP3 first; YouTube is the small secondary input. Local files give the models cleaner input than YouTube's 130 kbps Opus.
- Split runs once on the whole song. Selections are cut afterwards from the already separated stems, instantly, snapped to bar or beat, with 5 ms fades and leading silence trimmed.
- Tracks are named by what they sound like ("Strings", "Synth", "Accordion") with the detected instruments listed under the name and a confidence score explained on hover. Silent stems are collapsed, never dropped.
- Samples: drag-select on any lane, "Save selection as sample", "Download selection", "Slice into hits" (one-shots from onsets). Names carry BPM, key and bars. Rows drag straight into other apps. Deletes go to a trash with 7 day retention and an Undo toast.
- The top transport controls whatever is playing (mix, one track, a sample, a pad, the source, the loop); the playhead is corrected for audio output latency.
- Notes tab: MIDI extraction with Basic Pitch, key and camelot, chords in time, a piano roll, plain-words theory, MIDI export.
- Storage chip with Clear scans and Empty trash; GPU busy chip; Low priority toggle for splits.

## Songs, scans and samples

- Every fetched song is a scan. The three most recent scans stay so you can flip between them (Songs panel, B); older unkept scans are deleted when you fetch a new link. Press Keep to hold a song, or delete it yourself.
- Any track, including kit pieces and lead or backing vocals, can be saved as a sample (bookmark icon). Samples live in `~/.absolutesample/samples/<song>/` with their range and BPM and survive the song being pruned. The Samples panel (N) plays one sample at a time with a waveform, renames, reveals, deletes and exports.
- Timers are measured, never estimated: the transport shows elapsed time while a job runs and the real per-pass durations after. Jobs belong to a song, so switching songs never cancels one.
- Waveforms draw from precomputed peaks, so no audio is decoded until you press play.

## Using the stem view

The stem view is laid out like a DAW: track headers on the left, waveform lanes on the right, one shared
playhead. There are two ways to listen, and the transport chip tells you which one is active:

- **Play mix** (the big transport button, or Space) plays all four stems together with your Solo/Mute and
  fader settings. Since the four bands are complementary crossovers, the unaltered mix sounds like the
  original loop. That is expected.
- **Play <stem> only** (the play button in a track header, or keys 1 to 4) auditions a single stem and
  pauses everything else. Use this to hear what each band actually contains.

Toggle buttons fill with colour when active: Solo is amber, Mute is red (the lane dims and shows MUTED),
Loop is cyan. Esc stops, L toggles loop, ? in the transport lists the shortcuts.

## Pipeline

1. **Fetch**: `yt-dlp -f bestaudio` saves `source.<ext>` untouched; ffprobe reads metadata; a `source.wav`
   decode is produced for the browser waveform.
2. **Trim**: `ffmpeg -ss S -to E -c copy` cuts the loop at packet granularity with zero re-encode, then
   decodes `loop.wav` for the DSP stage.
3. **Stems**: one ffmpeg `filter_complex` run. Each crossover is a Linkwitz-Riley 8th order filter (48 dB/oct)
   (four cascaded Q=0.7071 Butterworth 2nd-order sections).
   * `01_drums_sub`   LP 130 Hz
   * `02_bass_lowmid` HP 130 Hz → LP 800 Hz
   * `03_mid_vocals`  HP 800 Hz → LP 4.5 kHz → Mid channel (L+R)/2, which cancels side-panned instruments
   * `04_highs_air`   HP 4.5 kHz → `stereotools` mid down / side up for width
   Outputs are 44.1 kHz 24-bit PCM. Peak and RMS come from `astats`.
4. **Analyze** (pure Rust): mono 22.05 kHz decode, log-energy onset envelope (1024/256), half-wave
   rectified flux, peak picking with a 50 ms gap, autocorrelation tempo search 60–200 BPM with
   parabolic refinement and octave disambiguation, and a beat grid anchored on the strongest onset.

Work files live under `~/.absolutesample/work/<video id>/`.

## Test

```bash
./test-seed.sh
```

Builds the CLI, runs the Rust unit tests, executes the seed pipeline on `https://youtu.be/nRKgT3d6xoE`
(0:30–0:45) and asserts that all four stem WAVs exist, are non-empty, decode with zero ffmpeg errors,
match the expected duration, and carry signal.
