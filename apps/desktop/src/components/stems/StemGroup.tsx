import { useEffect, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import type WaveSurfer from "wavesurfer.js";
import { StemTrack } from "./StemTrack";
import { Button } from "@/components/neumorphic/Button";
import { backend } from "@/lib/backend";
import type { StemInfo } from "@/lib/types";
import type { TrackGainState } from "@/hooks/useSyncPlayback";

export interface StemGroupProps {
  trackId: string;
  stems: StemInfo[];
  tracks: TrackGainState[];
  onUpsertTrack: (state: TrackGainState) => void;
  onRegisterInstance: (id: string, ws: WaveSurfer, isMaster?: boolean) => void;
  onUnregisterInstance: (id: string) => void;
  onTimeUpdate: (id: string, time: number) => void;
  onFinish: (id: string) => void;
}

export function StemGroup({
  trackId,
  stems,
  tracks,
  onUpsertTrack,
  onRegisterInstance,
  onUnregisterInstance,
  onTimeUpdate,
  onFinish,
}: StemGroupProps) {
  const [wavUrls, setWavUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        stems.map(async (stem) => [stem.path, await backend.resolveWavUrl(stem.path)] as const)
      );
      if (!cancelled) setWavUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [stems]);

  useEffect(() => {
    for (const stem of stems) {
      if (!tracks.find((t) => t.id === stem.key)) {
        onUpsertTrack({ id: stem.key, volume: 1, solo: false, mute: false });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stems]);

  const getTrack = (key: string): TrackGainState =>
    tracks.find((t) => t.id === key) ?? { id: key, volume: 1, solo: false, mute: false };

  const handleDownload = async (stem: StemInfo) => {
    const basename = stem.path.split(/[\\/]/).pop() ?? `${stem.key}.wav`;
    const destPath = await save({ defaultPath: basename, filters: [{ name: "WAV", extensions: ["wav"] }] });
    if (!destPath) return;
    await backend.saveStem({ srcPath: stem.path, destPath });
  };

  const handleExportAll = async () => {
    const destDir = await open({ directory: true });
    if (!destDir || Array.isArray(destDir)) return;
    await backend.saveAllStems({ trackId, destDir });
  };

  const handleOpenFolder = async () => {
    await backend.openWorkDir({ trackId });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        {stems.map((stem) => {
          const t = getTrack(stem.key);
          return (
            <StemTrack
              key={stem.key}
              stem={stem}
              wavUrl={wavUrls[stem.path] ?? null}
              solo={t.solo}
              mute={t.mute}
              volume={t.volume}
              onToggleSolo={() => onUpsertTrack({ ...t, solo: !t.solo })}
              onToggleMute={() => onUpsertTrack({ ...t, mute: !t.mute })}
              onVolumeChange={(v) => onUpsertTrack({ ...t, volume: v })}
              onDownload={() => handleDownload(stem)}
              onReady={(ws) => onRegisterInstance(stem.key, ws, stem.index === 1)}
              onTimeUpdate={(t) => onTimeUpdate(stem.key, t)}
              onFinish={() => onFinish(stem.key)}
              onDestroy={() => onUnregisterInstance(stem.key)}
            />
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
