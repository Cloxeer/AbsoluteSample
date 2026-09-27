import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Drum, Guitar, Mic2, Piano, Sparkles } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Slider } from "@/components/neumorphic/Slider";
import { Playhead } from "@/components/waveform/Playhead";
import { useLaneSelection, LaneSelectionChips } from "@/components/waveform/LaneSelection";
import { LaneSelectionActions } from "./LaneSelectionActions";
import type { LaneSelectionRange } from "@/components/waveform/LaneSelection";
import type { GateFn } from "./BusyGate";
import { isDerived } from "@/lib/stemFiles";
import { formatDb } from "@/lib/format";
import { peaksOptions } from "@/lib/wavePeaks";
import type { EnhancedSpan, InstrumentGroup, InstrumentStem, Sample } from "@/lib/types";
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

function Meter({ label, db, color, infoTip }: { label: string; db: number; color: string; infoTip?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1 w-6 text-[9px] text-muted uppercase shrink-0">
        {label}
        {infoTip}
      </span>
      <div className="flex-1 h-1.5 rounded-full neu-surface-inset overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${dbToRatio(db) * 100}%`, backgroundColor: color }} />
      </div>
      <span className="w-12 text-[9px] text-muted font-mono tabular-nums text-right">{formatDb(db)}</span>
    </div>
  );
}

function detectionsLine(detections: { label: string; score: number }[], count: number): string {
  return detections
    .slice(0, count)
    .map((d) => `${d.label} ${d.score.toFixed(2)}`)
    .join(", ");
}

function DetectionsRow({ stem }: { stem: InstrumentStem }) {
  const [expanded, setExpanded] = useState(false);
  const detections = stem.detections;
  if (!detections || detections.length === 0) return null;
  const hasMore = detections.length > 3;
  const shown = expanded ? detections.slice(0, 5) : detections.slice(0, 3);
  return (
    <div className="flex items-center gap-1 min-w-0">
      <span className="text-[10px] text-muted truncate">{detectionsLine(shown, shown.length)}</span>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[9px] text-muted hover:text-text shrink-0"
          aria-label={expanded ? "Show fewer detections" : "Show more detections"}
        >
          {expanded ? "-" : `+${Math.min(detections.length, 5) - 3}`}
        </button>
      )}
    </div>
  );
}

function confidenceDotColor(score: number): string {
  if (score >= 0.7) return "#3DD68C";
  if (score >= 0.4) return "#F2B33D";
  return "#8A94A6";
}

export interface InstrumentTrackProps {
  stem: InstrumentStem;
  wavUrl: string | null;
  volume: number;
  isPlaying: boolean;
  currentTime?: number;
  /** True for kit/lead-backing child rows, which render smaller and indented. */
  indented?: boolean;
  onTogglePlay: () => void;
  onVolumeChange: (v: number) => void;
  onDownload: () => void;
  /** Optional extra icon action rendered next to Download, e.g. a Save-as-sample button. */
  extraAction?: React.ReactNode;
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
  /** v11: spans re-run by Enhance, drawn as a subtle band on the lane. */
  enhanced?: EnhancedSpan[];
  /** v11: playable url on demand (derived stems have no file until materialized). */
  resolveUrl?: () => Promise<string>;
  /** v11: runs before a selection cut/save/slice (materializes a derived stem). */
  prepare?: () => Promise<unknown>;
  /** v11: Enhance the selected time span (all stems). */
  onEnhance?: (range: LaneSelectionRange) => Promise<unknown>;
  gate?: GateFn;
}

/** Cheap signature of a peaks array, so a derived (peaks-only) lane redraws when its peaks change. */
function peaksSignature(peaks: number[] | undefined, durationSec: number | undefined): string {
  if (!peaks || peaks.length === 0) return "";
  let sum = 0;
  for (let i = 0; i < peaks.length; i++) sum += Math.abs(peaks[i]) * ((i % 7) + 1);
  return `${peaks.length}:${durationSec ?? 0}:${sum.toFixed(4)}`;
}

export function InstrumentTrack({
  stem,
  wavUrl,
  volume,
  isPlaying,
  currentTime = 0,
  indented = false,
  onTogglePlay,
  onVolumeChange,
  onDownload,
  extraAction,
  onReady,
  onTimeUpdate,
  onFinish,
  onDestroy,
  onSeek,
  trackId,
  songTitle,
  samples = [],
  onSampleSaved,
  enhanced,
  resolveUrl,
  prepare,
  onEnhance,
  gate,
}: InstrumentTrackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [duration, setDuration] = useState(0);
  const [ws, setWs] = useState<WaveSurfer | null>(null);
  const color = GROUP_COLORS[stem.group];
  const Icon = GROUP_ICONS[stem.group];
  const { regionsPlugin, selection, clear } = useLaneSelection(ws);
  const derived = isDerived(stem);
  // Derived stems have no file: their lane draws from the stem's peaks alone (no url to fetch).
  const peaksSig = useMemo(() => (derived ? peaksSignature(stem.peaks, stem.durationSec) : ""), [derived, stem.peaks, stem.durationSec]);
  const peaksOnly = derived && !wavUrl && peaksSig !== "";

  useEffect(() => {
    if (!containerRef.current || (!wavUrl && !peaksOnly)) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: color,
      progressColor: color,
      cursorColor: "#4CC9F0",
      height: indented ? 48 : 72,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      cursorWidth: 1,
      ...(wavUrl ? { url: wavUrl } : {}),
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
  }, [wavUrl, peaksOnly ? peaksSig : ""]);

  const laneDuration = duration || stem.durationSec || 0;

  return (
    <div role="group" aria-label={`${stem.displayLabel ?? stem.label} track`} className={clsx("flex items-stretch gap-3", indented && "ml-9")}>
      <div
        className={clsx(
          "shrink-0 flex flex-col gap-2 p-3 rounded-2xl bg-surface neu-surface-raised",
          indented ? "w-[210px]" : "w-[240px]"
        )}
      >
        <div className="flex items-start gap-2">
          <Icon size={14} color={color} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1" title={stem.model}>
            <div className="text-sm font-semibold truncate">{stem.displayLabel ?? stem.label}</div>
            <DetectionsRow stem={stem} />
          </div>
          <PlayPauseButton
            playing={isPlaying}
            onToggle={onTogglePlay}
            label={`${stem.label} only`}
            size={14}
            className="!p-0 h-8 w-8 flex items-center justify-center shrink-0"
          />
        </div>

        <div className="flex items-center gap-1">
          <Button aria-label={`Download ${stem.label}`} title="Download this track" onClick={onDownload} className="!px-2 !py-1 shrink-0">
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
            <Meter
              label="Pk"
              db={stem.peakDb}
              color={color}
              infoTip={<InfoTip term="PK" text="The loudest single moment in this track." />}
            />
            <Meter
              label="RMS"
              db={stem.rmsDb}
              color={color}
              infoTip={<InfoTip term="RMS" text="How loud it feels on average." />}
            />
            {stem.confidence && (
              <div className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: confidenceDotColor(stem.confidence.score) }}
                  aria-hidden
                />
                <span className="text-[9px] text-muted">Confidence {stem.confidence.score.toFixed(2)}</span>
                <InfoTip
                  term="confidence"
                  text={`How sure the models are about this track. ${stem.confidence.reasons.join(". ")}`}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="relative rounded-2xl bg-surface neu-surface-raised p-2 transition-opacity duration-150">
          <div className="min-w-0" ref={containerRef} data-testid={`waveform-${stem.key}`} />
          {laneDuration > 0 &&
            (enhanced ?? []).map((span) => (
              <EnhancedBand key={`${span.start}-${span.end}`} span={span} durationSec={laneDuration} />
            ))}
          <Playhead currentTime={currentTime} duration={duration} />
          <LaneSelectionChips selection={selection} durationSec={duration} />
        </div>
        {selection && trackId && songTitle && (wavUrl || resolveUrl) && (
          <LaneSelectionActions
            trackId={trackId}
            stemKey={stem.key}
            stemLabel={stem.label}
            songTitle={songTitle}
            wavUrl={wavUrl}
            selection={selection}
            samples={samples}
            onSaved={onSampleSaved}
            resolveUrl={resolveUrl}
            prepare={prepare}
            onEnhance={onEnhance}
            gate={gate}
          />
        )}
      </div>
    </div>
  );
}

/** Subtle band marking a span that was re-run by Enhance. */
function EnhancedBand({ span, durationSec }: { span: EnhancedSpan; durationSec: number }) {
  const left = Math.min(100, Math.max(0, (span.start / durationSec) * 100));
  const right = Math.min(100, Math.max(0, (span.end / durationSec) * 100));
  if (right <= left) return null;
  return (
    <div
      className="pointer-events-none absolute top-2 bottom-2 z-10 rounded-md bg-cyan/[0.07] border-x border-cyan/30"
      style={{ left: `${left}%`, width: `${right - left}%` }}
      title="Enhanced"
      data-testid="enhanced-band"
    >
      <span className="absolute bottom-0.5 left-1 text-[9px] leading-none text-cyan/80">Enhanced</span>
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
      {open ? "Hide" : "Show"} {label}
      {count > 0 ? ` (${count})` : ""}
    </button>
  );
}
