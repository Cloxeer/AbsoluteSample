import type { InstrumentStem } from "./types";

export interface InstrumentNode {
  stem: InstrumentStem;
  /** Top-level tracks are the ones that belong in the mix (parent === null). */
  inMix: boolean;
  children: InstrumentStem[];
}

/**
 * Groups a flat InstrumentStem list into top-level tracks (parent === null), sorted by
 * order, each carrying its own children (also sorted by order) attached underneath.
 * Only top-level tracks are inMix: mix playback must never double up child/kit stems.
 */
export function groupInstruments(stems: InstrumentStem[]): InstrumentNode[] {
  const topLevel = stems.filter((s) => s.parent === null).sort((a, b) => a.order - b.order);
  return topLevel.map((stem) => ({
    stem,
    inMix: true,
    children: stems.filter((s) => s.parent === stem.key).sort((a, b) => a.order - b.order),
  }));
}
