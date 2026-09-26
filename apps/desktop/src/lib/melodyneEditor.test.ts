import { describe, expect, it } from "vitest";
import {
  allowedPitchClasses,
  edgeScrollPx,
  EDGE_MAX_PX_PER_FRAME,
  noteAtTime,
  applyNoteParams,
  blobProfile,
  BLOB_MAX_THICKNESS,
  BLOB_MIN_THICKNESS,
  clampScroll,
  computeLayout,
  computePeaks,
  correctPitch,
  dbToThickness,
  encodeWav16,
  fitViewport,
  followPlayhead,
  formatCents,
  formatTime,
  hitTestNotes,
  isInScale,
  isNoteEdited,
  keyLabel,
  matchSnapshot,
  mergeSpans,
  midiToY,
  MIN_HIT_HALF_ROWS,
  mixToMono,
  nearestAllowed,
  nextStructuralOp,
  noteName,
  notesInRect,
  parseMode,
  parseTonic,
  patchSamples,
  pitchRange,
  pitchReadout,
  referenceDb,
  regionAt,
  rulerStep,
  scalePitchClasses,
  snapPitch,
  snapshotNotes,
  stepAllowed,
  timeToX,
  UndoStack,
  updatePeaks,
  voicedRuns,
  xToTime,
  yToMidi,
  zoomHorizontal,
  type EngineNote,
  type Viewport,
} from "./melodyneEditor";

function note(partial: Partial<EngineNote> & { startFrame: number; endFrame: number; center: number }, hop = 0.01): EngineNote {
  return {
    startSec: partial.startFrame * hop,
    endSec: partial.endFrame * hop,
    target: partial.center,
    drift: 1,
    modulation: 1,
    peakDb: -6,
    ...partial,
  };
}

const C_MAJOR = scalePitchClasses(0, "major");
const A_MINOR = scalePitchClasses(9, "minor");

describe("note names, keys, scales", () => {
  it("names MIDI notes with octave (C4 = 60)", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(66)).toBe("F#4");
    expect(noteName(59)).toBe("B3");
    expect(noteName(21)).toBe("A0");
    expect(noteName(60.4)).toBe("C4");
  });

  it("parses tonics given as names, flats or numbers", () => {
    expect(parseTonic("F#")).toBe(6);
    expect(parseTonic("Gb")).toBe(6);
    expect(parseTonic("c")).toBe(0);
    expect(parseTonic("Cb")).toBe(11);
    expect(parseTonic(9)).toBe(9);
    expect(parseTonic(14)).toBe(2);
    expect(parseTonic("?")).toBe(0);
    expect(parseTonic(null)).toBe(0);
  });

  it("parses modes", () => {
    expect(parseMode("minor")).toBe("minor");
    expect(parseMode("Minor")).toBe("minor");
    expect(parseMode("min")).toBe("minor");
    expect(parseMode("aeolian")).toBe("minor");
    expect(parseMode("dorian")).toBe("dorian");
    expect(parseMode("weird")).toBe("major");
  });

  it("labels a detected key", () => {
    expect(keyLabel({ tonic: "F#", mode: "minor", confidence: 0.8 })).toBe("F# minor");
    expect(keyLabel({ tonic: 2, mode: "major", confidence: 0.8 })).toBe("D major");
    expect(keyLabel(null)).toBeNull();
  });

  it("builds pitch-class sets for tonic + mode", () => {
    expect(C_MAJOR).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(A_MINOR).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scalePitchClasses(6, "minor")).toEqual([1, 2, 4, 6, 8, 9, 11]); // F# G# A B C# D E
    expect(scalePitchClasses(0, "chromatic")).toHaveLength(12);
    expect(scalePitchClasses(0, "major pentatonic")).toEqual([0, 2, 4, 7, 9]);
  });

  it("checks scale membership", () => {
    expect(isInScale(60, C_MAJOR)).toBe(true);
    expect(isInScale(61, C_MAJOR)).toBe(false);
    expect(isInScale(71, C_MAJOR)).toBe(true);
  });
});

describe("snapping", () => {
  it("nearest allowed note in a scale skips out-of-scale notes", () => {
    expect(nearestAllowed(61.2, C_MAJOR)).toBe(62); // C#+20 -> D (C# not in C major)
    expect(nearestAllowed(60.8, C_MAJOR)).toBe(60); // closer to C than D
    expect(nearestAllowed(66, C_MAJOR)).toBe(65); // F# tie between F and G -> lower
    expect(nearestAllowed(64.4, C_MAJOR)).toBe(64);
  });

  it("nearest allowed with chromatic = plain rounding", () => {
    const all = allowedPitchClasses("chromatic", C_MAJOR);
    expect(nearestAllowed(61.2, all)).toBe(61);
    expect(nearestAllowed(61.6, all)).toBe(62);
  });

  it("allowedPitchClasses: scale uses the key, chromatic/off use all 12", () => {
    expect(allowedPitchClasses("scale", C_MAJOR)).toEqual(C_MAJOR);
    expect(allowedPitchClasses("chromatic", C_MAJOR)).toHaveLength(12);
    expect(allowedPitchClasses("off", C_MAJOR)).toHaveLength(12);
    expect(allowedPitchClasses("scale", [])).toHaveLength(12);
  });

  it("snapPitch lands exactly on a scale note, or is free with Alt / Off", () => {
    expect(snapPitch(61.3, "scale", C_MAJOR)).toBe(62);
    expect(snapPitch(61.3, "chromatic", C_MAJOR)).toBe(61);
    expect(snapPitch(61.3, "off", C_MAJOR)).toBeCloseTo(61.3);
    expect(snapPitch(61.3, "scale", C_MAJOR, true)).toBeCloseTo(61.3);
    expect(Number.isInteger(snapPitch(63.49, "scale", C_MAJOR))).toBe(true);
  });

  it("stepAllowed moves one allowed step up/down", () => {
    expect(stepAllowed(60, 1, C_MAJOR)).toBe(62);
    expect(stepAllowed(64, 1, C_MAJOR)).toBe(65);
    expect(stepAllowed(60, -1, C_MAJOR)).toBe(59);
    expect(stepAllowed(61.4, 1, C_MAJOR)).toBe(62);
    expect(stepAllowed(61.4, -1, C_MAJOR)).toBe(60);
    const all = allowedPitchClasses("chromatic", []);
    expect(stepAllowed(60, 1, all)).toBe(61);
  });

  it("pitch readout: nearest chromatic note and cents", () => {
    expect(pitchReadout(66)).toEqual({ name: "F#4", cents: 0 });
    expect(pitchReadout(65.88)).toEqual({ name: "F#4", cents: -12 });
    expect(pitchReadout(60.25)).toEqual({ name: "C4", cents: 25 });
    expect(formatCents(0)).toBe("0 cents");
    expect(formatCents(-12)).toBe("-12 cents");
    expect(formatCents(7)).toBe("+7 cents");
  });
});

describe("Correct Pitch macro", () => {
  it("moves the center pct of the way to the nearest allowed note and flattens drift", () => {
    const n = { center: 61.2, modulation: 1.3 };
    const r = correctPitch(n, 0.9, 0.7, C_MAJOR);
    expect(r.target).toBeCloseTo(61.2 + 0.9 * (62 - 61.2));
    expect(r.drift).toBeCloseTo(0.3);
    expect(r.modulation).toBe(1.3);
  });

  it("100% lands exactly on the note (0 cents)", () => {
    const r = correctPitch({ center: 64.37, modulation: 1 }, 1, 0.5, C_MAJOR);
    expect(r.target).toBe(64);
    expect(r.drift).toBeCloseTo(0.5);
  });

  it("0% leaves the center alone; values are clamped", () => {
    expect(correctPitch({ center: 64.37, modulation: 1 }, 0, 0, C_MAJOR).target).toBeCloseTo(64.37);
    const r = correctPitch({ center: 64.37, modulation: 1 }, 2, -1, C_MAJOR);
    expect(r.target).toBe(64);
    expect(r.drift).toBe(1);
  });

  it("detects edited notes", () => {
    expect(isNoteEdited({ center: 60, target: 60, drift: 1, modulation: 1 })).toBe(false);
    expect(isNoteEdited({ center: 60, target: 61, drift: 1, modulation: 1 })).toBe(true);
    expect(isNoteEdited({ center: 60, target: 60, drift: 0.5, modulation: 1 })).toBe(true);
    expect(isNoteEdited({ center: 60, target: 60, drift: 1, modulation: 0 })).toBe(true);
  });

  it("applyNoteParams merges edits by index without mutating", () => {
    const notes = [note({ startFrame: 0, endFrame: 10, center: 60 }), note({ startFrame: 10, endFrame: 20, center: 62 })];
    const next = applyNoteParams(notes, [{ index: 1, target: 64, drift: 0.2, modulation: 0.5 }, { index: 9, target: 1, drift: 1, modulation: 1 }]);
    expect(next[1]).toMatchObject({ target: 64, drift: 0.2, modulation: 0.5, center: 62 });
    expect(notes[1].target).toBe(62);
    expect(next[0]).toBe(notes[0]);
  });
});

describe("layout and coordinates", () => {
  const layout = computeLayout(900);
  const vp: Viewport = { scrollSec: 2, pxPerSec: 100, topMidi: 72.5, rowPx: 20 };

  it("computes lanes top to bottom: time ruler, waveform, grid", () => {
    expect(layout.timeRulerTop).toBe(0);
    expect(layout.waveTop).toBeGreaterThan(0);
    expect(layout.gridTop).toBe(layout.waveTop + layout.waveHeight);
    expect(layout.height).toBe(layout.gridTop + layout.gridHeight);
    expect(layout.gridLeft + layout.gridWidth).toBe(900);
  });

  it("maps time <-> x and pitch <-> y as inverses", () => {
    expect(timeToX(2, vp, layout)).toBe(layout.gridLeft);
    expect(timeToX(3, vp, layout)).toBe(layout.gridLeft + 100);
    expect(xToTime(timeToX(4.37, vp, layout), vp, layout)).toBeCloseTo(4.37);
    expect(midiToY(72.5, vp, layout)).toBe(layout.gridTop);
    expect(midiToY(72, vp, layout)).toBe(layout.gridTop + 10);
    expect(yToMidi(midiToY(65.3, vp, layout), vp, layout)).toBeCloseTo(65.3);
    // Higher pitch = higher on screen
    expect(midiToY(70, vp, layout)).toBeLessThan(midiToY(60, vp, layout));
  });

  it("an out-of-tune note sits between rows", () => {
    const y = midiToY(64.5, vp, layout);
    expect(y).toBeGreaterThan(midiToY(65, vp, layout));
    expect(y).toBeLessThan(midiToY(64, vp, layout));
  });

  it("classifies regions", () => {
    expect(regionAt(300, 5, layout)).toBe("time-ruler");
    expect(regionAt(300, layout.waveTop + 5, layout)).toBe("wave");
    expect(regionAt(10, layout.gridTop + 50, layout)).toBe("pitch-ruler");
    expect(regionAt(300, layout.gridTop + 50, layout)).toBe("grid");
    expect(regionAt(-1, 5, layout)).toBe("none");
  });

  it("pitch range covers centers and targets ±4", () => {
    expect(pitchRange([{ center: 60.3, target: 60.3 }, { center: 64, target: 67 }])).toEqual({ lo: 56, hi: 71 });
  });

  it("fit shows the whole duration and all notes", () => {
    const notes = [note({ startFrame: 0, endFrame: 50, center: 60 }), note({ startFrame: 100, endFrame: 200, center: 67 })];
    const f = fitViewport(notes, 10, layout);
    expect(f.scrollSec).toBe(0);
    expect(timeToX(10, f, layout)).toBeCloseTo(900);
    const yLo = midiToY(57, f, layout);
    const yHi = midiToY(70, f, layout);
    expect(yHi).toBeGreaterThanOrEqual(layout.gridTop);
    expect(yLo).toBeLessThanOrEqual(layout.gridTop + layout.gridHeight);
    expect(f.rowPx).toBeGreaterThanOrEqual(16);
  });

  it("opens on a readable window starting at the first note, with rows fitted to the core range", () => {
    const notes = [
      note({ startFrame: 300, endFrame: 400, center: 60 }),
      note({ startFrame: 500, endFrame: 3000, center: 62 }),
      note({ startFrame: 3100, endFrame: 3105, center: 30 }), // a stray blip must not squash the rows
    ];
    const f = fitViewport(notes, 60, layout, 12);
    expect(xToTime(layout.gridLeft + layout.gridWidth, f, layout) - f.scrollSec).toBeCloseTo(12);
    expect(f.scrollSec).toBeCloseTo(2.5);
    expect(f.rowPx).toBeGreaterThanOrEqual(16);
    const y = midiToY(61, f, layout);
    expect(y).toBeGreaterThan(layout.gridTop);
    expect(y).toBeLessThan(layout.gridTop + layout.gridHeight);
  });

  it("zoom keeps the time under the cursor and never zooms out past fit", () => {
    const f: Viewport = { scrollSec: 0, pxPerSec: layout.gridWidth / 20, topMidi: 70, rowPx: 20 };
    const anchor = layout.gridLeft + 300;
    const t = xToTime(anchor, f, layout);
    const z = zoomHorizontal(f, 4, anchor, 20, layout);
    expect(z.pxPerSec).toBeCloseTo(f.pxPerSec * 4);
    expect(xToTime(anchor, z, layout)).toBeCloseTo(t);
    const out = zoomHorizontal(f, 0.1, anchor, 20, layout);
    expect(out.pxPerSec).toBeCloseTo(f.pxPerSec);
    expect(out.scrollSec).toBe(0);
  });

  it("clampScroll keeps the view within the audio", () => {
    const c = clampScroll({ ...vp, scrollSec: 100 }, 20, layout);
    expect(c.scrollSec).toBeCloseTo(20 - layout.gridWidth / vp.pxPerSec);
    expect(clampScroll({ ...vp, scrollSec: -5 }, 20, layout).scrollSec).toBe(0);
  });

  it("followPlayhead pages forward only when the playhead leaves the view", () => {
    const v: Viewport = { scrollSec: 0, pxPerSec: 100, topMidi: 70, rowPx: 20 };
    expect(followPlayhead(v, 3, 60, layout)).toBe(v);
    const next = followPlayhead(v, 8.3, 60, layout);
    expect(next.scrollSec).toBeGreaterThan(7);
    expect(next.scrollSec).toBeLessThan(8.3);
  });

  it("ruler steps and time labels", () => {
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(10)).toBe(10);
    expect(rulerStep(1000)).toBe(0.1);
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(62.5, 0.5)).toBe("1:02.5");
  });
});

describe("blobs", () => {
  it("maps level to thickness between min and max", () => {
    expect(dbToThickness(0, 0)).toBeCloseTo(BLOB_MAX_THICKNESS);
    expect(dbToThickness(-100, 0)).toBeCloseTo(BLOB_MIN_THICKNESS);
    expect(dbToThickness(-24, 0)).toBeGreaterThan(BLOB_MIN_THICKNESS);
    expect(dbToThickness(-24, 0)).toBeLessThan(BLOB_MAX_THICKNESS);
    expect(dbToThickness(-Infinity, 0)).toBe(BLOB_MIN_THICKNESS);
  });

  it("referenceDb is the loudest finite frame", () => {
    expect(referenceDb([-30, -6, -Infinity, -12])).toBe(-6);
    expect(referenceDb([])).toBe(0);
  });

  it("profile follows the envelope, is symmetric-half, with rounded ends", () => {
    const db = new Array(40).fill(-60);
    for (let f = 10; f <= 30; f++) db[f] = f < 20 ? -6 : -30;
    const p = blobProfile({ startFrame: 10, endFrame: 30 }, db, -6);
    expect(p.length).toBe(21);
    // half-thickness never exceeds half of max
    for (const v of p) expect(v).toBeLessThanOrEqual(BLOB_MAX_THICKNESS / 2 + 1e-6);
    // loud part thicker than quiet part
    expect(p[5]).toBeGreaterThan(p[16]);
    // rounded caps: ends thinner than the inside
    expect(p[0]).toBeLessThan(p[5]);
    expect(p[20]).toBeLessThan(p[16]);
    expect(p[0]).toBeGreaterThan(0);
  });

  it("handles notes past the end of the db array", () => {
    const p = blobProfile({ startFrame: 5, endFrame: 12 }, [-6, -6, -6, -6, -6, -6, -6, -6], -6);
    expect(p.length).toBe(8);
    expect(Number.isFinite(p[7])).toBe(true);
  });
});

describe("hit-testing", () => {
  const layout = computeLayout(900);
  const vp: Viewport = { scrollSec: 0, pxPerSec: 100, topMidi: 70.5, rowPx: 20 };
  const notes = [note({ startFrame: 100, endFrame: 200, center: 64 }), note({ startFrame: 250, endFrame: 300, center: 67 })];
  const db = new Array(400).fill(-6);
  const profiles = notes.map((n) => blobProfile(n, db, -6));

  it("hits a blob body at its center line", () => {
    const x = timeToX(1.5, vp, layout);
    const y = midiToY(64, vp, layout);
    expect(hitTestNotes(x, y, notes, profiles, 0.01, vp, layout)).toEqual({ index: 0, zone: "body" });
  });

  it("the top third of a blob is the split zone", () => {
    const x = timeToX(1.5, vp, layout);
    const half = profiles[0][50] * vp.rowPx;
    const y = midiToY(64, vp, layout) - half * 0.8;
    expect(hitTestNotes(x, y, notes, profiles, 0.01, vp, layout)).toEqual({ index: 0, zone: "top" });
    const yBottom = midiToY(64, vp, layout) + half * 0.8;
    expect(hitTestNotes(x, yBottom, notes, profiles, 0.01, vp, layout)?.zone).toBe("body");
  });

  it("misses outside the blob, outside the note time, and outside the grid", () => {
    const x = timeToX(1.5, vp, layout);
    expect(hitTestNotes(x, midiToY(62, vp, layout), notes, profiles, 0.01, vp, layout)).toBeNull();
    expect(hitTestNotes(timeToX(2.2, vp, layout), midiToY(64, vp, layout), notes, profiles, 0.01, vp, layout)).toBeNull();
    expect(hitTestNotes(x, 5, notes, profiles, 0.01, vp, layout)).toBeNull();
  });

  it("uses the displayed pitch (e.g. while dragging) and keeps a minimum grab height", () => {
    const x = timeToX(1.5, vp, layout);
    const hit = hitTestNotes(x, midiToY(66, vp, layout), notes, profiles, 0.01, vp, layout, (i) => (i === 0 ? 66 : notes[i].target));
    expect(hit?.index).toBe(0);
    const thin = [new Float32Array(101).fill(0.01), profiles[1]];
    const y = midiToY(64, vp, layout) + MIN_HIT_HALF_ROWS * vp.rowPx * 0.9;
    expect(hitTestNotes(x, y, notes, thin, 0.01, vp, layout)?.index).toBe(0);
  });

  it("marquee selects notes whose center line crosses the rectangle", () => {
    const rect = { x0: timeToX(0.5, vp, layout), y0: midiToY(65, vp, layout), x1: timeToX(3.5, vp, layout), y1: midiToY(63, vp, layout) };
    expect(notesInRect(rect, notes, vp, layout)).toEqual([0]);
    const big = { ...rect, y0: midiToY(69, vp, layout) };
    expect(notesInRect(big, notes, vp, layout)).toEqual([0, 1]);
    // unordered corners work too
    expect(notesInRect({ x0: big.x1, y0: big.y1, x1: big.x0, y1: big.y0 }, notes, vp, layout)).toEqual([0, 1]);
  });
});

describe("pitch curves", () => {
  it("splits voiced runs at nulls", () => {
    const pitch = [null, 60, 60.1, null, 61, 61, 61, null];
    expect(voicedRuns(pitch, 0, 7)).toEqual([
      [1, 2],
      [4, 6],
    ]);
    expect(voicedRuns(pitch, 5, 20)).toEqual([[5, 6]]);
  });
});

describe("undo", () => {
  it("undo/redo round trip", () => {
    const u = new UndoStack<number>();
    expect(u.canUndo).toBe(false);
    u.push(1, undefined, 0);
    u.push(2, undefined, 10);
    expect(u.undo(3)).toBe(2);
    expect(u.undo(2)).toBe(1);
    expect(u.undo(1)).toBeNull();
    expect(u.redo(1)).toBe(2);
    expect(u.redo(2)).toBe(3);
    expect(u.canRedo).toBe(false);
  });

  it("a new push clears redo", () => {
    const u = new UndoStack<number>();
    u.push(1, undefined, 0);
    u.undo(2);
    expect(u.canRedo).toBe(true);
    u.push(5, undefined, 100);
    expect(u.canRedo).toBe(false);
  });

  it("coalesces rapid pushes with the same key (slider drags)", () => {
    const u = new UndoStack<number>(200, 1000);
    u.push(1, "vib", 0);
    u.push(2, "vib", 300);
    u.push(3, "vib", 600);
    u.push(4, "drift", 700);
    u.push(5, "vib", 5000);
    expect(u.undo(9)).toBe(5);
    expect(u.undo(5)).toBe(4);
    expect(u.undo(4)).toBe(1);
    expect(u.canUndo).toBe(false);
  });

  it("is bounded", () => {
    const u = new UndoStack<number>(3);
    for (let i = 0; i < 10; i++) u.push(i, undefined, i * 5000);
    expect(u.undo(99)).toBe(9);
    expect(u.undo(9)).toBe(8);
    expect(u.undo(8)).toBe(7);
    expect(u.undo(7)).toBeNull();
  });

  it("snapshots note state", () => {
    const n = note({ startFrame: 0, endFrame: 10, center: 60, target: 61, drift: 0.5 });
    expect(snapshotNotes([n])).toEqual([{ startFrame: 0, endFrame: 10, startSec: 0, endSec: 0.1, target: 61, drift: 0.5, modulation: 1 }]);
  });

  it("plans a merge to undo a split, and a split to undo a merge", () => {
    const whole = [{ startFrame: 0, endFrame: 100, startSec: 0 }];
    const split = [
      { startFrame: 0, endFrame: 50, startSec: 0 },
      { startFrame: 50, endFrame: 100, startSec: 0.5 },
    ];
    expect(nextStructuralOp(split, whole)).toEqual({ kind: "merge", index: 0 });
    expect(nextStructuralOp(whole, split)).toEqual({ kind: "split", index: 0, sec: 0.5 });
    expect(nextStructuralOp(split, split)).toBeNull();
    expect(nextStructuralOp(whole, whole)).toBeNull();
  });

  it("does not merge separate notes that both exist in the target", () => {
    const a = [
      { startFrame: 0, endFrame: 40, startSec: 0 },
      { startFrame: 60, endFrame: 100, startSec: 0.6 },
    ];
    expect(nextStructuralOp(a, a)).toBeNull();
  });

  it("matches snapshot notes to current notes by start frame", () => {
    const snap = snapshotNotes([note({ startFrame: 10, endFrame: 20, center: 60, target: 62 }), note({ startFrame: 30, endFrame: 40, center: 61 })]);
    const current = [{ startFrame: 11 }, { startFrame: 30 }, { startFrame: 90 }];
    expect(matchSnapshot(current, snap).map(([i]) => i)).toEqual([1]); // exact frames by default
    const m = matchSnapshot(current, snap, 1);
    expect(m.map(([i]) => i)).toEqual([0, 1]);
    expect(m[0][1].target).toBe(62);
  });

  it("undoes a split made one frame from a note edge (engine notes share boundary frames)", () => {
    const whole = [{ startFrame: 147, endFrame: 153, startSec: 1.47 }];
    const split = [
      { startFrame: 147, endFrame: 148, startSec: 1.47 },
      { startFrame: 148, endFrame: 153, startSec: 1.48 },
    ];
    expect(nextStructuralOp(split, whole)).toEqual({ kind: "merge", index: 0 });
    expect(nextStructuralOp(whole, split)).toEqual({ kind: "split", index: 0, sec: 1.48 });
  });
});

describe("audio helpers", () => {
  it("mixes channels to mono", () => {
    const m = mixToMono([new Float32Array([1, 0, 0.5]), new Float32Array([0, 1, 0.5])]);
    expect(Array.from(m)).toEqual([0.5, 0.5, 0.5]);
    const single = new Float32Array([0.1, 0.2]);
    const copy = mixToMono([single]);
    expect(copy).not.toBe(single);
    expect(Array.from(copy)).toEqual(Array.from(single));
    expect(mixToMono([]).length).toBe(0);
  });

  it("patches samples with clipping at both ends", () => {
    const d = new Float32Array(10);
    expect(patchSamples(d, 8, new Float32Array([1, 2, 3, 4]))).toEqual([8, 10]);
    expect(Array.from(d.slice(7))).toEqual([0, 1, 2]);
    const e = new Float32Array(5);
    expect(patchSamples(e, -2, new Float32Array([1, 2, 3, 4]))).toEqual([0, 2]);
    expect(Array.from(e)).toEqual([3, 4, 0, 0, 0]);
    expect(patchSamples(e, 20, new Float32Array([1]))).toEqual([20, 20]);
  });

  it("computes and updates waveform peaks", () => {
    const d = new Float32Array(10);
    d[3] = -0.8;
    d[7] = 0.4;
    const peaks = computePeaks(d, 4);
    expect(peaks.length).toBe(3);
    expect(peaks[0]).toBeCloseTo(0.8);
    expect(peaks[1]).toBeCloseTo(0.4);
    d[3] = 0.1;
    updatePeaks(peaks, d, 4, 2, 4);
    expect(peaks[0]).toBeCloseTo(0.1);
  });

  it("encodes a valid 16-bit mono WAV", () => {
    const wav = encodeWav16(new Float32Array([0, 1, -1, 0.5, 2]), 44100);
    const v = new DataView(wav);
    const str = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(wav.byteLength).toBe(44 + 10);
    expect(str(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 10);
    expect(str(8)).toBe("WAVE");
    expect(str(12)).toBe("fmt ");
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(88200);
    expect(v.getUint16(34, true)).toBe(16);
    expect(str(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(10);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
    expect(v.getInt16(50, true)).toBe(Math.round(0.5 * 32767));
    expect(v.getInt16(52, true)).toBe(32767); // clipped
  });

  it("merges overlapping spans", () => {
    expect(mergeSpans([
      [2, 3],
      [0, 1],
      [0.5, 1.5],
      [3, 4],
      [5, 5],
    ])).toEqual([
      [0, 1.5],
      [2, 4],
    ]);
  });
});

describe("playhead helpers", () => {
  const notes = [
    { startSec: 1, endSec: 2 },
    { startSec: 3, endSec: 4 },
  ];
  it("noteAtTime finds the sung note, else the next one coming up, else the last one", () => {
    expect(noteAtTime(notes, 1.5)).toEqual({ index: 0, sounding: true });
    expect(noteAtTime(notes, 3.0)).toEqual({ index: 1, sounding: true });
    expect(noteAtTime(notes, 0)).toEqual({ index: 0, sounding: false }); // silence before the first note
    expect(noteAtTime(notes, 2.2)).toEqual({ index: 1, sounding: false }); // gap: the next note
    expect(noteAtTime(notes, 10)).toEqual({ index: 1, sounding: false }); // after the end: the last note
    expect(noteAtTime([], 1)).toBeNull();
  });

  it("edgeScrollPx scrolls left/right only near the edges, faster deeper in", () => {
    const layout = computeLayout(1000);
    const mid = layout.gridLeft + layout.gridWidth / 2;
    expect(edgeScrollPx(mid, layout)).toBe(0);
    expect(edgeScrollPx(layout.gridLeft + 30, layout)).toBeLessThan(0);
    expect(edgeScrollPx(layout.gridLeft + 2, layout)).toBeLessThan(edgeScrollPx(layout.gridLeft + 30, layout));
    expect(edgeScrollPx(layout.gridLeft - 500, layout)).toBe(-EDGE_MAX_PX_PER_FRAME);
    expect(edgeScrollPx(layout.gridLeft + layout.gridWidth - 10, layout)).toBeGreaterThan(0);
    expect(edgeScrollPx(layout.gridLeft + layout.gridWidth + 500, layout)).toBe(EDGE_MAX_PX_PER_FRAME);
  });
});
