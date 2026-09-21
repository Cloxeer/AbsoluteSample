import type { NotesResult } from "./types";
import { mixEngine } from "./mixEngine";
import { samplePlayer } from "./samplePlayer";
import { nowPlaying } from "./nowPlaying";

export interface NotePlayerState {
  /** The source label of the currently loaded result, or null if nothing has been played yet. */
  id: string | null;
  currentTime: number;
  isPlaying: boolean;
}

type Listener = (state: NotePlayerState) => void;

type AudioContextFactory = () => AudioContext;

/** Linear attack ramp, matching the click-free envelopes used elsewhere in the app. */
const ATTACK_SEC = 0.005;
/** Release applied before a note's natural end, so notes don't click off abruptly. */
const RELEASE_SEC = 0.04;
const MASTER_GAIN = 0.3;

/**
 * Module-level WebAudio synth singleton that plays a NotesResult's notes as a simple triangle-wave
 * instrument, so the Notes tab's "Play" button walks through the piano roll instead of only letting
 * individual notes be clicked. Mirrors samplePlayer's/mixEngine's singleton + subscribe() pattern.
 */
class NotePlayerSingleton {
  private ctxFactory: AudioContextFactory;
  private _ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  private voices: { osc: OscillatorNode; gain: GainNode }[] = [];
  private listeners = new Set<Listener>();

  private _isPlaying = false;
  private startCtxTime = 0;
  private startOffset = 0;
  private position = 0;
  private result: NotesResult | null = null;
  private source = "";
  private rafId: number | null = null;

  /** Stable controller identity so nowPlaying doesn't treat pause/resume as a new source stopping the old one. */
  private controller = {
    pause: () => this.pause(),
    resume: () => this.resume(),
    stop: () => this.stop(),
  };

  constructor(ctxFactory?: AudioContextFactory) {
    this.ctxFactory = ctxFactory ?? (() => new AudioContext());
  }

  private ctx(): AudioContext {
    if (!this._ctx) {
      this._ctx = this.ctxFactory();
      this.masterGain = this._ctx.createGain();
      this.masterGain.gain.value = MASTER_GAIN;
      this.masterGain.connect(this._ctx.destination);
    }
    return this._ctx;
  }

  private freqForMidi(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  private stopVoices() {
    for (const { osc } of this.voices) {
      try {
        osc.stop();
      } catch {
        // already stopped/ended
      }
    }
    this.voices = [];
  }

  /** Schedules every note starting at or after `fromSec`, offset so the audible result starts "now". */
  play(result: NotesResult, fromSec: number, source = "Notes"): void {
    if (mixEngine.isPlaying) mixEngine.pause();
    samplePlayer.stop();

    const ctx = this.ctx();
    if (ctx.state === "suspended") void ctx.resume();

    this.stopVoices();
    this.result = result;
    this.source = source;
    this.startCtxTime = ctx.currentTime;
    this.startOffset = fromSec;
    this.position = fromSec;
    this._isPlaying = true;

    for (const note of result.notes) {
      if (note.endSec <= fromSec) continue; // already finished before the requested start
      const noteStartSec = Math.max(note.startSec, fromSec);
      const when = ctx.currentTime + (noteStartSec - fromSec);
      const noteEnd = ctx.currentTime + (note.endSec - fromSec);
      const releaseAt = Math.max(when, noteEnd - RELEASE_SEC);
      const peak = Math.max(0.001, Math.min(1, note.velocity / 127));

      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = this.freqForMidi(note.midi);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(peak, when + ATTACK_SEC);
      gain.gain.setValueAtTime(peak, releaseAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, Math.max(releaseAt + 0.001, noteEnd));

      osc.connect(gain).connect(this.masterGain!);
      osc.start(when);
      osc.stop(Math.max(when + 0.01, noteEnd + 0.01));
      this.voices.push({ osc, gain });
    }

    const duration = result.notes.length > 0 ? Math.max(...result.notes.map((n) => n.endSec)) : 0;
    nowPlaying.start("notes", `Notes: ${source}`, Math.max(0, duration - fromSec), this.controller);

    this.startTicking();
    this.emit();
  }

  pause(): void {
    if (!this._isPlaying) return;
    this.position = this.currentTime();
    this.stopVoices();
    this._isPlaying = false;
    this.stopTicking();
    this.emit();
  }

  resume(): void {
    if (!this.result) return;
    this.play(this.result, this.position, this.source);
  }

  stop(): void {
    this.stopVoices();
    this._isPlaying = false;
    this.position = 0;
    this.stopTicking();
    this.emit();
  }

  /** Derived arithmetically from ctx.currentTime, matching mixEngine's approach (never polled from oscillator state). */
  currentTime(): number {
    if (!this._isPlaying) return this.position;
    return this.startOffset + (this.ctx().currentTime - this.startCtxTime);
  }

  private tick = () => {
    if (!this._isPlaying) return;
    nowPlaying.tick(this.currentTime());
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

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  getState(): NotePlayerState {
    return { id: this.result ? this.source : null, currentTime: this.currentTime(), isPlaying: this._isPlaying };
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

export const notePlayer = new NotePlayerSingleton();
