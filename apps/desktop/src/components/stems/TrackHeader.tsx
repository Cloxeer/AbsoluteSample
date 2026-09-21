import { Download } from "lucide-react";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Slider } from "@/components/neumorphic/Slider";
import { formatDb } from "@/lib/format";
import clsx from "clsx";

export interface TrackHeaderProps {
  color: string;
  name: string;
  band: string;
  /** True while this exact track is the audition target and actively playing. */
  isAuditioning: boolean;
  volume: number;
  peakDb: number;
  rmsDb: number;
  onAudition: () => void;
  onVolumeChange: (v: number) => void;
  onDownload: () => void;
  /** Optional extra icon action rendered next to Download, e.g. a Save-as-sample button. */
  extraAction?: React.ReactNode;
  className?: string;
}

function dbToRatio(db: number): number {
  // -60dB..0dB mapped to 0..1
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

function Meter({ label, db, color, infoTip }: { label: string; db: number; color: string; infoTip?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1 w-6 text-[9px] text-muted uppercase shrink-0">
        {label}
        {infoTip}
      </span>
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

/** Fixed-width (~240px) DAW-style track header: identity, transport, volume, meters, download. */
export function TrackHeader({
  color,
  name,
  band,
  isAuditioning,
  volume,
  peakDb,
  rmsDb,
  onAudition,
  onVolumeChange,
  onDownload,
  extraAction,
  className,
}: TrackHeaderProps) {
  return (
    <div
      role="group"
      aria-label={`${name} track controls`}
      className={clsx("w-[240px] shrink-0 flex flex-col gap-2 p-3 rounded-2xl bg-surface neu-surface-raised", className)}
    >
      <div className="flex items-start gap-2">
        <div className="w-1.5 self-stretch rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{name}</div>
          <div className="text-[11px] text-muted truncate">{band}</div>
        </div>
        <PlayPauseButton
          playing={isAuditioning}
          onToggle={onAudition}
          label={`${name} only`}
          size={14}
          className="!p-0 h-8 w-8 flex items-center justify-center shrink-0"
        />
      </div>

      <div className="flex items-center gap-1">
        <Button aria-label={`Download ${name} WAV`} onClick={onDownload} className="!px-2 !py-1 shrink-0">
          <Download size={14} />
        </Button>
        {extraAction}
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
        <Meter label="Pk" db={peakDb} color={color} infoTip={<InfoTip term="PK" text="The loudest single moment in this track." />} />
        <Meter label="RMS" db={rmsDb} color={color} infoTip={<InfoTip term="RMS" text="How loud it feels on average." />} />
      </div>
    </div>
  );
}
