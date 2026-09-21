import { isTauri, mediaUrl } from "./mediaUrl";
import * as mock from "./backend.mock";
import type {
  DependencyReport,
  EngineStatus,
  InstrumentStem,
  LibraryEntry,
  LoopAnalysis,
  LoopInfo,
  SliceInfo,
  StemInfo,
  StemKey,
  TrackInfo,
  TrackSession,
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

  async fetchAudio(args: { url: string; force?: boolean }): Promise<TrackInfo> {
    if (isTauri()) return invokeTauri<TrackInfo>("fetch_audio", args);
    return mock.fetchAudio(args);
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

  async engineStatus(): Promise<EngineStatus> {
    if (isTauri()) return invokeTauri<EngineStatus>("engine_status");
    return mock.engineStatus();
  },

  async engineInstall(): Promise<EngineStatus> {
    if (isTauri()) return invokeTauri<EngineStatus>("engine_install");
    return mock.engineInstall();
  },

  async separateInstruments(args: { trackId: string; passes?: string[] }): Promise<InstrumentStem[]> {
    if (isTauri()) return invokeTauri<InstrumentStem[]>("separate_instruments", args);
    return mock.separateInstruments(args);
  },

  async listLibrary(): Promise<LibraryEntry[]> {
    if (isTauri()) return invokeTauri<LibraryEntry[]>("list_library");
    return mock.listLibrary();
  },

  async openTrack(trackId: string): Promise<TrackSession> {
    if (isTauri()) return invokeTauri<TrackSession>("open_track", { trackId });
    return mock.openTrack(trackId);
  },

  async setKept(trackId: string, kept: boolean): Promise<LibraryEntry> {
    if (isTauri()) return invokeTauri<LibraryEntry>("set_kept", { trackId, kept });
    return mock.setKept(trackId, kept);
  },

  async deleteTrack(trackId: string): Promise<void> {
    if (isTauri()) return invokeTauri<void>("delete_track", { trackId });
    return mock.deleteTrack(trackId);
  },

  async librarySize(): Promise<{ bytes: number; tracks: number }> {
    if (isTauri()) return invokeTauri<{ bytes: number; tracks: number }>("library_size");
    return mock.librarySize();
  },
};

export type Backend = typeof backend;
