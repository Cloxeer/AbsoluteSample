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
  band: string;              // "LP 130 Hz (LR8)" etc.
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
Linkwitz-Riley 8th order = four cascaded 2nd-order Butterworth (Q=0.7071):
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

---

# v2 addendum: AI instrument separation engine (authoritative)

## Engine location
`%LOCALAPPDATA%/AbsoluteSample/engine/` holds `venv/` (Python 3.12 virtualenv), `models/` (downloaded weights),
and `separate.py` (the Rust binary embeds repo `engine/separate.py` via `include_str!` and writes it there before every run).

## Python script protocol
`<engine>/venv/Scripts/python.exe <engine>/separate.py --input <loop.wav> --out <workdir>/instruments --passes instruments,vocals,lead,drums --models-dir <engine>/models --device auto`
stdout JSON lines: `device {device,gpu}`, `progress {pass,percent,message}` (percent -1 = indeterminate), `pass_done {pass,seconds}`,
`pass_failed {pass,error}` (chain continues), `done {stems:[{key,label,group,parent,path,model,order}],device}`, `fatal {error}` (exit 1).
Passes: instruments (Demucs htdemucs_6s, always), vocals (BS-Roformer ensemble), lead (lead/backing vocals), drums (kick/snare/toms/hihat/ride/crash).

## Python discovery (engine_install)
Order: env `ABSOLUTESAMPLE_PYTHON`; `py -3.12`; `py -0` listing any tag containing `3.12` (e.g. `-V:Astral\CPython3.12.14`, run as `py -V:<tag>`); `python3.12`/`python` on PATH whose `--version` starts with 3.12; else error "Python 3.12 not found" with an install hint (`winget install Python.Python.3.12`).
Install steps (emit "engine://progress" {stage:'python'|'venv'|'torch'|'separator'|'verify', percent, message}):
1. `<python> -m venv <engine>/venv`
2. `<venv>/Scripts/python.exe -m pip install --upgrade pip`
3. `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124`
4. `pip install "audio-separator[gpu]" soundfile`
5. verify: `python -c "import torch,audio_separator,soundfile;print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"`
Stream pip stdout lines as progress messages (percent -1). Long running: tens of minutes on first install; must run on a blocking thread.

## New Tauri commands / types (camelCase JSON)
```ts
interface EngineStatus { installed: boolean; pythonFound: boolean; pythonPath: string|null; venvPath: string|null;
  torchVersion: string|null; cuda: boolean; gpuName: string|null; modelsPresent: string[]; enginePath: string; }
// engine_status() -> EngineStatus     never throws; installed = venv python exists AND verify import succeeds (cache result 60s)
// engine_install() -> EngineStatus    long-running, progress on "engine://progress"
// separate_instruments({ trackId, passes?: string[] }) -> InstrumentStem[]
//   emits "pipeline://progress" { stage:'separate', pass:string, percent:number, message:string, failed?:boolean }
interface InstrumentStem { key: string; label: string; group: 'vocals'|'drums'|'bass'|'guitar'|'keys'|'other';
  parent: string|null; path: string; bytes: number; peakDb: number; rmsDb: number; model: string; order: number; }
// Output: <workdir>/instruments/<key>.wav; manifest <workdir>/instruments.json ({stems, device, failedPasses:[{pass,error}]}).
// peakDb/rmsDb via ffmpeg astats as for the band stems.
// The 4-band split stays available as separate_stems (UI label "Quick EQ bands").
```

## CLI
`absolutesample-cli engine status|install`, `absolutesample-cli instruments --track <id> [--passes a,b]`,
`run --engine ai|bands` (default bands) runs the full chain; with `ai` the manifest gains `instruments: InstrumentStem[]` and `engine: EngineStatus`.

## Frontend fixtures
Mock backend serves `/fixtures/instruments/<key>.wav` listed in `/fixtures/manifest.json` `instruments`.

## Home directory (overrides earlier %LOCALAPPDATA% paths, v2)
All app data lives under `ABSOLUTESAMPLE_HOME` env if set, else `%USERPROFILE%\.absolutesample\`:
`work\<track_id>\...` (was %LOCALAPPDATA%/AbsoluteSample/work) and `engine\` (venv, models, separate.py).
Reason: `%LOCALAPPDATA%` is filesystem-virtualized for processes started from packaged (MSIX) apps, so files written there
are invisible to the same program launched normally. `tauri.conf.json` assetProtocol scope must include `$HOME/.absolutesample/**`
(keep the old entries too).

---

# v3 addendum: Song library (keep going through songs)

Every fetched track keeps its work dir `~/.absolutesample/work/<id>/` and gets `track.json` (TrackInfo) written at fetch,
plus `state.json`: `{ kept: bool, fetchedAt: rfc3339, lastOpenedAt: rfc3339, loop?: LoopInfo, analysis?: LoopAnalysis }`.
`loop` is written by trim_loop, `analysis` by analyze_loop. Band stems live in `stems/`, AI stems in `instruments/` + `instruments.json` (already).

Keep rule (no bloat): `kept` becomes true automatically when a split completes (separate_stems or separate_instruments) or a save/export
happens (save_stem, save_all_stems), or when the user toggles Keep. `fetch_audio` first calls `prune_unkept(except: new id)` which deletes work dirs
that are not kept AND have no split output; it never deletes the track being fetched. Re-fetching an id that already exists returns the cached
TrackInfo without downloading (unless `force: true`).

URL normalization: extract the 11-char video id from youtu.be/<id>, youtube.com/watch?v=<id>, /shorts/<id>, /embed/<id>; ignore list/si/start_radio params;
pass `--no-playlist`. The work dir id is the video id.

```ts
interface LibraryEntry { id: string; title: string; url: string; durationSec: number; fetchedAt: string; lastOpenedAt: string;
  kept: boolean; hasLoop: boolean; loopStartSec: number|null; loopEndSec: number|null; hasBands: boolean; hasInstruments: boolean;
  instrumentCount: number; bytes: number; }
interface TrackSession { track: TrackInfo; loop: LoopInfo|null; stems: StemInfo[]|null; instruments: InstrumentStem[]|null; analysis: LoopAnalysis|null; }
// list_library() -> LibraryEntry[]  (sorted lastOpenedAt desc)
// open_track({ trackId }) -> TrackSession   (touches lastOpenedAt; rebuilds StemInfo[] from stems/*.wav via astats cache in state.json if present)
// set_kept({ trackId, kept }) -> LibraryEntry
// delete_track({ trackId }) -> void          (removes the work dir)
// library_size() -> { bytes: number, tracks: number }
// fetch_audio({ url, force?: boolean })      (extended)
```
CLI: `library list|open <id>|keep <id> [--off]|delete <id>|size`.

---

# v4 addendum: scans vs kept songs, and samples

## Keep semantics (replaces v3 keep rule)
A fetched/split song is a *scan* by default (`kept: false`). Nothing auto-keeps. Prune (called at the start of every fetch_audio,
except the id being fetched, and never the currently open track passed as `except`): delete unkept songs beyond the 3 most recently opened
(`MAX_SCANS = 3`). `LibraryEntry.kept` is the stored flag only. `delete_track` is explicit and always allowed. Split/export/save no longer mark kept.
`library_size()` also returns `scans: number` (unkept count) and `samplesBytes`.

## Samples
`~/.absolutesample/samples/<sanitized song title>/<sanitized sample name>.wav` and index `~/.absolutesample/samples/samples.json`:
```ts
interface Sample { id: string; name: string; path: string; bytes: number; songId: string; songTitle: string; stemKey: string; stemLabel: string;
  group: string; startSec: number; endSec: number; durationSec: number; bpm: number|null; createdAt: string; }
// save_sample({ trackId, stemKey, name? }) -> Sample    stemKey may be a band stem key (drums_sub...), an instrument key (kick...), or "loop"
//   copies the wav (loop range from state.json; bpm from analysis if present); default name "<song> - <stem> <m:ss-m:ss>"; unique name suffix (2), (3)
// list_samples() -> Sample[] (createdAt desc)
// rename_sample({ id, name }) -> Sample (renames file too)
// delete_sample({ id }) -> void
// export_samples({ ids, destDir }) -> string[]   (copies to a user-chosen folder)
// reveal_sample({ id }) -> void  (open containing folder)
```
CLI: `samples list|save <track> <stemKey> [--name]|delete <id>|export <dir> <ids...>`.

---

# v5 addendum: honesty, tags, peaks, per-song jobs, matrix, samples playback

## Instrument tags (new pass "tag", runs last, never fatal)
separate.py classifies every top-level stem (vocals, drums, bass, guitar, piano, other) with the free AudioSet AST model
(`MIT/ast-finetuned-audioset-10-10-0.4593`, transformers) in 10 s windows, averaging sigmoid scores over non-silent windows.
Each stem gets `tags: [{label, score}]` (top 5, score 0..1) and `soundsLike: string|null` = the best *instrument-family* label when it differs
from the bucket (mapping table in separate.py: e.g. Violin/Viola/Cello/Bowed string instrument/String section -> "Strings"; Synthesizer -> "Synth";
Organ/Electric piano/Harpsichord -> "Keys"; Acoustic guitar/Electric guitar/Banjo -> "Guitar"; Trumpet/Saxophone/Brass -> "Brass/Winds"; Choir -> "Choir").
Protocol: `done.stems[].tags`, `done.stems[].soundsLike`. InstrumentStem gains `tags` and `soundsLike`. UI shows "Guitar" with a muted caption
"sounds like Strings (violin 0.62)" when soundsLike is set; never renames the file.

## Honest timing
Every long command (fetch, trim, separate_stems, separate_instruments, analyze) reports `startedAt` (rfc3339) and `elapsedSec` in its progress
payload (`pipeline://progress` gains `trackId`, `startedAt`, `elapsedSec`, and for separate `passSeconds: {pass: seconds}` as passes complete);
results gain `elapsedSec` (InstrumentStem[] is wrapped: `separate_instruments -> { stems, elapsedSec, passSeconds, device, failedPasses }`;
`instruments.json` stores the same). Frontend shows a live mm:ss timer from `startedAt` while running and the final real durations after.

## Peaks (performance)
Rust computes `peaks: number[]` (1000 points, max-abs per bucket, 0..1) for every wav it produces (source, loop, band stems, instrument stems, samples)
using a fast PCM read (no ffmpeg). Fields: `TrackInfo.peaks`, `LoopInfo.peaks`, `StemInfo.peaks`, `InstrumentStem.peaks`, `Sample.peaks`, plus `durationSec`
everywhere. The frontend passes `peaks` + `duration` to wavesurfer so it does not decode the wav until playback. `fetch_audio` no longer decodes `source.wav`;
`TrackInfo.wavPath` now points at `source.<ext>` (WebView2 plays webm/opus and m4a natively). `loop.wav` is still produced for the DSP.
`analyze_file({ path }) -> LoopAnalysis` analyzes any wav (used for per-stem onsets in the Beat Matrix, cached in `<workdir>/analysis/<stemKey>.json`).

## Per-song jobs
Progress payloads carry `trackId`. Frontend keeps `jobs: Record<trackId, {stage, percent, message, startedAt, elapsedSec}>`; switching songs while a job runs
does not cancel it; the Songs panel shows a spinner + stage on that song's row and the transport shows a small "Processing <title>" chip when the running job
belongs to another song. When a job finishes for a non-current song, refresh the library only.

## Samples playback
Exactly one sample plays at a time (a module-level singleton player); clicking another sample stops the current one. Each sample row shows a peaks waveform
(wavesurfer with `peaks`, height 36) with a playhead; the row hover/highlight spans the full row; the delete confirm renders inline in place of the action buttons.

## Beat Matrix (simple, honest)
Rows = the current song's top-level instrument stems (kit children when expanded) plus any saved samples the user adds with "Add sample row".
Each row's pads come from that row's own onset analysis (`analyze_file` on that wav), lit when an onset falls within a 16th-note window of the pad; pad brightness = onset strength.
Columns = beats of the loop (bars x 4, 16th subdivision toggle). The top transport Play/Pause is the only loop transport: it plays the mix and a column highlight follows
the playhead. Clicking a pad auditions that slice of that stem (stops any other audition; clicking again stops). Nothing loops automatically unless Loop is on.

---

# Implementation note: `TrackSession.instruments` shape (v5 backend)

The v5 addendum leaves the `TrackSession.instruments` shape as an explicit either/or ("either `instruments` becomes
the whole `{ stems, elapsedSec, passSeconds, device, failedPasses }` object, or keep `instruments: InstrumentStem[]`
plus a separate `instrumentsMeta`"). This implementation picked the **second** option:

```ts
interface TrackSession {
  // ...
  instruments: InstrumentStem[] | null;
  instrumentsMeta: { elapsedSec: number; passSeconds: Record<string, number>; device: string;
    failedPasses: { pass: string; error: string }[] } | null;
}
```

Rationale: `instruments` staying a plain array keeps every existing frontend consumer that maps/filters/renders
`session.instruments` as a stem list working unchanged; the new timing/device/failure metadata is additive via the
sibling `instrumentsMeta` field, which is `null` until a track has been AI-separated at least once. `instruments.json`
on disk mirrors the same split: `{ stems, device, failedPasses, elapsedSec, passSeconds }` (all fields at the top
level, since the file has no sibling "session" object to split across). The `separate_instruments` Tauri command
itself returns `{ stems, elapsedSec, passSeconds, device, failedPasses }` (one flat object) since it's a single
just-finished operation's result, not a persisted session snapshot.

---

# v6 addendum: whole-song split, grid-snapped samples, one-shots, local files, notes, trash, honesty

## Split the whole song once (item 1)
`separate_instruments` runs on `source.wav` (decoded 24-bit soxr from source.<ext>, created lazily at split time, kept) instead of `loop.wav`.
Instrument stems therefore cover the full song. The loop/selection is applied afterwards, instantly, by cutting regions out of stems.
`trim_loop` still exists for the source lane and the Quick EQ bands path. `state.json.instrumentsScope: "song"|"loop"` records which was used; old loop-scoped splits keep working.

## Region cut (items 2, 4)
`cut_region({ trackId, stemKey, startSec, endSec, snap: 'none'|'beat'|'bar', fadeMs?: number (default 5), trimLeadingSilence?: boolean })
  -> { path, startSec, endSec, bars: number|null, peaks, durationSec }`
Writes `<workdir>/cuts/<stemKey>_<start>-<end>.wav` (24-bit). Snapping uses the song analysis beat grid (`analyze_file` on source.wav, cached as `analysis/source.json`).
`save_sample` accepts an optional `{ startSec, endSec, snap, fadeMs, trimLeadingSilence }` and cuts via cut_region instead of copying the whole stem.

## Key detection and naming (item 3)
`analyze_file` result gains `key: { tonic: 'G', mode: 'major'|'minor', confidence: number, camelot: string }` (Krumhansl-Schmuckler on a chroma from ffmpeg-decoded mono; pure Rust).
Default sample name: `<song> - <stem label> - <bpm>bpm - <key short e.g. Gm> - <n>bars` (bars omitted when not grid-snapped). Sample gains `keyShort`, `bars`.

## One-shots (item 5)
`slice_hits({ trackId, stemKey, minGapMs?: 60, maxHits?: 64 }) -> Sample[]` writes one wav per onset (from onset to next onset or 1 s max, 5 ms fades, leading silence trimmed) into
`~/.absolutesample/samples/<song>/<stem> hits/NN.wav` and registers each in samples.json with `kind: 'hit'`. Sample gains `kind: 'stem'|'region'|'hit'`.

## Drag out (item 6)
Frontend uses Tauri's drag plugin (`@crabnebula/tauri-plugin-drag`, free, MIT) to drag a sample's file path to any app. Rust registers `tauri_plugin_drag`; capability `drag:default`.
Samples panel rows are draggable; the whole file (not a copy) is offered.

## GPU busy and low priority (item 8)
`engine_status()` gains `busy: boolean` and `busyTrackId`; `separate_instruments` takes `lowPriority?: boolean` which starts the Python child with BELOW_NORMAL_PRIORITY_CLASS
(and passes `--low-priority`, which the script uses to call `torch.set_num_threads(max(1, cpu//2))` and set CUDA to a lower-priority stream when available). Only one split runs at a time; a second request returns Err("engine busy").

## Storage (item 9)
`library_size()` already returns bytes/samplesBytes/trashBytes (new). `clear_scans()` deletes every unkept song; `empty_trash()`.

## Local files first (item 10)
`import_local({ path }) -> TrackInfo` accepts wav/flac/mp3/m4a/aiff/ogg: id = "local-" + 12 hex of sha1(path+size+mtime); copies the original into `work/<id>/source.<ext>`
(no re-encode), probes it, writes track.json/state.json, `sourceKind: 'local'|'youtube'` on TrackInfo. Tauri `dragDropEnabled` window option on; frontend listens to `tauri://drag-drop`.

## Stem confidence (item 12)
InstrumentStem gains `confidence: { score: 0..1, reasons: string[] }` computed in separate.py: score from the strongest family tag (0.5 weight), inverse of leakage estimate
(energy of the stem that is also present in "other" via band-limited correlation, 0.3 weight), and family agreement with the bucket (0.2 weight). Reasons are short strings like "strong Cello tag", "some leakage into Other".

## Trash (item 13)
`delete_track` and `delete_sample` move to `~/.absolutesample/trash/<yyyymmdd-hhmmss>-<id>/` with a `meta.json` (kind, original paths, deletedAt). `list_trash() -> TrashEntry[]`,
`restore_trash({ id })`, `empty_trash()`. Purge entries older than 7 days on app start (`prune_trash`). "Undo" toast in the UI for 8 s after a delete calls restore_trash.

## Instrument naming (from the last review)
separate.py: `displayLabel` per stem = the strongest family when it beats the bucket family by 1.3x and >= 0.06 (e.g. "Strings"), else the bucket label. If two families are within 25% of each other and both >= 0.08: "Guitar + Strings". `detections: [{label, score}]` = top 5 instrument-level tags (never generic), shown under the track like the kit list.
`--low-priority` flag as above.

## Notes (replaces Loop & Beat Matrix)
`engine/notes.py --input <wav> --out <dir>` uses Basic Pitch (free, local) to write `notes.mid` and `notes.json`: `{ notes: [{startSec, endSec, midi, name, velocity}], key: {tonic, mode, confidence}, chords: [{startSec, endSec, name, notes:[...]}], bpm?: number }`.
Chords: per beat (from analysis bpm) take the sounding pitch classes and match major/minor/7th templates. Rust: `extract_notes({ path }) -> NotesResult` (cached next to the wav as `<name>.notes.json`), `export_midi({ path, destPath })`.
Frontend "Notes" tab: BPM + confidence with info buttons, source picker (any stem, any saved sample), piano roll (SVG, 12 rows per octave, 4 octaves visible, scrollable), key + scale notes, chord strip in time with the transport, and a kid-level explanation block ("This song is in G major. Its home note is G. It mostly uses these 7 notes: ..."). Export MIDI button.

## UI rules (apply everywhere)
No solo/mute on instrument tracks. Lane drag-select on every waveform (source and instruments) with In/Out flags; the lane keeps its own cursor (local audition position) and the master playhead crosses all lanes. Info "?" on PK, RMS, BPM, Key, Confidence with one-sentence plain explanations. Playhead is drawn at `time - outputLatency` (AudioContext.outputLatency || baseLatency). Local file drop zone is the primary hero input; YouTube URL is a small secondary control. Transport shows storage used and a GPU busy chip. Low priority is a small toggle in the engine card.
