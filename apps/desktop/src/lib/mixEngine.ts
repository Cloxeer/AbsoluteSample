/**
 * Sample-accurate mix playback via the Web Audio API.
 *
 * Replaces the old approach of playing one HTMLMediaElement per stem (via wavesurfer) and
 * periodically re-syncing them when they drift: independent media elements drift by several ms
 * between resyncs, which comb-filters the summed stems into a buzzy/smeared sound.
 *
 * Instead, every track's AudioBuffer is started from a single AudioBufferSourceNode, all
 * scheduled to start at the *exact same* `ctx.currentTime`, so they stay phase-locked for the
 * whole playback (no per-frame resync needed). Per-track gain is a GainNode; the transport clock
 * is derived arithmetically from `ctx.currentTime`, never read back from a node's own state.
 */

export interface MixTrackDef {
  id: string;
  url: string;
}

type AudioContextFactory = () => AudioContext;

/** How far into the future playback is scheduled to start, so all sources share one exact start time. */
const START_LATENCY_SEC = 0.05;
/** Short ramp used for gain changes, to avoid audible clicks/pops. */
const GAIN_RAMP_SEC = 0.02;
/** Every start, stop, seek and loop seam fades over this long, so playback never clicks. */
const FADE_SEC = 0.008;

/** Glides an AudioParam from its CURRENT value to `value`. Anchoring first matters: a bare
 * linearRamp starts from the last scheduled event (possibly long ago), which jumps = click. */
function glide(param: AudioParam, value: number, now: number, dur: number): void {
  param.cancelScheduledValues?.(now);
  param.setValueAtTime?.(param.value, now);
  param.linearRampToValueAtTime(value, now + dur);
}

export class MixEngine {
  private ctxFactory: AudioContextFactory;
  private _ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  private buffers = new Map<string, AudioBuffer>();
  private tracks: MixTrackDef[] = [];
  private gains = new Map<string, GainNode>();
  private sources = new Map<string, AudioBufferSourceNode>();
  /** Per-play fade envelope for each source (source -> envelope -> track gain). */
  private envelopes = new Map<string, GainNode>();

  private _isPlaying = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private position = 0;
  private loop = false;

  private loadGeneration = 0;
  private playGeneration = 0;
  private endedCb: (() => void) | null = null;

  constructor(ctxFactory?: AudioContextFactory) {
    this.ctxFactory = ctxFactory ?? (() => new AudioContext());
  }

  private ctx(): AudioContext {
    if (!this._ctx) {
      this._ctx = this.ctxFactory();
      this.masterGain = this._ctx.createGain();
      this.masterGain.connect(this._ctx.destination);
    }
    return this._ctx;
  }

  private gainFor(id: string): GainNode {
    let g = this.gains.get(id);
    if (!g) {
      g = this.ctx().createGain();
      g.connect(this.masterGain!);
      this.gains.set(id, g);
    }
    return g;
  }

  /**
   * Fetches + decodes every track's audio, caching AudioBuffers by url. If a later load() call
   * starts before this one finishes, this call's result is discarded (never clobbers newer state).
   */
  async load(defs: MixTrackDef[]): Promise<void> {
    const generation = ++this.loadGeneration;
    const ctx = this.ctx();
    const decoded = await Promise.all(
      defs.map(async (d) => {
        const cached = this.buffers.get(d.url);
        if (cached) return [d.url, cached] as const;
        const res = await fetch(d.url);
        const arrayBuffer = await res.arrayBuffer();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        return [d.url, buffer] as const;
      })
    );

    if (generation !== this.loadGeneration) return; // superseded by a newer load()

    for (const [url, buffer] of decoded) this.buffers.set(url, buffer);
    this.tracks = defs;
    for (const d of defs) this.gainFor(d.id);
  }

  private longestTrackId(): string | null {
    let bestId: string | null = null;
    let bestDur = -1;
    for (const d of this.tracks) {
      const buf = this.buffers.get(d.url);
      if (buf && buf.duration > bestDur) {
        bestDur = buf.duration;
        bestId = d.id;
      }
    }
    return bestId;
  }

  /** Fades every playing source out over FADE_SEC, then stops it (never a hard cut). */
  private stopSources() {
    const ctx = this._ctx;
    const now = ctx ? ctx.currentTime : 0;
    for (const [id, src] of this.sources) {
      const env = this.envelopes.get(id);
      src.onended = null;
      try {
        if (env && ctx) {
          glide(env.gain, 0, now, FADE_SEC);
          src.stop(now + FADE_SEC + 0.002);
          src.onended = () => env.disconnect?.();
        } else {
          src.stop();
        }
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.envelopes.clear();
  }

  /** Starts every loaded track's source simultaneously, offset to `fromSec` into each buffer. */
  play(fromSec: number): void {
    const ctx = this.ctx();
    if (ctx.state === "suspended") void ctx.resume();

    this.stopSources();
    const generation = ++this.playGeneration;
    const startAt = ctx.currentTime + START_LATENCY_SEC;
    this.startCtxTime = startAt;
    this.startOffset = fromSec;
    this.position = fromSec;

    const longestId = this.longestTrackId();

    for (const d of this.tracks) {
      const buffer = this.buffers.get(d.url);
      if (!buffer) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // Fade in at the start and out just before the natural end (loop seams included).
      const env = ctx.createGain();
      env.gain.setValueAtTime?.(0, startAt);
      env.gain.linearRampToValueAtTime(1, startAt + FADE_SEC);
      src.connect(env);
      env.connect(this.gainFor(d.id));
      this.envelopes.set(d.id, env);

      if (d.id === longestId) {
        src.onended = () => {
          if (generation !== this.playGeneration) return; // stopped/superseded, not a natural end
          this.handleEnded();
        };
      }

      const offset = Math.min(Math.max(0, fromSec), Math.max(0, buffer.duration - 0.0001));
      const remaining = buffer.duration - offset;
      if (remaining > 3 * FADE_SEC) {
        env.gain.setValueAtTime?.(1, startAt + remaining - FADE_SEC);
        env.gain.linearRampToValueAtTime(0, startAt + remaining);
      }
      src.start(startAt, offset);
      this.sources.set(d.id, src);
    }

    this._isPlaying = true;
  }

  private handleEnded(): void {
    if (this.loop) {
      this.play(0);
    } else {
      this.stopSources();
      this._isPlaying = false;
      this.position = 0;
      this.playGeneration++;
    }
    this.endedCb?.();
  }

  pause(): void {
    if (!this._isPlaying) return;
    this.position = this.currentTime();
    this.stopSources();
    this._isPlaying = false;
    this.playGeneration++;
  }

  /** If playing, stops and restarts every track at the new offset (same simultaneous-start technique). If paused, just remembers the position. */
  seek(sec: number): void {
    if (this._isPlaying) {
      this.play(sec);
    } else {
      this.position = sec;
    }
  }

  stop(): void {
    this.stopSources();
    this._isPlaying = false;
    this.position = 0;
    this.playGeneration++;
  }

  setGain(id: string, gain: number): void {
    const g = this.gainFor(id);
    const ctx = this.ctx();
    glide(g.gain, gain, ctx.currentTime, GAIN_RAMP_SEC);
  }

  setMaster(gain: number): void {
    const ctx = this.ctx();
    this.ctx(); // ensure masterGain exists
    glide(this.masterGain!.gain, gain, ctx.currentTime, GAIN_RAMP_SEC);
  }

  /** Derived arithmetically from ctx.currentTime, never from a node's own playback state. */
  currentTime(): number {
    if (!this._isPlaying) return this.position;
    return this.startOffset + (this.ctx().currentTime - this.startCtxTime);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  onEnded(cb: (() => void) | null): void {
    this.endedCb = cb;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /** Estimated output latency in seconds; 0 if no AudioContext has been created yet. */
  outputLatency(): number {
    if (!this._ctx) return 0;
    return this._ctx.outputLatency || this._ctx.baseLatency || 0;
  }
}

/** Shared singleton used by the app; tests construct their own MixEngine with a fake AudioContext. */
export const mixEngine = new MixEngine();
