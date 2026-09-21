import { useEffect, useRef, useState } from "react";
import { FolderOpen, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { backend } from "@/lib/backend";
import type { Sample } from "@/lib/types";

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
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else void audio.play();
  };

  const commitRename = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== sample.name) onRename(trimmed);
    else setName(sample.name);
  };

  const color = colorForGroup(sample.group);

  return (
    <div className="flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-white/[0.04]">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${sample.name}`}
        className="shrink-0"
      />
      {url && (
        <audio
          ref={audioRef}
          src={url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
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
      </div>
      <span
        className="text-[10px] px-2 py-0.5 rounded-full border shrink-0"
        style={{ borderColor: `${color}55`, color, backgroundColor: `${color}15` }}
      >
        {sample.stemLabel}
      </span>
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
      {confirmDelete ? (
        <div className="flex items-center gap-1 text-xs shrink-0">
          <span className="text-muted">Delete?</span>
          <button
            type="button"
            className="text-danger underline"
            onClick={() => {
              onDelete();
              setConfirmDelete(false);
            }}
          >
            Yes
          </button>
          <button type="button" className="text-muted underline" onClick={() => setConfirmDelete(false)}>
            No
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Delete ${sample.name}`}
          onClick={() => setConfirmDelete(true)}
          className="shrink-0 rounded-lg p-1.5 text-muted hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}
