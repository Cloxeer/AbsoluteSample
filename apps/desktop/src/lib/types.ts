export interface DependencyReport {
  ffmpeg: string | null;
  ffprobe: string | null;
  ytdlp: string | null;
  ok: boolean;
}

export type SourceKind = "local" | "youtube";

export interface TrackInfo {
  id: string;
  title: string;
  url: string;
  sourcePath: string;
  wavPath: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  codec: string;
  workDir: string;
  peaks?: number[];
  sourceKind?: SourceKind;
}

export interface LoopInfo {
  trackId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  loopPath: string;
  wavPath: string;
  peaks?: number[];
}

export type StemKey = "drums_sub" | "bass_lowmid" | "mid_vocals" | "highs_air";

export interface StemInfo {
  index: 1 | 2 | 3 | 4;
  key: StemKey;
  label: string;
  band: string;
  path: string;
  bytes: number;
  peakDb: number;
  rmsDb: number;
  peaks?: number[];
  durationSec?: number;
}

export interface KeyDetection {
  tonic: string;
  mode: "major" | "minor";
  confidence: number;
  camelot: string;
}

export interface LoopAnalysis {
  bpm: number;
  confidence: number;
  transients: number[];
  beatGrid: number[];
  bars: number;
  onsetEnvelope: number[];
  peakDb: number;
  rmsDb: number;
  key?: KeyDetection;
}

export interface SliceInfo {
  index: number;
  startSec: number;
  endSec: number;
  path: string;
}

export type ProgressStage = "download" | "decode" | "trim" | "stems" | "analyze" | "slice" | "separate";

export interface ProgressPayload {
  stage: ProgressStage;
  percent: number;
  message: string;
  pass?: string;
  failed?: boolean;
  trackId?: string;
  startedAt?: string;
  elapsedSec?: number;
  passSeconds?: Record<string, number>;
}

// v2 addendum: AI instrument separation engine

export interface EngineStatus {
  installed: boolean;
  pythonFound: boolean;
  pythonPath: string | null;
  venvPath: string | null;
  torchVersion: string | null;
  cuda: boolean;
  gpuName: string | null;
  modelsPresent: string[];
  enginePath: string;
  busy?: boolean;
  busyTrackId?: string | null;
}

export type InstrumentGroup = "vocals" | "drums" | "bass" | "guitar" | "keys" | "other";

export interface InstrumentStem {
  key: string;
  label: string;
  group: InstrumentGroup;
  parent: string | null;
  path: string;
  bytes: number;
  peakDb: number;
  rmsDb: number;
  model: string;
  order: number;
  peaks?: number[];
  durationSec?: number;
  tags?: { label: string; score: number }[];
  soundsLike?: string | null;
  displayLabel?: string;
  detections?: { label: string; score: number }[];
  confidence?: { score: number; reasons: string[] };
}

export interface InstrumentsResult {
  stems: InstrumentStem[];
  elapsedSec: number;
  passSeconds: Record<string, number>;
  device: string;
  failedPasses: string[];
}

export type EnginePassStage = "python" | "venv" | "torch" | "separator" | "verify";

export interface EngineProgressPayload {
  stage: EnginePassStage;
  percent: number;
  message: string;
}

// v3 addendum: Song library

export interface LibraryEntry {
  id: string;
  title: string;
  url: string;
  durationSec: number;
  fetchedAt: string;
  lastOpenedAt: string;
  kept: boolean;
  hasLoop: boolean;
  loopStartSec: number | null;
  loopEndSec: number | null;
  hasBands: boolean;
  hasInstruments: boolean;
  instrumentCount: number;
  bytes: number;
  hasKaraoke?: boolean;
}

export interface TrackSession {
  track: TrackInfo;
  loop: LoopInfo | null;
  stems: StemInfo[] | null;
  instruments: InstrumentStem[] | null;
  analysis: LoopAnalysis | null;
  instrumentsMeta?: Omit<InstrumentsResult, "stems"> | null;
}

// v5 addendum: per-song jobs

export interface Job {
  trackId: string;
  stage: string;
  pass?: string;
  percent: number;
  message: string;
  startedAt: string;
  elapsedSec: number;
  passSeconds?: Record<string, number>;
}

// v4 addendum: scans vs kept songs, and samples

export type SampleKind = "stem" | "region" | "hit";

export interface Sample {
  id: string;
  name: string;
  path: string;
  bytes: number;
  songId: string;
  songTitle: string;
  stemKey: string;
  stemLabel: string;
  group: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  bpm: number | null;
  createdAt: string;
  peaks?: number[];
  kind?: SampleKind;
  keyShort?: string | null;
  bars?: number | null;
}

export interface LibrarySize {
  bytes: number;
  tracks: number;
  scans: number;
  samplesBytes: number;
  trashBytes?: number;
}

// v6 addendum

export type RegionSnap = "none" | "beat" | "bar";

export interface RegionParams {
  startSec: number;
  endSec: number;
  snap: RegionSnap;
  fadeMs?: number;
  trimLeadingSilence?: boolean;
}

export interface CutRegionResult {
  path: string;
  startSec: number;
  endSec: number;
  bars: number | null;
  peaks: number[];
  durationSec: number;
}

// Highlight-a-saved-sample addendum: cutting/saving a part of an already-saved sample.

export type CutSampleResult = CutRegionResult;

export interface TrashEntry {
  id: string;
  kind: "track" | "sample";
  name: string;
  deletedAt: string;
  bytes: number;
}

// v6 addendum: Notes (replaces Loop & Beat Matrix)

export interface NoteEvent {
  startSec: number;
  endSec: number;
  midi: number;
  name: string;
  velocity: number;
}

export interface ChordEvent {
  startSec: number;
  endSec: number;
  name: string;
  notes: string[];
}

export interface NotesKey {
  tonic: string;
  mode: "major" | "minor";
  confidence: number;
}

export interface DrumLane {
  key: string;
  label: string;
  hits: number[];
}

export interface DrumResult {
  bpm: number;
  steps: number;
  lanes: DrumLane[];
}

export interface NotesResult {
  notes: NoteEvent[];
  key: NotesKey | null;
  chords: ChordEvent[];
  scale: string[];
  bpm: number | null;
  midPath: string;
  elapsedSec: number;
  drum?: DrumResult;
}

// v7 addendum: Karaoke, Frequencies, Autotune

export interface KaraokeResult {
  stems: InstrumentStem[];
  elapsedSec: number;
  device: string;
}

export interface SpectrumPoint {
  hz: number;
  db: number;
}

export interface FrequencyBand {
  key: string;
  name: string;
  lowHz: number;
  highHz: number;
  db: number;
  sharePct: number;
}

export interface FrequencyNoteStat {
  name: string;
  cents: number;
  count: number;
}

export interface FrequencyTuning {
  referenceHz: number;
  avgCentsOff: number;
  inTunePct: number;
  estimatedRefHz: number;
  perNote?: FrequencyNoteStat[];
}

export interface FrequencyResult {
  spectrum: SpectrumPoint[];
  bands: FrequencyBand[];
  tuning: FrequencyTuning;
  key: KeyDetection | null;
  durationSec: number;
}

export interface PitchPoint {
  t: number;
  hz: number;
  midi: number;
  cents: number;
  voiced: boolean;
}

export interface PitchNote {
  startSec: number;
  endSec: number;
  midi: number;
  cents: number;
  confidence: number;
}

export interface PitchResult {
  sampleRate: number;
  hopSec: number;
  f0: PitchPoint[];
  notes: PitchNote[];
  key: NotesKey | null;
  /** Path to the cached pitch analysis (<stem>.pitch.json); pass to applyAutotune to skip CREPE on preview renders. */
  cachePath: string;
  /** Perf metrics from the engine's final "metrics" line, when available. */
  seconds?: number;
  peakRssMb?: number;
}

export interface AutotuneNoteEdit {
  startSec: number;
  endSec: number;
  targetMidi: number;
  /** The note's detected (float) MIDI pitch; the engine shifts the whole note by targetMidi - sourceMidi. */
  sourceMidi?: number;
}

export interface AutotuneEdits {
  snapStrength: number;
  scale: number[] | null;
  transitionMs: number;
  notes: AutotuneNoteEdit[];
}

export interface AutotuneResult {
  path: string;
  peaks: number[];
  durationSec: number;
  /** Perf metrics from the engine's final "metrics" line, when available. */
  seconds?: number;
  peakRssMb?: number;
}

// v8 addendum: fast region preview + perf metrics

/** Args accepted by applyAutotune; the region/cache fields enable a fast, cached-pitch, region-only render. */
export interface ApplyAutotuneArgs {
  path: string;
  edits: AutotuneEdits;
  /** Render only this slice of the source (seconds); omit for a full-file render. */
  regionStartSec?: number;
  regionEndSec?: number;
  /** Cached pitch analysis path (PitchResult.cachePath) to skip CREPE on preview renders. */
  pitchCachePath?: string;
}
