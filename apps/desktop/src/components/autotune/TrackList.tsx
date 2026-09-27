import clsx from "clsx";
import { Loader2, Plus, Star, X } from "lucide-react";
import { Button } from "@/components/neumorphic/Button";
import { Slider } from "@/components/neumorphic/Slider";
import type { MixPatch, TuneTrack } from "@/hooks/useAutotuneTracks";

export interface AlignNote {
  ok: boolean;
  message: string;
}

export interface TrackListProps {
  tracks: readonly TuneTrack[];
  activeId: string | null;
  alignNotes: Readonly<Record<string, AlignNote>>;
  onSelect(id: string): void;
  onMakeLead(id: string): void;
  onMix(id: string, patch: MixPatch): void;
  onNudge(id: string, deltaSec: number): void;
  onAlign(id: string): void;
  onInclude(id: string, include: boolean): void;
  onRemove(id: string): void;
  onAdd(): void;
}

export const NUDGE_SEC = 0.01;

function statusText(t: TuneTrack): string | null {
  if (t.status === "queued") return "Waiting…";
  if (t.status === "decoding" || t.status === "analyzing") return "Analyzing…";
  return null;
}

function formatOffset(sec: number): string {
  const ms = Math.round(sec * 1000);
  return `${ms > 0 ? "+" : ms < 0 ? "−" : ""}${Math.abs(ms)} ms`;
}

const small = "!px-2 !py-1 !rounded-lg text-[11px] leading-none";

/**
 * Lead + harmony tracks: pick the track to edit, set the lead, mute/solo/volume, line takes up in
 * time and choose which tracks "Tune all to key" touches. With one track it collapses to a single
 * "Add harmony" button so the simple case looks like a plain vocal editor.
 */
export function TrackList({ tracks, activeId, alignNotes, onSelect, onMakeLead, onMix, onNudge, onAlign, onInclude, onRemove, onAdd }: TrackListProps) {
  if (tracks.length <= 1) {
    return (
      <div className="flex items-center gap-2 px-1" data-testid="autotune-tracks">
        <Button type="button" onClick={onAdd} className={clsx(small, "inline-flex items-center gap-1")} title="Add harmony takes that play along with this vocal">
          <Plus size={12} /> Add harmony
        </Button>
      </div>
    );
  }
  // Aligning needs both this take and the lead analysed.
  const leadReady = tracks.some((x) => x.isLead && x.status === "ready");
  return (
    <div className="flex flex-col gap-1.5" data-testid="autotune-tracks" role="list" aria-label="Tracks">
      {tracks.map((t) => {
        const active = t.id === activeId;
        const status = statusText(t);
        const note = alignNotes[t.id];
        return (
          <div
            key={t.id}
            role="listitem"
            data-testid={`track-row-${t.id}`}
            data-active={active || undefined}
            aria-current={active || undefined}
            onClick={() => onSelect(t.id)}
            className={clsx(
              "flex flex-col gap-1 px-2.5 py-1.5 rounded-xl cursor-pointer transition-colors",
              active ? "neu-surface-inset bg-surface" : "hover:bg-white/[0.03]"
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ background: t.color, boxShadow: active ? `0 0 8px ${t.color}` : undefined }}
                aria-hidden
              />
              <span className={clsx("text-xs truncate max-w-[180px]", active ? "text-text font-semibold" : "text-muted")} title={t.name}>
                {t.name}
              </span>
              <button
                type="button"
                aria-label={t.isLead ? `${t.name} is the lead` : `Make ${t.name} the lead`}
                aria-pressed={t.isLead}
                title={t.isLead ? "Lead vocal (harmony intervals are measured against it)" : "Make this the lead vocal"}
                onClick={(e) => {
                  e.stopPropagation();
                  onMakeLead(t.id);
                }}
                className={clsx("p-0.5 rounded", t.isLead ? "text-[#F0A04B]" : "text-muted/50 hover:text-muted")}
              >
                <Star size={13} fill={t.isLead ? "currentColor" : "none"} />
              </button>
              {status && (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted uppercase tracking-wide" data-testid={`track-status-${t.id}`}>
                  <Loader2 size={11} className="animate-spin" /> {status}
                </span>
              )}
              {t.status === "error" && (
                <span className="text-[11px] text-danger truncate max-w-[240px]" title={t.error ?? undefined}>
                  {t.error ?? "Could not open this file"}
                </span>
              )}

              <div className="flex items-center gap-1.5 ml-auto" onClick={(e) => e.stopPropagation()}>
                <Button
                  type="button"
                  pressed={t.muted}
                  tone="red"
                  aria-label={`Mute ${t.name}`}
                  title="Mute"
                  onClick={() => onMix(t.id, { muted: !t.muted })}
                  className={clsx(small, "w-7 font-bold")}
                >
                  M
                </Button>
                <Button
                  type="button"
                  pressed={t.solo}
                  tone="amber"
                  aria-label={`Solo ${t.name}`}
                  title="Solo"
                  onClick={() => onMix(t.id, { solo: !t.solo })}
                  className={clsx(small, "w-7 font-bold")}
                >
                  S
                </Button>
                <Slider
                  value={Math.round(t.volume * 100)}
                  min={0}
                  max={100}
                  step={1}
                  orientation="horizontal"
                  label={`Volume ${t.name}`}
                  onChange={(v) => onMix(t.id, { volume: v / 100 })}
                  className="w-16"
                />
                {!t.isLead && (
                  <>
                    <Button type="button" aria-label={`Nudge ${t.name} earlier`} title="10 ms earlier" onClick={() => onNudge(t.id, -NUDGE_SEC)} className={small}>
                      −
                    </Button>
                    <span className="text-[11px] text-text tabular-nums font-mono w-14 text-center" data-testid={`track-offset-${t.id}`} title="Time offset against the song">
                      {formatOffset(t.offsetSec)}
                    </span>
                    <Button type="button" aria-label={`Nudge ${t.name} later`} title="10 ms later" onClick={() => onNudge(t.id, NUDGE_SEC)} className={small}>
                      +
                    </Button>
                    <Button
                      type="button"
                      aria-label={`Align ${t.name} to lead`}
                      title={t.status === "ready" && leadReady ? "Line this take up with the lead by its syllables" : "Available once this take and the lead are analyzed"}
                      disabled={t.status !== "ready" || !leadReady}
                      onClick={() => onAlign(t.id)}
                      className={small}
                    >
                      Align to lead
                    </Button>
                  </>
                )}
                <label className="flex items-center gap-1 text-[10px] text-muted uppercase tracking-wide cursor-pointer" title="Include in Tune all to key">
                  <input
                    type="checkbox"
                    checked={t.includeInTuneAll}
                    onChange={(e) => onInclude(t.id, e.target.checked)}
                    aria-label={`Include ${t.name} in Tune all`}
                    className="accent-[#F0A04B]"
                  />
                  Tune all
                </label>
                <button
                  type="button"
                  aria-label={`Remove ${t.name}`}
                  title="Remove track"
                  onClick={() => onRemove(t.id)}
                  className="p-1 rounded text-muted hover:text-danger"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
            {note && (
              <div role="status" className={clsx("text-[11px] pl-5", note.ok ? "text-muted" : "text-[#F0C04B]")} data-testid={`track-align-${t.id}`}>
                {note.message}
              </div>
            )}
          </div>
        );
      })}
      <div className="px-1">
        <Button type="button" onClick={onAdd} className={clsx(small, "inline-flex items-center gap-1")}>
          <Plus size={12} /> Add track
        </Button>
      </div>
    </div>
  );
}
