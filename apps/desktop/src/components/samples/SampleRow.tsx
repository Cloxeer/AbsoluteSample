import { useEffect, useRef, useState } from "react";
import { FolderOpen, Pause, Pencil, Play, Trash2 } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { backend } from "@/lib/backend";
import { samplePlayer } from "@/lib/samplePlayer";
import { peaksOptions } from "@/lib/wavePeaks";
import { isTauri } from "@/lib/mediaUrl";
import type { Sample, SampleKind } from "@/lib/types";

const GROUP_COLORS: Record<string, string> = {
  vocals: "#F25F5C",
  drums: "#F2B33D",
  bass: "#4C8BF5",
  guitar: "#3DD68C",
  keys: "#B692F6",
  other: "#8A94A6",
  band: "#FFB84D",
  loop: "#4CC9F0",
};

function colorForGroup(group: string): string {
  return GROUP_COLORS[group] ?? "#8A94A6";
}

function formatMinSec(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

const KIND_LABELS: Record<SampleKind, string> = {
  stem: "Stem",
  region: "Region",
  hit: "Hit",
};

function kindLabel(kind?: SampleKind): string | null {
  if (!kind) return null;
  return KIND_LABELS[kind] ?? null;
}

export interface SampleRowProps {
  sample: Sample;
  selected: boolean;
  onToggleSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onReveal: () => void;
}

export function SampleRow({ sample, selected, onToggleSelect, onRename, onDelete, onReveal }: SampleRowProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sample.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);

  useEffect(() => {
    let alive = true;
    backend.resolveWavUrl(sample.path).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [sample.path]);

  useEffect(() => {
    setName(sample.name);
  }, [sample.name]);

  // Peaks waveform: never decodes audio, uses the sample's precomputed peaks + duration.
  useEffect(() => {
    if (!waveContainerRef.current || !url) return;
    const ws = WaveSurfer.create({
      container: waveContainerRef.current,
      waveColor: colorForGroup(sample.group),
      progressColor: colorForGroup(sample.group),
      cursorColor: "#4CC9F0",
      height: 36,
      normalize: true,
      interact: false,
      cursorWidth: 0,
      url,
      ...peaksOptions(sample.peaks, sample.durationSec),
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Playhead driven by the singleton player's published time, so silence at the start is visible.
  useEffect(() => {
    return samplePlayer.subscribe((state) => {
      const isThis = state.id === sample.id;
      setPlaying(isThis);
      const ws = wsRef.current;
      if (ws && sample.durationSec > 0) {
        const progress = isThis ? Math.min(1, state.currentTime / sample.durationSec) : 0;
        ws.seekTo(progress);
      }
    });
  }, [sample.id, sample.durationSec]);

  const togglePlay = () => {
    if (!url) return;
    if (samplePlayer.isPlaying(sample.id)) {
      samplePlayer.stop();
    } else {
      samplePlayer.play(sample, url);
    }
  };

  const commitRename = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== sample.name) onRename(trimmed);
    else setName(sample.name);
  };

  const color = colorForGroup(sample.group);
  const kind = kindLabel(sample.kind);
  const inTauri = isTauri();

  const handleDragStart = async (e: React.DragEvent<HTMLDivElement>) => {
    if (inTauri) {
      e.preventDefault();
      const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
      await startDrag({ item: [sample.path], icon: "" });
      return;
    }
    e.dataTransfer.setData("text/plain", sample.name);
  };

  return (
    <div
      className="w-full flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-white/[0.04]"
      draggable
      onDragStart={handleDragStart}
      data-testid={`sample-row-${sample.id}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${sample.name}`}
        className="shrink-0"
      />
      <button
        type="button"
        aria-label={playing ? `Pause ${sample.name}` : `Play ${sample.name}`}
        onClick={togglePlay}
        className="shrink-0 rounded-lg p-1.5 text-muted hover:text-text"
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div className="flex-1 min-w-[9rem]">
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") {
                setName(sample.name);
                setEditing(false);
              }
            }}
            aria-label={`Rename ${sample.name}`}
            className="w-full bg-surface neu-surface-inset rounded px-1.5 py-0.5 text-sm outline-none"
          />
        ) : (
          <div className="flex items-center gap-1 group/name" onDoubleClick={() => setEditing(true)}>
            <span className="text-sm font-medium truncate">{sample.name}</span>
            <button
              type="button"
              aria-label={`Rename ${sample.name}`}
              onClick={() => setEditing(true)}
              className="opacity-0 group-hover/name:opacity-100 text-muted hover:text-text shrink-0"
            >
              <Pencil size={12} />
            </button>
          </div>
        )}
        <div className="text-[11px] text-muted truncate">{sample.songTitle}</div>
        <div ref={waveContainerRef} data-testid={`sample-wave-${sample.id}`} className="mt-1" />
      </div>
      <span
        className="text-[10px] px-2 py-0.5 rounded-full border shrink-0"
        style={{ borderColor: `${color}55`, color, backgroundColor: `${color}15` }}
      >
        {sample.stemLabel}
      </span>
      {kind && (
        <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted shrink-0">{kind}</span>
      )}
      {sample.bars != null && (
        <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted font-mono shrink-0">
          {sample.bars} bar{sample.bars === 1 ? "" : "s"}
        </span>
      )}
      {sample.keyShort && (
        <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted font-mono shrink-0">
          {sample.keyShort}
        </span>
      )}
      <span className="text-[10px] text-muted font-mono shrink-0">{formatMinSec(sample.durationSec)}</span>
      {sample.bpm !== null && (
        <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/30 bg-accent/10 text-accent font-mono shrink-0">
          {sample.bpm.toFixed(1)} BPM
        </span>
      )}
      <span className="text-[10px] text-muted font-mono shrink-0">{formatMB(sample.bytes)}</span>
      <button
        type="button"
        aria-label={`Reveal ${sample.name} in folder`}
        onClick={onReveal}
        className="shrink-0 rounded-lg p-1.5 text-muted hover:text-text"
      >
        <FolderOpen size={14} />
      </button>
      <div className="flex items-center gap-1 shrink-0 w-[68px] justify-end">
        {confirmDelete ? (
          <div className="flex items-center gap-1 text-xs">
            <button
              type="button"
              aria-label={`Confirm delete ${sample.name}`}
              className="text-danger underline"
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
            >
              Yes
            </button>
            <button
              type="button"
              aria-label={`Cancel delete ${sample.name}`}
              className="text-muted underline"
              onClick={() => setConfirmDelete(false)}
            >
              No
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label={`Delete ${sample.name}`}
            onClick={() => setConfirmDelete(true)}
            className="rounded-lg p-1.5 text-muted hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
