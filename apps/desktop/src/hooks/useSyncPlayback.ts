import { useCallback, useEffect, useRef, useState } from "react";

export interface TrackGainState {
  id: string;
  volume: number;
  solo: boolean;
  mute: boolean;
}

/**
 * Pure function: computes effective gain (0..1) per track given the solo/mute/volume matrix.
 * If any track is soloed, only soloed (and un-muted) tracks are audible; others are silenced.
 * Otherwise, all non-muted tracks play at their own volume.
 */
export function computeGains(tracks: TrackGainState[]): Record<string, number> {
  const anySolo = tracks.some((t) => t.solo);
  const result: Record<string, number> = {};
  for (const t of tracks) {
    if (t.mute) {
      result[t.id] = 0;
      continue;
    }
    if (anySolo && !t.solo) {
      result[t.id] = 0;
      continue;
    }
    result[t.id] = t.volume;
  }
  return result;
}

export interface WaveSurferLike {
  play: () => void;
  pause: () => void;
  setTime: (time: number) => void;
  getCurrentTime: () => number;
  setVolume: (v: number) => void;
  isPlaying: () => boolean;
}

const DRIFT_THRESHOLD_SEC = 0.03;

export function useSyncPlayback() {
  const instancesRef = useRef<Map<string, WaveSurferLike>>(new Map());
  const masterIdRef = useRef<string | null>(null);
  const [tracks, setTracks] = useState<TrackGainState[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const loopEnabledRef = useRef(false);
  loopEnabledRef.current = loopEnabled;

  const registerInstance = useCallback((id: string, ws: WaveSurferLike, isMaster = false) => {
    instancesRef.current.set(id, ws);
    if (isMaster || masterIdRef.current === null) masterIdRef.current = id;
  }, []);

  const unregisterInstance = useCallback((id: string) => {
    instancesRef.current.delete(id);
    if (masterIdRef.current === id) {
      const next = instancesRef.current.keys().next();
      masterIdRef.current = next.done ? null : next.value;
    }
  }, []);

  const upsertTrack = useCallback((state: TrackGainState) => {
    setTracks((prev) => {
      const idx = prev.findIndex((t) => t.id === state.id);
      if (idx === -1) return [...prev, state];
      const next = [...prev];
      next[idx] = state;
      return next;
    });
  }, []);

  const removeTrack = useCallback((id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const applyGains = useCallback(() => {
    const gains = computeGains(tracks);
    for (const [id, ws] of instancesRef.current.entries()) {
      const gain = gains[id] ?? 1;
      ws.setVolume(gain);
    }
  }, [tracks]);

  const syncTime = useCallback((sourceId: string, time: number) => {
    const masterId = masterIdRef.current;
    if (sourceId !== masterId) return;
    for (const [id, ws] of instancesRef.current.entries()) {
      if (id === masterId) continue;
      const drift = Math.abs(ws.getCurrentTime() - time);
      if (drift > DRIFT_THRESHOLD_SEC) {
        ws.setTime(time);
      }
    }
  }, []);

  /** Called by every track on `timeupdate`; only the master drives the clock and re-syncs the others. */
  const handleTimeUpdate = useCallback(
    (sourceId: string, time: number) => {
      if (sourceId !== masterIdRef.current) return;
      setCurrentTime(time);
      syncTime(sourceId, time);
    },
    [syncTime]
  );

  /** Called by every track on `finish`; the master decides whether to loop or stop. */
  const handleFinish = useCallback((sourceId: string) => {
    if (sourceId !== masterIdRef.current) return;
    if (loopEnabledRef.current) {
      for (const ws of instancesRef.current.values()) {
        ws.setTime(0);
        ws.play();
      }
      setCurrentTime(0);
    } else {
      for (const ws of instancesRef.current.values()) ws.pause();
      setIsPlaying(false);
    }
  }, []);

  // Re-apply the solo/mute/volume gain matrix whenever it changes.
  useEffect(() => {
    applyGains();
  }, [applyGains]);

  const play = useCallback(() => {
    for (const ws of instancesRef.current.values()) ws.play();
    setIsPlaying(true);
  }, []);

  const pause = useCallback(() => {
    for (const ws of instancesRef.current.values()) ws.pause();
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const stop = useCallback(() => {
    for (const ws of instancesRef.current.values()) {
      ws.pause();
      ws.setTime(0);
    }
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  const toggleLoop = useCallback(() => setLoopEnabled((v) => !v), []);

  return {
    tracks,
    upsertTrack,
    removeTrack,
    registerInstance,
    unregisterInstance,
    applyGains,
    syncTime,
    handleTimeUpdate,
    handleFinish,
    currentTime,
    play,
    pause,
    togglePlay,
    stop,
    isPlaying,
    loopEnabled,
    toggleLoop,
  };
}
