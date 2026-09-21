import { useCallback, useEffect, useRef, useState } from "react";
import { mixEngine } from "@/lib/mixEngine";
import { samplePlayer } from "@/lib/samplePlayer";
import { nowPlaying } from "@/lib/nowPlaying";

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

export function useSyncPlayback() {
  const instancesRef = useRef<Map<string, WaveSurferLike>>(new Map());
  const masterIdRef = useRef<string | null>(null);
  /** Which registered ids belong in mix playback. Expanded child/kit tracks are registered with inMix=false. */
  const inMixRef = useRef<Map<string, boolean>>(new Map());
  /** url per registered track id, used to drive mixEngine.load(). */
  const urlsRef = useRef<Map<string, string>>(new Map());
  const loadPromiseRef = useRef<Promise<void> | null>(null);
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

  /** All top-level (non-expanded-child) registered tracks, as mixEngine track defs. */
  const mixTrackDefs = useCallback(() => {
    const defs: { id: string; url: string }[] = [];
    for (const [id, inMix] of inMixRef.current.entries()) {
      if (inMix === false) continue;
      const url = urlsRef.current.get(id);
      if (url) defs.push({ id, url });
    }
    return defs;
  }, []);

  /** Kicks off (or refreshes) a mixEngine.load() for every currently-registered mix track. Safe to call repeatedly. */
  const preloadMix = useCallback(() => {
    const defs = mixTrackDefs();
    if (defs.length === 0) return;
    loadPromiseRef.current = mixEngine.load(defs);
  }, [mixTrackDefs]);

  const registerInstance = useCallback(
    (id: string, ws: WaveSurferLike, isMaster = false, inMix = true, url?: string) => {
      instancesRef.current.set(id, ws);
      inMixRef.current.set(id, inMix);
      if (url) urlsRef.current.set(id, url);
      if (isMaster || masterIdRef.current === null) masterIdRef.current = id;
      // Never let a display-only instance emit audio of its own.
      ws.setVolume(0);
      ws.pause();
      if (url) preloadMix();
    },
    [preloadMix]
  );

  const unregisterInstance = useCallback((id: string) => {
    instancesRef.current.delete(id);
    inMixRef.current.delete(id);
    urlsRef.current.delete(id);
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

  /** Applies the solo/mute/volume gain matrix to mixEngine's per-track GainNodes. */
  const applyGains = useCallback(() => {
    const gains = computeGains(tracks);
    for (const [id, gain] of Object.entries(gains)) {
      mixEngine.setGain(id, gain);
    }
  }, [tracks]);

  // Kept for API compatibility with track components that still wire wavesurfer's own
  // timeupdate/finish events; no longer drives the transport clock (mixEngine does).
  const syncTime = useCallback((_sourceId: string, _time: number) => {}, []);
  const handleTimeUpdate = useCallback((_sourceId: string, _time: number) => {}, []);
  const handleFinish = useCallback((_sourceId: string) => {}, []);

  // Re-apply the solo/mute/volume gain matrix whenever it changes.
  useEffect(() => {
    applyGains();
  }, [applyGains]);

  // Drive mixEngine's loop flag from the loopEnabled toggle.
  useEffect(() => {
    mixEngine.setLoop(loopEnabled);
  }, [loopEnabled]);

  // React to mixEngine's own "ended" (natural end of the longest track), which fires whether or
  // not loop is on; on loop it has already restarted itself, otherwise the transport goes to pause.
  useEffect(() => {
    mixEngine.onEnded(() => {
      if (loopEnabledRef.current) {
        setCurrentTime(0);
      } else {
        setTransport((prev) => nextTransportState(prev, { type: "PAUSE" }));
        setCurrentTime(0);
      }
    });
    return () => mixEngine.onEnded(null);
  }, []);

  // While playing, drive the transport clock from mixEngine.currentTime() every frame, and move
  // every visible (display-only) wavesurfer instance's playhead to match — but never call
  // ws.play() on them, since audio now comes entirely from mixEngine.
  useEffect(() => {
    if (!transport.isPlaying) return;
    let raf: number;
    const tick = () => {
      const t = mixEngine.currentTime();
      setCurrentTime(t);
      nowPlaying.tick(t);
      const mode = transportRef.current.mode;
      if (mode === "mix") {
        for (const [id, ws] of instancesRef.current.entries()) {
          if (inMixRef.current.get(id) !== false) ws.setTime(t);
        }
      } else if (mode === "audition" && transportRef.current.auditionId) {
        instancesRef.current.get(transportRef.current.auditionId)?.setTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [transport.isPlaying]);

  // Pause/resume/stop must also update the hook's transport state so the tick loop runs.
  const mixControllerRef = useRef<{ pause(): void; resume(): void; stop(): void }>({
    pause: () => {
      mixEngine.pause();
      setTransport((prev) => nextTransportState(prev, { type: "PAUSE" }));
    },
    resume: () => {
      mixEngine.play(mixEngine.currentTime());
      nowPlaying.setPlaying(true);
      setTransport((prev) => nextTransportState(prev, { type: "PLAY_MIX" }));
    },
    stop: () => {
      mixEngine.stop();
      setTransport((prev) => nextTransportState(prev, { type: "STOP" }));
    },
  });

  /** Play the full mix through mixEngine, from its current position. Display wavesurfer instances follow along but never emit audio. */
  const playMix = useCallback(async () => {
    samplePlayer.stop();
    const defs = mixTrackDefs();
    if (defs.length > 0) {
      if (!loadPromiseRef.current) loadPromiseRef.current = mixEngine.load(defs);
      await loadPromiseRef.current;
    }
    for (const [id, ws] of instancesRef.current.entries()) {
      if (inMixRef.current.get(id) !== false) ws.pause();
    }
    mixEngine.play(mixEngine.currentTime());
    nowPlaying.start("mix", "Mix", 0, mixControllerRef.current);
    setTransport((prev) => nextTransportState(prev, { type: "PLAY_MIX" }));
  }, [mixTrackDefs]);

  const pause = useCallback(() => {
    mixEngine.pause();
    nowPlaying.setPlaying(false);
    setTransport((prev) => nextTransportState(prev, { type: "PAUSE" }));
  }, []);

  /**
   * Seeks the transport to `time`: live if mix is currently playing (restarts every source at the
   * new offset via mixEngine.seek), or just stores the position if paused/stopped. Either way,
   * every registered lane's displayed cursor and the master clock (`currentTime`) are updated so
   * playing afterwards (playMix/auditionTrack) resumes from here rather than from 0.
   */
  const seek = useCallback((time: number) => {
    mixEngine.seek(time);
    setCurrentTime(time);
    nowPlaying.tick(time);
    for (const [, ws] of instancesRef.current.entries()) {
      ws.setTime(time);
    }
  }, []);

  const togglePlay = useCallback(() => {
    if (transportRef.current.isPlaying) pause();
    else void playMix();
  }, [pause, playMix]);

  const stopAll = useCallback(() => {
    mixEngine.stop();
    nowPlaying.stop();
    for (const [, ws] of instancesRef.current.entries()) {
      ws.pause();
      ws.setTime(0);
    }
    setTransport((prev) => nextTransportState(prev, { type: "STOP" }));
    setCurrentTime(0);
  }, []);

  /**
   * Solo-audition a single track, routed through mixEngine with just that one track loaded so
   * there's a single consistent audio code path. Calling it again on the already-playing
   * auditioned track stops it (toggle off).
   */
  const auditionTrack = useCallback(
    (id: string) => {
      const prevState = transportRef.current;
      const turningOff = prevState.mode === "audition" && prevState.auditionId === id && prevState.isPlaying;

      samplePlayer.stop();
      for (const [instanceId, ws] of instancesRef.current.entries()) {
        if (instanceId !== id) ws.pause();
      }

      if (turningOff) {
        mixEngine.pause();
        nowPlaying.setPlaying(false);
        setTransport((prev) => nextTransportState(prev, { type: "AUDITION", id }));
        return;
      }

      const auditionController = {
        pause: () => {
          mixEngine.pause();
          setTransport((prev) => nextTransportState(prev, { type: "PAUSE" }));
        },
        resume: () => {
          mixEngine.play(mixEngine.currentTime());
          nowPlaying.setPlaying(true);
          setTransport((prev) => nextTransportState(prev, { type: "AUDITION", id }));
        },
        stop: () => {
          mixEngine.stop();
          setTransport((prev) => nextTransportState(prev, { type: "STOP" }));
        },
      };
      nowPlaying.start("audition", `Solo: ${id}`, 0, auditionController);

      const url = urlsRef.current.get(id);
      if (url) {
        // mixEngine.load() never resets `this.position`, so the position captured here (before
        // the load, which may take a while) is still the last known transport position once the
        // load resolves — audition should resume from there, not always from 0.
        const startPos = mixEngine.currentTime();
        const loadPromise = mixEngine.load([{ id, url }]);
        loadPromiseRef.current = loadPromise;
        void loadPromise.then(() => {
          const t = transportRef.current;
          if (t.mode === "audition" && t.auditionId === id) {
            mixEngine.play(startPos);
          }
        });
      }

      setTransport((prev) => nextTransportState(prev, { type: "AUDITION", id }));
    },
    []
  );

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
    seek,
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
