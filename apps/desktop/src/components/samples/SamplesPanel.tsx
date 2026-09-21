import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { SampleRow } from "./SampleRow";
import type { Sample } from "@/lib/types";

function formatGBorMB(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export interface SamplesPanelProps {
  open: boolean;
  samples: Sample[];
  onClose: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onReveal: (id: string) => void;
  onExport: (ids: string[]) => void;
}

export function SamplesPanel({ open, samples, onClose, onRename, onDelete, onReveal, onExport }: SamplesPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => [...samples].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), [samples]);
  const totalBytes = useMemo(() => samples.reduce((sum, s) => sum + s.bytes, 0), [samples]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Samples">
      <div className="flex-1" onClick={onClose} />
      <Surface variant="raised" className="w-[420px] max-w-full h-full flex flex-col p-4 gap-3 rounded-none">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Samples</h2>
          <button type="button" aria-label="Close samples" onClick={onClose} className="text-muted hover:text-text p-1">
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            className="!px-2 !py-1 text-xs"
            disabled={selected.size === 0}
            onClick={() => onExport(Array.from(selected))}
          >
            Export selected
          </Button>
          <Button
            className="!px-2 !py-1 text-xs"
            disabled={samples.length === 0}
            onClick={() => onExport(samples.map((s) => s.id))}
          >
            Export all
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-1">
          {sorted.length === 0 ? (
            <p className="text-xs text-muted py-6 text-center">No samples yet. Press Save as sample on any track.</p>
          ) : (
            sorted.map((sample) => (
              <SampleRow
                key={sample.id}
                sample={sample}
                selected={selected.has(sample.id)}
                onToggleSelect={() => toggle(sample.id)}
                onRename={(name) => onRename(sample.id, name)}
                onDelete={() => onDelete(sample.id)}
                onReveal={() => onReveal(sample.id)}
              />
            ))
          )}
        </div>

        <div className="border-t border-white/[0.06] pt-3">
          <span className="text-xs text-text font-medium">{formatGBorMB(totalBytes)} total</span>
        </div>
      </Surface>
    </div>
  );
}
