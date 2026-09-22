import { useEffect, useRef, useState } from "react";
import { Bookmark, Download, FolderOpen, Pause, Pencil, Play, Trash2, X } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import { backend } from "@/lib/backend";
import { samplePlayer } from "@/lib/samplePlayer";
import { peaksOptions } from "@/lib/wavePeaks";
import { isTauri } from "@/lib/mediaUrl";
import { useLaneSelection } from "@/components/waveform/LaneSelection";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Button } from "@/components/neumorphic/Button";
import { formatTime } from "@/lib/format";
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
  /** Called after "Save as new sample" registers a new sample, so the caller can refresh its list. */
  onSaved?: () => void;
}

export function SampleRow({ sample, selected, onToggleSelect, onRename, onDelete, onReveal, onSaved }: SampleRowProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sample.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ws, setWs] = useState<WaveSurfer | null>(null);
  /** Seconds into this sample where the next play() call should start, set by clicking the waveform. */
  const startAtRef = useRef(0);

  const { regionsPlugin, selection, clear: clearSelection } = useLaneSelection(ws);
  const [selPlaying, setSelPlaying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [savePartName, setSavePartName] = useState("");
  const [savingPart, setSavingPart] = useState(false);
  const selPlayId = `${sample.id}:selection`;

  useEffect(() => {
    return samplePlayer.subscribe((state) => setSelPlaying(state.id === selPlayId));
  }, [selPlayId]);

  // Selection clears whenever this row's url changes (new sample/source).
  useEffect(() => {
    clearSelection();
    setSaveOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

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
    const instance = WaveSurfer.create({
      container: waveContainerRef.current,
      waveColor: colorForGroup(sample.group),
      progressColor: colorForGroup(sample.group),
      cursorColor: "#4CC9F0",
      height: 36,
      normalize: true,
      interact: true,
      cursorWidth: 1,
      url,
      plugins: [regionsPlugin],
      ...peaksOptions(sample.peaks, sample.durationSec),
    });
    instance.on("interaction", (newTime) => {
      startAtRef.current = newTime;
    });
    wsRef.current = instance;
    setWs(instance);
    return () => {
      instance.destroy();
      wsRef.current = null;
      setWs(null);
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
      samplePlayer.play(sample, url, { start: startAtRef.current });
    }
  };

  const handleToggleSelPlay = () => {
    if (!url || !selection) return;
    if (samplePlayer.isPlaying(selPlayId)) {
      samplePlayer.stop();
    } else {
      samplePlayer.playPath(selPlayId, url, { start: selection.start, end: selection.end, kind: "pad", label: `${sample.name} selection` });
    }
  };

  const handleDownloadSelection = async () => {
    if (!selection) return;
    setDownloading(true);
    try {
      const cut = await backend.cutSample({ sampleId: sample.id, startSec: selection.start, endSec: selection.end });
      const { save } = await import("@tauri-apps/plugin-dialog");
      const basename = cut.path.split(/[\\/]/).pop() ?? `${sample.name}-selection.wav`;
      const destPath = await save({ defaultPath: basename, filters: [{ name: "WAV", extensions: ["wav"] }] });
      if (!destPath) return;
      await backend.saveStem({ srcPath: cut.path, destPath });
    } finally {
      setDownloading(false);
    }
  };

  const openSavePart = () => {
    if (!selection) return;
    setSavePartName(`${sample.name} ${formatMinSec(selection.start)}-${formatMinSec(selection.end)}`);
    setSaveOpen(true);
  };

  const handleSavePart = async () => {
    if (!selection) return;
    setSavingPart(true);
    try {
      await backend.saveSamplePart({
        sampleId: sample.id,
        startSec: selection.start,
        endSec: selection.end,
        name: savePartName.trim() || undefined,
      });
      setSaveOpen(false);
      onSaved?.();
    } finally {
      setSavingPart(false);
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
        {selection && (
          <div className="flex items-center gap-1.5 mt-1" data-testid={`sample-selection-${sample.id}`}>
            <PlayPauseButton
              playing={selPlaying}
              onToggle={handleToggleSelPlay}
              label={`${sample.name} selection`}
              size={11}
              className="!p-1 h-6 w-6 flex items-center justify-center shrink-0"
            />
            <span className="text-[10px] text-muted font-mono tabular-nums">
              {formatTime(selection.start)}–{formatTime(selection.end)}
            </span>
            <Button
              aria-label={`Download ${sample.name} selection`}
              onClick={handleDownloadSelection}
              busy={downloading}
              className="!px-1.5 !py-0.5"
            >
              <Download size={12} />
            </Button>
            <div className="relative">
              <Button aria-label={`Save ${sample.name} selection as new sample`} onClick={openSavePart} className="!px-1.5 !py-0.5">
                <Bookmark size={12} />
              </Button>
              {saveOpen && (
                <div
                  className="absolute left-0 top-full mt-1 w-56 rounded-xl bg-surface neu-surface-raised p-2 flex flex-col gap-1.5 z-50"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    autoFocus
                    value={savePartName}
                    onChange={(e) => setSavePartName(e.target.value)}
                    aria-label="New sample name"
                    className="bg-surface neu-surface-inset rounded px-1.5 py-0.5 text-xs outline-none"
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button className="!px-1.5 !py-0.5 text-[11px]" onClick={() => setSaveOpen(false)}>
                      Cancel
                    </Button>
                    <Button variant="primary" className="!px-1.5 !py-0.5 text-[11px]" busy={savingPart} onClick={handleSavePart}>
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label={`Clear ${sample.name} selection`}
              onClick={clearSelection}
              className="text-muted hover:text-text p-0.5"
            >
              <X size={12} />
            </button>
          </div>
        )}
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
