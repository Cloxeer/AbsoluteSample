import { useState } from "react";
import { X } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { LibraryRow } from "./LibraryRow";
import type { LibraryEntry } from "@/lib/types";

function formatGBorMB(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export interface LibraryPanelProps {
  open: boolean;
  entries: LibraryEntry[];
  currentTrackId: string | null;
  sizeBytes: number;
  onClose: () => void;
  onOpenTrack: (id: string) => void;
  onSetKept: (id: string, kept: boolean) => void;
  onDeleteTrack: (id: string) => void;
}

export function LibraryPanel({
  open,
  entries,
  currentTrackId,
  sizeBytes,
  onClose,
  onOpenTrack,
  onSetKept,
  onDeleteTrack,
}: LibraryPanelProps) {
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  if (!open) return null;

  const sorted = [...entries].sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1));
  const scanCount = entries.filter((e) => !e.kept).length;

  const handleDeleteAllScans = () => {
    for (const entry of entries) {
      if (!entry.kept) onDeleteTrack(entry.id);
    }
    setConfirmingDeleteAll(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Song library">
      <div className="flex-1" onClick={onClose} />
      <Surface variant="raised" className="w-[340px] max-w-full h-full flex flex-col p-4 gap-3 rounded-none">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Songs</h2>
          <button type="button" aria-label="Close song library" onClick={onClose} className="text-muted hover:text-text p-1">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-1.5">
          {sorted.length === 0 ? (
            <p className="text-xs text-muted py-6 text-center">No songs yet. Fetch a link to get started.</p>
          ) : (
            sorted.map((entry) => (
              <LibraryRow
                key={entry.id}
                entry={entry}
                isCurrent={entry.id === currentTrackId}
                onOpen={onOpenTrack}
                onSetKept={onSetKept}
                onDelete={onDeleteTrack}
              />
            ))
          )}
        </div>

        <div className="border-t border-white/[0.06] pt-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text font-medium">
              {entries.length} {entries.length === 1 ? "song" : "songs"}, {scanCount} {scanCount === 1 ? "scan" : "scans"},{" "}
              {formatGBorMB(sizeBytes)}
            </span>
            {confirmingDeleteAll ? (
              <div className="flex items-center gap-1 text-xs shrink-0">
                <span className="text-muted">Delete all scans?</span>
                <button type="button" className="text-danger underline" onClick={handleDeleteAllScans}>
                  Yes
                </button>
                <button type="button" className="text-muted underline" onClick={() => setConfirmingDeleteAll(false)}>
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDeleteAll(true)}
                disabled={scanCount === 0}
                className="text-[11px] text-danger underline shrink-0 disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
              >
                Delete all scans
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted leading-snug">
            Songs are scans by default. The 3 most recent scans stay; older unkept scans are removed when you fetch a
            new link. Press Keep to hold a song, or save the stems you want as samples.
          </p>
        </div>
      </Surface>
    </div>
  );
}
