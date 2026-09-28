import { describe, expect, it } from "vitest";
import { COLORS, drawScene, type SceneState } from "./melodyneDraw";
import { blobProfile, computeLayout, midiToY, referenceDb, scalePitchClasses, timeToX, type Analysis, type EngineNote } from "./melodyneEditor";

/** Records every fillRect with the fill style in effect, and every stroke's style/width. */
function recorder() {
  const fills: { x: number; y: number; w: number; h: number; style: string }[] = [];
  const strokes: { style: string; width: number }[] = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "", lineJoin: "", globalAlpha: 1 };
  const noop = () => {};
  const ctx = new Proxy(state as unknown as CanvasRenderingContext2D, {
    get(t, k) {
      if (k === "fillRect") return (x: number, y: number, w: number, h: number) => fills.push({ x, y, w, h, style: String(state.fillStyle) });
      if (k === "stroke") return () => strokes.push({ style: String(state.strokeStyle), width: state.lineWidth });
      if (k === "createLinearGradient") return () => ({ addColorStop: noop });
      if (k === "measureText") return () => ({ width: 20 });
      if (k in state) return (state as Record<string, unknown>)[k as string];
      return noop;
    },
    set(t, k, v) {
      (state as Record<string, unknown>)[k as string] = v;
      return true;
    },
  });
  return { ctx, fills, strokes };
}

const HOP = 0.01;
function scene(extra: Partial<SceneState> = {}): SceneState {
  const n = (s: number, e: number, c: number): EngineNote => ({ startSec: s, endSec: e, startFrame: s / HOP, endFrame: e / HOP, center: c, target: c, drift: 1, modulation: 1, peakDb: -6 });
  const notes = [n(0.5, 1.5, 64), n(2, 3, 65)];
  const db = Array.from({ length: 400 }, (_, f) => (notes.some((x) => f >= x.startFrame && f <= x.endFrame) ? -6 : -60));
  const analysis: Analysis = { hopSec: HOP, durationSec: 4, pitch: db.map(() => null), editedPitch: db.map(() => null), db, notes, key: null };
  const layout = computeLayout(900);
  return {
    layout,
    vp: { scrollSec: 0, pxPerSec: 200, topMidi: 72, rowPx: 16 },
    analysis,
    profiles: notes.map((x) => blobProfile(x, db, referenceDb(db))),
    scalePcs: scalePitchClasses(0, "major"),
    tonicPc: 0,
    selected: new Set(),
    overrides: null,
    peaks: null,
    peakBlock: 256,
    peakMax: 1,
    sampleRate: 44100,
    ...extra,
  };
}

describe("drawScene", () => {
  it("paints the notes of the key light blue (home note stronger) and the others dark", () => {
    const s = scene();
    const { ctx, fills } = recorder();
    drawScene(ctx, s);
    const rowAt = (midi: number) => fills.find((f) => f.x === s.layout.gridLeft && Math.abs(f.y - midiToY(midi + 0.5, s.vp, s.layout)) < 0.01 && f.h === s.vp.rowPx);
    expect(rowAt(64)?.style).toBe(COLORS.beam); // E: in C major
    expect(rowAt(60)?.style).toBe(COLORS.beamTonic); // C: the home note
    expect(rowAt(61)?.style).toBe(COLORS.offScale); // C#: not in the key
    expect(COLORS.beam).toMatch(/^#1d2635$/i); // a blue hue
    // The note-name ruler is tinted too.
    expect(fills.some((f) => f.x === 0 && f.style === COLORS.rulerBeam)).toBe(true);
  });

  it("draws the section strip under the time ruler and red edges on clashing notes", () => {
    const s = scene({ sections: [{ startSec: 0, endSec: 1, kind: "lead" }, { startSec: 1, endSec: 3, kind: "stack" }], clashes: new Set([1]) });
    const { ctx, fills, strokes } = recorder();
    drawScene(ctx, s);
    const strip = fills.filter((f) => f.y === s.layout.waveTop - 4 && f.h === 3);
    expect(strip.map((f) => f.style)).toEqual([COLORS.section.lead, COLORS.section.stack]);
    expect(strip[1].x).toBeCloseTo(timeToX(1, s.vp, s.layout));
    expect(strokes.filter((x) => x.style === COLORS.clash && x.width === 2)).toHaveLength(1);
  });
});
