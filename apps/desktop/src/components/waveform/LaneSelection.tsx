import { useCallback, useEffect, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { formatTime } from "@/lib/format";

export interface LaneSelectionRange {
  start: number;
  end: number;
}

export interface UseLaneSelectionResult {
  /** Pass into WaveSurfer.create({ plugins: [regionsPlugin] }). */
  regionsPlugin: RegionsPlugin;
  /** The current (single) selection, or null when none is drawn. */
  selection: LaneSelectionRange | null;
  /** Removes the current selection, if any. */
  clear: () => void;
}

/**
 * Enables drag-to-select on a wavesurfer lane, keeping at most one region: starting a new drag
 * replaces any existing one. Attach `regionsPlugin` to the WaveSurfer instance and call this hook
 * with that instance once it is ready (or null before then).
 */
export function useLaneSelection(ws: WaveSurfer | null): UseLaneSelectionResult {
  const regionsRef = useRef<RegionsPlugin | null>(null);
  if (!regionsRef.current) regionsRef.current = RegionsPlugin.create();
  const regions = regionsRef.current;
  const activeRegionRef = useRef<Region | null>(null);
  const [selection, setSelection] = useState<LaneSelectionRange | null>(null);

  useEffect(() => {
    if (!ws) return;
    regions.enableDragSelection({ color: "rgba(76,201,240,0.18)" });

    const onRegionCreated = (region: Region) => {
      const previous = activeRegionRef.current;
      if (previous && previous !== region) previous.remove();
      activeRegionRef.current = region;
      setSelection({ start: region.start, end: region.end });
    };
    const onRegionUpdated = (region: Region) => {
      if (region !== activeRegionRef.current) return;
      setSelection({ start: region.start, end: region.end });
    };
    const onRegionRemoved = (region: Region) => {
      if (region !== activeRegionRef.current) return;
      activeRegionRef.current = null;
      setSelection(null);
    };

    regions.on("region-created", onRegionCreated);
    regions.on("region-updated", onRegionUpdated);
    regions.on("region-removed", onRegionRemoved);
    return () => {
      regions.un("region-created", onRegionCreated);
      regions.un("region-updated", onRegionUpdated);
      regions.un("region-removed", onRegionRemoved);
    };
  }, [ws, regions]);

  const clear = useCallback(() => {
    activeRegionRef.current?.remove();
    activeRegionRef.current = null;
    setSelection(null);
  }, []);

  return { regionsPlugin: regions, selection, clear };
}

export interface LaneSelectionChipsProps {
  selection: LaneSelectionRange | null;
  durationSec: number;
}

/** Small In/Out time chips (mm:ss.mmm) pinned above the selection's edges, matching the source selector's chip style. */
export function LaneSelectionChips({ selection, durationSec }: LaneSelectionChipsProps) {
  if (!selection || !durationSec || durationSec <= 0) return null;
  return (
    <>
      <LaneSelectionChip label="In" time={selection.start} durationSec={durationSec} />
      <LaneSelectionChip label="Out" time={selection.end} durationSec={durationSec} />
    </>
  );
}

function LaneSelectionChip({ label, time, durationSec }: { label: "In" | "Out"; time: number; durationSec: number }) {
  const left = Math.min(100, Math.max(0, (time / durationSec) * 100));
  return (
    <div
      className="pointer-events-none absolute top-0 -translate-x-1/2 z-30"
      style={{ left: `${left}%` }}
      aria-hidden
    >
      <span
        aria-label={`${label} ${formatTime(time)}`}
        className="mt-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent text-accent-ink whitespace-nowrap"
      >
        {formatTime(time)}
      </span>
    </div>
  );
}
