import { useEffect, useRef } from "react";
import { Surface } from "@/components/neumorphic/Surface";

export interface MultiTrackScrubberProps {
  currentTime: number;
  durationSec: number;
}

/**
 * A shared global playhead overlay bar for the multi-track stem view.
 */
export function MultiTrackScrubber({ currentTime, durationSec }: MultiTrackScrubberProps) {
  const lineRef = useRef<HTMLDivElement>(null);
  const ratio = durationSec > 0 ? Math.min(1, currentTime / durationSec) : 0;

  useEffect(() => {
    if (lineRef.current) {
      lineRef.current.style.left = `${ratio * 100}%`;
    }
  }, [ratio]);

  return (
    <Surface variant="inset" className="relative h-2 w-full overflow-hidden">
      <div
        ref={lineRef}
        className="absolute top-0 bottom-0 w-[2px] bg-cyan shadow-[0_0_8px_#4CC9F0]"
        style={{ left: `${ratio * 100}%` }}
        aria-hidden
      />
    </Surface>
  );
}
