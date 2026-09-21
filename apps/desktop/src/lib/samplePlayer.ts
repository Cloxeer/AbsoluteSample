import type { Sample } from "./types";
import { mixEngine } from "./mixEngine";
import { nowPlaying } from "./nowPlaying";

export interface SamplePlayerState {
  id: string | null;
  currentTime: number;
}

type Listener = (state: SamplePlayerState) => void;

/**
 * Module-level singleton: exactly one sample (or auditioned slice) plays at a time.
 * Calling play()/playSlice() stops whatever was playing before.
 */
class SamplePlayerSingleton {
  private audio: HTMLAudioElement | null = null;
  private currentId: string | null = null;
  private listeners = new Set<Listener>();
  private rafId: number | null = null;
  private endTime: number | null = null;
  /** True while this player is the source nowPlaying is tracking, so stop()/handleEnded() know whether to reset it. */
  private isNowPlayingSource = false;

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.addEventListener("ended", () => this.handleEnded());
    }
    return this.audio;
  }

  private handleEnded() {
    this.currentId = null;
    this.endTime = null;
    this.stopTicking();
    if (this.isNowPlayingSource) {
      this.isNowPlayingSource = false;
      nowPlaying.stop();
    }
    this.emit();
  }

  private tick = () => {
    if (!this.audio || this.currentId === null) return;
    if (this.endTime !== null && this.audio.currentTime >= this.endTime) {
      this.stop();
      return;
    }
    nowPlaying.tick(this.audio.currentTime);
    this.emit();
    this.rafId = requestAnimationFrame(this.tick);
  };

  private startTicking() {
    this.stopTicking();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopTicking() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private emit() {
    const state: SamplePlayerState = {
      id: this.currentId,
      currentTime: this.audio?.currentTime ?? 0,
    };
    for (const listener of this.listeners) listener(state);
  }

  /** Plays a sample from the start (or the given slice), stopping any previous playback first. */
  play(sample: Sample, url: string, opts?: { start?: number; end?: number }): void {
    this.playPath(sample.id, url, { ...opts, kind: "sample", label: sample.name });
  }

  /** Sibling of play(): auditions an arbitrary slice of a wav by url/id (e.g. a Beat Matrix pad), not requiring a full Sample. */
  playPath(
    id: string,
    url: string,
    opts?: { start?: number; end?: number; kind?: "sample" | "pad"; label?: string }
  ): void {
    this.stop();
    if (mixEngine.isPlaying) mixEngine.pause();
    const audio = this.ensureAudio();
    audio.src = url;
    audio.currentTime = opts?.start ?? 0;
    this.endTime = opts?.end ?? null;
    this.currentId = id;
    const kind = opts?.kind ?? "sample";
    const label = opts?.label ?? id;
    const duration = (opts?.end ?? 0) - (opts?.start ?? 0);
    nowPlaying.start(kind, label, duration > 0 ? duration : 0, {
      pause: () => this.audio?.pause(),
      resume: () => void this.audio?.play(),
      stop: () => this.stop(),
    });
    this.isNowPlayingSource = true;
    void audio.play();
    this.startTicking();
    this.emit();
  }

  /** Toggles playback of a slice for auditioning (e.g. Beat Matrix pads): same id + overlapping slice stops it. */
  isPlaying(id: string): boolean {
    return this.currentId === id;
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
    }
    this.currentId = null;
    this.endTime = null;
    this.stopTicking();
    if (this.isNowPlayingSource) {
      this.isNowPlayingSource = false;
      nowPlaying.stop();
    }
    this.emit();
  }

  getState(): SamplePlayerState {
    return { id: this.currentId, currentTime: this.audio?.currentTime ?? 0 };
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

export const samplePlayer = new SamplePlayerSingleton();
