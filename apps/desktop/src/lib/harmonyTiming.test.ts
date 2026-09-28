import { describe, expect, it } from "vitest";
import { planTightTiming } from "./harmonyTiming";
import { inToOut, isValidSegment, outToIn } from "./timeWarp";
import type { EngineNote } from "./melodyneEditor";

const HOP = 0.01;
function notes(spec: [number, number][]): EngineNote[] {
  return spec.map(([s, e]) => ({ startSec: s, endSec: e, startFrame: Math.round(s / HOP), endFrame: Math.round(e / HOP), center: 64, target: 64, drift: 1, modulation: 1, peakDb: -6 }));
}

const lead = [
  { startSec: 1.0, endSec: 1.4 },
  { startSec: 1.4, endSec: 1.9 },
  { startSec: 3.0, endSec: 3.6 },
];

describe("planTightTiming (Tighten timing)", () => {
  it("pulls late and early syllables toward the lead, inside valid identity-ended segments", () => {
    // Harmony: 50 ms late into the first line, 30 ms early on its second note, releases 60 ms late.
    const h = notes([
      [1.05, 1.37],
      [1.37, 1.96],
      [3.02, 3.6],
    ]);
    const plan = planTightTiming({ lead, notes: h, offsetSec: 0, durationSec: 5, tight: 1 });
    expect(plan.segments.length).toBe(2);
    for (const s of plan.segments) expect(isValidSegment(s)).toBe(true);
    // Fully tight: the syllable sung at 1.05 is heard at 1.00; the release at 1.96 at 1.90.
    expect(inToOut(plan.segments, 1.05)).toBeCloseTo(1.0, 6);
    expect(inToOut(plan.segments, 1.37)).toBeCloseTo(1.4, 6);
    expect(inToOut(plan.segments, 1.96)).toBeCloseTo(1.9, 6);
    expect(inToOut(plan.segments, 3.02)).toBeCloseTo(3.0, 6);
    expect(plan.moved).toBe(4);
    // Silence far from the phrases is untouched.
    expect(inToOut(plan.segments, 0.2)).toBe(0.2);
    expect(inToOut(plan.segments, 2.45)).toBe(2.45);
  });

  it("Natural moves 75% of the way; nothing moves when already tight or wildly off", () => {
    const h = notes([[1.04, 1.4]]);
    const nat = planTightTiming({ lead, notes: h, offsetSec: 0, durationSec: 5, tight: 0 });
    expect(inToOut(nat.segments, 1.04)).toBeCloseTo(1.04 - 0.75 * 0.04, 6);
    expect(planTightTiming({ lead, notes: notes([[1.003, 1.4]]), offsetSec: 0, durationSec: 5, tight: 1 }).segments).toHaveLength(0);
    // 300 ms late is a different syllable, not sloppy timing: left alone.
    expect(planTightTiming({ lead: [{ startSec: 1, endSec: 1.2 }], notes: notes([[1.3, 1.5]]), offsetSec: 0, durationSec: 5, tight: 1 }).moved).toBe(0);
  });

  it("works in the take's own time when the take is offset on the timeline", () => {
    const h = notes([[0.55, 0.9]]); // placed at +0.5 s: heard at 1.05
    const plan = planTightTiming({ lead, notes: h, offsetSec: 0.5, durationSec: 3, tight: 1 });
    expect(inToOut(plan.segments, 0.55)).toBeCloseTo(0.5, 6);
    expect(outToIn(plan.segments, inToOut(plan.segments, 0.7))).toBeCloseTo(0.7, 6);
  });

  it("never produces a map the engine would refuse, even for crowded syllables", () => {
    const h = notes(Array.from({ length: 30 }, (_, i) => [1 + i * 0.09 + (i % 2 ? 0.05 : -0.05), 1 + i * 0.09 + 0.085] as [number, number]));
    const dense = Array.from({ length: 30 }, (_, i) => ({ startSec: 1 + i * 0.09, endSec: 1 + i * 0.09 + 0.085 }));
    const plan = planTightTiming({ lead: dense, notes: h, offsetSec: 0, durationSec: 5, tight: 1 });
    for (const s of plan.segments) expect(isValidSegment(s)).toBe(true);
  });
});
