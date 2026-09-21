import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { formatTime } from "@/lib/format";

export interface RegionSelectorProps {
  wavUrl: string;
  initialStart?: number;
  initialEnd?: number;
  /** Total duration of the source, in seconds, used by "Select all" and range clamping. */
  durationSec?: number;
  bpm?: number | null;
  onChange: (start: number, end: number) => void;
  onReady?: (ws: WaveSurfer) => void;
}

function clampRange(s: number, e: number, duration: number): { start: number; end: number } | null {
  const start = Math.max(0, Math.min(s, duration));
  const end = Math.max(0, Math.min(e, duration));
  if (!(start < end)) return null;
  return { start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
}

/** Committing text input: shows a live value while typing, only calls onCommit on blur or Enter. */
function TimeField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value.toFixed(3)));

  useEffect(() => {
    setDraft(String(value.toFixed(3)));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(value.toFixed(3)));
  };

  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      <span className="uppercase tracking-wide">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-28 bg-surface neu-surface-inset rounded-lg px-2 py-1.5 text-text text-sm font-mono tabular-nums outline-none"
      />
    </label>
  );
}

export function RegionSelector({
  wavUrl,
  initialStart = 0,
  initialEnd,
  durationSec,
  bpm,
  onChange,
  onReady,
}: RegionSelectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionRef = useRef<Region | null>(null);
  const [duration, setDuration] = useState(durationSec ?? 0);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd ?? initialStart + 15);
  const [playhead, setPlayhead] = useState(0);
  const [sourcePlaying, setSourcePlaying] = useState(false);
  const [selectionPlaying, setSelectionPlaying] = useState(false);
  const selectionStopAt = useRef<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#4C8BF5",
      progressColor: "#F2B33D",
      cursorColor: "#4CC9F0",
      height: 96,
      url: wavUrl,
      interact: true,
      dragToSeek: false,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    ws.on("ready", () => {
      const dur = ws.getDuration();
      setDuration(dur);
      const s = clampRange(initialStart, initialEnd ?? initialStart + 15, dur) ?? { start: 0, end: dur };
      const region = regions.addRegion({
        start: s.start,
        end: s.end,
        color: "rgba(242,179,61,0.18)",
        drag: false,
        resize: true,
      });
      regionRef.current = region;
      setStart(s.start);
      setEnd(s.end);
      onChange(s.start, s.end);
      onReady?.(ws);
    });

    ws.on("timeupdate", (t) => {
      setPlayhead(t);
      if (selectionStopAt.current !== null && t >= selectionStopAt.current) {
        ws.pause();
      }
    });
    ws.on("play", () => setSourcePlaying(true));
    ws.on("pause", () => {
      setSourcePlaying(false);
      setSelectionPlaying(false);
      selectionStopAt.current = null;
    });
    ws.on("finish", () => {
      setSourcePlaying(false);
      setSelectionPlaying(false);
      selectionStopAt.current = null;
    });

    regions.on("region-updated", (region: Region) => {
      const clamped = clampRange(region.start, region.end, ws.getDuration());
      if (!clamped) return;
      setStart(clamped.start);
      setEnd(clamped.end);
      onChange(clamped.start, clamped.end);
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      regionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wavUrl]);

  const applyRange = (s: number, e: number) => {
    const dur = duration || wsRef.current?.getDuration() || Math.max(e, s + 0.01);
    const clamped = clampRange(s, e, dur);
    if (!clamped) return;
    setStart(clamped.start);
    setEnd(clamped.end);
    regionRef.current?.setOptions({ start: clamped.start, end: clamped.end });
    onChange(clamped.start, clamped.end);
  };

  const setInAtPlayhead = () => applyRange(playhead, end);
  const setOutAtPlayhead = () => applyRange(start, playhead);

  const selectAll = () => {
    const dur = duration || wsRef.current?.getDuration() || 0;
    if (dur > 0) applyRange(0, dur);
  };

  const barsFromPlayhead = (bars: number) => {
    const effectiveBpm = bpm && bpm > 0 ? bpm : 120;
    const barLen = (4 * 60) / effectiveBpm;
    const anchor = start;
    applyRange(anchor, anchor + bars * barLen);
  };

  const toggleSourcePlay = () => {
    const ws = wsRef.current;
    if (!ws) return;
    selectionStopAt.current = null;
    if (ws.isPlaying()) ws.pause();
    else ws.play();
  };

  const stop = () => {
    const ws = wsRef.current;
    if (!ws) return;
    selectionStopAt.current = null;
    ws.pause();
    ws.setTime(start);
  };

  const toggleSelectionPlay = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (selectionPlaying) {
      ws.pause();
      selectionStopAt.current = null;
      return;
    }
    selectionStopAt.current = end;
    setSelectionPlaying(true);
    ws.setTime(start);
    ws.play();
  };

  const lengthSec = Math.max(0, end - start);

  return (
    <Surface variant="raised" className="p-4 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <PlayPauseButton playing={sourcePlaying && !selectionPlaying} onToggle={toggleSourcePlay} label="source" />
        <Button aria-label="Stop" onClick={stop} className="!p-0 h-9 w-9 flex items-center justify-center">
          <Square size={14} />
        </Button>
        <span className="text-xs text-muted font-mono tabular-nums">{formatTime(playhead)}</span>
      </div>

      <div className="relative">
        <div ref={containerRef} data-testid="region-waveform" />
        {duration > 0 && (
          <>
            <div
              className="pointer-events-none absolute top-0 bottom-0 flex flex-col items-start"
              style={{ left: `${(start / duration) * 100}%` }}
            >
              <div className="w-[2px] h-full bg-accent" />
              <span className="mt-1 -translate-x-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent text-accent-ink whitespace-nowrap">
                {formatTime(start)}
              </span>
            </div>
            <div
              className="pointer-events-none absolute top-0 bottom-0 flex flex-col items-start"
              style={{ left: `${(end / duration) * 100}%` }}
            >
              <div className="w-[2px] h-full bg-accent" />
              <span className="mt-1 -translate-x-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent text-accent-ink whitespace-nowrap">
                {formatTime(end)}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <TimeField label="In" value={start} onCommit={(v) => applyRange(v, end)} />
        <TimeField label="Out" value={end} onCommit={(v) => applyRange(start, v)} />
        <Button onClick={setInAtPlayhead}>Set In at playhead</Button>
        <Button onClick={setOutAtPlayhead}>Set Out at playhead</Button>
        <Button onClick={selectAll}>Select all</Button>
        <PlayPauseButton playing={selectionPlaying} onToggle={toggleSelectionPlay} label="selection" tone="cyan" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => barsFromPlayhead(8)}>8 bars</Button>
        <Button onClick={() => barsFromPlayhead(16)}>16 bars</Button>
        <span className="text-sm text-muted font-mono tabular-nums ml-auto">Length {lengthSec.toFixed(3)} s</span>
      </div>
    </Surface>
  );
}
