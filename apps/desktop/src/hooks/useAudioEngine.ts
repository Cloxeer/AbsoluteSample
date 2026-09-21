import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";
import { onProgress } from "@/lib/events";
import { markJobStarted } from "@/lib/localJobs";
import { getLowPriority } from "@/lib/lowPriority";
import type { InstrumentsResult, InstrumentStem, LoopAnalysis, LoopInfo, ProgressPayload, StemInfo, TrackInfo, TrackSession } from "@/lib/types";

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

export function useAudioEngine() {
  const [engine, setEngine] = useState<AudioEngineState>({
    state: "idle",
    track: null,
    loop: null,
    stems: null,
    instruments: null,
    instrumentsMeta: null,
    analysis: null,
    progress: null,
    error: null,
  });

  const unlistenRef = useRef<(() => void) | null>(null);

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
      setEngine((prev) => ({ ...prev, ...sessionToState(session), error: null, progress: null }));
      return session;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    }
  }, []);

  /** Clears the current session back to the empty state without deleting any backend data. */
  const newLink = useCallback((teardown?: () => void) => {
    teardown?.();
    setEngine({
      state: "idle",
      track: null,
      loop: null,
      stems: null,
      instruments: null,
      instrumentsMeta: null,
      analysis: null,
      progress: null,
      error: null,
    });
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
    }
  }, []);

  const separateInstruments = useCallback(async (trackId: string, options?: { lowPriority?: boolean }) => {
    markJobStarted(trackId);
    setEngine((prev) => ({ ...prev, state: "separating", error: null }));
    try {
      const lowPriority = options?.lowPriority ?? getLowPriority();
      const { stems, ...instrumentsMeta } = await backend.separateInstruments({ trackId, lowPriority });
      setEngine((prev) => ({ ...prev, state: "ready", instruments: stems, instrumentsMeta, progress: null }));
      return stems;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
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
    setEngine({
      state: "idle",
      track: null,
      loop: null,
      stems: null,
      instruments: null,
      instrumentsMeta: null,
      analysis: null,
      progress: null,
      error: null,
    });
  }, []);

  return { engine, fetchAudio, importLocal, trimLoop, separateStems, separateInstruments, analyzeLoop, reset, openTrack, newLink };
}
