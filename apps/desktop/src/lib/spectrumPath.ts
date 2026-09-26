import type { SpectrumPoint } from "./types";

export const SPECTRUM_MIN_HZ = 20;
export const SPECTRUM_MAX_HZ = 20000;
export const SPECTRUM_MIN_DB = -120;
export const SPECTRUM_MAX_DB = 0;

/** Maps a frequency (Hz) to an x-coordinate on a log scale spanning [SPECTRUM_MIN_HZ, SPECTRUM_MAX_HZ] -> [0, width]. */
export function xForHz(hz: number, width: number): number {
  const clamped = Math.max(SPECTRUM_MIN_HZ, Math.min(SPECTRUM_MAX_HZ, hz));
  const t = Math.log(clamped / SPECTRUM_MIN_HZ) / Math.log(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ);
  return t * width;
}

/** Maps a dB value to a y-coordinate spanning [SPECTRUM_MIN_DB, SPECTRUM_MAX_DB] -> [height, 0]. */
export function yForDb(db: number, height: number): number {
  const clamped = Math.max(SPECTRUM_MIN_DB, Math.min(SPECTRUM_MAX_DB, db));
  const t = (clamped - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB);
  return height - t * height;
}

/**
 * Builds an SVG path string for the spectrum line, plus a closed fill path for the area
 * under it, given the spectrum points and a target pixel width/height.
 * Pure and deterministic so it can be unit tested without rendering anything.
 */
export function buildSpectrumPaths(
  points: SpectrumPoint[],
  width: number,
  height: number
): { linePath: string; areaPath: string } {
  if (points.length === 0) {
    return { linePath: "", areaPath: "" };
  }
  const sorted = [...points].sort((a, b) => a.hz - b.hz);
  const coords = sorted.map((p) => ({ x: xForHz(p.hz, width), y: yForDb(p.db, height) }));

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");

  const firstX = coords[0].x.toFixed(2);
  const lastX = coords[coords.length - 1].x.toFixed(2);
  const areaPath = `M ${firstX} ${height} ${coords
    .map((c) => `L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(" ")} L ${lastX} ${height} Z`;

  return { linePath, areaPath };
}
