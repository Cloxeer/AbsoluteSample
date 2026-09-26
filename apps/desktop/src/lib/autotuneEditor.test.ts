import { describe, expect, it } from "vitest";
import {
  applyHumanize,
  buildEditableNotes,
  buildScalePitchClasses,
  computeAutotuneLayout,
  isBlackKey,
  midiToNoteName,
  nearestScaleMidi,
  resetEditableNotes,
  retuneSpeedToParams,
  setNoteTarget,
  snapYToMidi,
  toAutotuneNoteEdits,
  tuneNotesToScale,
  tuningBucket,
} from "./autotuneEditor";
import type { PitchNote, PitchPoint } from "./types";

function note(startSec: number, endSec: number, midi: number, cents = 0): PitchNote {
  return { startSec, endSec, midi, cents, confidence: 0.9 };
}

function point(t: number, midi: number, voiced = true): PitchPoint {
  return { t, hz: 440 * Math.pow(2, (midi - 69) / 12), midi, cents: 0, voiced };
}

describe("isBlackKey", () => {
  it("flags black-key pitch classes", () => {
    expect(isBlackKey(61)).toBe(true); // C#
    expect(isBlackKey(60)).toBe(false); // C
  });
});

describe("midiToNoteName", () => {
  it("names middle C and neighbors", () => {
    expect(midiToNoteName(60)).toBe("C4");
    expect(midiToNoteName(69)).toBe("A4");
    expect(midiToNoteName(61)).toBe("C#4");
  });
});

describe("computeAutotuneLayout", () => {
  it("pads the note range by 2 semitones and expands to a minimum of 2 octaves", () => {
    const layout = computeAutotuneLayout([note(0, 1, 60), note(1, 2, 64)], []);
    expect(layout.minMidi).toBeLessThanOrEqual(58);
    expect(layout.maxMidi).toBeGreaterThanOrEqual(66);
    expect(layout.maxMidi - layout.minMidi).toBeGreaterThanOrEqual(24);
  });

  it("maps pitch to y descending and is invertible", () => {
    const layout = computeAutotuneLayout([note(0, 1, 60), note(1, 2, 72)], []);
    expect(layout.yForMidi(72)).toBeLessThan(layout.yForMidi(60));
    expect(layout.midiForY(layout.yForMidi(65.5))).toBeCloseTo(65.5, 5);
  });

  it("maps time to x proportionally and is invertible", () => {
    const layout = computeAutotuneLayout([note(0, 8, 60)], [], { pxPerSec: 50 });
    expect(layout.xForSec(0)).toBe(0);
    expect(layout.xForSec(2)).toBe(100);
    expect(layout.secForX(layout.xForSec(3.5))).toBeCloseTo(3.5, 5);
  });

  it("uses the f0 contour's end time when it exceeds the last note's end", () => {
    const layout = computeAutotuneLayout([note(0, 1, 60)], [point(0, 60), point(5, 60)]);
    expect(layout.durationSec).toBe(5);
  });

  it("falls back to a default centered range with no notes", () => {
    const layout = computeAutotuneLayout([], []);
    expect(layout.maxMidi - layout.minMidi).toBeGreaterThanOrEqual(24);
  });
});

describe("tuningBucket", () => {
  it("buckets in-tune, close and off by absolute cents", () => {
    expect(tuningBucket(3)).toBe("in-tune");
    expect(tuningBucket(-5)).toBe("in-tune");
    expect(tuningBucket(12)).toBe("close");
    expect(tuningBucket(-20)).toBe("close");
    expect(tuningBucket(35)).toBe("off");
  });
});

describe("buildScalePitchClasses", () => {
  it("returns null for chromatic", () => {
    expect(buildScalePitchClasses("chromatic", 0)).toBeNull();
  });

  it("builds a C major scale", () => {
    expect(buildScalePitchClasses("major", 0)).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it("transposes minor scale steps by the tonic pitch class", () => {
    const scale = buildScalePitchClasses("minor", 9); // A natural minor -> same pitch classes as C major
    expect(scale).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it("supports dorian and mixolydian modes", () => {
    expect(buildScalePitchClasses("dorian", 0)).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(buildScalePitchClasses("mixolydian", 0)).toEqual([0, 2, 4, 5, 7, 9, 10]);
  });
});

describe("retuneSpeedToParams", () => {
  it("maps Fast (100) to hard, near-instant correction", () => {
    const p = retuneSpeedToParams(100);
    expect(p.snapStrength).toBeCloseTo(1.0, 3);
    expect(p.transitionMs).toBe(0);
  });

  it("maps Slow (0) to a lower strength and a longer transition", () => {
    const p = retuneSpeedToParams(0);
    expect(p.snapStrength).toBeCloseTo(0.3, 3);
    expect(p.transitionMs).toBe(150);
  });

  it("is monotonic between Slow and Fast", () => {
    const slow = retuneSpeedToParams(20);
    const mid = retuneSpeedToParams(50);
    const fast = retuneSpeedToParams(80);
    expect(slow.snapStrength).toBeLessThan(mid.snapStrength);
    expect(mid.snapStrength).toBeLessThan(fast.snapStrength);
    expect(slow.transitionMs).toBeGreaterThan(mid.transitionMs);
    expect(mid.transitionMs).toBeGreaterThan(fast.transitionMs);
  });

  it("clamps out-of-range input", () => {
    expect(retuneSpeedToParams(-50)).toEqual(retuneSpeedToParams(0));
    expect(retuneSpeedToParams(500)).toEqual(retuneSpeedToParams(100));
  });
});

describe("applyHumanize", () => {
  it("leaves the transition unchanged at 0", () => {
    expect(applyHumanize(40, 0)).toBe(40);
  });

  it("adds smoothing proportional to the humanize amount", () => {
    expect(applyHumanize(40, 100)).toBe(80);
  });
});

describe("nearestScaleMidi", () => {
  it("keeps an in-scale pitch unchanged", () => {
    expect(nearestScaleMidi(60, [0, 2, 4, 5, 7, 9, 11])).toBe(60); // C4 is in C major
  });

  it("snaps an out-of-scale pitch to the nearest scale tone", () => {
    expect(nearestScaleMidi(61, [0, 2, 4, 5, 7, 9, 11])).toBe(60); // C#4 -> C4 (closer than D4)
  });

  it("rounds a fractional pitch before snapping", () => {
    expect(nearestScaleMidi(60.4, [0, 2, 4, 5, 7, 9, 11])).toBe(60);
  });
});

describe("editable note helpers", () => {
  const notes: PitchNote[] = [note(0, 1, 60.4, -4), note(1, 2, 63, 6)];

  it("builds editable notes with rounded targetMidi", () => {
    const editable = buildEditableNotes(notes);
    expect(editable[0].targetMidi).toBe(60);
    expect(editable[1].targetMidi).toBe(63);
  });

  it("setNoteTarget updates only the given index and snaps to a whole semitone", () => {
    const editable = buildEditableNotes(notes);
    const updated = setNoteTarget(editable, 0, 62.6);
    expect(updated[0].targetMidi).toBe(63);
    expect(updated[1].targetMidi).toBe(63);
    expect(updated[1]).toBe(editable[1]); // untouched entries keep their original reference
  });

  it("resetEditableNotes clears any target back to the detected pitch", () => {
    const editable = setNoteTarget(buildEditableNotes(notes), 0, 70);
    const reset = resetEditableNotes(editable);
    expect(reset[0].targetMidi).toBe(60);
  });

  it("tuneNotesToScale snaps every note to the nearest scale tone", () => {
    const editable = buildEditableNotes(notes);
    const tuned = tuneNotesToScale(editable, [0, 2, 4, 5, 7, 9, 11]); // C major
    expect(tuned[0].targetMidi).toBe(60); // already C4
    expect(tuned[1].targetMidi).toBe(62); // D#4(63) -> D4(62), nearer than E4
  });

  it("tuneNotesToScale with a null scale rounds to nearest semitone", () => {
    const editable = buildEditableNotes(notes);
    const tuned = tuneNotesToScale(editable, null);
    expect(tuned[0].targetMidi).toBe(60);
  });

  it("toAutotuneNoteEdits maps to the backend payload shape", () => {
    const editable = setNoteTarget(buildEditableNotes(notes), 1, 65);
    expect(toAutotuneNoteEdits(editable)).toEqual([
      { startSec: 0, endSec: 1, targetMidi: 60 },
      { startSec: 1, endSec: 2, targetMidi: 65 },
    ]);
  });
});

describe("snapYToMidi", () => {
  it("rounds and clamps a y-coordinate to the layout's midi range", () => {
    const layout = computeAutotuneLayout([note(0, 1, 60)], []);
    expect(snapYToMidi(layout.yForMidi(60), layout)).toBe(60);
    expect(snapYToMidi(-1000, layout)).toBe(layout.maxMidi);
    expect(snapYToMidi(1000000, layout)).toBe(layout.minMidi);
  });
});
