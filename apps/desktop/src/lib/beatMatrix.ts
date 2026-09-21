import type { LoopAnalysis } from "./types";

export interface Onset {
  time: number;
  strength: number;
}

/** Extracts onset times + strengths from a LoopAnalysis (transient times, strength sampled from the onset envelope). */
export function onsetsFromAnalysis(analysis: LoopAnalysis, frameRate = 86): Onset[] {
  return analysis.transients.map((time) => {
    const frame = Math.round(time * frameRate);
    const strength = analysis.onsetEnvelope[frame] ?? analysis.onsetEnvelope[analysis.onsetEnvelope.length - 1] ?? 1;
    return { time, strength };
  });
}

/**
 * Pure helper for the Beat Matrix: lights a pad for each grid (column) time when an onset falls
 * within windowSec of it. Returns one opacity value per grid column, normalized 0..1 across the row
 * (the row's strongest onset becomes opacity 1); a pad with no onset in range is 0.
 */
export function padsForRow(onsets: Onset[], grid: number[], windowSec: number): number[] {
  const maxStrength = onsets.reduce((m, o) => Math.max(m, o.strength), 0) || 1;
  return grid.map((t) => {
    let best = 0;
    for (const onset of onsets) {
      if (Math.abs(onset.time - t) <= windowSec) {
        best = Math.max(best, onset.strength);
      }
    }
    return best / maxStrength;
  });
}
