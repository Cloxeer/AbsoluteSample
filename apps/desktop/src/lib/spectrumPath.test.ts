import { describe, expect, it } from "vitest";
import { buildSpectrumPaths, xForHz, yForDb, SPECTRUM_MIN_HZ, SPECTRUM_MAX_HZ, SPECTRUM_MIN_DB, SPECTRUM_MAX_DB } from "./spectrumPath";

describe("xForHz", () => {
  it("maps the minimum frequency to x=0", () => {
    expect(xForHz(SPECTRUM_MIN_HZ, 1000)).toBeCloseTo(0, 5);
  });

  it("maps the maximum frequency to x=width", () => {
    expect(xForHz(SPECTRUM_MAX_HZ, 1000)).toBeCloseTo(1000, 5);
  });

  it("clamps frequencies outside the range", () => {
    expect(xForHz(1, 1000)).toBeCloseTo(0, 5);
    expect(xForHz(100000, 1000)).toBeCloseTo(1000, 5);
  });

  it("is logarithmic: 1kHz sits at the same fraction each decade", () => {
    // 20 -> 20000 spans 3 decades; 1000 is 2 decades up from 20 (17dB... check ratio)
    const x1k = xForHz(1000, 900);
    const expectedT = Math.log(1000 / 20) / Math.log(20000 / 20);
    expect(x1k).toBeCloseTo(expectedT * 900, 3);
  });
});

describe("yForDb", () => {
  it("maps 0dB (max) to y=0", () => {
    expect(yForDb(SPECTRUM_MAX_DB, 500)).toBeCloseTo(0, 5);
  });

  it("maps -120dB (min) to y=height", () => {
    expect(yForDb(SPECTRUM_MIN_DB, 500)).toBeCloseTo(500, 5);
  });

  it("clamps dB values outside the range", () => {
    expect(yForDb(10, 500)).toBeCloseTo(0, 5);
    expect(yForDb(-200, 500)).toBeCloseTo(500, 5);
  });

  it("maps the midpoint proportionally", () => {
    expect(yForDb(-60, 500)).toBeCloseTo(250, 5);
  });
});

describe("buildSpectrumPaths", () => {
  it("returns empty paths for no points", () => {
    expect(buildSpectrumPaths([], 100, 100)).toEqual({ linePath: "", areaPath: "" });
  });

  it("builds a line path starting with M and using L for subsequent points", () => {
    const points = [
      { hz: 20, db: 0 },
      { hz: 20000, db: -120 },
    ];
    const { linePath } = buildSpectrumPaths(points, 100, 100);
    expect(linePath.startsWith("M 0.00 0.00")).toBe(true);
    expect(linePath).toContain("L 100.00 100.00");
  });

  it("sorts points by frequency before building the path", () => {
    const points = [
      { hz: 20000, db: -120 },
      { hz: 20, db: 0 },
    ];
    const { linePath } = buildSpectrumPaths(points, 100, 100);
    expect(linePath.startsWith("M 0.00 0.00")).toBe(true);
  });

  it("closes the area path down to the baseline at the first and last x", () => {
    const points = [
      { hz: 20, db: -60 },
      { hz: 20000, db: -60 },
    ];
    const { areaPath } = buildSpectrumPaths(points, 100, 50);
    expect(areaPath.startsWith("M 0.00 50")).toBe(true);
    expect(areaPath.trim().endsWith("Z")).toBe(true);
    expect(areaPath).toContain("L 100.00 50");
  });
});
