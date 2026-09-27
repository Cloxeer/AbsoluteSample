import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Scissors, Sparkles } from "lucide-react";
import { Button } from "@/components/neumorphic/Button";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { SaveSampleButton } from "./SaveSampleButton";
import type { GateFn } from "./BusyGate";
import { backend } from "@/lib/backend";
import { samplePlayer } from "@/lib/samplePlayer";
import { audioExtension } from "@/lib/stemFiles";
import type { LaneSelectionRange } from "@/components/waveform/LaneSelection";
import type { Sample } from "@/lib/types";

export interface LaneSelectionActionsProps {
  trackId: string;
  stemKey: string;
  stemLabel: string;
  songTitle: string;
  /** Playable url of the lane's audio; null for a derived stem (then `resolveUrl` is used). */
  wavUrl: string | null;
  selection: LaneSelectionRange;
  samples: Sample[];
  /** Called after any save (sample, hits) that should refresh the caller's samples list/count. */
  onSaved?: () => void;
  className?: string;
  /** v11: resolves a playable url on demand (derived stems are materialized as a file first). */
  resolveUrl?: () => Promise<string>;
  /** v11: runs before cut/save/slice, e.g. to materialize a derived stem as a real file. */
  prepare?: () => Promise<unknown>;
  /** v11: re-runs the best-quality separation on this time span (all stems). Shows the Enhance button. */
  onEnhance?: (range: LaneSelectionRange) => Promise<unknown>;
  /** v11: PC busy check wrapper for heavy work. */
  gate?: GateFn;
}

export const ENHANCE_TOOLTIP = "Re-run the best-quality separation on just this part";

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
  resolveUrl,
  prepare,
  onEnhance,
  gate,
}: LaneSelectionActionsProps) {
  const playId = `${trackId}:${stemKey}:selection`;
  const [playing, setPlaying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [slicing, setSlicing] = useState(false);
  const [confirmingSlice, setConfirmingSlice] = useState(false);
  const [hitsMessage, setHitsMessage] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceElapsed, setEnhanceElapsed] = useState(0);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  useEffect(() => {
    if (!enhancing) return;
    const startedMs = Date.now();
    setEnhanceElapsed(0);
    const timer = setInterval(() => setEnhanceElapsed(Math.floor((Date.now() - startedMs) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [enhancing]);

  useEffect(() => {
    return samplePlayer.subscribe((state) => setPlaying(state.id === playId));
  }, [playId]);

  const handleTogglePlay = async () => {
    if (samplePlayer.isPlaying(playId)) {
      samplePlayer.stop();
      return;
    }
    const url = wavUrl ?? (resolveUrl ? await resolveUrl() : null);
    if (!url) return;
    samplePlayer.playPath(playId, url, {
      start: selection.start,
      end: selection.end,
      kind: "pad",
      label: `${stemLabel} selection`,
    });
  };

  const handleEnhance = () => {
    if (!onEnhance) return;
    const range = { start: selection.start, end: selection.end };
    const run = async () => {
      setEnhanceError(null);
      setEnhancing(true);
      try {
        await onEnhance(range);
      } catch (err) {
        setEnhanceError(String(err));
      } finally {
        setEnhancing(false);
      }
    };
    if (gate) void gate("Enhance", run);
    else void run();
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await prepare?.();
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
      const ext = audioExtension(basename);
      const destPath = await save({ defaultPath: basename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
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
      await prepare?.();
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
      <PlayPauseButton playing={playing} onToggle={() => void handleTogglePlay()} label={`${stemLabel} selection`} size={12} />
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
        prepare={prepare}
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
      {onEnhance && (
        <Button
          aria-label={`Enhance ${stemLabel} selection`}
          title={ENHANCE_TOOLTIP}
          onClick={handleEnhance}
          busy={enhancing}
          busyLabel={`Enhancing ${enhanceElapsed}s`}
          className="!px-2 !py-1 text-xs"
        >
          <span className="inline-flex items-center gap-1">
            <Sparkles size={14} />
            Enhance
          </span>
        </Button>
      )}
      {hitsMessage && <span className="text-[10px] text-ok">{hitsMessage}</span>}
      {enhanceError && <span className="text-[10px] text-danger truncate max-w-[16rem]" title={enhanceError}>{enhanceError}</span>}
    </div>
  );
}
