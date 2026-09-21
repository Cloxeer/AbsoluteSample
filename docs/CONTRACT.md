# AbsoluteSample — Frontend/Backend Contract (authoritative)

Monorepo root: `absolutesample/` == `C:/Users/sebastian/Desktop/Coding/Tools/AbsoluteSample`
App: `apps/desktop` (Vite 5 + React 18 + TypeScript + Tailwind 3 + Tauri v2). Package manager: pnpm.
Windows host. ffmpeg/ffprobe 8.x on PATH. yt-dlp on PATH (or `YTDLP_PATH` env override). No aubio: BPM/transients are pure Rust.

## Workspace dir
`%LOCALAPPDATA%/AbsoluteSample/work/<track_id>/` holds:
- `source.<ext>`   original yt-dlp bestaudio download (webm/opus or m4a), never re-encoded
- `source.wav`     16-bit 44.1k stereo PCM decode of source (for browser waveform playback)
- `loop.<ext>`     zero-re-encode `-c copy` trim of source
- `loop.wav`       PCM decode of loop (input to DSP)
- `stems/01_drums_sub.wav`, `stems/02_bass_lowmid.wav`, `stems/03_mid_vocals.wav`, `stems/04_highs_air.wav`
- `analysis.json`

## Tauri commands (snake_case in Rust, invoked from TS with identical names; all args camelCase on TS side, Tauri v2 auto-maps to snake_case)

```ts
// check_dependencies()
interface DependencyReport { ffmpeg: string|null; ffprobe: string|null; ytdlp: string|null; ok: boolean; }

// fetch_audio({ url }) — runs yt-dlp -f bestaudio, then ffprobe, then decodes source.wav. Emits progress events (see below).
interface TrackInfo {
  id: string;            // yt-dlp video id (sanitized) or sha1(url) fallback
  title: string;
  url: string;
  sourcePath: string;    // absolute path to source.<ext>
  wavPath: string;       // absolute path to source.wav
  durationSec: number;
  sampleRate: number;
  channels: number;
  codec: string;         // e.g. "opus"
  workDir: string;
}

// trim_loop({ trackId, startSec, endSec }) — ffmpeg -ss/-to -c copy on source.<ext>, then decodes loop.wav
interface LoopInfo {
  trackId: string;
  startSec: number; endSec: number; durationSec: number;
  loopPath: string;   // loop.<ext> (copy-trimmed)
  wavPath: string;    // loop.wav
}

// separate_stems({ trackId }) — one ffmpeg filter_complex run over loop.wav -> 4 wavs (44.1k, 24-bit pcm_s24le, stereo)
interface StemInfo {
  index: 1|2|3|4;
  key: 'drums_sub'|'bass_lowmid'|'mid_vocals'|'highs_air';
  label: string;             // "Drums / Sub" etc.
  band: string;              // "LP 130 Hz (LR4)" etc.
  path: string;              // absolute wav path
  bytes: number;
  peakDb: number; rmsDb: number;   // from ffmpeg astats
}

// analyze_loop({ trackId }) — pure-Rust onset/BPM on loop.wav (decoded via ffmpeg to f32le mono 22050)
interface LoopAnalysis {
  bpm: number;                 // 60..200, 1 decimal
  confidence: number;          // 0..1
  transients: number[];        // onset times in seconds (relative to loop start)
  beatGrid: number[];          // beat times in seconds from first strong onset at 60/bpm spacing
  bars: number;                // floor(duration / (4*60/bpm))
  onsetEnvelope: number[];     // normalized 0..1, ~ 86 frames/sec (hop 256 @ 22050), for UI plotting
  peakDb: number; rmsDb: number;
}

// save_stem({ srcPath, destPath }) -> destPath (copies wav; frontend picks destPath with @tauri-apps/plugin-dialog save())
// save_all_stems({ trackId, destDir }) -> string[] (dest paths)
// open_work_dir({ trackId }) -> void  (opens explorer)
// slice_beats({ trackId, stemKey|null, bpm, divisions }) -> SliceInfo[]  — chops loop.wav (or a stem) into `divisions` equal slices per bar on the beat grid: files stems/slices/<key>_slice_NN.wav
interface SliceInfo { index: number; startSec: number; endSec: number; path: string; }
```

Errors: every command returns `Result<T, String>` with a human-readable message (include the failing ffmpeg/yt-dlp stderr tail).

Progress: backend emits Tauri event `"pipeline://progress"` with payload `{ stage: 'download'|'decode'|'trim'|'stems'|'analyze'|'slice', percent: number (0-100), message: string }`.

## Playback URLs
Frontend loads wavs into Wavesurfer via `convertFileSrc(path)` from `@tauri-apps/api/core`. `tauri.conf.json` must enable `app.security.assetProtocol.enable=true` with scope `["$APPLOCALDATA/**", "$LOCALDATA/AbsoluteSample/**"]` and CSP allowing `asset:` and `http://asset.localhost` for media-src/connect-src.

## Dev without Tauri (browser preview)
`src/lib/backend.ts` exports the typed API. If `window.__TAURI_INTERNALS__` is absent it uses `src/lib/backend.mock.ts`, which serves fixture data from `/public/fixtures/` (produced by the CLI seed run: `manifest.json` + wavs). Real Tauri path uses `invoke`.

## DSP spec (ffmpeg filter graph, single pass)
Linkwitz-Riley 4th order = two cascaded 2nd-order Butterworth (Q=0.7071):
- LP(f): `lowpass=f=F:p=2:t=q:w=0.7071,lowpass=f=F:p=2:t=q:w=0.7071`
- HP(f): `highpass=f=F:p=2:t=q:w=0.7071,highpass=f=F:p=2:t=q:w=0.7071`
- Stem1 drums_sub  : LP(130)
- Stem2 bass_lowmid: HP(130),LP(800)
- Stem3 mid_vocals : HP(800),LP(4500), then mid extraction  `pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1`
- Stem4 highs_air  : HP(4500), then side/width emphasis `stereotools=mlev=0.6:slev=1.6` (mid level down, side level up)
Graph: `[0:a]asplit=4[a][b][c][d]; [a]LP130[s1]; [b]HP130,LP800[s2]; [c]HP800,LP4500,pan..[s3]; [d]HP4500,stereotools..[s4]` mapped to 4 outputs `-c:a pcm_s24le -ar 44100`.

## BPM algorithm (Rust, no deps beyond std)
1. decode mono f32 22050 via ffmpeg stdout.
2. frames of 1024 with hop 256: energy = sum(x^2); log-compress; onset = max(0, e[n]-e[n-1]) (half-wave rectified difference); smooth with 3-tap.
3. transient peaks: local max above mean+1.0*std with min gap 50 ms.
4. tempo: autocorrelation of onset envelope for lags 60..200 BPM; pick max, refine with parabolic interp; check half/double ambiguity preferring 80-160 range. confidence = peak / sum-normalized.
5. beat grid: anchor at strongest transient, step 60/bpm, extend both directions across loop.

## CLI (for tests)
`cargo run --bin absolutesample-cli -- run --url <url> --start 30 --end 45 --out <dir>` performs fetch→trim→stems→analyze and writes `manifest.json` (`{track, loop, stems, analysis}`) into `<dir>`; exit non-zero on any failure. Subcommands: `deps`, `fetch`, `trim`, `stems`, `analyze`, `run`.
