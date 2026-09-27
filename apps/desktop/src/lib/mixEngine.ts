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

/**
 * v11: a derived track is a recipe over other tracks' decoded audio: sum(plus) - sum(minus), where the
 * special id "mix" (the source mix) is scaled by mixGain. Computed by exact sample math, no file needed.
 */
export interface DerivedSpec {
  plus: string[];
  minus: string[];
  mixGain?: number | null;
}

export interface MixTrackDef {
  id: string;
  /** Audio to fetch + decode (cached by url). Omit for a derived track. */
  url?: string;
  /** Derived track recipe; its inputs are other defs' ids in the same load() call. */
  derive?: DerivedSpec;
  /** Loaded only as an input for derived tracks (e.g. the source "mix"), never played. */
  hidden?: boolean;
}

/** The id of the source-mix def that derived recipes reference. */
export const MIX_ID = "mix";

interface DerivedCacheEntry {
  spec: string;
  inputs: AudioBuffer[];
  buffer: AudioBuffer;
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

  /** Decoded audio by url. */
  private buffers = new Map<string, AudioBuffer>();
  /** Derived buffers by track id, reused while the recipe and its input buffers are unchanged. */
  private derivedCache = new Map<string, DerivedCacheEntry>();
  /** The buffer each currently loaded track plays (url-decoded or derived). */
  private trackBuffers = new Map<string, AudioBuffer>();
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
    const urls = Array.from(new Set(defs.filter((d) => d.url && !d.derive).map((d) => d.url as string)));
    const decoded = await Promise.all(
      urls.map(async (url) => {
        const cached = this.buffers.get(url);
        if (cached) return [url, cached] as const;
        const res = await fetch(url);
        const arrayBuffer = await res.arrayBuffer();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        return [url, buffer] as const;
      })
    );

    if (generation !== this.loadGeneration) return; // superseded by a newer load()

    for (const [url, buffer] of decoded) this.buffers.set(url, buffer);

    const byId = new Map(defs.map((d) => [d.id, d] as const));
    const resolved = new Map<string, AudioBuffer | null>();
    const resolve = (id: string, stack: string[]): AudioBuffer | null => {
      if (resolved.has(id)) return resolved.get(id)!;
      const def = byId.get(id);
      let buf: AudioBuffer | null = null;
      if (def && !def.derive && def.url) {
        buf = this.buffers.get(def.url) ?? null;
      } else if (def?.derive && !stack.includes(id)) {
        buf = this.deriveBuffer(id, def.derive, (inputId) => resolve(inputId, [...stack, id]));
      }
      resolved.set(id, buf);
      return buf;
    };

    this.trackBuffers = new Map();
    for (const d of defs) {
      const buf = resolve(d.id, []);
      if (buf) this.trackBuffers.set(d.id, buf);
    }
    this.tracks = defs.filter((d) => !d.hidden);
    for (const d of this.tracks) this.gainFor(d.id);
  }

  /**
   * Builds (or reuses) a derived track's buffer by exact per-sample math over its inputs'
   * already-decoded buffers: out = sum(plus, "mix" scaled by mixGain) - sum(minus).
   * Returns null when an input is missing. Cached per id until the recipe or any input buffer changes.
   */
  private deriveBuffer(id: string, spec: DerivedSpec, input: (id: string) => AudioBuffer | null): AudioBuffer | null {
    const gain = spec.mixGain ?? 1;
    const terms: { buf: AudioBuffer; scale: number }[] = [];
    for (const p of spec.plus) {
      const buf = input(p);
      if (!buf) return null;
      terms.push({ buf, scale: p === MIX_ID ? gain : 1 });
    }
    for (const m of spec.minus) {
      const buf = input(m);
      if (!buf) return null;
      terms.push({ buf, scale: m === MIX_ID ? -gain : -1 });
    }
    if (terms.length === 0) return null;
    const specKey = JSON.stringify([spec.plus, spec.minus, gain]);
    const inputs = terms.map((t) => t.buf);
    const cached = this.derivedCache.get(id);
    if (cached && cached.spec === specKey && cached.inputs.length === inputs.length && cached.inputs.every((b, i) => b === inputs[i])) {
      return cached.buffer;
    }
    const channels = Math.max(...inputs.map((b) => b.numberOfChannels));
    const length = Math.max(...inputs.map((b) => b.length));
    const out = this.ctx().createBuffer(channels, length, inputs[0].sampleRate);
    for (let c = 0; c < channels; c++) {
      const dst = out.getChannelData(c);
      for (const { buf, scale } of terms) {
        const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        const n = Math.min(src.length, dst.length);
        for (let i = 0; i < n; i++) dst[i] += scale * src[i];
      }
    }
    this.derivedCache.set(id, { spec: specKey, inputs, buffer: out });
    return out;
  }

  /** Drops a decoded url (e.g. a stem file replaced by a new version after Enhance). */
  forget(url: string): void {
    const buf = this.buffers.get(url);
    this.buffers.delete(url);
    if (!buf) return;
    for (const [id, entry] of this.derivedCache) {
      if (entry.inputs.includes(buf)) this.derivedCache.delete(id);
    }
  }

  /** The buffer a loaded track plays (tests/inspection). */
  bufferFor(id: string): AudioBuffer | null {
    return this.trackBuffers.get(id) ?? null;
  }

  private longestTrackId(): string | null {
    let bestId: string | null = null;
    let bestDur = -1;
    for (const d of this.tracks) {
      const buf = this.trackBuffers.get(d.id);
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
      const buffer = this.trackBuffers.get(d.id);
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
