import { mixEngine } from "./mixEngine";

export type NowPlayingKind = "mix" | "audition" | "sample" | "pad" | "source" | "loop" | "notes" | "vocal" | null;

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

/** What the big transport Play starts on a tab when nothing of that tab is loaded in the transport. */
export interface TabSource {
  kind: NowPlayingKind;
  label: string;
  start(): void;
}

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
  private tabSources = new Map<string, TabSource>();

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

  /** True while `controller` is the source the transport controls. */
  isCurrent(controller: NowPlayingController): boolean {
    return this.controller === controller;
  }

  /** A tab (e.g. Autotune) tells the transport what Play means there; null unregisters. */
  setTabSource(tab: string, source: TabSource | null): void {
    if (source) this.tabSources.set(tab, source);
    else this.tabSources.delete(tab);
    this.setState({});
  }

  /**
   * The transport's Play/Pause on `tab`: pauses whatever plays; otherwise resumes the paused source
   * if it belongs here, else starts this tab's own source (e.g. the Autotune vocals), else
   * `fallback` (the stem mix). One switch, no guessing.
   */
  toggle(tab: string, fallback: () => void): void {
    const st = this.state;
    if (st.isPlaying) {
      this.pause();
      return;
    }
    const own = this.tabSources.get(tab) ?? null;
    const foreign = st.kind !== null && [...this.tabSources.entries()].some(([t, s]) => t !== tab && s.kind === st.kind);
    if (own && st.kind !== own.kind) own.start();
    else if (st.kind !== null && !foreign) this.resume();
    else if (own) own.start();
    else fallback();
  }

  tabSource(tab: string): TabSource | null {
    return this.tabSources.get(tab) ?? null;
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
