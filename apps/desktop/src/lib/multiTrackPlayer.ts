/**
 * Multitrack player for the Autotune editor (lead + harmonies). Every track is scheduled against ONE
 * clock with the same start time, so takes never drift apart. Each track has its own original and
 * tuned buffer (all channels), a timeline offset, volume, mute and solo. Starts, stops, seeks, A/B
 * switches and edit patches are short crossfades, so the player itself never clicks.
 */

import { buildPolish, supportsPolish, type PolishChain } from "./vocalPolish";

export type PlaySource = "original" | "tuned";

export interface TrackMix {
  volume: number;
  muted: boolean;
  solo: boolean;
}

/** DAW rule: if any track is soloed only soloed tracks play; a muted track is always silent. */
export function effectiveGain(t: TrackMix, anySolo: boolean): number {
  if (t.muted) return 0;
  if (anySolo && !t.solo) return 0;
  return t.volume;
}

export const FADE_SEC = 0.012;
const START_LATENCY_SEC = 0.03;

export interface TrackInfo extends TrackMix {
  id: string;
  offsetSec: number;
  durationSec: number;
}

export interface MultiTrackPlayer {
  /** Adds (or replaces) a track; output starts as a copy of the original. */
  addTrack(id: string, channels: Float32Array[], sampleRate: number, opts?: Partial<TrackMix> & { offsetSec?: number }): void;
  removeTrack(id: string): void;
  tracks(): TrackInfo[];
  setOffset(id: string, sec: number): void;
  setVolume(id: string, volume: number): void;
  setMuted(id: string, muted: boolean): void;
  setSolo(id: string, solo: boolean): void;
  /** Writes re-rendered samples (per channel, track-local sample index) into a track's tuned output. */
  patch(id: string, startSample: number, channels: Float32Array[]): void;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  /** Timeline position in seconds. */
  currentTime(): number;
  seek(sec: number): void;
  setSource(which: PlaySource): void;
  getSource(): PlaySource;
  /** Plays [startSec, endSec) (timeline seconds) of ONE track's tuned output; playhead unaffected. */
  audition(id: string, startSec: number, endSec: number): void;
  /** Timeline length: the end of the latest-ending track. */
  duration(): number;
  /**
   * A soft guide tone (the target melody) played with everything, at `offsetSec` on the timeline.
   * It ignores mute/solo, is not a track and does not change the duration. null removes it.
   */
  setGuide(samples: Float32Array | null, sampleRate?: number, offsetSec?: number): void;
  hasGuide(): boolean;
  /** Routes the whole mix through the studio polish chain (EQ, compression, plate). */
  setPolish(on: boolean): void;
  getPolish(): boolean;
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

interface Voice {
  src: AudioBufferSourceNode;
  env: GainNode;
}

interface Track extends TrackInfo {
  original: AudioBuffer;
  output: AudioBuffer;
  gain: GainNode;
  voice: Voice | null;
  restartQueued: boolean;
  /** The guide tone: not a track (no mute/solo, not in tracks() or duration()). */
  guide?: boolean;
}

export const GUIDE_ID = "__guide__";
export const GUIDE_VOLUME = 0.35;

type CtxFactory = () => AudioContext;

export function createMultiTrackPlayer(ctxFactory?: CtxFactory): MultiTrackPlayer {
  const AC: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let polishOn = false;
  let polish: PolishChain | null = null;
  const tracks = new Map<string, Track>();
  let source: PlaySource = "tuned";
  let playing = false;
  let startCtxTime = 0;
  let startPos = 0;
  let pos = 0;
  let audition: Voice | null = null;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const ensureCtx = (): AudioContext | null => {
    if (!ctx) {
      const make = ctxFactory ?? (AC ? () => new AC() : null);
      if (!make) return null;
      ctx = make();
      master = ctx.createGain();
      route();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  };

  /** master -> (polish ->) destination. */
  const route = () => {
    if (!ctx || !master) return;
    master.disconnect();
    if (polishOn && supportsPolish(ctx)) {
      polish ??= buildPolish(ctx);
      master.connect(polish.input);
      polish.output.disconnect();
      polish.output.connect(ctx.destination);
    } else master.connect(ctx.destination);
  };
  const realTracks = () => [...tracks.values()].filter((t) => !t.guide);
  const anySolo = () => realTracks().some((t) => t.solo);
  const glide = (param: AudioParam, value: number) => {
    const c = ctx!;
    const now = c.currentTime;
    param.cancelScheduledValues?.(now);
    param.setValueAtTime?.(param.value, now);
    param.linearRampToValueAtTime(value, now + FADE_SEC);
  };
  const applyGains = () => {
    if (!ctx) return;
    const solo = anySolo();
    for (const t of tracks.values()) glide(t.gain.gain, t.guide ? t.volume : effectiveGain(t, solo));
  };

  const livePos = () => (playing && ctx ? startPos + (ctx.currentTime - startCtxTime) : pos);
  const durationSec = () => Math.max(0, ...realTracks().map((t) => t.offsetSec + t.durationSec));

  const stopVoice = (v: Voice | null) => {
    if (!v || !ctx) return;
    const now = ctx.currentTime;
    v.src.onended = () => {
      v.src.disconnect();
      v.env.disconnect();
    };
    try {
      glide(v.env.gain, 0);
      v.src.stop(now + FADE_SEC + 0.005);
    } catch {
      /* already stopped */
    }
  };

  /** Starts `t` so that timeline position `timelineSec` sounds at context time `when`. */
  const startVoice = (t: Track, when: number, timelineSec: number) => {
    const c = ctx!;
    stopVoice(t.voice);
    t.voice = null;
    const local = timelineSec - t.offsetSec; // position inside the track's own audio
    if (local >= t.durationSec) return;
    const buf = source === "original" ? t.original : t.output;
    const src = c.createBufferSource();
    src.buffer = buf;
    const env = c.createGain();
    const at = when + Math.max(0, -local); // track begins later on the timeline
    env.gain.setValueAtTime?.(0, at);
    env.gain.linearRampToValueAtTime(1, at + FADE_SEC);
    src.connect(env).connect(t.gain);
    src.start(at, Math.max(0, local));
    t.voice = { src, env };
  };

  const scheduleEnd = () => {
    if (endTimer) clearTimeout(endTimer);
    if (!playing) return;
    const remaining = durationSec() - livePos();
    endTimer = setTimeout(() => {
      if (!playing) return;
      if (livePos() >= durationSec() - 0.02) {
        for (const t of tracks.values()) stopVoice(t.voice), (t.voice = null);
        playing = false;
        pos = 0;
        emit();
      } else scheduleEnd();
    }, Math.max(50, remaining * 1000 + 30));
  };

  const startAll = (timelineSec: number) => {
    const c = ensureCtx();
    if (!c) return;
    startCtxTime = c.currentTime + START_LATENCY_SEC;
    startPos = Math.max(0, Math.min(durationSec(), timelineSec));
    for (const t of tracks.values()) startVoice(t, startCtxTime, startPos);
    playing = true;
    scheduleEnd();
  };

  const stopAudition = () => {
    stopVoice(audition);
    audition = null;
  };

  return {
    addTrack(id, channels, sampleRate, opts = {}) {
      const c = ensureCtx();
      if (!c || channels.length === 0) return;
      const old = tracks.get(id);
      if (old) this.removeTrack(id);
      const n = channels[0].length;
      const make = () => {
        const b = c.createBuffer(channels.length, Math.max(1, n), sampleRate);
        channels.forEach((ch, i) => b.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
        return b;
      };
      const gain = c.createGain();
      gain.connect(master!);
      const t: Track = {
        id,
        offsetSec: opts.offsetSec ?? 0,
        durationSec: n / sampleRate,
        volume: opts.volume ?? 1,
        muted: opts.muted ?? false,
        solo: opts.solo ?? false,
        original: make(),
        output: make(),
        gain,
        voice: null,
        restartQueued: false,
      };
      tracks.set(id, t);
      applyGains();
      if (playing) startVoice(t, c.currentTime + START_LATENCY_SEC, livePos() + START_LATENCY_SEC);
      emit();
    },
    removeTrack(id) {
      const t = tracks.get(id);
      if (!t) return;
      stopVoice(t.voice);
      t.gain.disconnect();
      tracks.delete(id);
      applyGains();
      emit();
    },
    tracks: () => realTracks().map(({ id, offsetSec, durationSec, volume, muted, solo }) => ({ id, offsetSec, durationSec, volume, muted, solo })),
    setOffset(id, sec) {
      const t = tracks.get(id);
      if (!t) return;
      t.offsetSec = sec;
      if (playing && ctx) startVoice(t, ctx.currentTime + FADE_SEC, livePos() + FADE_SEC);
      emit();
    },
    setVolume(id, volume) {
      const t = tracks.get(id);
      if (!t) return;
      t.volume = Math.max(0, volume);
      applyGains();
      emit();
    },
    setMuted(id, muted) {
      const t = tracks.get(id);
      if (!t) return;
      t.muted = muted;
      applyGains();
      emit();
    },
    setSolo(id, solo) {
      const t = tracks.get(id);
      if (!t) return;
      t.solo = solo;
      applyGains();
      emit();
    },
    patch(id, startSample, channels) {
      const t = tracks.get(id);
      if (!t) return;
      const start = Math.max(0, Math.round(startSample));
      channels.forEach((ch, i) => {
        if (i >= t.output.numberOfChannels) return;
        const count = Math.min(ch.length, t.output.length - start);
        if (count > 0) t.output.copyToChannel(ch.subarray(0, count) as Float32Array<ArrayBuffer>, i, start);
      });
      // A started source keeps its data: restart just this track (crossfaded), once per burst.
      if (playing && source === "tuned" && !t.restartQueued) {
        t.restartQueued = true;
        setTimeout(() => {
          t.restartQueued = false;
          if (playing && source === "tuned" && ctx && tracks.get(id) === t) startVoice(t, ctx.currentTime + FADE_SEC, livePos() + FADE_SEC);
        }, 0);
      }
    },
    play() {
      if (playing) return;
      stopAudition();
      startAll(pos >= durationSec() - 0.01 ? 0 : pos);
      emit();
    },
    pause() {
      if (!playing) return;
      pos = livePos();
      for (const t of tracks.values()) stopVoice(t.voice), (t.voice = null);
      playing = false;
      if (endTimer) clearTimeout(endTimer);
      emit();
    },
    isPlaying: () => playing,
    currentTime: () => Math.min(durationSec(), Math.max(0, livePos())),
    seek(sec) {
      pos = Math.max(0, Math.min(durationSec(), sec));
      if (playing) startAll(pos);
      emit();
    },
    setSource(which) {
      if (which === source) return;
      const at = livePos();
      source = which;
      if (playing && ctx) for (const t of tracks.values()) startVoice(t, ctx.currentTime + FADE_SEC, at + FADE_SEC);
      emit();
    },
    getSource: () => source,
    audition(id, startSec, endSec) {
      const c = ensureCtx();
      const t = tracks.get(id);
      if (!c || !t || playing) return;
      stopAudition();
      const local = Math.max(0, startSec - t.offsetSec);
      const dur = Math.max(0.05, Math.min(endSec - t.offsetSec, t.durationSec) - local);
      const src = c.createBufferSource();
      src.buffer = t.output;
      const env = c.createGain();
      const now = c.currentTime;
      env.gain.setValueAtTime?.(0, now);
      env.gain.linearRampToValueAtTime(1, now + 0.01);
      env.gain.setValueAtTime?.(1, now + Math.max(0.011, dur - 0.04));
      env.gain.linearRampToValueAtTime(0, now + dur);
      src.connect(env).connect(master!);
      src.start(now, local, dur);
      audition = { src, env };
    },
    duration: durationSec,
    setGuide(samples, sampleRate = 44100, offsetSec = 0) {
      this.removeTrack(GUIDE_ID);
      if (!samples || samples.length === 0) return;
      this.addTrack(GUIDE_ID, [samples], sampleRate, { offsetSec, volume: GUIDE_VOLUME });
      const g = tracks.get(GUIDE_ID);
      if (g) {
        g.guide = true;
        applyGains();
      }
      emit();
    },
    hasGuide: () => tracks.has(GUIDE_ID),
    setPolish(on) {
      if (on === polishOn) return;
      polishOn = on;
      route();
      emit();
    },
    getPolish: () => polishOn,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose() {
      for (const t of tracks.values()) stopVoice(t.voice);
      stopAudition();
      tracks.clear();
      playing = false;
      if (endTimer) clearTimeout(endTimer);
      listeners.clear();
      void ctx?.close();
      ctx = null;
    },
  };
}
