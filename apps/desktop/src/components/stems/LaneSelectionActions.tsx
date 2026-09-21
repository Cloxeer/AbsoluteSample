import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Scissors } from "lucide-react";
import { Button } from "@/components/neumorphic/Button";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { SaveSampleButton } from "./SaveSampleButton";
import { backend } from "@/lib/backend";
import { samplePlayer } from "@/lib/samplePlayer";
import type { LaneSelectionRange } from "@/components/waveform/LaneSelection";
import type { Sample } from "@/lib/types";

export interface LaneSelectionActionsProps {
  trackId: string;
  stemKey: string;
  stemLabel: string;
  songTitle: string;
  wavUrl: string;
  selection: LaneSelectionRange;
  samples: Sample[];
  /** Called after any save (sample, hits) that should refresh the caller's samples list/count. */
  onSaved?: () => void;
  className?: string;
}

/** Compact row of actions (play/save/download/slice) for a lane's current drag selection. */
export function LaneSelectionActions({
  trackId,
  stemKey,
  stemLabel,
  songTitle,
  wavUrl,
  selection,
  samples,
  onSaved,
  className,
}: LaneSelectionActionsProps) {
  const playId = `${trackId}:${stemKey}:selection`;
  const [playing, setPlaying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [slicing, setSlicing] = useState(false);
  const [confirmingSlice, setConfirmingSlice] = useState(false);
  const [hitsMessage, setHitsMessage] = useState<string | null>(null);

  useEffect(() => {
    return samplePlayer.subscribe((state) => setPlaying(state.id === playId));
  }, [playId]);

  const handleTogglePlay = () => {
    if (samplePlayer.isPlaying(playId)) {
      samplePlayer.stop();
      return;
    }
    samplePlayer.playPath(playId, wavUrl, {
      start: selection.start,
      end: selection.end,
      kind: "pad",
      label: `${stemLabel} selection`,
    });
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const cut = await backend.cutRegion({
        trackId,
        stemKey,
        startSec: selection.start,
        endSec: selection.end,
        snap: "none",
        fadeMs: 5,
        trimLeadingSilence: true,
      });
      const basename = cut.path.split(/[\\/]/).pop() ?? `${stemKey}-selection.wav`;
      const destPath = await save({ defaultPath: basename, filters: [{ name: "WAV", extensions: ["wav"] }] });
      if (!destPath) return;
      await backend.saveStem({ srcPath: cut.path, destPath });
      onSaved?.();
    } finally {
      setDownloading(false);
    }
  };

  const handleSliceHits = async () => {
    setConfirmingSlice(false);
    setSlicing(true);
    try {
      const hits = await backend.sliceHits({ trackId, stemKey });
      onSaved?.();
      setHitsMessage(`${hits.length} hits saved`);
      setTimeout(() => setHitsMessage(null), 2000);
    } finally {
      setSlicing(false);
    }
  };

  return (
    <div className={className ?? "flex items-center gap-2 mt-1"}>
      <PlayPauseButton playing={playing} onToggle={handleTogglePlay} label={`${stemLabel} selection`} size={12} />
      <SaveSampleButton
        trackId={trackId}
        stemKey={stemKey}
        stemLabel={stemLabel}
        songTitle={songTitle}
        startSec={selection.start}
        endSec={selection.end}
        samples={samples}
        onSaved={onSaved}
        region={{ startSec: selection.start, endSec: selection.end, snap: "bar", fadeMs: 5, trimLeadingSilence: true }}
      />
      <Button
        aria-label={`Download ${stemLabel} selection`}
        onClick={handleDownload}
        busy={downloading}
        className="!px-2 !py-1"
      >
        <Download size={14} />
      </Button>
      {confirmingSlice ? (
        <div className="flex items-center gap-1.5 text-[10px] text-muted">
          <span>Create up to 64 one-shot samples from {stemLabel}?</span>
          <Button className="!px-2 !py-1 text-xs" onClick={handleSliceHits} busy={slicing}>
            Confirm
          </Button>
          <Button className="!px-2 !py-1 text-xs" onClick={() => setConfirmingSlice(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          aria-label={`Slice ${stemLabel} selection into hits`}
          onClick={() => setConfirmingSlice(true)}
          className="!px-2 !py-1"
        >
          <Scissors size={14} />
        </Button>
      )}
      {hitsMessage && <span className="text-[10px] text-ok">{hitsMessage}</span>}
    </div>
  );
}
