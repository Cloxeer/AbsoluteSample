import { useEffect, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import type WaveSurfer from "wavesurfer.js";
import { DisclosureToggle, InstrumentTrack } from "./InstrumentTrack";
import { Button } from "@/components/neumorphic/Button";
import { backend } from "@/lib/backend";
import { groupInstruments } from "@/lib/instruments";
import type { InstrumentStem } from "@/lib/types";
import type { TrackGainState } from "@/hooks/useSyncPlayback";

export interface InstrumentTrackListProps {
  trackId: string;
  stems: InstrumentStem[];
  tracks: TrackGainState[];
  currentTime: number;
  mode: "mix" | "audition";
  auditionId: string | null;
  onUpsertTrack: (state: TrackGainState) => void;
  onRegisterInstance: (id: string, ws: WaveSurfer, isMaster?: boolean, inMix?: boolean) => void;
  onUnregisterInstance: (id: string) => void;
  onTimeUpdate: (id: string, time: number) => void;
  onFinish: (id: string) => void;
  onAudition: (id: string) => void;
  /** Called after a save/export completes (backend marks the track kept automatically). */
  onSaved?: () => void;
}

const KIT_LABEL = "kit";

export function InstrumentTrackList({
  trackId,
  stems,
  tracks,
  currentTime,
  mode,
  auditionId,
  onUpsertTrack,
  onRegisterInstance,
  onUnregisterInstance,
  onTimeUpdate,
  onFinish,
  onAudition,
  onSaved,
}: InstrumentTrackListProps) {
  const [wavUrls, setWavUrls] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const nodes = groupInstruments(stems);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(stems.map(async (s) => [s.path, await backend.resolveWavUrl(s.path)] as const));
      if (!cancelled) setWavUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [stems]);

  useEffect(() => {
    for (const s of stems) {
      if (!tracks.find((t) => t.id === s.key)) {
        onUpsertTrack({ id: s.key, volume: 1, solo: false, mute: false });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stems]);

  const getTrack = (key: string): TrackGainState => tracks.find((t) => t.id === key) ?? { id: key, volume: 1, solo: false, mute: false };

  const handleDownload = async (stem: InstrumentStem) => {
    const basename = stem.path.split(/[\\/]/).pop() ?? `${stem.key}.wav`;
    const destPath = await save({ defaultPath: basename, filters: [{ name: "WAV", extensions: ["wav"] }] });
    if (!destPath) return;
    await backend.saveStem({ srcPath: stem.path, destPath });
    onSaved?.();
  };

  const handleExportAll = async () => {
    const destDir = await open({ directory: true });
    if (!destDir || Array.isArray(destDir)) return;
    for (const s of stems) {
      const basename = s.path.split(/[\\/]/).pop() ?? `${s.key}.wav`;
      await backend.saveStem({ srcPath: s.path, destPath: `${destDir}/${basename}` });
    }
    onSaved?.();
  };

  const handleOpenFolder = async () => {
    await backend.openWorkDir({ trackId });
  };

  const renderRow = (stem: InstrumentStem, indented: boolean, isMaster: boolean, inMix: boolean) => {
    const t = getTrack(stem.key);
    const isAuditioning = mode === "audition" && auditionId === stem.key;
    return (
      <InstrumentTrack
        key={`${trackId}:${stem.key}`}
        stem={stem}
        wavUrl={wavUrls[stem.path] ?? null}
        solo={t.solo}
        mute={t.mute}
        volume={t.volume}
        isPlaying={isAuditioning}
        indented={indented}
        currentTime={currentTime}
        onTogglePlay={() => onAudition(stem.key)}
        onToggleSolo={() => onUpsertTrack({ ...t, solo: !t.solo })}
        onToggleMute={() => onUpsertTrack({ ...t, mute: !t.mute })}
        onVolumeChange={(v) => onUpsertTrack({ ...t, volume: v })}
        onDownload={() => handleDownload(stem)}
        onReady={(ws) => onRegisterInstance(stem.key, ws, isMaster, inMix)}
        onTimeUpdate={(time) => onTimeUpdate(stem.key, time)}
        onFinish={() => onFinish(stem.key)}
        onDestroy={() => onUnregisterInstance(stem.key)}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        {nodes.map((node, i) => {
          const isOpen = expanded[node.stem.key] ?? false;
          const isKit = node.stem.group === "drums" && node.children.length > 0;
          const childLabel = isKit ? KIT_LABEL : "lead & backing";
          return (
            <div key={`${trackId}:${node.stem.key}`} className="flex flex-col gap-2">
              {renderRow(node.stem, false, i === 0, true)}
              {node.children.length > 0 && (
                <>
                  <DisclosureToggle
                    open={isOpen}
                    count={node.children.length}
                    label={childLabel}
                    onToggle={() => setExpanded((prev) => ({ ...prev, [node.stem.key]: !isOpen }))}
                  />
                  {isOpen && (
                    <div className="flex flex-col gap-2">
                      {node.children.map((child) => renderRow(child, true, false, false))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 justify-end">
        <Button onClick={handleOpenFolder}>Open folder</Button>
        <Button variant="primary" onClick={handleExportAll}>
          Export All
        </Button>
      </div>
    </div>
  );
}
