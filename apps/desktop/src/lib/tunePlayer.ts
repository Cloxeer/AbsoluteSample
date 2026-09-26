/**
 * Web Audio player for the Autotune editor: holds the ORIGINAL and the tuned OUTPUT buffers, plays
 * either one (instant A/B while playing), accepts patches into the output after each edit, and plays
 * short audition snippets without touching the playhead.
 */
import { mixToMono } from "./melodyneEditor";

export type PlaySource = "original" | "tuned";

/** Sample rate the editor works at (decoded audio is resampled to this by Web Audio). */
export const EDITOR_SAMPLE_RATE = 44100;

/** Decodes any browser-supported audio file and mixes it to mono at `sampleRate`. */
export async function decodeToMono(bytes: ArrayBuffer, sampleRate = EDITOR_SAMPLE_RATE): Promise<{ samples: Float32Array; sampleRate: number }> {
  const OAC: typeof OfflineAudioContext | undefined =
    typeof window !== "undefined"
      ? (window.OfflineAudioContext ??
        (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext)
      : undefined;
  if (!OAC) throw new Error("This browser cannot decode audio.");
  const ctx = new OAC(1, 1, sampleRate);
  const buf = await ctx.decodeAudioData(bytes);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  return { samples: mixToMono(channels), sampleRate: buf.sampleRate };
}

export interface TunePlayer {
  /** Loads mono audio; the output starts as a copy of the original. */
  load(original: Float32Array, sampleRate: number): void;
  /** Writes re-rendered samples into the output buffer (restarts playback if playing so it is heard). */
  patch(startSample: number, samples: Float32Array): void;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  /** Playhead position in seconds. */
  currentTime(): number;
  seek(sec: number): void;
  setSource(which: PlaySource): void;
  getSource(): PlaySource;
  /** Plays [startSec, endSec) of the tuned output on a separate voice; the playhead does not move. */
  audition(startSec: number, endSec: number): void;
  duration(): number;
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

type Ctx = AudioContext;

/** Web Audio typings want ArrayBuffer-backed arrays; ours always are. */
const abuf = (a: Float32Array) => a as Float32Array<ArrayBuffer>;

export function createTunePlayer(): TunePlayer {
  const AC: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  let ctx: Ctx | null = null;
  let original: AudioBuffer | null = null;
  let output: AudioBuffer | null = null;
  let sr = 44100;
  let length = 0;
  let source: PlaySource = "tuned";
  let node: AudioBufferSourceNode | null = null;
  let playing = false;
  let startCtxTime = 0;
  let startPos = 0;
  let pos = 0;
  let audition: { node: AudioBufferSourceNode; gain: GainNode } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const ensureCtx = (): Ctx | null => {
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  };

  const durationSec = () => (length > 0 ? length / sr : 0);

  const livePos = () => {
    if (!playing || !ctx) return pos;
    return Math.min(durationSec(), startPos + (ctx.currentTime - startCtxTime));
  };

  const stopNode = () => {
    if (!node) return;
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
    node.disconnect();
    node = null;
  };

  const startAt = (sec: number) => {
    const c = ensureCtx();
    const buf = source === "original" ? original : output;
    if (!c || !buf) return;
    stopNode();
    const n = c.createBufferSource();
    n.buffer = buf;
    n.connect(c.destination);
    const from = Math.max(0, Math.min(durationSec(), sec));
    n.onended = () => {
      if (node !== n) return;
      node = null;
      playing = false;
      pos = 0;
      emit();
    };
    n.start(0, from);
    node = n;
    startCtxTime = c.currentTime;
    startPos = from;
    playing = true;
  };

  const stopAudition = () => {
    if (!audition) return;
    try {
      audition.node.stop();
    } catch {
      /* noop */
    }
    audition.node.disconnect();
    audition.gain.disconnect();
    audition = null;
  };

  return {
    load(mono, sampleRate) {
      this.pause();
      stopAudition();
      pos = 0;
      sr = sampleRate;
      length = mono.length;
      const c = ensureCtx();
      if (!c || mono.length === 0) {
        original = output = null;
        emit();
        return;
      }
      original = c.createBuffer(1, mono.length, sampleRate);
      original.copyToChannel(abuf(mono), 0);
      output = c.createBuffer(1, mono.length, sampleRate);
      output.copyToChannel(abuf(mono), 0);
      emit();
    },
    patch(startSample, samples) {
      if (!output) return;
      const start = Math.max(0, Math.round(startSample));
      const skip = start - Math.round(startSample);
      const count = Math.max(0, Math.min(samples.length - skip, output.length - start));
      if (count <= 0) return;
      output.copyToChannel(abuf(samples.subarray(skip, skip + count)), 0, start);
      // An already-started source keeps the data it acquired; restart so the edit is heard right away.
      if (playing && source === "tuned") startAt(livePos());
    },
    play() {
      if (playing) return;
      startAt(pos >= durationSec() - 0.01 ? 0 : pos);
      emit();
    },
    pause() {
      if (!playing) return;
      pos = livePos();
      stopNode();
      playing = false;
      emit();
    },
    isPlaying: () => playing,
    currentTime: livePos,
    seek(sec) {
      pos = Math.max(0, Math.min(durationSec(), sec));
      if (playing) startAt(pos);
      emit();
    },
    setSource(which) {
      if (which === source) return;
      const at = livePos();
      source = which;
      if (playing) startAt(at);
      emit();
    },
    getSource: () => source,
    audition(startSec, endSec) {
      const c = ensureCtx();
      if (!c || !output || playing) return;
      stopAudition();
      const from = Math.max(0, Math.min(durationSec(), startSec));
      const dur = Math.max(0.05, Math.min(endSec, durationSec()) - from);
      const n = c.createBufferSource();
      n.buffer = output;
      const g = c.createGain();
      const t = c.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.01);
      g.gain.setValueAtTime(1, t + Math.max(0.011, dur - 0.04));
      g.gain.linearRampToValueAtTime(0, t + dur);
      n.connect(g).connect(c.destination);
      n.start(t, from, dur);
      audition = { node: n, gain: g };
      n.onended = () => {
        if (audition?.node === n) audition = null;
      };
    },
    duration: durationSec,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose() {
      stopNode();
      stopAudition();
      playing = false;
      listeners.clear();
      void ctx?.close();
      ctx = null;
    },
  };
}
