import { useState } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import clsx from "clsx";
import type { Job, LibraryEntry } from "@/lib/types";

function formatMinSec(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export interface LibraryRowProps {
  entry: LibraryEntry;
  isCurrent?: boolean;
  /** The active job for this song, if any is currently running. */
  job?: Job | null;
  onOpen: (id: string) => void;
  onSetKept: (id: string, kept: boolean) => void;
  onDelete: (id: string) => void;
}

export function LibraryRow({ entry, isCurrent = false, job = null, onOpen, onSetKept, onDelete }: LibraryRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div
      className={clsx(
        "flex flex-col gap-2 rounded-xl px-3 py-2 cursor-pointer transition-colors",
        isCurrent ? "bg-accent/10 border border-accent/40" : "hover:bg-white/[0.04] border border-transparent"
      )}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(entry.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(entry.id);
        }
      }}
      aria-current={isCurrent || undefined}
    >
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm truncate" title={entry.title}>
            {entry.title}
          </div>
          <div className="text-xs text-muted font-mono">{formatMinSec(entry.durationSec)}</div>
          {job && (
            <div className="flex items-center gap-1.5 text-[10px] text-accent mt-0.5" aria-label={`Processing ${entry.title}`}>
              <span className="w-2 h-2 rounded-full border border-accent border-t-transparent animate-spin shrink-0" aria-hidden />
              {job.message}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-pressed={entry.kept}
          title="Kept songs are never auto-removed"
          onClick={(e) => {
            e.stopPropagation();
            onSetKept(entry.id, !entry.kept);
          }}
          className={clsx(
            "shrink-0 rounded-lg p-1.5 transition-colors",
            entry.kept ? "text-stem-bass" : "text-muted hover:text-text"
          )}
        >
          <Bookmark size={16} fill={entry.kept ? "currentColor" : "none"} />
        </button>
        {confirmingDelete ? (
          <div className="flex items-center gap-1 text-xs shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-muted">Delete files?</span>
            <button
              type="button"
              className="text-danger underline"
              onClick={() => {
                onDelete(entry.id);
                setConfirmingDelete(false);
              }}
            >
              Yes
            </button>
            <button type="button" className="text-muted underline" onClick={() => setConfirmingDelete(false)}>
              No
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Delete track"
            title="Delete track files"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(true);
            }}
            className="shrink-0 rounded-lg p-1.5 text-muted hover:text-danger transition-colors"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.hasLoop && entry.loopStartSec !== null && entry.loopEndSec !== null && (
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted">
            Loop {formatMinSec(entry.loopStartSec)} to {formatMinSec(entry.loopEndSec)}
          </span>
        )}
        {entry.hasInstruments ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/30 bg-accent/10 text-accent">
            Split ({entry.instrumentCount})
          </span>
        ) : entry.hasBands ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/30 bg-accent/10 text-accent">
            EQ bands
          </span>
        ) : null}
        <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-muted font-mono">
          {formatMB(entry.bytes)}
        </span>
      </div>
    </div>
  );
}
