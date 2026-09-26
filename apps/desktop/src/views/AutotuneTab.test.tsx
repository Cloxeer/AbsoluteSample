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
import type { PlaySource, TunePlayer } from "@/lib/tunePlayer";
import type { InstrumentStem } from "@/lib/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

const HOP = 0.01;
const DURATION = 4;
const FRAMES = DURATION / HOP;

function baseNotes(): EngineNote[] {
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
  // 61.2 = C#4 +20 cents (nearest C-major note: D4); 64.3 = E4 +30 cents.
  return [mk(50, 150, 61.2), mk(200, 300, 64.3)];
}

/** In-process stand-in for the wasm PitchSession (jsdom has no Worker / wasm). */
function makeFakeEngine() {
  let notes = baseNotes();
  const db = new Array(FRAMES).fill(-60).map((v, f) => (notes.some((n) => f >= n.startFrame && f <= n.endFrame) ? -6 : v));
  const analysis = (): Analysis => {
    const pitch: (number | null)[] = new Array(FRAMES).fill(null);
    const editedPitch: (number | null)[] = new Array(FRAMES).fill(null);
    for (const n of baseNotes()) for (let f = n.startFrame; f <= n.endFrame; f++) pitch[f] = n.center;
    for (const n of notes) for (let f = n.startFrame; f <= n.endFrame; f++) editedPitch[f] = n.target;
    return { hopSec: HOP, durationSec: DURATION, pitch, editedPitch, db, notes: notes.map((n) => ({ ...n })), key: { tonic: "C", mode: "major", confidence: 0.9 } };
  };
  const result = (): EditResult => ({ ok: true, analysis: analysis(), patches: [{ startSec: 0.4, samples: new Float32Array(441).fill(0.1) }] });
  const engine = {
    load: vi.fn(async () => analysis()),
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
    dispose: vi.fn(),
  } satisfies PitchEngine;
  return engine;
}

function makeFakePlayer() {
  let pos = 0;
  let playing = false;
  let src: PlaySource = "tuned";
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const player = {
    load: vi.fn(),
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
      return () => listeners.delete(cb);
    },
    dispose: vi.fn(),
  } satisfies TunePlayer;
  return player;
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
function geometry() {
  const layout = computeLayout(FALLBACK_WIDTH);
  const notes = baseNotes();
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
  const decode = vi.fn(async () => ({ samples: new Float32Array(DURATION * 44100), sampleRate: 44100 }));
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
    render(<AutotuneTab track={null} instruments={instruments} samples={[]} deps={{ createEngine: makeFakeEngine, createPlayer: makeFakePlayer }} />);
    expect(screen.getByText(/drop your vocal or pick one from the song/i)).toBeInTheDocument();
    expect(screen.queryByTestId("autotune-editor")).toBeNull();
  });

  it("analyses with the in-browser engine, never the Python backend", async () => {
    const analyze = vi.spyOn(backend, "analyzePitch");
    const apply = vi.spyOn(backend, "applyAutotune");
    const { engine, decode, player } = await setup();
    expect(decode).toHaveBeenCalledWith(expect.objectContaining({ path: instruments[0].path, kind: "song" }));
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(player.load).toHaveBeenCalledTimes(1);
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
        deps={{ createEngine: () => engine, createPlayer: makeFakePlayer, decode: async () => ({ samples: new Float32Array(44100), sampleRate: 44100 }) }}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: /vocal from this song/i }), { target: { value: instruments[0].path } });
    expect(await screen.findByText(/analyzing vocal/i)).toBeInTheDocument();
    const a = await makeFakeEngine().load();
    await act(async () => release(a));
    expect(await screen.findByTestId("autotune-editor")).toBeInTheDocument();
  });

  it("uses a dropped File directly (web build)", async () => {
    const decode = vi.fn(async () => ({ samples: new Float32Array(44100), sampleRate: 44100 }));
    const created = vi.fn(() => "blob:fake");
    Object.defineProperty(URL, "createObjectURL", { value: created, configurable: true, writable: true });
    const { container } = render(
      <AutotuneTab track={null} instruments={instruments} samples={[]} deps={{ createEngine: makeFakeEngine, createPlayer: makeFakePlayer, decode }} />
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

  it("Download WAV renders the whole vocal", async () => {
    const created = vi.fn(() => "blob:wav");
    Object.defineProperty(URL, "createObjectURL", { value: created, configurable: true, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true, writable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { engine } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /download wav/i }));
    await waitFor(() => expect(engine.renderAll).toHaveBeenCalled());
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
    expect(engine.renderAll).toHaveBeenCalledTimes(1);
  });
});
