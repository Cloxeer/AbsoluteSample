import { Pause, Play } from "lucide-react";
import { Button, type ButtonTone } from "./Button";

export interface PlayPauseButtonProps {
  playing: boolean;
  onToggle: () => void;
  size?: number;
  /** What this button plays, used to build the aria-label ("Play <label>" / "Pause <label>"). */
  label: string;
  tone?: ButtonTone;
  className?: string;
}

/** A single play/pause control used everywhere audio can be toggled. Never shows a stale label. */
export function PlayPauseButton({ playing, onToggle, size = 16, label, tone = "accent", className }: PlayPauseButtonProps) {
  return (
    <Button
      type="button"
      aria-label={playing ? `Pause ${label}` : `Play ${label}`}
      aria-pressed={playing}
      pressed={playing}
      tone={tone}
      onClick={onToggle}
      className={className ?? "!p-0 h-9 w-9 flex items-center justify-center shrink-0"}
    >
      {playing ? <Pause size={size} /> : <Play size={size} />}
    </Button>
  );
}
