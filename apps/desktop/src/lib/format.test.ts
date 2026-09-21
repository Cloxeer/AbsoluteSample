import { describe, expect, it } from "vitest";
import { formatBytes, formatDb, formatTime } from "./format";

describe("formatTime", () => {
  it("formats mm:ss.ms", () => {
    expect(formatTime(0)).toBe("00:00.000");
    expect(formatTime(65.25)).toBe("01:05.250");
  });

  it("clamps negatives", () => {
    expect(formatTime(-5)).toBe("00:00.000");
  });
});

describe("formatDb", () => {
  it("formats with sign and one decimal", () => {
    expect(formatDb(-6.25)).toBe("-6.3 dB");
    expect(formatDb(3)).toBe("+3.0 dB");
  });

  it("handles non-finite as -inf", () => {
    expect(formatDb(-Infinity)).toBe("-inf dB");
  });
});

describe("formatBytes", () => {
  it("formats bytes into human units", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1_200_000)).toBe("1.1 MB");
  });
});
