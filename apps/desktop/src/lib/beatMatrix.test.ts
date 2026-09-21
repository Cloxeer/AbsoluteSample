import { describe, expect, it } from "vitest";
import { padsForRow, onsetsFromAnalysis, type Onset } from "./beatMatrix";
import type { LoopAnalysis } from "./types";

describe("padsForRow", () => {
  it("lights a pad when an onset falls within the window and leaves others dark", () => {
    const onsets: Onset[] = [{ time: 1.0, strength: 0.8 }];
    const grid = [0, 0.5, 1.0, 1.5];
    const result = padsForRow(onsets, grid, 0.1);
    expect(result).toEqual([0, 0, 1, 0]);
  });

  it("normalizes pad opacity 0..1 by the row's strongest onset", () => {
    const onsets: Onset[] = [
      { time: 0, strength: 0.4 },
      { time: 1, strength: 0.8 },
    ];
    const grid = [0, 1];
    const result = padsForRow(onsets, grid, 0.05);
    expect(result[0]).toBeCloseTo(0.5, 5);
    expect(result[1]).toBeCloseTo(1, 5);
  });

  it("returns all zeros when there are no onsets", () => {
    const result = padsForRow([], [0, 1, 2], 0.1);
    expect(result).toEqual([0, 0, 0]);
  });

  it("picks the strongest onset when multiple fall within the window", () => {
    const onsets: Onset[] = [
      { time: 0.98, strength: 0.3 },
      { time: 1.02, strength: 0.9 },
    ];
    const result = padsForRow(onsets, [1.0], 0.1);
    expect(result[0]).toBeCloseTo(1, 5);
  });
});

describe("onsetsFromAnalysis", () => {
  it("extracts one onset per transient with strength sampled from the onset envelope", () => {
    const analysis: LoopAnalysis = {
      bpm: 120,
      confidence: 0.9,
      transients: [0, 0.5],
      beatGrid: [0, 0.5],
      bars: 1,
      onsetEnvelope: new Array(200).fill(0).map((_, i) => (i === 0 ? 0.9 : i === 43 ? 0.6 : 0.1)),
      peakDb: -1,
      rmsDb: -14,
    };
    const onsets = onsetsFromAnalysis(analysis);
    expect(onsets).toHaveLength(2);
    expect(onsets[0].strength).toBeCloseTo(0.9, 5);
    expect(onsets[1].strength).toBeCloseTo(0.6, 5);
  });
});
