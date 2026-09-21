import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";
import { onProgress } from "@/lib/events";
import type { LoopAnalysis, LoopInfo, ProgressPayload, StemInfo, TrackInfo } from "@/lib/types";

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
  analysis: LoopAnalysis | null;
  progress: ProgressPayload | null;
  error: string | null;
}

export function useAudioEngine() {
  const [engine, setEngine] = useState<AudioEngineState>({
    state: "idle",
    track: null,
    loop: null,
    stems: null,
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

  const fetchAudio = useCallback(async (url: string) => {
    setEngine((prev) => ({ ...prev, state: "fetching", error: null }));
    try {
      const track = await backend.fetchAudio(url);
      setEngine((prev) => ({ ...prev, state: "fetched", track }));
      return track;
    } catch (err) {
      setEngine((prev) => ({ ...prev, state: "error", error: String(err) }));
      throw err;
    }
  }, []);

  const trimLoop = useCallback(async (trackId: string, startSec: number, endSec: number) => {
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
      analysis: null,
      progress: null,
      error: null,
    });
  }, []);

  return { engine, fetchAudio, trimLoop, separateStems, analyzeLoop, reset };
}
