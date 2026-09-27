import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";
import { onProgress, onStemReady } from "@/lib/events";
import { markJobEnded, markJobStarted } from "@/lib/localJobs";
import { getLowPriority } from "@/lib/lowPriority";
import type { InstrumentsResult, InstrumentStem, LoopAnalysis, LoopInfo, ProgressPayload, SplitQuality, StemInfo, TrackInfo, TrackSession } from "@/lib/types";

export type EngineState =
  | "idle"
  | "fetching"
  | "fetched"
  | "trimming"
  | "trimmed"
  | "separating"
  | "ready"
  | "analyzing"
  | "error";

export interface AudioEngineState {
  state: EngineState;
  track: TrackInfo | null;
  loop: LoopInfo | null;
  stems: StemInfo[] | null;
  instruments: InstrumentStem[] | null;
  instrumentsMeta: Omit<InstrumentsResult, "stems"> | null;
  /** v11: stems that arrived early (pipeline://stem) while a split of the current track is running. */
  partialInstruments: InstrumentStem[] | null;
  karaoke: InstrumentStem[] | null;
  /** v11: source mix of the karaoke stems (derived "instrumental" = mix * mixGain - vocals). */
  karaokeMixPath: string | null;
  analysis: LoopAnalysis | null;
  progress: ProgressPayload | null;
  error: string | null;
}

/**
 * Pure helper: maps a fetched TrackSession into the engine's internal state shape.
 * Status becomes "ready" if instruments or stems exist, "trimmed" if only a loop exists,
 * otherwise "fetched" (source downloaded but not yet trimmed or split).
 */
export function sessionToState(session: TrackSession): Pick<AudioEngineState, "state" | "track" | "loop" | "stems" | "instruments" | "instrumentsMeta" | "analysis"> {
  const hasSplit = !!(session.instruments && session.instruments.length) || !!(session.stems && session.stems.length);
  const state: EngineState = hasSplit ? "ready" : session.loop ? "trimmed" : "fetched";
  return {
    state,
    track: session.track,
    loop: session.loop,
    stems: session.stems,
    instruments: session.instruments,
    instrumentsMeta: session.instrumentsMeta ?? null,
    analysis: session.analysis,
  };
}

/** Adds or replaces one stem (by key) in a partial list, keeping the existing order stable. */
export function upsertStem(list: InstrumentStem[] | null, stem: InstrumentStem): InstrumentStem[] {
  const current = list ?? [];
  const idx = current.findIndex((s) => s.key === stem.key);
  if (idx === -1) return [...current, stem];
  const next = [...current];
  next[idx] = stem;
  return next;
}

/**
 * Applies a split_substems result: a full list (it contains top-level stems) replaces everything;
 * a children-only list replaces just that parent's children.
 */
export function mergeSubstems(current: InstrumentStem[] | null, parent: string, returned: InstrumentStem[]): InstrumentStem[] {
  if (returned.some((s) => s.parent === null)) return returned;
  const kept = (current ?? []).filter((s) => s.parent !== parent && !returned.some((r) => r.key === s.key));
  return [...kept, ...returned];
}

const EMPTY_STATE: AudioEngineState = {
  state: "idle",
  track: null,
  loop: null,
  stems: null,
  instruments: null,
  instrumentsMeta: null,
  partialInstruments: null,
  karaoke: null,
  karaokeMixPath: null,
  analysis: null,
  progress: null,
  error: null,
};

export function useAudioEngine() {
  const [engine, setEngine] = useState<AudioEngineState>(EMPTY_STATE);

  const unlistenRef = useRef<(() => void) | null>(null);
  /** The track whose split is running right now; early stems for any other track are ignored. */
  const splittingTrackRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onStemReady(({ trackId, stem }) => {
      if (cancelled || splittingTrackRef.current !== trackId) return;
      setEngine((prev) => (prev.track?.id === trackId ? { ...prev, partialInstruments: upsertStem(prev.partialInstruments, stem) } : prev));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    onProgress((payload) => {
      if (cancelled) return;
      setEngine((prev) => ({ ...prev, progress: payload }));
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenRef.current = unlisten;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, []);

  const fetchAudio = useCallback(async (url: string, force = false) => {
    const currentTrackId = engine.track?.id;
    if (currentTrackId) markJobStarted(currentTrackId);
    setEngine((prev) => ({ ...prev, state: "fetching", error: null }));
    try {
      const track = await backend.fetchAudio({ url, force, currentTrackId });
      setEngine((prev) => ({ ...prev, state: "fetched", track }));
      return track;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    }
  }, [engine.track?.id]);

  const importLocal = useCallback(async (path: string) => {
    setEngine((prev) => ({ ...prev, state: "fetching", error: null }));
    try {
      const track = await backend.importLocal({ path });
      setEngine((prev) => ({ ...prev, state: "fetched", track }));
      return track;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    }
  }, []);

  /** Opens a previously fetched song from the library, tearing down current playback first. */
  const openTrack = useCallback(async (id: string, teardown?: () => void) => {
    teardown?.();
    setEngine((prev) => ({ ...prev, state: "fetching", error: null }));
    try {
      const session = await backend.openTrack(id);
      setEngine((prev) => ({ ...prev, ...sessionToState(session), partialInstruments: null, error: null, progress: null }));
      return session;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    }
  }, []);

  /** Clears the current session back to the empty state without deleting any backend data. */
  const newLink = useCallback((teardown?: () => void) => {
    teardown?.();
    setEngine(EMPTY_STATE);
  }, []);

  const trimLoop = useCallback(async (trackId: string, startSec: number, endSec: number) => {
    markJobStarted(trackId);
    setEngine((prev) => ({ ...prev, state: "trimming", error: null }));
    try {
      const loop = await backend.trimLoop({ trackId, startSec, endSec });
      setEngine((prev) => ({ ...prev, state: "trimmed", loop }));
      return loop;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    } finally {
      markJobEnded(trackId);
    }
  }, []);

  const separateStems = useCallback(async (trackId: string) => {
    markJobStarted(trackId);
    setEngine((prev) => ({ ...prev, state: "separating", error: null }));
    try {
      const stems = await backend.separateStems({ trackId });
      setEngine((prev) => ({ ...prev, state: "ready", stems }));
      return stems;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    } finally {
      markJobEnded(trackId);
    }
  }, []);

  /** v11: quick split by default; stems that are ready early show up in `partialInstruments`. */
  const separateInstruments = useCallback(async (trackId: string, options?: { lowPriority?: boolean; quality?: SplitQuality }) => {
    markJobStarted(trackId);
    splittingTrackRef.current = trackId;
    setEngine((prev) => ({ ...prev, state: "separating", error: null, partialInstruments: null }));
    try {
      const lowPriority = options?.lowPriority ?? getLowPriority();
      const quality = options?.quality ?? "quick";
      const { stems, ...instrumentsMeta } = await backend.separateInstruments({ trackId, lowPriority, quality });
      setEngine((prev) => ({ ...prev, state: "ready", instruments: stems, instrumentsMeta, partialInstruments: null, progress: null }));
      return stems;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err), partialInstruments: null }));
      throw err;
    } finally {
      if (splittingTrackRef.current === trackId) splittingTrackRef.current = null;
      markJobEnded(trackId);
    }
  }, []);

  /**
   * v11: re-runs the best-quality separation on [startSec, endSec] for every stem. Enhanced files get
   * new versioned paths, so lanes and the mix reload just the changed audio. Errors are rethrown for
   * the caller to show; the current stems stay as they were.
   */
  const enhanceRegion = useCallback(async (trackId: string, startSec: number, endSec: number) => {
    markJobStarted(trackId);
    try {
      const { stems, ...meta } = await backend.enhanceRegion({ trackId, startSec, endSec });
      setEngine((prev) =>
        prev.track?.id === trackId
          ? { ...prev, instruments: stems, instrumentsMeta: prev.instrumentsMeta ? { ...prev.instrumentsMeta, ...meta } : meta, progress: null }
          : prev
      );
      return stems;
    } finally {
      markJobEnded(trackId);
    }
  }, []);

  /** v11: splits vocals (lead & backing) or drums (kit) on demand; returns the merged stem list. */
  const splitSubstems = useCallback(async (trackId: string, parent: string) => {
    markJobStarted(trackId);
    try {
      const { stems, ...meta } = await backend.splitSubstems({ trackId, parent });
      setEngine((prev) =>
        prev.track?.id === trackId
          ? {
              ...prev,
              instruments: mergeSubstems(prev.instruments, parent, stems),
              instrumentsMeta: prev.instrumentsMeta ? { ...prev.instrumentsMeta, ...meta } : meta,
              progress: null,
            }
          : prev
      );
      return stems;
    } finally {
      markJobEnded(trackId);
    }
  }, []);

  const separateKaraoke = useCallback(async (trackId: string, splitLeadBacking?: boolean, options?: { lowPriority?: boolean }) => {
    markJobStarted(trackId);
    setEngine((prev) => ({ ...prev, state: "separating", error: null }));
    try {
      const lowPriority = options?.lowPriority ?? getLowPriority();
      const { stems, mixPath } = await backend.separateKaraoke({ trackId, splitLeadBacking, lowPriority });
      setEngine((prev) => ({ ...prev, state: "ready", karaoke: stems, karaokeMixPath: mixPath ?? null, progress: null }));
      return stems;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    } finally {
      markJobEnded(trackId);
    }
  }, []);

  const analyzeLoop = useCallback(async (trackId: string) => {
    setEngine((prev) => ({ ...prev, state: "analyzing" }));
    try {
      const analysis = await backend.analyzeLoop({ trackId });
      setEngine((prev) => ({ ...prev, state: "ready", analysis }));
      return analysis;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    setEngine(EMPTY_STATE);
  }, []);

  return {
    engine,
    fetchAudio,
    importLocal,
    trimLoop,
    separateStems,
    separateInstruments,
    separateKaraoke,
    enhanceRegion,
    splitSubstems,
    analyzeLoop,
    reset,
    openTrack,
    newLink,
  };
}
