import { useEffect, useState } from "react";
import { Bookmark, Check } from "lucide-react";
import clsx from "clsx";
import { Button } from "@/components/neumorphic/Button";
import { backend } from "@/lib/backend";
import { formatTime } from "@/lib/format";
import type { CutRegionResult, RegionParams, RegionSnap, Sample } from "@/lib/types";

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const SNAP_OPTIONS: { value: RegionSnap; label: string }[] = [
  { value: "bar", label: "Bar" },
  { value: "beat", label: "Beat" },
  { value: "none", label: "None" },
];

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
  /** When set, this button saves an arbitrary region (from a lane selection) instead of the fixed startSec/endSec range. */
  region?: RegionParams;
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
  region,
}: SaveSampleButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [snap, setSnap] = useState<RegionSnap>(region?.snap ?? "bar");
  const [preview, setPreview] = useState<CutRegionResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [nameEdited, setNameEdited] = useState(false);

  const existing = samples.some(
    (s) => s.songId === trackId && s.stemKey === stemKey && s.startSec === startSec && s.endSec === endSec
  );

  const defaultName = region
    ? `${songTitle} - ${stemLabel} ${formatMmSs(preview?.startSec ?? region.startSec)}-${formatMmSs(preview?.endSec ?? region.endSec)}`
    : `${songTitle} - ${stemLabel} ${formatMmSs(startSec)}-${formatMmSs(endSec)}`;

  // Preview the snapped range whenever the popover is open with a region and the snap choice changes.
  useEffect(() => {
    if (!open || !region) return;
    let cancelled = false;
    setPreviewLoading(true);
    backend
      .cutRegion({
        trackId,
        stemKey,
        startSec: region.startSec,
        endSec: region.endSec,
        snap,
        fadeMs: 5,
        trimLeadingSilence: true,
      })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, region, snap, trackId, stemKey]);

  const handleToggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    setSnap(region?.snap ?? "bar");
    setPreview(null);
    setNameEdited(false);
    setName(defaultName);
    setOpen(true);
  };

  useEffect(() => {
    // Once the snapped preview lands, refresh the default name unless the user already typed their own.
    if (open && !nameEdited) setName(defaultName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const sample = await backend.saveSample({
        trackId,
        stemKey,
        name: name.trim() || undefined,
        region: region ? { startSec: region.startSec, endSec: region.endSec, snap, fadeMs: 5, trimLeadingSilence: true } : undefined,
      });
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
          {region && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`sample-snap-${trackId}-${stemKey}`} className="text-[10px] text-muted uppercase tracking-wide">
                Snap
              </label>
              <select
                id={`sample-snap-${trackId}-${stemKey}`}
                value={snap}
                onChange={(e) => setSnap(e.target.value as RegionSnap)}
                className="bg-surface neu-surface-inset rounded-lg px-2 py-1 text-xs outline-none"
              >
                {SNAP_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-muted font-mono tabular-nums">
                {previewLoading || !preview
                  ? "Previewing…"
                  : `${formatTime(preview.startSec)} to ${formatTime(preview.endSec)}${
                      preview.bars ? `, ${preview.bars} bar${preview.bars === 1 ? "" : "s"}` : ""
                    }`}
              </span>
            </div>
          )}
          <label htmlFor={`sample-name-${trackId}-${stemKey}`} className="text-[10px] text-muted uppercase tracking-wide">
            Sample name
          </label>
          <input
            id={`sample-name-${trackId}-${stemKey}`}
            autoFocus
            type="text"
            value={name}
            onChange={(e) => {
              setNameEdited(true);
              setName(e.target.value);
            }}
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
