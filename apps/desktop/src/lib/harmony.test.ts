import { describe, expect, it } from "vitest";
import { detectKeyAcross, intervalTo, leadNoteAt, type KeyNote } from "./harmony";

const notes = (midis: number[], len = 0.5): KeyNote[] => midis.map((m, i) => ({ startSec: i * len, endSec: (i + 1) * len, target: m }));

describe("harmony helpers", () => {
  it("detects one key from several takes (lead weighted more)", () => {
    // B minor material: B C# D E F# G A
    const lead = notes([71, 73, 74, 76, 78, 74, 71, 69, 71, 74, 78, 71]);
    const h1 = notes([74, 76, 78, 79, 81, 78, 74, 73]);
    const k = detectKeyAcross([{ notes: lead, weight: 2 }, { notes: h1, weight: 1 }]);
    expect(k).not.toBeNull();
    expect(k!.tonicPc).toBe(11); // B
    expect(k!.mode).toBe("minor");
  });

  it("returns null with no notes", () => {
    expect(detectKeyAcross([{ notes: [], weight: 1 }])).toBeNull();
  });

  it("names intervals to the lead and flags clashes", () => {
    expect(intervalTo(60, 64)).toMatchObject({ semitones: 4, label: "3rd above lead", clash: false });
    expect(intervalTo(60, 55)).toMatchObject({ semitones: -5, label: "4th below lead", clash: false });
    expect(intervalTo(60, 67.2)).toMatchObject({ semitones: 7, label: "5th above lead" });
    expect(intervalTo(60, 61)).toMatchObject({ label: "minor 2nd above lead", clash: true });
    expect(intervalTo(60, 72)).toMatchObject({ label: "octave above lead", clash: false });
    expect(intervalTo(60, 76)).toMatchObject({ label: "3rd + octave above lead" });
    expect(intervalTo(60, 60).label).toBe("unison with lead");
  });

  it("finds the lead note at a timeline time (with lead offset)", () => {
    const lead = notes([60, 62, 64]);
    expect(leadNoteAt(lead, 0, 0.6)?.target).toBe(62);
    expect(leadNoteAt(lead, 1, 1.2)?.target).toBe(60);
    expect(leadNoteAt(lead, 0, 5)).toBeNull();
  });
});
