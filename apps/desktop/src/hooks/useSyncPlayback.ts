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

export type TransportMode = "mix" | "audition";

export interface TransportState {
  mode: TransportMode;
  auditionId: string | null;
  isPlaying: boolean;
}

export type TransportAction =
  | { type: "PLAY_MIX" }
  | { type: "PAUSE" }
  | { type: "STOP" }
  | { type: "AUDITION"; id: string };

/**
 * Pure state machine for the transport's mode/audition/play-state. Kept separate from the
 * imperative wavesurfer side-effects (in useSyncPlayback) so the transition logic itself is
 * trivially unit-testable.
 *
 * Rules:
 * - PLAY_MIX always switches to mix mode and starts playback.
 * - STOP always resets to mix mode, no audition, stopped.
 * - PAUSE keeps the current mode/audition target but stops playback.
 * - AUDITION on the currently-playing auditioned track toggles it off (stops, back to mix/paused).
 *   AUDITION on any other id (or while stopped) starts auditioning that id.
 */
export function nextTransportState(state: TransportState, action: TransportAction): TransportState {
  switch (action.type) {
    case "PLAY_MIX":
      return { mode: "mix", auditionId: null, isPlaying: true };
    case "STOP":
      return { mode: "mix", auditionId: null, isPlaying: false };
    case "PAUSE":
      return { ...state, isPlaying: false };
    case "AUDITION": {
      if (state.mode === "audition" && state.auditionId === action.id && state.isPlaying) {
        return { mode: "mix", auditionId: null, isPlaying: false };
      }
      return { mode: "audition", auditionId: action.id, isPlaying: true };
    }
    default:
      return state;
  }
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
  const [transport, setTransport] = useState<TransportState>({
    mode: "mix",
    auditionId: null,
    isPlaying: false,
  });
  const transportRef = useRef(transport);
  transportRef.current = transport;
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

  /** The instance currently driving the on-screen clock: the audition target in audition mode, otherwise the mix master. */
  const clockSourceId = useCallback(() => {
    const t = transportRef.current;
    return t.mode === "audition" ? t.auditionId : masterIdRef.current;
  }, []);

  /** Called by every track on `timeupdate`; only the active clock source drives the readout (and re-syncs the others in mix mode). */
  const handleTimeUpdate = useCallback(
    (sourceId: string, time: number) => {
      if (sourceId !== clockSourceId()) return;
      setCurrentTime(time);
      if (transportRef.current.mode === "mix") syncTime(sourceId, time);
    },
    [clockSourceId, syncTime]
  );

  /** Called by every track on `finish`; the active clock source decides whether to loop or stop. */
  const handleFinish = useCallback((sourceId: string) => {
    if (sourceId !== clockSourceId()) return;
    const t = transportRef.current;
    if (loopEnabledRef.current) {
      if (t.mode === "audition" && t.auditionId) {
        const ws = instancesRef.current.get(t.auditionId);
        ws?.setTime(0);
        ws?.play();
      } else {
        for (const ws of instancesRef.current.values()) {
          ws.setTime(0);
          ws.play();
        }
      }
      setCurrentTime(0);
    } else {
      if (t.mode === "audition" && t.auditionId) {
        instancesRef.current.get(t.auditionId)?.pause();
      } else {
        for (const ws of instancesRef.current.values()) ws.pause();
      }
      setTransport((prev) => nextTransportState(prev, { type: "PAUSE" }));
    }
  }, [clockSourceId]);

  // Re-apply the solo/mute/volume gain matrix whenever it changes.
  useEffect(() => {
    applyGains();
  }, [applyGains]);

  /** Play the full mix: pause any audition-only instance first, then play every registered track from its own position. */
  const playMix = useCallback(() => {
    for (const ws of instancesRef.current.values()) ws.play();
    setTransport((prev) => nextTransportState(prev, { type: "PLAY_MIX" }));
  }, []);

  const pause = useCallback(() => {
    const t = transportRef.current;
    if (t.mode === "audition" && t.auditionId) {
      instancesRef.current.get(t.auditionId)?.pause();
    } else {
      for (const ws of instancesRef.current.values()) ws.pause();
    }
    setTransport((prev) => nextTransportState(prev, { type: "PAUSE" }));
  }, []);

  const togglePlay = useCallback(() => {
    if (transportRef.current.isPlaying) pause();
    else playMix();
  }, [pause, playMix]);

  const stopAll = useCallback(() => {
    for (const ws of instancesRef.current.values()) {
      ws.pause();
      ws.setTime(0);
    }
    setTransport((prev) => nextTransportState(prev, { type: "STOP" }));
    setCurrentTime(0);
  }, []);

  /**
   * Solo-audition a single track: pause every other instance, seek/play only `id`.
   * Calling it again on the already-playing auditioned track stops it (toggle off).
   */
  const auditionTrack = useCallback((id: string) => {
    const target = instancesRef.current.get(id);
    const prevState = transportRef.current;
    const turningOff = prevState.mode === "audition" && prevState.auditionId === id && prevState.isPlaying;

    for (const [instanceId, ws] of instancesRef.current.entries()) {
      if (instanceId !== id) ws.pause();
    }

    if (turningOff) {
      target?.pause();
    } else {
      target?.play();
    }

    setTransport((prev) => nextTransportState(prev, { type: "AUDITION", id }));
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
    // legacy aliases kept for compatibility with the mix-everything transport
    play: playMix,
    pause,
    stop: stopAll,
    togglePlay,
    isPlaying: transport.isPlaying,
    mode: transport.mode,
    auditionId: transport.auditionId,
    playMix,
    stopAll,
    auditionTrack,
    loopEnabled,
    toggleLoop,
  };
}
