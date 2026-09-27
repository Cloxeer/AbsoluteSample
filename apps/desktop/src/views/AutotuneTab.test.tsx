import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutotuneTab, type AutotuneDeps } from "./AutotuneTab";
import { backend } from "@/lib/backend";
import { FALLBACK_WIDTH } from "@/components/autotune/NoteCanvas";
import {
  blobProfile,
  computeLayout,
  fitViewport,
  midiToY,
  referenceDb,
  timeToX,
  type Analysis,
  type EngineNote,
  type NoteEdit,
} from "@/lib/melodyneEditor";
import type { EditResult, PitchEngine } from "@/lib/pitchEngine";
import type { MultiTrackPlayer, PlaySource, TrackInfo as PlayerTrack } from "@/lib/multiTrackPlayer";
import type { DecodedTrack, SourceFormat } from "@/lib/audioFormat";
import type { InstrumentStem } from "@/lib/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

const HOP = 0.01;
const DURATION = 4;
const FRAMES = DURATION / HOP;

function mkNotes(centers: [number, number]): EngineNote[] {
  const mk = (startFrame: number, endFrame: number, center: number): EngineNote => ({
    startFrame,
    endFrame,
    startSec: startFrame * HOP,
    endSec: endFrame * HOP,
    center,
    target: center,
    drift: 1,
    modulation: 1,
    peakDb: -6,
  });
  return [mk(50, 150, centers[0]), mk(200, 300, centers[1])];
}

// 61.2 = C#4 +20 cents (nearest C-major note: D4); 64.3 = E4 +30 cents.
function baseNotes(): EngineNote[] {
  return mkNotes([61.2, 64.3]);
}

/** In-process stand-in for the wasm PitchSession (jsdom has no Worker / wasm). */
function makeFakeEngine(initial: () => EngineNote[] = baseNotes, rendered: Float32Array[] = [new Float32Array(DURATION * 44100)]) {
  let notes = initial();
  const db = new Array(FRAMES).fill(-60).map((v, f) => (notes.some((n) => f >= n.startFrame && f <= n.endFrame) ? -6 : v));
  const analysis = (): Analysis => {
    const pitch: (number | null)[] = new Array(FRAMES).fill(null);
    const editedPitch: (number | null)[] = new Array(FRAMES).fill(null);
    for (const n of initial()) for (let f = n.startFrame; f <= n.endFrame; f++) pitch[f] = n.center;
    for (const n of notes) for (let f = n.startFrame; f <= n.endFrame; f++) editedPitch[f] = n.target;
    return { hopSec: HOP, durationSec: DURATION, pitch, editedPitch, db, notes: notes.map((n) => ({ ...n })), key: { tonic: "C", mode: "major", confidence: 0.9 } };
  };
  const result = (): EditResult => ({ ok: true, analysis: analysis(), patches: [{ startSec: 0.4, samples: new Float32Array(441).fill(0.1) }] });
  const engine = {
    load: vi.fn(async (_mono?: Float32Array, _sr?: number, _channels?: Float32Array[]) => analysis()),
    setNotes: vi.fn(async (edits: NoteEdit[]) => {
      for (const e of edits) notes[e.index] = { ...notes[e.index], target: e.target, drift: e.drift, modulation: e.modulation };
      return result();
    }),
    split: vi.fn(async (i: number, sec: number) => {
      const n = notes[i];
      const f = Math.round(sec / HOP);
      const a = { ...n, endFrame: f, endSec: f * HOP };
      const b = { ...n, startFrame: f, startSec: f * HOP };
      notes = [...notes.slice(0, i), a, b, ...notes.slice(i + 1)];
      return result();
    }),
    merge: vi.fn(async (i: number) => {
      const a = notes[i];
      const b = notes[i + 1];
      notes = [...notes.slice(0, i), { ...a, endFrame: b.endFrame, endSec: b.endSec }, ...notes.slice(i + 2)];
      return result();
    }),
    renderAll: vi.fn(async () => new Float32Array(DURATION * 44100)),
    renderAllChannels: vi.fn(async () => rendered),
    dispose: vi.fn(),
  } satisfies PitchEngine;
  return engine;
}

function makeFakePlayer() {
  let pos = 0;
  let playing = false;
  let src: PlaySource = "tuned";
  const tracks = new Map<string, PlayerTrack>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const set = (id: string, patch: Partial<PlayerTrack>) => {
    const t = tracks.get(id);
    if (t) tracks.set(id, { ...t, ...patch });
    emit();
  };
  const player = {
    addTrack: vi.fn((id: string, channels: Float32Array[], sampleRate: number, opts: Partial<PlayerTrack> = {}) => {
      tracks.set(id, { id, offsetSec: 0, volume: 1, muted: false, solo: false, ...opts, durationSec: channels[0].length / sampleRate });
      emit();
    }),
    removeTrack: vi.fn((id: string) => {
      tracks.delete(id);
      emit();
    }),
    tracks: () => [...tracks.values()],
    setOffset: vi.fn((id: string, offsetSec: number) => set(id, { offsetSec })),
    setVolume: vi.fn((id: string, volume: number) => set(id, { volume })),
    setMuted: vi.fn((id: string, muted: boolean) => set(id, { muted })),
    setSolo: vi.fn((id: string, solo: boolean) => set(id, { solo })),
    patch: vi.fn(),
    play: vi.fn(() => {
      playing = true;
      emit();
    }),
    pause: vi.fn(() => {
      playing = false;
      emit();
    }),
    isPlaying: () => playing,
    currentTime: () => pos,
    seek: vi.fn((s: number) => {
      pos = s;
      emit();
    }),
    setSource: vi.fn((w: PlaySource) => {
      src = w;
      emit();
    }),
    getSource: () => src,
    audition: vi.fn(),
    duration: () => DURATION,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose: vi.fn(),
  } satisfies MultiTrackPlayer;
  return player;
}

const WAV16: SourceFormat = { container: "wav", sampleRate: 44100, channels: 1, bitDepth: 16, float: false };

function decoded(frames = DURATION * 44100, opts: { channels?: number; sampleRate?: number; format?: SourceFormat } = {}): DecodedTrack {
  const nch = opts.channels ?? 1;
  const channels = Array.from({ length: nch }, () => new Float32Array(frames).fill(0.01));
  return { channels, mono: channels[0], sampleRate: opts.sampleRate ?? 44100, format: opts.format ?? WAV16 };
}

const instruments: InstrumentStem[] = [
  {
    key: "vocals",
    label: "Vocals",
    group: "vocals",
    parent: null,
    path: "mock/t1/instruments/vocals.wav",
    bytes: 1000,
    peakDb: -2,
    rmsDb: -14,
    model: "htdemucs_6s",
    order: 0,
  },
];

beforeAll(() => {
  // jsdom has no PointerEvent: without it fireEvent.pointer* drops clientX/clientY and modifier keys.
  if (typeof window.PointerEvent === "undefined") {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  }
  // jsdom has no canvas; drawing is skipped when there is no 2D context.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});

afterEach(() => vi.restoreAllMocks());

/** Geometry the editor uses right after loading (fit view at the fallback width). */
function geometry(notes: EngineNote[] = baseNotes()) {
  const layout = computeLayout(FALLBACK_WIDTH);
  const vp = fitViewport(notes, DURATION, layout);
  const db = new Array(FRAMES).fill(-60).map((v, f) => (notes.some((n) => f >= n.startFrame && f <= n.endFrame) ? -6 : v));
  const profiles = notes.map((n) => blobProfile(n, db, referenceDb(db)));
  const at = (i: number, pitch = notes[i].target) => ({
    clientX: timeToX((notes[i].startSec + notes[i].endSec) / 2, vp, layout),
    clientY: midiToY(pitch, vp, layout),
  });
  return { layout, vp, notes, profiles, at };
}

async function setup(extra: Partial<AutotuneDeps> = {}) {
  const engine = makeFakeEngine();
  const player = makeFakePlayer();
  const decode = vi.fn(async (_src: unknown) => decoded());
  const deps: Partial<AutotuneDeps> = { createEngine: () => engine, createPlayer: () => player, decode, ...extra };
  const utils = render(<AutotuneTab track={null} instruments={instruments} samples={[]} deps={deps} />);
  fireEvent.change(screen.getByRole("combobox", { name: /vocal from this song/i }), { target: { value: instruments[0].path } });
  const canvas = await screen.findByTestId("autotune-editor");
  return { ...utils, engine, player, decode, canvas };
}

function readout() {
  return screen.getByTestId("autotune-readout");
}

function click(canvas: HTMLElement, pt: { clientX: number; clientY: number }, opts: Record<string, unknown> = {}) {
  fireEvent.pointerDown(canvas, { ...pt, pointerId: 1, button: 0, ...opts });
  fireEvent.pointerUp(canvas, { ...pt, pointerId: 1, button: 0, ...opts });
}

describe("AutotuneTab (Melodyne-style editor)", () => {
  it("shows the empty state before a source is picked", () => {
    render(<AutotuneTab track={null} instruments={instruments} samples={[]} deps={{ createEngine: () => makeFakeEngine(), createPlayer: makeFakePlayer }} />);
    expect(screen.getByText(/drop your vocal or pick one from the song/i)).toBeInTheDocument();
    expect(screen.queryByTestId("autotune-editor")).toBeNull();
  });

  it("analyses with the in-browser engine, never the Python backend", async () => {
    const analyze = vi.spyOn(backend, "analyzePitch");
    const apply = vi.spyOn(backend, "applyAutotune");
    const { engine, decode, player } = await setup();
    expect(decode).toHaveBeenCalledWith(expect.objectContaining({ path: instruments[0].path, kind: "song" }));
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(player.addTrack).toHaveBeenCalledTimes(1);
    expect(analyze).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByText(/detected: c major/i)).toBeInTheDocument();
    expect(screen.getByText(/2 notes/i)).toBeInTheDocument();
    expect(screen.getByText(/drag a note up or down; it snaps to the song's key/i)).toBeInTheDocument();
  });

  it("shows an analyzing state while the engine works", async () => {
    let release: (a: Analysis) => void = () => {};
    const engine = makeFakeEngine();
    engine.load.mockImplementationOnce(() => new Promise<Analysis>((r) => (release = r)));
    render(
      <AutotuneTab
        track={null}
        instruments={instruments}
        samples={[]}
        deps={{ createEngine: () => engine, createPlayer: makeFakePlayer, decode: async () => decoded(44100) }}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: /vocal from this song/i }), { target: { value: instruments[0].path } });
    expect(await screen.findByText(/analyzing vocal/i)).toBeInTheDocument();
    const a = await makeFakeEngine().load();
    await act(async () => release(a));
    expect(await screen.findByTestId("autotune-editor")).toBeInTheDocument();
  });

  it("uses a dropped File directly (web build)", async () => {
    const decode = vi.fn(async (_src: unknown) => decoded(44100));
    const created = vi.fn(() => "blob:fake");
    Object.defineProperty(URL, "createObjectURL", { value: created, configurable: true, writable: true });
    const { container } = render(
      <AutotuneTab track={null} instruments={instruments} samples={[]} deps={{ createEngine: () => makeFakeEngine(), createPlayer: makeFakePlayer, decode }} />
    );
    const file = new File([new Uint8Array(8)], "my-vocal.wav", { type: "audio/wav" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByTestId("autotune-editor");
    expect(decode).toHaveBeenCalledWith(expect.objectContaining({ kind: "own", file, label: "my-vocal.wav" }));
  });

  it("clicking a blob selects it and the inspector shows note + cents", async () => {
    const { canvas } = await setup();
    const g = geometry();
    // With nothing selected the panel follows the playhead (no "click a note" instruction).
    expect(screen.getByText(/^(Note at playhead|Next note)$/)).toBeInTheDocument();
    expect(readout()).not.toHaveTextContent(/click a note/i);
    click(canvas, g.at(1));
    expect(screen.getByText("Selected note")).toBeInTheDocument();
    expect(readout()).toHaveTextContent("E4");
    expect(readout()).toHaveTextContent("+30 cents");
    // clicking empty grid deselects and the panel goes back to the playhead note
    click(canvas, { clientX: g.at(1).clientX, clientY: midiToY(58, g.vp, g.layout) });
    expect(screen.getByText(/^(Note at playhead|Next note)$/)).toBeInTheDocument();
  });

  it("shift-click adds to the selection", async () => {
    const { canvas } = await setup();
    const g = geometry();
    click(canvas, g.at(0));
    click(canvas, g.at(1), { shiftKey: true });
    expect(readout()).toHaveTextContent("+1 more");
  });

  it("marquee selects notes", async () => {
    const { canvas } = await setup();
    const g = geometry();
    const x0 = timeToX(0.2, g.vp, g.layout);
    const x1 = timeToX(3.5, g.vp, g.layout);
    fireEvent.pointerDown(canvas, { clientX: x0, clientY: midiToY(67, g.vp, g.layout), pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: x1, clientY: midiToY(59, g.vp, g.layout), pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(canvas, { clientX: x1, clientY: midiToY(59, g.vp, g.layout), pointerId: 1 });
    expect(readout()).toHaveTextContent("+1 more");
  });

  it("dragging a note snaps its center exactly onto a scale note, auditions it, and never moves the playhead", async () => {
    const { canvas, engine, player } = await setup();
    const g = geometry();
    const start = g.at(0);
    const timeBefore = player.currentTime();
    fireEvent.pointerDown(canvas, { ...start, pointerId: 1, button: 0 });
    // 0.9 semitone up from 61.2 -> 62.1 -> snaps to D4 (62) in C major
    const y = start.clientY - 0.9 * g.vp.rowPx;
    fireEvent.pointerMove(canvas, { clientX: start.clientX + 40, clientY: y, pointerId: 1, buttons: 1 });
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalled());
    expect(engine.setNotes.mock.calls[0][0]).toEqual([{ index: 0, target: 62, drift: 1, modulation: 1 }]);
    await waitFor(() => expect(player.audition).toHaveBeenCalled());
    fireEvent.pointerUp(canvas, { clientX: start.clientX + 40, clientY: y, pointerId: 1 });
    await waitFor(() => expect(readout()).toHaveTextContent("D4"));
    expect(readout()).toHaveTextContent("0 cents");
    const last = engine.setNotes.mock.calls[engine.setNotes.mock.calls.length - 1][0];
    expect(last).toEqual([{ index: 0, target: 62, drift: 1, modulation: 1 }]);
    expect(player.seek).not.toHaveBeenCalled();
    expect(player.currentTime()).toBe(timeBefore);
    // the patched audio was pushed into the output buffer
    expect(player.patch).toHaveBeenCalled();
  });

  it("Alt-drag moves freely without snapping", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    const start = g.at(0);
    fireEvent.pointerDown(canvas, { ...start, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: start.clientX, clientY: start.clientY - 0.5 * g.vp.rowPx, pointerId: 1, buttons: 1, altKey: true });
    fireEvent.pointerUp(canvas, { clientX: start.clientX, clientY: start.clientY - 0.5 * g.vp.rowPx, pointerId: 1, altKey: true });
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalled());
    const last = engine.setNotes.mock.calls[engine.setNotes.mock.calls.length - 1][0];
    expect(last[0].target).toBeCloseTo(61.7, 5);
  });

  it("chromatic snap lands on the nearest semitone", async () => {
    const { canvas, engine } = await setup();
    fireEvent.click(within(screen.getByRole("group", { name: "Snap" })).getByRole("button", { name: "Chromatic" }));
    const g = geometry();
    const start = g.at(0);
    fireEvent.pointerDown(canvas, { ...start, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: start.clientX, clientY: start.clientY + 0.4 * g.vp.rowPx, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(canvas, { clientX: start.clientX, clientY: start.clientY + 0.4 * g.vp.rowPx, pointerId: 1 });
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalled());
    const last = engine.setNotes.mock.calls[engine.setNotes.mock.calls.length - 1][0];
    expect(last[0].target).toBe(61); // 61.2 - 0.4 = 60.8 -> C#4
  });

  it("double-clicking a blob body snaps it to 0 cents", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    click(canvas, g.at(1));
    expect(readout()).toHaveTextContent("+30 cents");
    fireEvent.doubleClick(canvas, g.at(1));
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalledWith([{ index: 1, target: 64, drift: 1, modulation: 1 }]));
    expect(readout()).toHaveTextContent("E4");
    expect(readout()).toHaveTextContent("0 cents");
  });

  it("double-clicking the top third of a blob splits the note there", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    const pt = g.at(1);
    const half = g.profiles[1][50] * g.vp.rowPx;
    fireEvent.doubleClick(canvas, { clientX: pt.clientX, clientY: pt.clientY - half * 0.8 });
    await waitFor(() => expect(engine.split).toHaveBeenCalled());
    expect(engine.split.mock.calls[0][0]).toBe(1);
    expect(engine.split.mock.calls[0][1]).toBeCloseTo(2.5, 1);
    await waitFor(() => expect(screen.getByText(/3 notes/i)).toBeInTheDocument());
  });

  it("clicking the time ruler seeks the playhead", async () => {
    const { canvas, player } = await setup();
    const g = geometry();
    fireEvent.pointerDown(canvas, { clientX: timeToX(2, g.vp, g.layout), clientY: 6, pointerId: 1, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: timeToX(2, g.vp, g.layout), clientY: 6, pointerId: 1 });
    expect(player.seek).toHaveBeenCalledTimes(1);
    expect(player.seek.mock.calls[0][0]).toBeCloseTo(2, 5);
  });

  it("clicking the note grid does not seek; the waveform lane works like the timeline", async () => {
    const { canvas, player } = await setup();
    const g = geometry();
    click(canvas, { clientX: timeToX(2, g.vp, g.layout), clientY: midiToY(58, g.vp, g.layout) });
    expect(player.seek).not.toHaveBeenCalled();
    click(canvas, { clientX: timeToX(2, g.vp, g.layout), clientY: g.layout.waveTop + 10 });
    expect(player.seek).toHaveBeenCalledWith(expect.closeTo(2, 2));
  });

  it("Tune all to key puts every note exactly on the scale", async () => {
    const { engine } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /tune all to key/i }));
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalled());
    const edits = engine.setNotes.mock.calls[0][0];
    expect(edits.map((e) => e.target)).toEqual([62, 64]);
    expect(edits.every((e) => Math.abs(e.drift - 0.5) < 1e-9)).toBe(true);
  });

  it("Correct Pitch applies the macro (90% / 70%) to the selected note only", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    click(canvas, g.at(1));
    fireEvent.click(screen.getByRole("button", { name: /^correct pitch$/i }));
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalled());
    const edits = engine.setNotes.mock.calls[0][0];
    expect(edits).toHaveLength(1);
    expect(edits[0].index).toBe(1);
    expect(edits[0].target).toBeCloseTo(64.3 + 0.9 * (64 - 64.3));
    expect(edits[0].drift).toBeCloseTo(0.3);
  });

  it("changing the key changes snapping", async () => {
    const { canvas, engine } = await setup();
    // C# major contains C# (61): 61.2 now snaps down to C#4
    fireEvent.change(screen.getByRole("combobox", { name: "Tonic" }), { target: { value: "1" } });
    const g = geometry();
    fireEvent.doubleClick(canvas, g.at(0));
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalledWith([{ index: 0, target: 61, drift: 1, modulation: 1 }]));
  });

  it("undo restores the previous pitch and redo re-applies it", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    fireEvent.doubleClick(canvas, g.at(1));
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalledTimes(2));
    expect(engine.setNotes.mock.calls[1][0]).toEqual([{ index: 1, target: 64.3, drift: 1, modulation: 1 }]);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalledTimes(3));
    expect(engine.setNotes.mock.calls[2][0]).toEqual([{ index: 1, target: 64, drift: 1, modulation: 1 }]);
  });

  it("undo of a split merges the notes back", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    const pt = g.at(1);
    const half = g.profiles[1][50] * g.vp.rowPx;
    fireEvent.doubleClick(canvas, { clientX: pt.clientX, clientY: pt.clientY - half * 0.8 });
    await waitFor(() => expect(screen.getByText(/3 notes/i)).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(engine.merge).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.getByText(/2 notes/i)).toBeInTheDocument());
  });

  it("Merge joins the selected note with the next", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    click(canvas, g.at(0));
    fireEvent.click(screen.getByRole("button", { name: /merge/i }));
    await waitFor(() => expect(engine.merge).toHaveBeenCalledWith(0));
    await waitFor(() => expect(screen.getByText(/1 notes/i)).toBeInTheDocument());
  });

  it("arrow up moves the selected note one scale step", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    click(canvas, g.at(1));
    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalledWith([{ index: 1, target: 65, drift: 1, modulation: 1 }]));
  });

  it("Delete does nothing destructive", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    click(canvas, g.at(1));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(engine.setNotes).not.toHaveBeenCalled();
    expect(engine.merge).not.toHaveBeenCalled();
    expect(screen.getByText(/2 notes/i)).toBeInTheDocument();
  });

  it("Space toggles playback and Original/Tuned switches the source", async () => {
    const { player } = await setup();
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /pause vocal/i })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Compare" })).getByRole("button", { name: "Original" }));
    expect(player.setSource).toHaveBeenCalledWith("original");
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(player.pause).toHaveBeenCalled();
  });

  it("Vibrato slider edits the selected note's modulation", async () => {
    const { canvas, engine } = await setup();
    const g = geometry();
    click(canvas, g.at(0));
    const slider = screen.getByRole("slider", { name: "Vibrato" });
    fireEvent.keyDown(slider, { key: "Home" });
    await waitFor(() => expect(engine.setNotes).toHaveBeenCalledWith([{ index: 0, target: 61.2, drift: 1, modulation: 0 }]));
  });

  it("Download WAV renders every channel of the whole vocal", async () => {
    const created = vi.fn(() => "blob:wav");
    Object.defineProperty(URL, "createObjectURL", { value: created, configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true, writable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { engine } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /download wav/i }));
    await waitFor(() => expect(engine.renderAllChannels).toHaveBeenCalled());
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    const blob = (created.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe("audio/wav");
    // Saved under "<name>-autotuned.wav", and the user is told so.
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toMatch(/-autotuned\.wav$/);
    const status = await screen.findByTestId("autotune-saved");
    expect(status).toHaveTextContent(/-autotuned\.wav/);
    // Clicking again without changing anything does not save a duplicate.
    const button = screen.getByRole("button", { name: /saved/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(engine.renderAllChannels).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Multitrack (lead + harmonies)
// ---------------------------------------------------------------------------------------------

interface Take {
  name: string;
  notes?: () => EngineNote[];
  channels?: number;
  frames?: number;
  sampleRate?: number;
  format?: SourceFormat;
}

/** Engine whose notes are chosen at load() from a marker the fake decoder writes into the audio. */
function makeRoutingEngine(takes: Take[], gate: Promise<void> | null) {
  let inner: ReturnType<typeof makeFakeEngine> | null = null;
  const self = {
    take: null as string | null,
    load: vi.fn(async (mono: Float32Array, sr: number, channels?: Float32Array[]) => {
      const k = Math.round(mono[0] * 1000) - 1;
      const t = takes[k];
      self.take = t.name;
      const frames = t.frames ?? DURATION * 44100;
      const rendered = Array.from({ length: t.channels ?? 1 }, () => new Float32Array(frames).fill(0.25));
      inner = makeFakeEngine(t.notes ?? baseNotes, rendered);
      if (gate) await gate;
      return inner.load(mono, sr, channels);
    }),
    setNotes: vi.fn((edits: NoteEdit[]) => inner!.setNotes(edits)),
    split: vi.fn((i: number, sec: number) => inner!.split(i, sec)),
    merge: vi.fn((i: number) => inner!.merge(i)),
    renderAll: vi.fn(() => inner!.renderAll()),
    renderAllChannels: vi.fn(() => inner!.renderAllChannels()),
    dispose: vi.fn(),
  };
  return self;
}

type RoutingEngine = ReturnType<typeof makeRoutingEngine>;

async function setupMulti(takes: Take[], opts: { extra?: Partial<AutotuneDeps>; gate?: Promise<void>; wait?: boolean } = {}) {
  const player = makeFakePlayer();
  const engines: RoutingEngine[] = [];
  const decode = vi.fn(async (src: { label: string }) => {
    const k = takes.findIndex((t) => t.name === src.label);
    const t = takes[k];
    const frames = t.frames ?? DURATION * 44100;
    const channels = Array.from({ length: t.channels ?? 1 }, () => new Float32Array(frames).fill((k + 1) / 1000));
    return { channels, mono: channels[0], sampleRate: t.sampleRate ?? 44100, format: t.format ?? WAV16 } satisfies DecodedTrack;
  });
  const deps: Partial<AutotuneDeps> = {
    createEngine: () => {
      const e = makeRoutingEngine(takes, opts.gate ?? null);
      engines.push(e);
      return e;
    },
    createPlayer: () => player,
    decode,
    ...opts.extra,
  };
  const utils = render(<AutotuneTab track={null} instruments={instruments} samples={[]} deps={deps} />);
  const input = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  const files = takes.map((t) => new File([new Uint8Array(8)], t.name, { type: "audio/wav" }));
  fireEvent.change(input, { target: { files } });
  if (opts.wait !== false) {
    await waitFor(() => expect(engines.filter((e) => e.load.mock.calls.length > 0)).toHaveLength(takes.length));
    await waitFor(() => expect(screen.queryAllByTestId(/^track-status-/)).toHaveLength(0));
    await screen.findByTestId("autotune-editor");
  }
  const engineFor = (name: string) => {
    const e = engines.find((x) => x.take === name);
    if (!e) throw new Error(`no engine for ${name}`);
    return e;
  };
  const rows = () => screen.getAllByRole("listitem");
  const trackId = (name: string) => {
    const row = rows().find((r) => within(r).queryByText(name));
    return (row?.getAttribute("data-testid") ?? "").replace("track-row-", "");
  };
  return { ...utils, player, engines, engineFor, decode, rows, trackId };
}

const LEAD = "lead.wav";
const HARM = "harmony-high.wav";
const HARM2 = "harmony-low.wav";
// Harmony a 3rd above the lead's first note (61.2 -> 65.1) and a 3rd below its second.
const harmonyNotes = () => mkNotes([65.1, 60.2]);
const lowNotes = () => mkNotes([57.1, 59.2]);

describe("AutotuneTab (multitrack harmonies)", () => {
  beforeAll(() => {
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:fake"), configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true, writable: true });
  });

  it("uploading three files creates three tracks, the first is the lead, and each engine gets mono + channels", async () => {
    const { engines, rows, player } = await setupMulti([{ name: LEAD }, { name: HARM, channels: 2 }, { name: HARM2 }]);
    expect(rows()).toHaveLength(3);
    expect(engines).toHaveLength(3);
    expect(within(rows()[0]).getByRole("button", { name: `${LEAD} is the lead` })).toHaveAttribute("aria-pressed", "true");
    expect(within(rows()[1]).getByRole("button", { name: `Make ${HARM} the lead` })).toHaveAttribute("aria-pressed", "false");
    for (const e of engines) {
      const [mono, sr, channels] = e.load.mock.calls[0];
      expect(mono).toBeInstanceOf(Float32Array);
      expect(sr).toBe(44100);
      expect(channels).toHaveLength(e.take === HARM ? 2 : 1);
    }
    expect(player.addTrack).toHaveBeenCalledTimes(3);
    // The lead is the one being edited.
    expect(screen.getByTestId("autotune-editor")).toHaveAttribute("data-track", rows()[0].getAttribute("data-testid")!.replace("track-row-", ""));
  });

  it("analyses at most two tracks at a time and keeps the others waiting", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { engines } = await setupMulti([{ name: "a.wav" }, { name: "b.wav" }, { name: "c.wav" }, { name: "d.wav" }], { gate, wait: false });
    await waitFor(() => expect(engines).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(engines).toHaveLength(2);
    expect(screen.getAllByText("Waiting…")).toHaveLength(2);
    expect(screen.getAllByText("Analyzing…")).toHaveLength(2);
    await act(async () => release());
    await waitFor(() => expect(engines).toHaveLength(4));
    await waitFor(() => expect(screen.queryAllByTestId(/^track-status-/)).toHaveLength(0));
    expect(engines.every((e) => e.load.mock.calls.length === 1)).toBe(true);
  });

  it("M and S call the player and show their pressed state", async () => {
    const { player, trackId } = await setupMulti([{ name: LEAD }, { name: HARM, notes: harmonyNotes }]);
    const id = trackId(HARM);
    const mute = screen.getByRole("button", { name: `Mute ${HARM}` });
    const solo = screen.getByRole("button", { name: `Solo ${HARM}` });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mute);
    expect(player.setMuted).toHaveBeenCalledWith(id, true);
    expect(screen.getByRole("button", { name: `Mute ${HARM}` })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(solo);
    expect(player.setSolo).toHaveBeenCalledWith(id, true);
    expect(screen.getByRole("button", { name: `Solo ${HARM}` })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: `Mute ${HARM}` }));
    expect(player.setMuted).toHaveBeenLastCalledWith(id, false);
  });

  it("switching the active track changes which notes are editable and shows the others as ghosts", async () => {
    const { trackId, engineFor } = await setupMulti([{ name: LEAD }, { name: HARM, notes: harmonyNotes }, { name: HARM2, notes: lowNotes }]);
    const [lead, harm, low] = [trackId(LEAD), trackId(HARM), trackId(HARM2)];
    const canvas = screen.getByTestId("autotune-editor");
    expect(canvas).toHaveAttribute("data-track", lead);
    expect(canvas.getAttribute("data-ghosts")!.split(",").sort()).toEqual([harm, low].sort());

    fireEvent.click(screen.getByTestId(`track-row-${harm}`));
    expect(canvas).toHaveAttribute("data-track", harm);
    expect(canvas.getAttribute("data-ghosts")!.split(",").sort()).toEqual([lead, low].sort());

    // The harmony's own note is the one under the pointer now (and it is snapped on its own engine).
    fireEvent.click(within(screen.getByRole("group", { name: "Snap" })).getByRole("button", { name: "Chromatic" }));
    const g = geometry(harmonyNotes());
    fireEvent.doubleClick(canvas, g.at(0));
    await waitFor(() => expect(engineFor(HARM).setNotes).toHaveBeenCalledWith([{ index: 0, target: 65, drift: 1, modulation: 1 }]));
    expect(engineFor(LEAD).setNotes).not.toHaveBeenCalled();
    expect(readout()).toHaveTextContent("F4");
  });

  it("selecting or dragging a harmony note shows its interval to the lead, clashes in a warning color", async () => {
    const { trackId } = await setupMulti([{ name: LEAD }, { name: HARM, notes: harmonyNotes }]);
    fireEvent.click(screen.getByTestId(`track-row-${trackId(HARM)}`));
    fireEvent.click(within(screen.getByRole("group", { name: "Snap" })).getByRole("button", { name: "Chromatic" }));
    const canvas = screen.getByTestId("autotune-editor");
    const g = geometry(harmonyNotes());
    const start = g.at(0);
    fireEvent.pointerDown(canvas, { ...start, pointerId: 1, button: 0 });
    // Selected: F4 against the lead's C#4 is a major 3rd.
    expect(screen.getByTestId("autotune-interval")).toHaveTextContent("3rd above lead");
    expect(screen.getByTestId("autotune-interval")).not.toHaveAttribute("data-clash");
    // Drag up to G4: a tritone above C#4 rubs.
    const y = start.clientY - 1.9 * g.vp.rowPx;
    fireEvent.pointerMove(canvas, { clientX: start.clientX, clientY: y, pointerId: 1, buttons: 1 });
    expect(screen.getByTestId("autotune-interval")).toHaveTextContent("tritone above lead");
    expect(screen.getByTestId("autotune-interval")).toHaveAttribute("data-clash", "true");
    fireEvent.pointerUp(canvas, { clientX: start.clientX, clientY: y, pointerId: 1 });
  });

  it("Tune all to key tunes every included track and skips excluded ones", async () => {
    const { engineFor } = await setupMulti([{ name: LEAD }, { name: HARM, notes: harmonyNotes }, { name: HARM2, notes: lowNotes }]);
    fireEvent.click(screen.getByRole("checkbox", { name: `Include ${HARM2} in Tune all` }));
    fireEvent.click(screen.getByRole("button", { name: /tune all to key/i }));
    await waitFor(() => expect(engineFor(LEAD).setNotes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(engineFor(HARM).setNotes).toHaveBeenCalledTimes(1));
    expect(engineFor(HARM2).setNotes).not.toHaveBeenCalled();
    for (const name of [LEAD, HARM]) {
      const edits = engineFor(name).setNotes.mock.calls[0][0];
      expect(edits).toHaveLength(2);
      expect(edits.every((e) => Math.abs(e.drift - 0.5) < 1e-9 && Number.isInteger(e.target))).toBe(true);
    }
  });

  it("Align to lead moves the take by the estimated offset and refuses a low-confidence match", async () => {
    const estimate = vi.fn().mockReturnValueOnce({ offsetSec: 0.25, confidence: 0.8 }).mockReturnValueOnce({ offsetSec: 1.5, confidence: 0.1 });
    const { player, trackId } = await setupMulti([{ name: LEAD }, { name: HARM, notes: harmonyNotes }, { name: HARM2, notes: lowNotes }], {
      extra: { estimateOffset: estimate },
    });
    const harm = trackId(HARM);
    const low = trackId(HARM2);
    fireEvent.click(screen.getByRole("button", { name: `Align ${HARM} to lead` }));
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(player.setOffset).toHaveBeenCalledWith(harm, 0.25);
    expect(screen.getByTestId(`track-offset-${harm}`)).toHaveTextContent("+250 ms");

    fireEvent.click(screen.getByRole("button", { name: `Align ${HARM2} to lead` }));
    expect(screen.getByTestId(`track-align-${low}`)).toHaveTextContent(/couldn't match this take to the lead/i);
    expect(player.setOffset).not.toHaveBeenCalledWith(low, expect.anything());
    expect(screen.getByTestId(`track-offset-${low}`)).toHaveTextContent("0 ms");

    // Nudging by hand works in 10 ms steps.
    fireEvent.click(screen.getByRole("button", { name: `Nudge ${HARM2} later` }));
    expect(player.setOffset).toHaveBeenLastCalledWith(low, 0.01);
  });

  it("the edited track is drawn at its offset on the shared timeline", async () => {
    const estimate = vi.fn(() => ({ offsetSec: 0.5, confidence: 0.9 }));
    const { trackId } = await setupMulti([{ name: LEAD }, { name: HARM, notes: harmonyNotes }], { extra: { estimateOffset: estimate } });
    const harm = trackId(HARM);
    fireEvent.click(screen.getByRole("button", { name: `Align ${HARM} to lead` }));
    fireEvent.click(screen.getByTestId(`track-row-${harm}`));
    expect(screen.getByTestId("autotune-editor")).toHaveAttribute("data-time-offset", "0.5");
  });

  it("Download all saves one -autotuned.wav per track with the exact source frames, channels and rate", async () => {
    const saved: { name: string; bytes: Uint8Array }[] = [];
    const save = vi.spyOn(backend, "saveExport").mockImplementation(async (name: string, bytes: Uint8Array) => {
      saved.push({ name, bytes });
      return null;
    });
    await setupMulti([
      { name: "Lead take.wav", frames: 12345, channels: 2, sampleRate: 48000, format: { container: "wav", sampleRate: 48000, channels: 2, bitDepth: 24, float: false } },
      { name: "Harm.flac", notes: harmonyNotes, frames: 9999, channels: 1, sampleRate: 44100, format: { container: "flac", sampleRate: 44100, channels: 1, bitDepth: 16, float: false } },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /download all/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const header = (b: Uint8Array) => {
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const ch = v.getUint16(22, true);
      const bits = v.getUint16(34, true);
      return { ch, rate: v.getUint32(24, true), bits, frames: v.getUint32(40, true) / (ch * (bits / 8)) };
    };
    expect(saved.map((s) => s.name)).toEqual(["Lead take-autotuned.wav", "Harm-autotuned.wav"]);
    expect(header(saved[0].bytes)).toEqual({ ch: 2, rate: 48000, bits: 24, frames: 12345 });
    expect(header(saved[1].bytes)).toEqual({ ch: 1, rate: 44100, bits: 16, frames: 9999 });
    const status = await screen.findByTestId("autotune-saved");
    expect(status).toHaveTextContent(/downloaded 2 files/i);
    expect(status).toHaveTextContent("Lead take-autotuned.wav");
    // Nothing changed since: both are saved and the buttons say so.
    expect(screen.getByRole("button", { name: /all saved/i })).toBeDisabled();
  });

  it("removing a track disposes its engine and its player track", async () => {
    const { player, engineFor, trackId, rows } = await setupMulti([{ name: LEAD }, { name: HARM, notes: harmonyNotes }, { name: HARM2, notes: lowNotes }]);
    const id = trackId(HARM);
    fireEvent.click(screen.getByRole("button", { name: `Remove ${HARM}` }));
    expect(engineFor(HARM).dispose).toHaveBeenCalledTimes(1);
    expect(engineFor(LEAD).dispose).not.toHaveBeenCalled();
    expect(player.removeTrack).toHaveBeenCalledWith(id);
    expect(rows()).toHaveLength(2);
  });

  it("with a single track the list collapses to an Add harmony button", async () => {
    await setup();
    expect(screen.getByRole("button", { name: /add harmony/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^mute /i })).toBeNull();
    expect(screen.queryByRole("button", { name: /download all/i })).toBeNull();
  });
});
