import { isTauri, mediaUrl } from "./mediaUrl";
import * as mock from "./backend.mock";
import type {
  AutotuneEdits,
  AutotuneResult,
  CutRegionResult,
  CutSampleResult,
  DependencyReport,
  EngineStatus,
  FrequencyResult,
  InstrumentsResult,
  KaraokeResult,
  LibraryEntry,
  LibrarySize,
  LoopAnalysis,
  LoopInfo,
  NotesResult,
  PitchResult,
  RegionParams,
  Sample,
  SliceInfo,
  StemInfo,
  StemKey,
  TrackInfo,
  TrackSession,
  TrashEntry,
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

  async fetchAudio(args: { url: string; force?: boolean; currentTrackId?: string }): Promise<TrackInfo> {
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

  async separateInstruments(args: { trackId: string; passes?: string[]; lowPriority?: boolean }): Promise<InstrumentsResult> {
    if (isTauri()) return invokeTauri<InstrumentsResult>("separate_instruments", args);
    return mock.separateInstruments(args);
  },

  async analyzeFile(args: { path: string }): Promise<LoopAnalysis> {
    if (isTauri()) return invokeTauri<LoopAnalysis>("analyze_file", args);
    return mock.analyzeFile(args);
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

  async librarySize(): Promise<LibrarySize> {
    if (isTauri()) return invokeTauri<LibrarySize>("library_size");
    return mock.librarySize();
  },

  async saveSample(args: { trackId: string; stemKey: string; name?: string; region?: RegionParams }): Promise<Sample> {
    if (isTauri()) return invokeTauri<Sample>("save_sample", args);
    return mock.saveSample(args);
  },

  async cutRegion(args: { trackId: string; stemKey: string } & RegionParams): Promise<CutRegionResult> {
    if (isTauri()) return invokeTauri<CutRegionResult>("cut_region", { ...args });
    return mock.cutRegion(args);
  },

  async sliceHits(args: { trackId: string; stemKey: string; minGapMs?: number; maxHits?: number }): Promise<Sample[]> {
    if (isTauri()) return invokeTauri<Sample[]>("slice_hits", args);
    return mock.sliceHits(args);
  },

  async cutSample(args: { sampleId: string; startSec: number; endSec: number; fadeMs?: number }): Promise<CutSampleResult> {
    if (isTauri()) return invokeTauri<CutSampleResult>("cut_sample", args);
    return mock.cutSample(args);
  },

  async saveSamplePart(args: { sampleId: string; startSec: number; endSec: number; name?: string }): Promise<Sample> {
    if (isTauri()) return invokeTauri<Sample>("save_sample_part", args);
    return mock.saveSamplePart(args);
  },

  async importLocal(args: { path: string }): Promise<TrackInfo> {
    if (isTauri()) return invokeTauri<TrackInfo>("import_local", args);
    return mock.importLocal(args);
  },

  async listTrash(): Promise<TrashEntry[]> {
    if (isTauri()) return invokeTauri<TrashEntry[]>("list_trash");
    return mock.listTrash();
  },

  async restoreTrash(args: { id: string }): Promise<void> {
    if (isTauri()) return invokeTauri<void>("restore_trash", args);
    return mock.restoreTrash(args);
  },

  async emptyTrash(): Promise<void> {
    if (isTauri()) return invokeTauri<void>("empty_trash");
    return mock.emptyTrash();
  },

  async clearScans(args?: { except?: string }): Promise<void> {
    if (isTauri()) return invokeTauri<void>("clear_scans", args);
    return mock.clearScans(args);
  },

  async listSamples(): Promise<Sample[]> {
    if (isTauri()) return invokeTauri<Sample[]>("list_samples");
    return mock.listSamples();
  },

  async renameSample(args: { id: string; name: string }): Promise<Sample> {
    if (isTauri()) return invokeTauri<Sample>("rename_sample", args);
    return mock.renameSample(args);
  },

  async deleteSample(args: { id: string }): Promise<void> {
    if (isTauri()) return invokeTauri<void>("delete_sample", args);
    return mock.deleteSample(args);
  },

  async exportSamples(args: { ids: string[]; destDir?: string }): Promise<string[]> {
    if (isTauri()) {
      let destDir = args.destDir;
      if (!destDir) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({ directory: true });
        if (!picked || Array.isArray(picked)) return [];
        destDir = picked;
      }
      return invokeTauri<string[]>("export_samples", { ids: args.ids, destDir });
    }
    return mock.exportSamples(args);
  },

  async revealSample(args: { id: string }): Promise<void> {
    if (isTauri()) return invokeTauri<void>("reveal_sample", args);
    return mock.revealSample(args);
  },

  async extractNotes(args: { path: string; bpm?: number; kind?: "melodic" | "drums" }): Promise<NotesResult> {
    if (isTauri()) return invokeTauri<NotesResult>("extract_notes", args);
    return mock.extractNotes(args);
  },

  async separateKaraoke(args: { trackId: string; splitLeadBacking?: boolean; lowPriority?: boolean }): Promise<KaraokeResult> {
    if (isTauri()) return invokeTauri<KaraokeResult>("separate_karaoke", args);
    return mock.separateKaraoke(args);
  },

  async analyzeFrequencies(args: { path: string }): Promise<FrequencyResult> {
    if (isTauri()) return invokeTauri<FrequencyResult>("analyze_frequencies", args);
    return mock.analyzeFrequencies(args);
  },

  async analyzePitch(args: { path: string }): Promise<PitchResult> {
    if (isTauri()) return invokeTauri<PitchResult>("analyze_pitch", args);
    return mock.analyzePitch(args);
  },

  async applyAutotune(args: { path: string; edits: AutotuneEdits }): Promise<AutotuneResult> {
    if (isTauri()) return invokeTauri<AutotuneResult>("apply_autotune", args);
    return mock.applyAutotune(args);
  },

  async exportMidi(args: { path: string; destPath?: string }): Promise<string | null> {
    if (isTauri()) {
      let destPath = args.destPath;
      if (!destPath) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const picked = await save({ filters: [{ name: "MIDI", extensions: ["mid"] }] });
        if (!picked) return null;
        destPath = picked;
      }
      return invokeTauri<string>("export_midi", { path: args.path, destPath });
    }
    return mock.exportMidi(args);
  },
};

export type Backend = typeof backend;
