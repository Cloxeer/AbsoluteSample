import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  orientation?: "vertical" | "horizontal";
  onChange: (value: number) => void;
  label?: string;
  className?: string;
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  orientation = "vertical",
  onChange,
  label,
  className,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const isVertical = orientation === "vertical";
  const ratio = (value - min) / (max - min);

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      let r: number;
      if (isVertical) {
        r = 1 - (clientY - rect.top) / rect.height;
      } else {
        r = (clientX - rect.left) / rect.width;
      }
      r = Math.min(1, Math.max(0, r));
      const raw = min + r * (max - min);
      const stepped = Math.round(raw / step) * step;
      onChange(Math.min(max, Math.max(min, Number(stepped.toFixed(4)))));
    },
    [isVertical, min, max, step, onChange]
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updateFromPointer(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    updateFromPointer(e.clientX, e.clientY);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = step * (e.shiftKey ? 10 : 1);
    if ((isVertical && e.key === "ArrowUp") || (!isVertical && e.key === "ArrowRight")) {
      onChange(Math.min(max, value + delta));
      e.preventDefault();
    } else if ((isVertical && e.key === "ArrowDown") || (!isVertical && e.key === "ArrowLeft")) {
      onChange(Math.max(min, value - delta));
      e.preventDefault();
    } else if (e.key === "Home") {
      onChange(min);
    } else if (e.key === "End") {
      onChange(max);
    }
  };

  return (
    <div
      className={clsx("flex items-center gap-2", isVertical ? "flex-col h-32" : "flex-row", !className?.includes("w-") && !isVertical && "w-32", className)}
      aria-label={label}
    >
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-orientation={orientation}
        aria-label={label}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onKeyDown={handleKeyDown}
        className={clsx(
          "relative rounded-full neu-surface-inset cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          isVertical ? "w-2 flex-1" : "h-2 flex-1"
        )}
      >
        <div
          className={clsx(
            "absolute rounded-full bg-gradient-to-b from-[#2b2d35] to-[#22242b] shadow-[8px_8px_18px_#0B0C0E,-6px-6px_14px_#22242B] border border-white/10",
            isVertical ? "w-4 h-4 left-1/2 -translate-x-1/2" : "h-4 w-4 top-1/2 -translate-y-1/2"
          )}
          style={
            isVertical
              ? { bottom: `calc(${ratio * 100}% - 8px)` }
              : { left: `calc(${ratio * 100}% - 8px)` }
          }
        />
      </div>
    </div>
  );
}
