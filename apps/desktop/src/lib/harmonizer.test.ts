import { describe, expect, it } from "vitest";
import { detectRole, findSections, isClash, planFixHarmonies, scaleStep, type StackTrack } from "./harmonizer";
import { scalePitchClasses, type EngineNote } from "./melodyneEditor";

const C_MAJOR = scalePitchClasses(0, "major");
const HOP = 0.01;

/** Notes from [startSec, endSec, sungCenter] triples. */
function notes(spec: [number, number, number][]): EngineNote[] {
  return spec.map(([s, e, c]) => ({
    startSec: s,
    endSec: e,
    startFrame: Math.round(s / HOP),
    endFrame: Math.round(e / HOP),
    center: c,
    target: c,
    drift: 1,
    modulation: 1,
    peakDb: -6,
  }));
}

// Lead melody in C major: E D C D E E E (Mary had a little lamb), each 0.4 s, slightly off.
const leadSpec: [number, number, number][] = [
  [0.0, 0.4, 64.1],
  [0.4, 0.8, 61.85],
  [0.8, 1.2, 60.2],
  [1.2, 1.6, 62.1],
  [1.6, 2.0, 63.8],
  [2.0, 2.4, 64.05],
  [2.4, 3.0, 64.2],
];
const lead: StackTrack = { id: "lead", notes: notes(leadSpec), offsetSec: 0, isLead: true };

/** A harmony singing a diatonic 3rd above the lead, with human errors in cents. */
function thirdAbove(errors: number[]): StackTrack {
  const above = [67, 65, 64, 65, 67, 67, 67];
  return { id: "high", notes: notes(leadSpec.map(([s, e], i) => [s, e, above[i] + errors[i]])), offsetSec: 0, isLead: false };
}

const targetsOf = (plan: ReturnType<typeof planFixHarmonies>, id: string) =>
  (plan.tracks.find((t) => t.id === id)?.edits ?? []).map((e) => e.target);

describe("harmonizer (Fix harmonies)", () => {
  it("scale steps and clash intervals", () => {
    expect(scaleStep(64, C_MAJOR) - scaleStep(60, C_MAJOR)).toBe(2); // C -> E is a 3rd
    expect(scaleStep(67, C_MAJOR) - scaleStep(60, C_MAJOR)).toBe(4); // C -> G is a 5th
    expect(isClash(1)).toBe(true);
    expect(isClash(11)).toBe(true);
    expect(isClash(6)).toBe(true);
    expect(isClash(4)).toBe(false);
    expect(isClash(-3)).toBe(false);
  });

  it("tunes the lead gently: held notes land on the key, vibrato and most of the wander stay", () => {
    const plan = planFixHarmonies([lead], new Set(["lead"]), { scalePcs: C_MAJOR, tight: 0 });
    expect(targetsOf(plan, "lead")).toEqual([64, 62, 60, 62, 64, 64, 64]);
    const e = plan.tracks[0].edits;
    expect(e.every((x) => x.modulation === 1 && x.drift >= 0.7)).toBe(true);
    // Tight holds it steadier.
    const tight = planFixHarmonies([lead], new Set(["lead"]), { scalePcs: C_MAJOR, tight: 1 }).tracks[0].edits;
    expect(tight.every((x) => x.drift < 0.4 && x.modulation < 1)).toBe(true);
  });

  it("snaps a sloppy 3rd-above harmony onto the right notes and reports its role", () => {
    const high = thirdAbove([-0.4, 0.3, -0.35, 0.2, 0.45, -0.3, 0.1]);
    const plan = planFixHarmonies([lead, high], new Set(["lead", "high"]), { scalePcs: C_MAJOR, tight: 0 });
    expect(targetsOf(plan, "high")).toEqual([67, 65, 64, 65, 67, 67, 67]);
    const t = plan.tracks.find((x) => x.id === "high")!;
    expect(t.role?.steps).toBe(2);
    expect(t.role?.label).toMatch(/high harmony/i);
    expect(t.clashesAfter).toBe(0);
  });

  it("fixes a note sung a semitone wrong (a clash) instead of keeping the mistake", () => {
    // Over the lead's D (62) the singer hit F# (66, clashes: tritone against C... and out of key).
    const high = thirdAbove([0, 0.9, 0, 0, 0, 0, 0]); // 65.9 over D: nearest in-key note is F(65) or G(67)
    const plan = planFixHarmonies([lead, high], new Set(["lead", "high"]), { scalePcs: C_MAJOR, tight: 0 });
    // F keeps the 3rd-above role and is consonant; G would be a 4th over D.
    expect(targetsOf(plan, "high")[1]).toBe(65);
  });

  it("keeps an intentional double (unison with the lead) a double", () => {
    const dbl: StackTrack = { id: "dbl", notes: notes(leadSpec.map(([s, e, c]) => [s, e, c + 0.05])), offsetSec: 0, isLead: false };
    const plan = planFixHarmonies([lead, dbl], new Set(["lead", "dbl"]), { scalePcs: C_MAJOR, tight: 0 });
    expect(targetsOf(plan, "dbl")).toEqual(targetsOf(plan, "lead"));
    expect(plan.tracks.find((t) => t.id === "dbl")!.role?.label).toMatch(/double/i);
  });

  it("follows the harmony's own melodic shape rather than jumping around", () => {
    // A 6th below the lead the whole way, sung a bit flat each time.
    const below = [57, 55, 55, 55, 57, 57, 57].map((m) => m - 0.3);
    const low: StackTrack = { id: "low", notes: notes(leadSpec.map(([s, e], i) => [s, e, below[i]])), offsetSec: 0, isLead: false };
    const plan = planFixHarmonies([lead, low], new Set(["lead", "low"]), { scalePcs: C_MAJOR, tight: 0 });
    expect(targetsOf(plan, "low")).toEqual([57, 55, 55, 55, 57, 57, 57]);
  });

  it("leaves slides and very short notes alone", () => {
    const h: StackTrack = { id: "h", notes: notes([[0, 0.05, 66.5], [0.05, 0.4, 67.2]]), offsetSec: 0, isLead: false };
    const plan = planFixHarmonies([lead, h], new Set(["lead", "h"]), { scalePcs: C_MAJOR, tight: 0 });
    const edits = plan.tracks.find((t) => t.id === "h")!.edits;
    expect(edits.map((e) => e.index)).toEqual([1]);
  });

  it("keeps two harmonies from rubbing against each other", () => {
    const high = thirdAbove([0, 0, 0, 0, 0, 0, 0]);
    // A second harmony drifting between F and F# over the lead's E: F would rub a semitone on the 3rd-above G.
    const other: StackTrack = { id: "other", notes: notes([[0, 0.4, 65.45]]), offsetSec: 0, isLead: false };
    const plan = planFixHarmonies([lead, high, other], new Set(["lead", "high", "other"]), { scalePcs: C_MAJOR, tight: 0 });
    const t = targetsOf(plan, "other")[0];
    expect(isClash(t - 67)).toBe(false);
    expect(isClash(t - 64)).toBe(false);
  });

  it("respects offsets on the shared timeline and skips tracks that are not included", () => {
    const shifted: StackTrack = { ...thirdAbove([0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]), offsetSec: 0 };
    const plan = planFixHarmonies([lead, shifted], new Set(["high"]), { scalePcs: C_MAJOR, tight: 0 });
    expect(plan.tracks.find((t) => t.id === "lead")!.edits).toHaveLength(0);
    expect(targetsOf(plan, "high")).toEqual([67, 65, 64, 65, 67, 67, 67]);
  });

  it("detectRole says 'free' when the take barely overlaps the lead", () => {
    const leadPlaced = [{ s: 0, e: 0.4, target: 64 }];
    const r = detectRole(notes([[5, 6, 67]]), 0, leadPlaced, C_MAJOR);
    expect(r.steps).toBeNull();
    expect(r.label).toMatch(/free/i);
  });

  it("finds lead-alone, stack and harmony-alone sections", () => {
    const l: StackTrack = { id: "l", notes: notes([[0, 2, 60], [4, 6, 60]]), offsetSec: 0, isLead: true };
    const h: StackTrack = { id: "h", notes: notes([[1, 2, 64], [6.5, 7.5, 64]]), offsetSec: 0, isLead: false };
    const secs = findSections([l, h]);
    expect(secs.map((x) => x.kind)).toEqual(["lead", "stack", "lead", "harmony"]);
    expect(secs[1]).toMatchObject({ startSec: 1, endSec: 2 });
  });

  it("is fast: a 3-minute lead with four harmonies plans in well under 100 ms", () => {
    const n = 900;
    const long = (off: number, id: string, isLead: boolean): StackTrack => ({
      id,
      isLead,
      offsetSec: 0,
      notes: notes(Array.from({ length: n }, (_, i) => [i * 0.2, i * 0.2 + 0.18, 60 + ((i * 7) % 12) + off + 0.2] as [number, number, number])),
    });
    const tracks = [long(0, "lead", true), long(4, "a", false), long(7, "b", false), long(-5, "c", false), long(12, "d", false)];
    const t0 = performance.now();
    planFixHarmonies(tracks, new Set(tracks.map((t) => t.id)), { scalePcs: C_MAJOR, tight: 0.5 });
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
