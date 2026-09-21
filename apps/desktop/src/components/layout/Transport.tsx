import { useState } from "react";
import { AudioWaveform, HelpCircle, Pause, Play, Repeat, Square } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { Slider } from "@/components/neumorphic/Slider";
import { formatTime } from "@/lib/format";
import type { DependencyReport } from "@/lib/types";
import clsx from "clsx";

export interface TransportProps {
  deps: DependencyReport | null;
  isPlaying: boolean;
  currentTime: number;
  mode: "mix" | "audition";
  /** Human label of the auditioned track, e.g. "Drums / Sub". */
  auditionLabel: string | null;
  loopEnabled: boolean;
  bpm: number | null;
  masterVolume: number;
  progress?: { message: string; percent: number } | null;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleLoop: () => void;
  onMasterVolumeChange: (v: number) => void;
}

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause mix"],
  ["L", "Toggle loop"],
  ["1 - 4", "Audition stem 1-4"],
  ["M", "Mute focused track"],
  ["Esc", "Stop"],
];

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

export function Transport({
  deps,
  isPlaying,
  currentTime,
  mode,
  auditionLabel,
  loopEnabled,
  bpm,
  masterVolume,
  progress,
  onPlayPause,
  onStop,
  onToggleLoop,
  onMasterVolumeChange,
}: TransportProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  return (
    <div className="sticky top-0 z-30 bg-bg/95 backdrop-blur-sm border-b border-white/[0.04]">
      <header className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full neu-surface-raised bg-surface flex items-center justify-center">
            <AudioWaveform className="text-accent" size={20} />
          </div>
          <span className="text-lg font-semibold tracking-tight hidden sm:inline">AbsoluteSample</span>
        </div>

        <Surface variant="raised" className="flex items-center gap-3 px-4 py-2">
          <Button
            aria-label={isPlaying ? "Pause" : "Play mix"}
            aria-pressed={isPlaying && mode === "mix"}
            pressed={isPlaying && mode === "mix"}
            tone="accent"
            onClick={onPlayPause}
            className="!px-3 !py-3 h-11 w-11 flex items-center justify-center"
            title="Play mix"
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </Button>
          <Button aria-label="Stop" onClick={onStop} className="!px-3 !py-2">
            <Square size={16} />
          </Button>
          <Button
            aria-label="Toggle loop"
            aria-pressed={loopEnabled}
            pressed={loopEnabled}
            tone="cyan"
            onClick={onToggleLoop}
            className="!px-3 !py-2"
          >
            <Repeat size={16} />
          </Button>
          <span className="text-lg text-text font-mono tabular-nums min-w-[110px] text-center">
            {formatTime(currentTime)}
          </span>
          {bpm !== null && (
            <span className="text-xs px-2 py-1 rounded-full border border-accent/30 bg-accent/10 text-accent font-mono">
              {bpm.toFixed(1)} BPM
            </span>
          )}
          <span
            className={clsx(
              "text-xs px-2 py-1 rounded-full border font-medium",
              mode === "audition" ? "text-cyan border-cyan/30 bg-cyan/5" : "text-muted border-white/10"
            )}
          >
            {mode === "audition" && auditionLabel ? `Solo: ${auditionLabel}` : "Mix"}
          </span>
          <div className="flex items-center gap-2 pl-2 border-l border-white/[0.06]">
            <span className="text-[10px] text-muted uppercase">Vol</span>
            <Slider
              orientation="horizontal"
              value={masterVolume}
              min={0}
              max={1}
              step={0.01}
              onChange={onMasterVolumeChange}
              label="Master volume"
              className="w-24"
            />
          </div>
          <div className="relative">
            <Button
              aria-label="Keyboard shortcuts"
              pressed={shortcutsOpen}
              onClick={() => setShortcutsOpen((v) => !v)}
              className="!px-2 !py-2"
            >
              <HelpCircle size={16} />
            </Button>
            {shortcutsOpen && (
              <div className="absolute right-0 top-full mt-2 w-56 rounded-2xl bg-surface neu-surface-raised p-3 z-40">
                <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Shortcuts</div>
                <ul className="flex flex-col gap-1.5">
                  {SHORTCUTS.map(([key, desc]) => (
                    <li key={key} className="flex items-center justify-between text-xs">
                      <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px]">{key}</kbd>
                      <span className="text-muted">{desc}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Surface>

        <div className="flex items-center gap-2">
          <Pill name="ffmpeg" ok={!!deps?.ffmpeg} />
          <Pill name="ffprobe" ok={!!deps?.ffprobe} />
          <Pill name="yt-dlp" ok={!!deps?.ytdlp} />
        </div>
      </header>

      {mode === "audition" && auditionLabel && (
        <div className="px-6 pb-2 -mt-2 text-xs text-muted">
          Auditioning <span className="text-cyan font-medium">{auditionLabel}</span> only — press Play mix to hear
          all stems.
        </div>
      )}

      {progress && (
        <div className="px-6 pb-3 flex flex-col gap-1">
          <div className="h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-200"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <span className="text-[11px] text-muted">
            {progress.message} ({progress.percent}%)
          </span>
        </div>
      )}
    </div>
  );
}
