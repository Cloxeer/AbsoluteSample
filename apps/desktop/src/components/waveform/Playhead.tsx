export interface PlayheadProps {
  currentTime: number;
  duration: number;
}

/** Absolutely-positioned vertical line drawn across a lane column, driven by currentTime/duration. */
export function Playhead({ currentTime, duration }: PlayheadProps) {
  if (!duration || duration <= 0) return null;
  const ratio = Math.min(1, Math.max(0, currentTime / duration));
  return (
    <div
      className="pointer-events-none absolute inset-y-0 w-px bg-cyan z-20 shadow-[0_0_6px_rgba(53,208,255,0.8)]"
      style={{ left: `${ratio * 100}%` }}
      aria-hidden
    />
  );
}
