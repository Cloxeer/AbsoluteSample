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
}

export interface LoopInfo {
  trackId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  loopPath: string;
  wavPath: string;
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
}

export type EnginePassStage = "python" | "venv" | "torch" | "separator" | "verify";

export interface EngineProgressPayload {
  stage: EnginePassStage;
  percent: number;
  message: string;
}
