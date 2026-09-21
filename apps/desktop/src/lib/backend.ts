import { isTauri, mediaUrl } from "./mediaUrl";
import * as mock from "./backend.mock";
import type {
  DependencyReport,
  LoopAnalysis,
  LoopInfo,
  SliceInfo,
  StemInfo,
  StemKey,
  TrackInfo,
} from "./types";

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const backend = {
  async checkDependencies(): Promise<DependencyReport> {
    if (isTauri()) return invokeTauri<DependencyReport>("check_dependencies");
    return mock.checkDependencies();
  },

  async fetchAudio(url: string): Promise<TrackInfo> {
    if (isTauri()) return invokeTauri<TrackInfo>("fetch_audio", { url });
    return mock.fetchAudio(url);
  },

  async trimLoop(args: { trackId: string; startSec: number; endSec: number }): Promise<LoopInfo> {
    if (isTauri()) return invokeTauri<LoopInfo>("trim_loop", args);
    return mock.trimLoop(args);
  },

  async separateStems(args: { trackId: string }): Promise<StemInfo[]> {
    if (isTauri()) return invokeTauri<StemInfo[]>("separate_stems", args);
    return mock.separateStems(args);
  },

  async analyzeLoop(args: { trackId: string }): Promise<LoopAnalysis> {
    if (isTauri()) return invokeTauri<LoopAnalysis>("analyze_loop", args);
    return mock.analyzeLoop(args);
  },

  async saveStem(args: { srcPath: string; destPath: string }): Promise<string> {
    if (isTauri()) return invokeTauri<string>("save_stem", args);
    return mock.saveStem(args);
  },

  async saveAllStems(args: { trackId: string; destDir: string }): Promise<string[]> {
    if (isTauri()) return invokeTauri<string[]>("save_all_stems", args);
    return mock.saveAllStems(args);
  },

  async openWorkDir(args: { trackId: string }): Promise<void> {
    if (isTauri()) return invokeTauri<void>("open_work_dir", args);
    return mock.openWorkDir(args);
  },

  async sliceBeats(args: { trackId: string; stemKey: StemKey | null; bpm: number; divisions: number }): Promise<SliceInfo[]> {
    if (isTauri()) return invokeTauri<SliceInfo[]>("slice_beats", args);
    return mock.sliceBeats(args);
  },

  async resolveWavUrl(path: string): Promise<string> {
    if (isTauri()) return mediaUrl(path);
    return mock.resolveWav(path);
  },
};

export type Backend = typeof backend;
