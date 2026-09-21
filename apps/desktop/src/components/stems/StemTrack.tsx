import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { TrackHeader } from "./TrackHeader";
import { Playhead } from "@/components/waveform/Playhead";
import type { StemInfo } from "@/lib/types";
import { peaksOptions } from "@/lib/wavePeaks";
import clsx from "clsx";

const STEM_COLORS: Record<string, string> = {
  drums_sub: "#FF6B6B",
  bass_lowmid: "#FFB84D",
  mid_vocals: "#F25F5C",
  highs_air: "#4CC9F0",
};

export interface StemTrackProps {
  stem: StemInfo;
  wavUrl: string | null;
  solo: boolean;
  mute: boolean;
  volume: number;
  /** True while this stem is the audition (solo-play) target and actively playing. */
  isAuditioning?: boolean;
  currentTime?: number;
  onToggleSolo: () => void;
  onToggleMute: () => void;
  onVolumeChange: (v: number) => void;
  onDownload: () => void;
  extraAction?: React.ReactNode;
  onAudition?: () => void;
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
  isAuditioning = false,
  currentTime = 0,
  onToggleSolo,
  onToggleMute,
  onVolumeChange,
  onDownload,
  extraAction,
  onAudition,
  onReady,
  onTimeUpdate,
  onFinish,
  onDestroy,
}: StemTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [peakDb] = useState(stem.peakDb);
  const [rmsDb] = useState(stem.rmsDb);
  const [duration, setDuration] = useState(0);
  const color = STEM_COLORS[stem.key] ?? "#F25F5C";

  useEffect(() => {
    if (!containerRef.current || !wavUrl) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: color,
      progressColor: color,
      cursorColor: "#4CC9F0",
      height: 72,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      url: wavUrl,
      ...peaksOptions(stem.peaks, stem.durationSec),
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
    <div role="group" aria-label={`${stem.label} track`} className="flex items-stretch gap-3">
      <TrackHeader
        color={color}
        name={stem.label}
        band={stem.band}
        isAuditioning={isAuditioning}
        solo={solo}
        mute={mute}
        volume={volume}
        peakDb={peakDb}
        rmsDb={rmsDb}
        onAudition={() => onAudition?.()}
        onToggleSolo={onToggleSolo}
        onToggleMute={onToggleMute}
        onVolumeChange={onVolumeChange}
        onDownload={onDownload}
        extraAction={extraAction}
      />
      <div
        className={clsx(
          "relative flex-1 min-w-0 rounded-2xl bg-surface neu-surface-raised p-2 transition-opacity duration-150",
          mute && "opacity-35"
        )}
      >
        <div className="min-w-0" ref={containerRef} data-testid={`waveform-${stem.key}`} />
        <Playhead currentTime={currentTime} duration={duration} />
      </div>
    </div>
  );
}
