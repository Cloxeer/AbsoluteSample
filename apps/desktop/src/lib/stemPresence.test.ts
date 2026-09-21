import { describe, expect, it } from "vitest";
import { isAudible } from "./stemPresence";

describe("isAudible", () => {
  it("is audible when both rms and peak are well above threshold", () => {
    expect(isAudible({ rmsDb: -20, peakDb: -10 })).toBe(true);
  });

  it("is audible when only rms crosses above threshold", () => {
    expect(isAudible({ rmsDb: -40, peakDb: -40 })).toBe(true);
  });

  it("is audible when only peak crosses above threshold", () => {
    expect(isAudible({ rmsDb: -60, peakDb: -10 })).toBe(true);
  });

  it("is silent only when both rms and peak are below threshold", () => {
    expect(isAudible({ rmsDb: -55, peakDb: -35 })).toBe(false);
  });

  it("is audible at the exact boundary (not strictly below)", () => {
    expect(isAudible({ rmsDb: -50, peakDb: -30 })).toBe(true);
  });
});
