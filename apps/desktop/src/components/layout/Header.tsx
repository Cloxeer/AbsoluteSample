import { AudioWaveform, Square } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { formatTime } from "@/lib/format";
import type { DependencyReport } from "@/lib/types";
import clsx from "clsx";

export interface HeaderProps {
  deps: DependencyReport | null;
  isPlaying: boolean;
  currentTime: number;
  onPlayPause: () => void;
  onStop: () => void;
}

function Pill({ name, ok }: { name: string; ok: boolean }) {
  return (
    <span
      className={clsx(
        "text-xs px-2 py-1 rounded-full border",
        ok ? "text-cyan border-cyan/30 bg-cyan/5" : "text-stem-drums border-stem-drums/30 bg-stem-drums/5"
      )}
    >
      {name} {ok ? "OK" : "missing"}
    </span>
  );
}

export function Header({ deps, isPlaying, currentTime, onPlayPause, onStop }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-4 gap-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full neu-surface-raised bg-surface flex items-center justify-center">
          <AudioWaveform className="text-accent" size={20} />
        </div>
        <span className="text-lg font-semibold tracking-tight">AbsoluteSample</span>
      </div>

      <div className="flex items-center gap-2">
        <Pill name="ffmpeg" ok={!!deps?.ffmpeg} />
        <Pill name="ffprobe" ok={!!deps?.ffprobe} />
        <Pill name="yt-dlp" ok={!!deps?.ytdlp} />
      </div>

      <Surface variant="raised" className="flex items-center gap-3 px-4 py-2">
        <PlayPauseButton playing={isPlaying} onToggle={onPlayPause} label="mix" className="!px-3 !py-2" />
        <Button aria-label="Stop" onClick={onStop} className="!px-3 !py-2">
          <Square size={16} />
        </Button>
        <span className="text-sm text-muted font-mono tabular-nums">{formatTime(currentTime)}</span>
      </Surface>
    </header>
  );
}
