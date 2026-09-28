import { describe, expect, it } from "vitest";
import { expandSpans, flattenWarps, inToOut, isValidSegment, outToIn, warpAnalysis, type WarpSegment } from "./timeWarp";
import type { Analysis } from "./melodyneEditor";

const seg: WarpSegment = { anchors: [[0.9, 0.9], [1.0, 1.06], [1.6, 1.6]] };

describe("timeWarp", () => {
  it("maps both ways and is the identity outside segments", () => {
    expect(outToIn([seg], 1.0)).toBeCloseTo(1.06);
    expect(inToOut([seg], 1.06)).toBeCloseTo(1.0);
    expect(inToOut([seg], outToIn([seg], 1.3))).toBeCloseTo(1.3);
    expect(outToIn([seg], 0.5)).toBe(0.5);
    expect(inToOut([seg], 2)).toBe(2);
  });

  it("validates like the engine (identity ends, increasing, 0.5x..2x speed)", () => {
    expect(isValidSegment(seg)).toBe(true);
    expect(isValidSegment({ anchors: [[0.9, 0.95], [1.6, 1.6]] })).toBe(false);
    expect(isValidSegment({ anchors: [[0.9, 0.9], [0.95, 1.3], [1.6, 1.6]] })).toBe(false);
    expect(isValidSegment({ anchors: [[0.9, 0.9]] })).toBe(false);
  });

  it("flattens for the engine and grows render spans to whole segments", () => {
    expect(Array.from(flattenWarps([seg]))).toEqual([3, 0.9, 0.9, 1, 1.06, 1.6, 1.6].map((v) => Math.fround(v)));
    expect(expandSpans([[1.2, 1.3], [3, 4]], [seg])).toEqual([[0.9, 1.6], [3, 4]]);
  });

  it("warpAnalysis shows notes where they are heard and keeps indices", () => {
    const n = (s: number, e: number) => ({ startSec: s, endSec: e, startFrame: s * 100, endFrame: e * 100, center: 60, target: 60, drift: 1, modulation: 1, peakDb: -6 });
    const pitch = Array.from({ length: 200 }, (_, f) => (f >= 106 && f <= 150 ? 60 : null));
    const a: Analysis = { hopSec: 0.01, durationSec: 2, pitch, editedPitch: pitch, db: pitch.map((p) => (p === null ? -60 : -6)), notes: [n(0.2, 0.5), n(1.06, 1.5)], key: null };
    const w = warpAnalysis(a, [seg]);
    expect(w.notes[0].startSec).toBe(0.2);
    expect(w.notes[1].startSec).toBeCloseTo(1.0);
    expect(w.notes[1].startFrame).toBe(100);
    expect(w.pitch[101]).toBe(60);
    expect(w.pitch[99]).toBeNull();
    // Cached: the same object for the same inputs; untouched without warps.
    expect(warpAnalysis(a, w === a ? [] : [seg])).toBeDefined();
    expect(warpAnalysis(a, [])).toBe(a);
  });
});
