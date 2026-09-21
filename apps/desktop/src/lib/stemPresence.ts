/**
 * A stem is treated as "silent" (effectively inaudible) only when BOTH its RMS and peak levels
 * are very low. Either metric crossing back above threshold makes it audible again.
 */
export interface StemLevels {
  rmsDb: number;
  peakDb: number;
}

const RMS_SILENT_DB = -50;
const PEAK_SILENT_DB = -30;

export function isAudible(stem: StemLevels): boolean {
  const silent = stem.rmsDb < RMS_SILENT_DB && stem.peakDb < PEAK_SILENT_DB;
  return !silent;
}
