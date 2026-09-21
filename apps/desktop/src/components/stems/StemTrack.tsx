import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { Slider } from "@/components/neumorphic/Slider";
import { formatDb } from "@/lib/format";
import type { StemInfo } from "@/lib/types";
import clsx from "clsx";

const STEM_COLORS: Record<string, string> = {
  drums_sub: "#FF6B6B",
  bass_lowmid: "#FFB84D",
  mid_vocals: "#7C5CFF",
  highs_air: "#35D0FF",
};

export interface StemTrackProps {
  stem: StemInfo;
  wavUrl: string | null;
  solo: boolean;
  mute: boolean;
  volume: number;
  onToggleSolo: () => void;
  onToggleMute: () => void;
  onVolumeChange: (v: number) => void;
  onDownload: () => void;
  onReady?: (ws: WaveSurfer) => void;
  onTimeUpdate?: (time: number) => void;
  onFinish?: () => void;
  onDestroy?: () => void;
}

export function StemTrack({
  stem,
  wavUrl,
  solo,
  mute,
  volume,
  onToggleSolo,
  onToggleMute,
  onVolumeChange,
  onDownload,
  onReady,
  onTimeUpdate,
  onFinish,
  onDestroy,
}: StemTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [peakDb] = useState(stem.peakDb);
  const [rmsDb] = useState(stem.rmsDb);

  useEffect(() => {
    if (!containerRef.current || !wavUrl) return;
    const color = STEM_COLORS[stem.key] ?? "#7C5CFF";
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: color,
      progressColor: color,
      cursorColor: "#35D0FF",
      height: 56,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      url: wavUrl,
    });
    wsRef.current = ws;
    ws.on("ready", () => onReady?.(ws));
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
    <Surface variant="raised" className="flex items-center gap-4 p-3">
      <div
        className="w-1.5 self-stretch rounded-full"
        style={{ backgroundColor: STEM_COLORS[stem.key] ?? "#7C5CFF" }}
        aria-hidden
      />
      <div className="w-36 shrink-0">
        <div className="text-sm font-semibold">{stem.label}</div>
        <div className="text-xs text-muted">{stem.band}</div>
      </div>

      <div className="flex-1 min-w-0" ref={containerRef} data-testid={`waveform-${stem.key}`} />

      <div className="flex flex-col items-center gap-1 w-16 shrink-0 text-[10px] text-muted font-mono tabular-nums">
        <span>{formatDb(peakDb)}</span>
        <span>{formatDb(rmsDb)}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button
          aria-label="Solo"
          aria-pressed={solo}
          pressed={solo}
          onClick={onToggleSolo}
          className={clsx("!px-2 !py-1 text-xs font-bold", solo && "text-accent")}
        >
          S
        </Button>
        <Button
          aria-label="Mute"
          aria-pressed={mute}
          pressed={mute}
          onClick={onToggleMute}
          className={clsx("!px-2 !py-1 text-xs font-bold", mute && "text-stem-drums")}
        >
          M
        </Button>
      </div>

      <Slider
        orientation="vertical"
        value={volume}
        min={0}
        max={1}
        step={0.01}
        onChange={onVolumeChange}
        label={`${stem.label} volume`}
        className="h-16 shrink-0"
      />

      <Button aria-label="Download WAV" onClick={onDownload} className="!px-2 !py-2 shrink-0">
        <Download size={16} />
      </Button>
    </Surface>
  );
}
