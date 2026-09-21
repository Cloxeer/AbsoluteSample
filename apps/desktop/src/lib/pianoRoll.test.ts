import { describe, expect, it } from "vitest";
import { computePianoRollLayout, isBlackKey } from "./pianoRoll";
import type { NoteEvent } from "./types";

function note(startSec: number, endSec: number, midi: number): NoteEvent {
  return { startSec, endSec, midi, name: `m${midi}`, velocity: 100 };
}

describe("isBlackKey", () => {
  it("flags black-key pitch classes", () => {
    expect(isBlackKey(61)).toBe(true); // C#
    expect(isBlackKey(60)).toBe(false); // C
  });
});

describe("computePianoRollLayout", () => {
  it("expands a narrow note range to a minimum of 2 octaves", () => {
    const layout = computePianoRollLayout([note(0, 1, 60), note(1, 2, 64)]);
    expect(layout.maxMidi - layout.minMidi).toBeGreaterThanOrEqual(24);
    expect(layout.minMidi).toBeLessThanOrEqual(60);
    expect(layout.maxMidi).toBeGreaterThanOrEqual(64);
  });

  it("keeps a wide note range as-is", () => {
    const layout = computePianoRollLayout([note(0, 1, 40), note(1, 2, 90)]);
    expect(layout.minMidi).toBe(40);
    expect(layout.maxMidi).toBe(90);
  });

  it("maps pitch to y descending (higher pitch drawn above lower pitch)", () => {
    const layout = computePianoRollLayout([note(0, 1, 60), note(1, 2, 72)]);
    expect(layout.yForMidi(72)).toBeLessThan(layout.yForMidi(60));
  });

  it("maps time to x proportionally", () => {
    const layout = computePianoRollLayout([note(0, 8, 60)], { pxPerSec: 50 });
    expect(layout.xForSec(0)).toBe(0);
    expect(layout.xForSec(2)).toBe(100);
    expect(layout.width).toBeGreaterThanOrEqual(layout.xForSec(8));
  });

  it("falls back to a default centered range with no notes", () => {
    const layout = computePianoRollLayout([]);
    expect(layout.maxMidi - layout.minMidi).toBeGreaterThanOrEqual(24);
  });
});
