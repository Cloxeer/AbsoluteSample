/**
 * Returns wavesurfer `peaks` + `duration` options only when both are usable
 * (non-empty peaks array and a positive duration). Otherwise returns an empty
 * object so wavesurfer decodes the url itself, exactly as before peaks existed.
 */
export function peaksOptions(peaks: number[] | undefined | null, durationSec: number | undefined | null): { peaks?: number[][]; duration?: number } {
  if (Array.isArray(peaks) && peaks.length > 0 && typeof durationSec === "number" && durationSec > 0) {
    return { peaks: [peaks], duration: durationSec };
  }
  return {};
}
