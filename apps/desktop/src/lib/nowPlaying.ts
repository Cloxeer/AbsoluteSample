import { mixEngine } from "./mixEngine";

export type NowPlayingKind = "mix" | "audition" | "sample" | "pad" | "source" | "loop" | "notes" | null;

export interface NowPlayingState {
  kind: NowPlayingKind;
  label: string;
  time: number;
  duration: number;
  isPlaying: boolean;
}

export interface NowPlayingController {
  pause(): void;
  resume(): void;
  stop(): void;
}

type Listener = (state: NowPlayingState) => void;

const initialState: NowPlayingState = {
  kind: null,
  label: "",
  time: 0,
  duration: 0,
  isPlaying: false,
};

/**
 * Module-level singleton tracking whichever single audio source is currently "now playing",
 * across the mix engine, sample/pad auditions, the region-selector source, and loop preview.
 * Starting a new source stops whatever controller was previously active (unless it's the same
 * source being re-started), so only one thing is ever audible/considered "playing" at a time
 * from the transport's point of view.
 */
class NowPlayingSingleton {
  private state: NowPlayingState = { ...initialState };
  private listeners = new Set<Listener>();
  private controller: NowPlayingController | null = null;

  getState(): NowPlayingState {
    return this.state;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    for (const listener of this.listeners) listener(this.state);
  }

  private setState(patch: Partial<NowPlayingState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  start(kind: NowPlayingKind, label: string, duration: number, controller: NowPlayingController): void {
    // Only stop a *different* source. The mix/audition controllers are re-created per render,
    // so compare by kind too: restarting the same engine must not reset its seek position.
    if (this.controller && this.controller !== controller && this.state.kind !== kind) {
      this.controller.stop();
    }
    this.controller = controller;
    this.setState({ kind, label, duration, time: 0, isPlaying: true });
  }

  tick(time: number): void {
    this.setState({ time });
  }

  setPlaying(playing: boolean): void {
    this.setState({ isPlaying: playing });
  }

  pause(): void {
    this.controller?.pause();
    this.setState({ isPlaying: false });
  }

  resume(): void {
    this.controller?.resume();
    this.setState({ isPlaying: true });
  }

  stop(): void {
    const controller = this.controller;
    this.controller = null;
    controller?.stop();
    this.setState({ kind: null, label: "", time: 0, isPlaying: false });
  }
}

export const nowPlaying = new NowPlayingSingleton();

/** Estimated output latency, in seconds, of the shared mix engine's AudioContext (0 before one exists). */
export function outputLatency(): number {
  return mixEngine.outputLatency();
}
