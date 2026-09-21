import { useState } from "react";
import { Bookmark, Check } from "lucide-react";
import clsx from "clsx";
import { Button } from "@/components/neumorphic/Button";
import { backend } from "@/lib/backend";
import type { Sample } from "@/lib/types";

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface SaveSampleButtonProps {
  trackId: string;
  stemKey: string;
  stemLabel: string;
  songTitle: string;
  startSec: number;
  endSec: number;
  samples: Sample[];
  onSaved?: (sample: Sample) => void;
  className?: string;
}

/** Small icon button that opens an inline popover to save the current track/stem as a named sample. */
export function SaveSampleButton({
  trackId,
  stemKey,
  stemLabel,
  songTitle,
  startSec,
  endSec,
  samples,
  onSaved,
  className,
}: SaveSampleButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const existing = samples.some(
    (s) => s.songId === trackId && s.stemKey === stemKey && s.startSec === startSec && s.endSec === endSec
  );

  const defaultName = `${songTitle} - ${stemLabel} ${formatMmSs(startSec)}-${formatMmSs(endSec)}`;

  const handleToggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    setName(defaultName);
    setOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const sample = await backend.saveSample({ trackId, stemKey, name: name.trim() || undefined });
      setOpen(false);
      setSaved(true);
      onSaved?.(sample);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={clsx("relative shrink-0", className)}>
      <button
        type="button"
        aria-label={`Save ${stemLabel} as sample`}
        aria-pressed={existing}
        onClick={handleToggleOpen}
        className={clsx(
          "shrink-0 rounded-lg p-1.5 transition-colors",
          existing ? "bg-accent text-bg" : "text-muted hover:text-text"
        )}
      >
        {saved ? <Check size={14} className="text-ok" /> : <Bookmark size={14} fill={existing ? "currentColor" : "none"} />}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-64 rounded-2xl bg-surface neu-surface-raised p-3 flex flex-col gap-2 z-50"
          onClick={(e) => e.stopPropagation()}
        >
          <label htmlFor={`sample-name-${trackId}-${stemKey}`} className="text-[10px] text-muted uppercase tracking-wide">
            Sample name
          </label>
          <input
            id={`sample-name-${trackId}-${stemKey}`}
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-surface neu-surface-inset rounded-lg px-2 py-1 text-xs outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button className="!px-2 !py-1 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" className="!px-2 !py-1 text-xs" busy={saving} onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
