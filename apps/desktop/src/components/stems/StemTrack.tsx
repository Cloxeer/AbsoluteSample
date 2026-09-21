import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { TrackHeader } from "./TrackHeader";
import { Playhead } from "@/components/waveform/Playhead";
import { useLaneSelection, LaneSelectionChips } from "@/components/waveform/LaneSelection";
import { LaneSelectionActions } from "./LaneSelectionActions";
import type { Sample, StemInfo } from "@/lib/types";
import { peaksOptions } from "@/lib/wavePeaks";

const STEM_COLORS: Record<string, string> = {
  drums_sub: "#FF6B6B",
  bass_lowmid: "#FFB84D",
  mid_vocals: "#F25F5C",
  highs_air: "#4CC9F0",
};

export interface StemTrackProps {
  stem: StemInfo;
  wavUrl: string | null;
  volume: number;
  /** True while this stem is the audition (solo-play) target and actively playing. */
  isAuditioning?: boolean;
  currentTime?: number;
  onVolumeChange: (v: number) => void;
  onDownload: () => void;
  extraAction?: React.ReactNode;
  onAudition?: () => void;
  onReady?: (ws: WaveSurfer) => void;
  onTimeUpdate?: (time: number) => void;
  onFinish?: () => void;
  onDestroy?: () => void;
  /** Called with the clicked time (seconds) when the user clicks/drags on this lane's waveform. */
  onSeek?: (time: number) => void;
  /** Track id, for lane-selection save/download/slice actions. */
  trackId?: string;
  songTitle?: string;
  samples?: Sample[];
  /** Called after a lane-selection save/download/slice completes. */
  onSampleSaved?: () => void;
}

export function StemTrack({
  stem,
  wavUrl,
  volume,
  isAuditioning = false,
  currentTime = 0,
  onVolumeChange,
  onDownload,
  extraAction,
  onAudition,
  onReady,
  onTimeUpdate,
  onFinish,
  onDestroy,
  onSeek,
  trackId,
  songTitle,
  samples = [],
  onSampleSaved,
}: StemTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [peakDb] = useState(stem.peakDb);
  const [rmsDb] = useState(stem.rmsDb);
  const [duration, setDuration] = useState(0);
  const [ws, setWs] = useState<WaveSurfer | null>(null);
  const color = STEM_COLORS[stem.key] ?? "#F25F5C";
  const { regionsPlugin, selection, clear } = useLaneSelection(ws);

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
      cursorWidth: 1,
      url: wavUrl,
      plugins: [regionsPlugin],
      ...peaksOptions(stem.peaks, stem.durationSec),
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      setDuration(ws.getDuration());
      setWs(ws);
      onReady?.(ws);
    });
    ws.on("timeupdate", (t) => onTimeUpdate?.(t));
    ws.on("finish", () => onFinish?.());
    ws.on("interaction", (newTime) => onSeek?.(newTime));
    return () => {
      onDestroy?.();
      ws.destroy();
      wsRef.current = null;
      setWs(null);
      clear();
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
        volume={volume}
        peakDb={peakDb}
        rmsDb={rmsDb}
        onAudition={() => onAudition?.()}
        onVolumeChange={onVolumeChange}
        onDownload={onDownload}
        extraAction={extraAction}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="relative rounded-2xl bg-surface neu-surface-raised p-2 transition-opacity duration-150">
          <div className="min-w-0" ref={containerRef} data-testid={`waveform-${stem.key}`} />
          <Playhead currentTime={currentTime} duration={duration} />
          <LaneSelectionChips selection={selection} durationSec={duration} />
        </div>
        {selection && trackId && songTitle && wavUrl && (
          <LaneSelectionActions
            trackId={trackId}
            stemKey={stem.key}
            stemLabel={stem.label}
            songTitle={songTitle}
            wavUrl={wavUrl}
            selection={selection}
            samples={samples}
            onSaved={onSampleSaved}
          />
        )}
      </div>
    </div>
  );
}
