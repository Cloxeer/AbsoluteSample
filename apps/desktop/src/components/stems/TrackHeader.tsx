import { Download, Pause, Play } from "lucide-react";
import { Button } from "@/components/neumorphic/Button";
import { Slider } from "@/components/neumorphic/Slider";
import { formatDb } from "@/lib/format";
import clsx from "clsx";

export interface TrackHeaderProps {
  color: string;
  name: string;
  band: string;
  /** True while this exact track is the audition target and actively playing. */
  isAuditioning: boolean;
  solo: boolean;
  mute: boolean;
  volume: number;
  peakDb: number;
  rmsDb: number;
  onAudition: () => void;
  onToggleSolo: () => void;
  onToggleMute: () => void;
  onVolumeChange: (v: number) => void;
  onDownload: () => void;
  className?: string;
}

function dbToRatio(db: number): number {
  // -60dB..0dB mapped to 0..1
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

function Meter({ label, db, color }: { label: string; db: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-6 text-[9px] text-muted uppercase shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full neu-surface-inset overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{ width: `${dbToRatio(db) * 100}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-12 text-[9px] text-muted font-mono tabular-nums text-right">{formatDb(db)}</span>
    </div>
  );
}

/** Fixed-width (~240px) DAW-style track header: identity, transport, S/M, volume, meters, download. */
export function TrackHeader({
  color,
  name,
  band,
  isAuditioning,
  solo,
  mute,
  volume,
  peakDb,
  rmsDb,
  onAudition,
  onToggleSolo,
  onToggleMute,
  onVolumeChange,
  onDownload,
  className,
}: TrackHeaderProps) {
  return (
    <div
      role="group"
      aria-label={`${name} track controls`}
      className={clsx(
        "w-[240px] shrink-0 flex flex-col gap-2 p-3 rounded-2xl bg-surface neu-surface-raised",
        solo && "border-l-4",
        mute && "opacity-70",
        className
      )}
      style={solo ? { borderLeftColor: color, boxShadow: `${`var(--shadow-raised)`}, 0 0 12px ${color}55` } : undefined}
    >
      <div className="flex items-start gap-2">
        <div className="w-1.5 self-stretch rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{name}</div>
          <div className="text-[11px] text-muted truncate">{band}</div>
        </div>
        <Button
          aria-label={isAuditioning ? `Pause ${name} only` : `Play ${name} only`}
          aria-pressed={isAuditioning}
          pressed={isAuditioning}
          tone="accent"
          onClick={onAudition}
          className="!p-0 h-8 w-8 flex items-center justify-center shrink-0"
        >
          {isAuditioning ? <Pause size={14} /> : <Play size={14} />}
        </Button>
      </div>

      {mute && (
        <span className="self-start text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-stem-drums/20 text-stem-drums">
          MUTED
        </span>
      )}

      <div className="flex items-center gap-1">
        <Button
          aria-label="Solo"
          aria-pressed={solo}
          pressed={solo}
          tone="amber"
          onClick={onToggleSolo}
          className="!px-2 !py-1 text-xs font-bold flex-1"
        >
          S
        </Button>
        <Button
          aria-label="Mute"
          aria-pressed={mute}
          pressed={mute}
          tone="red"
          onClick={onToggleMute}
          className="!px-2 !py-1 text-xs font-bold flex-1"
        >
          M
        </Button>
        <Button aria-label={`Download ${name} WAV`} onClick={onDownload} className="!px-2 !py-1 shrink-0">
          <Download size={14} />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted font-mono tabular-nums w-9 shrink-0">
          {volume === 0 ? "-inf" : `${Math.round(20 * Math.log10(volume))}dB`}
        </span>
        <Slider
          orientation="horizontal"
          value={volume}
          min={0}
          max={1}
          step={0.01}
          onChange={onVolumeChange}
          label={`${name} volume`}
          className="flex-1 w-auto"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Meter label="Pk" db={peakDb} color={color} />
        <Meter label="RMS" db={rmsDb} color={color} />
      </div>
    </div>
  );
}
