export interface DependencyReport {
  ffmpeg: string | null;
  ffprobe: string | null;
  ytdlp: string | null;
  ok: boolean;
}

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

export interface LoopAnalysis {
  bpm: number;
  confidence: number;
  transients: number[];
  beatGrid: number[];
  bars: number;
  onsetEnvelope: number[];
  peakDb: number;
  rmsDb: number;
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
}

export interface LibrarySize {
  bytes: number;
  tracks: number;
  scans: number;
  samplesBytes: number;
}
