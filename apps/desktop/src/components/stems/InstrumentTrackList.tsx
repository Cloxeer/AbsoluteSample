import { useEffect, useMemo, useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { Loader2 } from "lucide-react";
import type WaveSurfer from "wavesurfer.js";
import { DisclosureToggle, InstrumentTrack } from "./InstrumentTrack";
import { SaveSampleButton } from "./SaveSampleButton";
import type { GateFn } from "./BusyGate";
import { Button } from "@/components/neumorphic/Button";
import type { LaneSelectionRange } from "@/components/waveform/LaneSelection";
import { backend } from "@/lib/backend";
import { groupInstruments } from "@/lib/instruments";
import { MIX_ID, type MixTrackDef } from "@/lib/mixEngine";
import { isAudible } from "@/lib/stemPresence";
import { audioExtension, downloadName, isDerived, stemRealPath } from "@/lib/stemFiles";
import type { EnhancedSpan, InstrumentStem, Sample } from "@/lib/types";
import type { TrackGainState } from "@/hooks/useSyncPlayback";

export interface InstrumentTrackListProps {
  trackId: string;
  stems: InstrumentStem[];
  tracks: TrackGainState[];
  currentTime: number;
  mode: "mix" | "audition";
  auditionId: string | null;
  onUpsertTrack: (state: TrackGainState) => void;
  onRegisterInstance: (id: string, ws: WaveSurfer, isMaster?: boolean, inMix?: boolean, url?: string) => void;
  onUnregisterInstance: (id: string) => void;
  onTimeUpdate: (id: string, time: number) => void;
  onFinish: (id: string) => void;
  onAudition: (id: string) => void;
  /** Called with the clicked time (seconds) when the user clicks/drags on any lane's waveform. */
  onSeek?: (time: number) => void;
  /** Called after a save/export completes (backend marks the track kept automatically). */
  onSaved?: () => void;
  /** Song title and loop range, for the "Save as sample" default name; samples list, to show already-saved state. */
  songTitle?: string;
  loopStartSec?: number;
  loopEndSec?: number;
  samples?: Sample[];
  onSampleSaved?: () => void;
  /** v11: publishes every stem's audio source (files, derived recipes, the source mix) to the player. */
  onSetSources?: (owner: string, defs: MixTrackDef[]) => void;
  /** v11: source mix path that derived stems reference as "mix". */
  mixPath?: string | null;
  /** v11: spans already re-run by Enhance. */
  enhanced?: EnhancedSpan[];
  /** v11: Enhance a time span of every stem. Shows the Enhance action on lane selections. */
  onEnhance?: (range: LaneSelectionRange) => Promise<unknown>;
  /** v11: split vocals/drums into sub-parts on demand. Shows the sub-part toggles even before they exist. */
  onSplitSubstems?: (parent: string) => Promise<unknown>;
  /** v11: PC busy check wrapper for heavy work. */
  gate?: GateFn;
  /** v11: a split is still running; shows a placeholder row for the stems still to come. */
  pendingLabel?: string | null;
  /** v11: prefix for backend.stemFile keys, e.g. "karaoke:" for the karaoke set. */
  fileKeyPrefix?: string;
}

const KIT_LABEL = "kit";

/** Stems that can be split into sub-parts on demand, with their toggle and button labels. */
const LAZY_SUBPARTS: Record<string, { toggle: string; action: string }> = {
  vocals: { toggle: "lead & backing", action: "Split lead & backing" },
  drums: { toggle: KIT_LABEL, action: "Split drum kit" },
};

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
  onSeek,
  onSaved,
  songTitle,
  loopStartSec,
  loopEndSec,
  samples = [],
  onSampleSaved,
  onSetSources,
  mixPath,
  enhanced,
  onEnhance,
  onSplitSubstems,
  gate,
  pendingLabel,
  fileKeyPrefix = "",
}: InstrumentTrackListProps) {
  const [wavUrls, setWavUrls] = useState<Record<string, string>>({});
  const [mixUrl, setMixUrl] = useState<string | null>(null);
  /** Urls of materialized derived stems whose recipe can't be computed in the browser (fallback). */
  const [derivedUrls, setDerivedUrls] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [splitting, setSplitting] = useState<Record<string, boolean>>({});
  const [splitErrors, setSplitErrors] = useState<Record<string, string>>({});
  const nodes = groupInstruments(stems);
  const audibleNodes = nodes.filter((n) => isAudible(n.stem));
  const silentNodes = nodes.filter((n) => !isAudible(n.stem));
  const [ownerId] = useState(() => Math.random().toString(36).slice(2));
  const sourcesOwner = `${trackId}:${ownerId}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = stems.filter((s) => !isDerived(s));
      const entries = await Promise.all(stored.map(async (s) => [s.path, await backend.resolveWavUrl(s.path)] as const));
      if (!cancelled) setWavUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [stems]);

  const needsMix = stems.some((s) => s.derived?.plus.includes(MIX_ID) || s.derived?.minus.includes(MIX_ID));
  useEffect(() => {
    if (!mixPath || !needsMix) {
      setMixUrl(null);
      return;
    }
    let cancelled = false;
    backend
      .resolveWavUrl(mixPath)
      .then((u) => {
        if (!cancelled) setMixUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mixPath, needsMix]);

  // A derived stem whose inputs aren't all available here (no recipe, or no source mix) is played
  // from a materialized file instead.
  const keys = useMemo(() => new Set(stems.map((s) => s.key)), [stems]);
  const recipeUsable = (s: InstrumentStem): boolean => {
    if (!s.derived) return false;
    return [...s.derived.plus, ...s.derived.minus].every((k) => (k === MIX_ID ? !!mixPath : keys.has(k)));
  };
  const hasPeaks = (s: InstrumentStem) => !!s.peaks && s.peaks.length > 0 && !!s.durationSec;
  const fallbackKeys = stems.filter((s) => isDerived(s) && (!recipeUsable(s) || !hasPeaks(s))).map((s) => s.key);
  const fallbackSig = fallbackKeys.join(",");
  useEffect(() => {
    if (fallbackKeys.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        fallbackKeys.map(async (key) => {
          try {
            const path = await backend.stemFile({ trackId, key: `${fileKeyPrefix}${key}` });
            return [key, await backend.resolveWavUrl(path)] as const;
          } catch {
            return null;
          }
        })
      );
      if (!cancelled) setDerivedUrls(Object.fromEntries(entries.filter((e): e is readonly [string, string] => !!e)));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, fallbackSig, stems]);

  // Publish every stem's source to the player, so derived lanes (and mixes containing them) play.
  useEffect(() => {
    if (!onSetSources) return;
    const defs: MixTrackDef[] = [];
    for (const s of stems) {
      if (isDerived(s)) {
        if (s.derived && recipeUsable(s)) defs.push({ id: s.key, derive: s.derived });
        else if (derivedUrls[s.key]) defs.push({ id: s.key, url: derivedUrls[s.key] });
      } else if (wavUrls[s.path]) {
        defs.push({ id: s.key, url: wavUrls[s.path] });
      }
    }
    if (mixUrl) defs.push({ id: MIX_ID, url: mixUrl, hidden: true });
    onSetSources(sourcesOwner, defs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stems, wavUrls, mixUrl, derivedUrls, onSetSources]);

  useEffect(() => {
    return () => onSetSources?.(sourcesOwner, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const srcPath = await stemRealPath(trackId, stem, fileKeyPrefix);
    const ext = audioExtension(srcPath);
    const destPath = await save({ defaultPath: downloadName(stem.key, srcPath), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!destPath) return;
    await backend.saveStem({ srcPath, destPath });
    onSaved?.();
  };

  const handleExportAll = async () => {
    const destDir = await open({ directory: true });
    if (!destDir || Array.isArray(destDir)) return;
    for (const s of stems) {
      const srcPath = await stemRealPath(trackId, s, fileKeyPrefix);
      await backend.saveStem({ srcPath, destPath: `${destDir}/${downloadName(s.key, srcPath)}` });
    }
    onSaved?.();
  };

  const handleOpenFolder = async () => {
    await backend.openWorkDir({ trackId });
  };

  const runSplitSubstems = (parent: string) => {
    if (!onSplitSubstems) return;
    const run = async () => {
      setSplitting((prev) => ({ ...prev, [parent]: true }));
      setSplitErrors((prev) => ({ ...prev, [parent]: "" }));
      try {
        await onSplitSubstems(parent);
      } catch (err) {
        setSplitErrors((prev) => ({ ...prev, [parent]: String(err) }));
      } finally {
        setSplitting((prev) => ({ ...prev, [parent]: false }));
      }
    };
    const label = LAZY_SUBPARTS[parent]?.action ?? "Split";
    if (gate) void gate(label, run);
    else void run();
  };

  const renderRow = (stem: InstrumentStem, indented: boolean, isMaster: boolean, inMix: boolean) => {
    const t = getTrack(stem.key);
    const isAuditioning = mode === "audition" && auditionId === stem.key;
    const derived = isDerived(stem);
    // Derived lanes draw from their peaks; without peaks they fall back to a materialized file.
    const wavUrl = derived ? (hasPeaks(stem) ? null : derivedUrls[stem.key] ?? null) : wavUrls[stem.path] ?? null;
    const realFile = () => stemRealPath(trackId, stem, fileKeyPrefix);
    return (
      <InstrumentTrack
        key={`${trackId}:${stem.key}`}
        stem={stem}
        wavUrl={wavUrl}
        volume={t.volume}
        isPlaying={isAuditioning}
        indented={indented}
        currentTime={currentTime}
        onTogglePlay={() => onAudition(stem.key)}
        onVolumeChange={(v) => onUpsertTrack({ ...t, volume: v })}
        onDownload={() => void handleDownload(stem)}
        trackId={trackId}
        songTitle={songTitle}
        samples={samples}
        onSampleSaved={onSampleSaved}
        enhanced={enhanced}
        resolveUrl={derived ? async () => backend.resolveWavUrl(await realFile()) : undefined}
        prepare={derived ? realFile : undefined}
        onEnhance={onEnhance}
        gate={gate}
        extraAction={
          songTitle && loopStartSec !== undefined && loopEndSec !== undefined ? (
            <SaveSampleButton
              trackId={trackId}
              stemKey={stem.key}
              stemLabel={stem.label}
              songTitle={songTitle}
              startSec={loopStartSec}
              endSec={loopEndSec}
              samples={samples}
              onSaved={onSampleSaved}
              prepare={derived ? realFile : undefined}
            />
          ) : undefined
        }
        onReady={(ws) => onRegisterInstance(stem.key, ws, isMaster, inMix, wavUrl ?? undefined)}
        onTimeUpdate={(time) => onTimeUpdate(stem.key, time)}
        onFinish={() => onFinish(stem.key)}
        onDestroy={() => onUnregisterInstance(stem.key)}
        onSeek={onSeek}
      />
    );
  };

  const renderNode = (node: (typeof nodes)[number], isMaster: boolean) => {
    const isOpen = expanded[node.stem.key] ?? false;
    const lazy = onSplitSubstems && node.stem.parent === null ? LAZY_SUBPARTS[node.stem.key] : undefined;
    const isKit = node.stem.group === "drums" && node.children.length > 0;
    const childLabel = lazy?.toggle ?? (isKit ? KIT_LABEL : "lead & backing");
    const audibleChildren = node.children.filter((c) => isAudible(c));
    const silentChildren = node.children.filter((c) => !isAudible(c));
    const showToggle = node.children.length > 0 || !!lazy;
    return (
      <div key={`${trackId}:${node.stem.key}`} className="flex flex-col gap-2">
        {renderRow(node.stem, false, isMaster, true)}
        {showToggle && (
          <>
            <DisclosureToggle
              open={isOpen}
              count={node.children.length}
              label={childLabel}
              onToggle={() => setExpanded((prev) => ({ ...prev, [node.stem.key]: !isOpen }))}
            />
            {isOpen && node.children.length === 0 && lazy && (
              <div className="ml-9 flex items-center gap-2">
                <Button
                  className="!px-3 !py-1 text-xs"
                  busy={!!splitting[node.stem.key]}
                  busyLabel="Splitting"
                  onClick={() => runSplitSubstems(node.stem.key)}
                >
                  {lazy.action}
                </Button>
                {splitErrors[node.stem.key] && <span className="text-[10px] text-danger">{splitErrors[node.stem.key]}</span>}
              </div>
            )}
            {isOpen && node.children.length > 0 && (
              <div className="flex flex-col gap-2">
                {audibleChildren.map((child) => renderRow(child, true, false, false))}
                {silentChildren.length > 0 && (
                  <SilentStemsRow stems={silentChildren} renderRow={(s) => renderRow(s, true, false, false)} />
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        {audibleNodes.map((node, i) => renderNode(node, i === 0 && audibleNodes.length > 0))}
        {silentNodes.length > 0 && (
          <SilentStemsRow
            stems={silentNodes.map((n) => n.stem)}
            renderRow={(s) => {
              const node = silentNodes.find((n) => n.stem.key === s.key)!;
              return renderNode(node, false);
            }}
          />
        )}
        {pendingLabel && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-2xl neu-surface-inset px-4 py-3 text-xs text-muted"
          >
            <Loader2 size={14} className="animate-spin text-accent shrink-0" />
            {pendingLabel}
          </div>
        )}
      </div>
      {!pendingLabel && (
        <div className="flex gap-2 justify-end">
          <Button onClick={handleOpenFolder}>Open folder</Button>
          <Button variant="primary" onClick={handleExportAll}>
            Export All
          </Button>
        </div>
      )}
    </div>
  );
}

/** Collapses a set of effectively-silent stems into a single muted row with a Show/Hide toggle. */
function SilentStemsRow<T extends { key: string; label: string }>({
  stems,
  renderRow,
}: {
  stems: T[];
  renderRow: (stem: T) => React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  if (stems.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="self-start text-xs px-2 py-1 rounded-full border border-white/10 text-muted hover:text-text transition-colors"
      >
        {stems.length} silent stem{stems.length === 1 ? "" : "s"} hidden: {stems.map((s) => s.label).join(", ")} · {show ? "Hide" : "Show"}
      </button>
      {show && <div className="flex flex-col gap-2">{stems.map((s) => renderRow(s))}</div>}
    </div>
  );
}
