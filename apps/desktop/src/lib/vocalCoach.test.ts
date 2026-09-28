import { describe, expect, it } from "vitest";
import { coachNote, coachSummary, nextNoteHints, renderGuide, steadiness } from "./vocalCoach";
import { scalePitchClasses, type Analysis, type EngineNote } from "./melodyneEditor";

const C_MAJOR = scalePitchClasses(0, "major");
const HOP = 0.01;

function note(s: number, e: number, center: number): EngineNote {
  return { startSec: s, endSec: e, startFrame: Math.round(s / HOP), endFrame: Math.round(e / HOP), center, target: center, drift: 1, modulation: 1, peakDb: -6 };
}

function pitchFor(notes: EngineNote[], frames: number, fn: (n: EngineNote, f: number) => number = (n) => n.center): (number | null)[] {
  const p: (number | null)[] = new Array(frames).fill(null);
  for (const n of notes) for (let f = n.startFrame; f <= n.endFrame; f++) p[f] = fn(n, f);
  return p;
}

describe("vocalCoach", () => {
  it("steadiness ignores vibrato but catches a wandering note", () => {
    const n = note(0, 1, 64);
    const vib = pitchFor([n], 110, (m, f) => m.center + 0.3 * Math.sin((2 * Math.PI * 6 * f * HOP)));
    const wander = pitchFor([n], 110, (m, f) => m.center + 0.6 * Math.sin((2 * Math.PI * 1 * f * HOP)));
    expect(steadiness(vib, n)!).toBeGreaterThan(0.8);
    expect(steadiness(wander, n)!).toBeLessThan(0.4);
    expect(steadiness(vib, note(0, 0.1, 64))).toBeNull();
  });

  it("per note: what to aim for, how far off, in plain words", () => {
    const flat = coachNote(note(0, 1, 63.6), pitchFor([note(0, 1, 63.6)], 110), C_MAJOR);
    expect(flat).toMatchObject({ aimName: "E4", cents: -40 });
    expect(flat.verdict).toMatch(/a little flat/i);
    const on = coachNote(note(0, 1, 60.1), pitchFor([note(0, 1, 60.1)], 110), C_MAJOR);
    expect(on.verdict).toMatch(/^on pitch/i);
    expect(coachNote(note(0, 1, 67.4), pitchFor([note(0, 1, 67.4)], 110), C_MAJOR).verdict).toMatch(/a little sharp/i);
  });

  it("summary: accuracy, steadiness and the notes most worth practising", () => {
    const ns = [note(0, 0.5, 60.05), note(0.5, 1, 62.45), note(1, 1.5, 64.1), note(1.5, 2, 65.35), note(2, 2.05, 70)];
    const a: Analysis = { hopSec: HOP, durationSec: 3, pitch: pitchFor(ns, 300), editedPitch: pitchFor(ns, 300), db: [], notes: ns, key: null };
    const s = coachSummary(a, C_MAJOR);
    expect(s.heldNotes).toBe(4);
    expect(s.accuracy).toBeCloseTo(0.5);
    expect(s.steadiness).toBeCloseTo(1);
    expect(s.practice.map((p) => p.index)).toEqual([1, 3]);
    expect(s.practice[0]).toMatchObject({ aimName: "D4", cents: 45 });
  });

  it("melody hints follow the pull of the scale", () => {
    // B (7th of C major) wants to rise to C.
    expect(nextNoteHints(71, 0, C_MAJOR)[0]).toMatchObject({ name: "C5" });
    // F (4th) leans down to E.
    expect(nextNoteHints(65, 0, C_MAJOR)[0]).toMatchObject({ name: "E4" });
    // D (2nd) steps home to C.
    expect(nextNoteHints(62, 0, C_MAJOR)[0]).toMatchObject({ name: "C4" });
    // In A minor, G# is not in the natural scale; the nearest in-key note is used.
    expect(nextNoteHints(68, 9, scalePitchClasses(9, "minor")).length).toBeGreaterThan(0);
  });

  it("guide tone: the target notes as a soft, click-free tone at the exact length", () => {
    const ns = [{ ...note(0.5, 1, 60.3), target: 60 }, note(1, 1.05, 70)];
    const g = renderGuide(ns, 8000, 2);
    expect(g.length).toBe(16000);
    expect(Math.max(...g.subarray(0, 3990).map(Math.abs))).toBe(0);
    expect(Math.max(...g.subarray(5000, 7000).map(Math.abs))).toBeGreaterThan(0.1);
    expect(Math.max(...g.subarray(8100).map(Math.abs))).toBe(0); // too-short note skipped
    const jump = Math.max(...Array.from(g.subarray(1, 16000), (v, i) => Math.abs(v - g[i])));
    expect(jump).toBeLessThan(0.1);
  });
});
