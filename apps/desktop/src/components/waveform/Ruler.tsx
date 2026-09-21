import { useMemo } from "react";

export interface RulerProps {
  duration: number;
  /** Beat times in seconds (relative to lane start), shown as thin cyan ticks when analysis exists. */
  beatGrid?: number[];
}

/** Seconds ruler drawn at the top of the lane column, with optional beat-grid tick marks. */
export function Ruler({ duration, beatGrid }: RulerProps) {
  const seconds = useMemo(() => {
    if (!duration || duration <= 0) return [];
    const step = duration > 60 ? 5 : 1;
    const marks: number[] = [];
    for (let t = 0; t <= duration; t += step) marks.push(t);
    return marks;
  }, [duration]);

  if (!duration || duration <= 0) return <div className="h-5" />;

  return (
    <div className="relative h-5 select-none" data-testid="ruler">
      {seconds.map((t) => (
        <div
          key={`s-${t}`}
          className="absolute top-0 h-full flex flex-col items-start"
          style={{ left: `${(t / duration) * 100}%` }}
        >
          <div className="w-px h-1.5 bg-muted/40" />
          <span className="text-[9px] text-muted font-mono -translate-x-1/2 mt-0.5">
            {Math.floor(t / 60)}:{String(Math.floor(t % 60)).padStart(2, "0")}
          </span>
        </div>
      ))}
      {beatGrid?.map((t, i) => (
        <div
          key={`b-${i}`}
          className="absolute bottom-0 w-px h-2 bg-cyan/50"
          style={{ left: `${(t / duration) * 100}%` }}
        />
      ))}
    </div>
  );
}
