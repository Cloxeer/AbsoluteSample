import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Drum, Guitar, Mic2, Piano, Sparkles } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { Button } from "@/components/neumorphic/Button";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Slider } from "@/components/neumorphic/Slider";
import { Playhead } from "@/components/waveform/Playhead";
import { formatDb } from "@/lib/format";
import type { InstrumentGroup, InstrumentStem } from "@/lib/types";
import clsx from "clsx";

const GROUP_COLORS: Record<InstrumentGroup, string> = {
  vocals: "#F25F5C",
  drums: "#F2B33D",
  bass: "#4C8BF5",
  guitar: "#3DD68C",
  keys: "#B692F6",
  other: "#8A94A6",
};

const GROUP_ICONS: Record<InstrumentGroup, typeof Mic2> = {
  vocals: Mic2,
  drums: Drum,
  bass: Guitar,
  guitar: Guitar,
  keys: Piano,
  other: Sparkles,
};

function dbToRatio(db: number): number {
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

function Meter({ label, db, color }: { label: string; db: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-6 text-[9px] text-muted uppercase shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full neu-surface-inset overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${dbToRatio(db) * 100}%`, backgroundColor: color }} />
      </div>
      <span className="w-12 text-[9px] text-muted font-mono tabular-nums text-right">{formatDb(db)}</span>
    </div>
  );
}

export interface InstrumentTrackProps {
  stem: InstrumentStem;
  wavUrl: string | null;
  solo: boolean;
  mute: boolean;
  volume: number;
  isPlaying: boolean;
  currentTime?: number;
  /** True for kit/lead-backing child rows, which render smaller and indented. */
  indented?: boolean;
  onTogglePlay: () => void;
  onToggleSolo: () => void;
  onToggleMute: () => void;
  onVolumeChange: (v: number) => void;
  onDownload: () => void;
  /** Optional extra icon action rendered next to Download, e.g. a Save-as-sample button. */
  extraAction?: React.ReactNode;
  onReady?: (ws: WaveSurfer) => void;
  onTimeUpdate?: (time: number) => void;
  onFinish?: () => void;
  onDestroy?: () => void;
}

export function InstrumentTrack({
  stem,
  wavUrl,
  solo,
  mute,
  volume,
  isPlaying,
  currentTime = 0,
  indented = false,
  onTogglePlay,
  onToggleSolo,
  onToggleMute,
  onVolumeChange,
  onDownload,
  extraAction,
  onReady,
  onTimeUpdate,
  onFinish,
  onDestroy,
}: InstrumentTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [duration, setDuration] = useState(0);
  const color = GROUP_COLORS[stem.group];
  const Icon = GROUP_ICONS[stem.group];

  useEffect(() => {
    if (!containerRef.current || !wavUrl) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: color,
      progressColor: color,
      cursorColor: "#4CC9F0",
      height: indented ? 48 : 72,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      url: wavUrl,
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      setDuration(ws.getDuration());
      onReady?.(ws);
    });
    ws.on("timeupdate", (t) => onTimeUpdate?.(t));
    ws.on("finish", () => onFinish?.());
    return () => {
      onDestroy?.();
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wavUrl]);

  return (
    <div role="group" aria-label={`${stem.label} track`} className={clsx("flex items-stretch gap-3", indented && "ml-9")}>
      <div
        className={clsx(
          "shrink-0 flex flex-col gap-2 p-3 rounded-2xl bg-surface neu-surface-raised",
          indented ? "w-[210px]" : "w-[240px]",
          solo && "border-l-4",
          mute && "opacity-70"
        )}
        style={solo ? { borderLeftColor: color } : undefined}
      >
        <div className="flex items-start gap-2">
          <Icon size={14} color={color} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1 group/label">
            <div className="text-sm font-semibold truncate">{stem.label}</div>
            <div className="text-[10px] text-muted truncate opacity-0 group-hover/label:opacity-100 transition-opacity" title={stem.model}>
              {stem.model}
            </div>
          </div>
          <PlayPauseButton
            playing={isPlaying}
            onToggle={onTogglePlay}
            label={`${stem.label} only`}
            size={14}
            className="!p-0 h-8 w-8 flex items-center justify-center shrink-0"
          />
        </div>

        {mute && (
          <span className="self-start text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-danger/20 text-danger">
            MUTED
          </span>
        )}

        <div className="flex items-center gap-1">
          <Button aria-label={`Solo ${stem.label}`} aria-pressed={solo} pressed={solo} tone="amber" onClick={onToggleSolo} className="!px-2 !py-1 text-xs font-bold flex-1">
            S
          </Button>
          <Button aria-label={`Mute ${stem.label}`} aria-pressed={mute} pressed={mute} tone="red" onClick={onToggleMute} className="!px-2 !py-1 text-xs font-bold flex-1">
            M
          </Button>
          <Button aria-label={`Download ${stem.label} WAV`} onClick={onDownload} className="!px-2 !py-1 shrink-0">
            <Download size={14} />
          </Button>
          {extraAction}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted font-mono tabular-nums w-9 shrink-0">
            {volume === 0 ? "-inf" : `${Math.round(20 * Math.log10(volume))}dB`}
          </span>
          <Slider orientation="horizontal" value={volume} min={0} max={1} step={0.01} onChange={onVolumeChange} label={`${stem.label} volume`} className="flex-1 w-auto" />
        </div>

        {!indented && (
          <div className="flex flex-col gap-1">
            <Meter label="Pk" db={stem.peakDb} color={color} />
            <Meter label="RMS" db={stem.rmsDb} color={color} />
          </div>
        )}
      </div>
      <div className={clsx("relative flex-1 min-w-0 rounded-2xl bg-surface neu-surface-raised p-2 transition-opacity duration-150", mute && "opacity-35")}>
        <div className="min-w-0" ref={containerRef} data-testid={`waveform-${stem.key}`} />
        <Playhead currentTime={currentTime} duration={duration} />
      </div>
    </div>
  );
}

export function DisclosureToggle({ open, count, label, onToggle }: { open: boolean; count: number; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 text-xs text-muted hover:text-text ml-9 transition-colors"
      aria-expanded={open}
    >
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      {open ? "Hide" : "Show"} {label} ({count})
    </button>
  );
}
