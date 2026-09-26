import { useEffect, useState } from "react";
import { Bookmark, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import clsx from "clsx";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { RegionSelector } from "@/components/waveform/RegionSelector";
import { StemGroup } from "@/components/stems/StemGroup";
import { InstrumentTrackList } from "@/components/stems/InstrumentTrackList";
import { EngineStatusCard } from "@/components/stems/EngineStatusCard";
import { SaveSampleButton } from "@/components/stems/SaveSampleButton";
import { SourcePicker } from "@/components/layout/SourcePicker";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useSyncPlayback } from "@/hooks/useSyncPlayback";
import { backend } from "@/lib/backend";
import { onProgress } from "@/lib/events";
import { formatTime } from "@/lib/format";
import { nowPlaying } from "@/lib/nowPlaying";
import type { EngineStatus, ProgressPayload, Sample } from "@/lib/types";
import WaveSurfer from "wavesurfer.js";
import { peaksOptions } from "@/lib/wavePeaks";
import { useRef } from "react";

const SEED_URL = "https://youtu.be/nRKgT3d6xoE";

const PASS_DEFS: { pass: string; label: string }[] = [
  { pass: "instruments", label: "Instruments (Demucs)" },
  { pass: "vocals", label: "Vocals refine" },
  { pass: "lead", label: "Lead/backing" },
  { pass: "drums", label: "Drum kit" },
];

const KARAOKE_PASS_DEFS: { pass: string; label: string }[] = [
  { pass: "vocals", label: "Vocals" },
  { pass: "lead", label: "Lead & backing" },
];

type PassState = "pending" | "running" | "done" | "failed";

function PassChecklist({
  passStates,
  reasons,
  defs = PASS_DEFS,
}: {
  passStates: Record<string, PassState>;
  reasons: Record<string, string>;
  defs?: { pass: string; label: string }[];
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {defs.map(({ pass, label }) => {
        const state = passStates[pass] ?? "pending";
        return (
          <li key={pass} className="flex items-center gap-2 text-xs">
            {state === "pending" && <CircleDashed size={14} className="text-muted shrink-0" />}
            {state === "running" && <Loader2 size={14} className="text-accent animate-spin shrink-0" />}
            {state === "done" && <CheckCircle2 size={14} className="text-ok shrink-0" />}
            {state === "failed" && <XCircle size={14} className="text-danger shrink-0" />}
            <span className={clsx(state === "failed" ? "text-danger" : "text-text")}>{label}</span>
            {state === "failed" && reasons[pass] && <span className="text-muted">({reasons[pass]})</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Compact waveform of the copy-trimmed loop with its own play/pause transport (pauses the mix first). */
function LoopPreview({
  wavPath,
  startSec,
  endSec,
  peaks,
  onPlay,
  trackId,
  songTitle,
  samples,
  onSampleSaved,
}: {
  wavPath: string;
  startSec: number;
  endSec: number;
  peaks?: number[];
  onPlay: () => void;
  trackId: string;
  songTitle: string;
  samples: Sample[];
  onSampleSaved: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const isNowPlayingSourceRef = useRef(false);

  useEffect(() => {
    let alive = true;
    backend.resolveWavUrl(wavPath).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [wavPath]);

  useEffect(() => {
    if (!containerRef.current || !url) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url,
      height: 72,
      waveColor: "#4C8BF5",
      progressColor: "#F2B33D",
      cursorColor: "#4CC9F0",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      ...peaksOptions(peaks, endSec - startSec),
    });
    ws.on("play", () => {
      setPlaying(true);
      isNowPlayingSourceRef.current = true;
      nowPlaying.start("loop", "Loop", endSec - startSec, {
        pause: () => ws.pause(),
        resume: () => void ws.play(),
        stop: () => ws.pause(),
      });
    });
    ws.on("timeupdate", (t) => {
      if (isNowPlayingSourceRef.current) nowPlaying.tick(t);
    });
    ws.on("pause", () => {
      setPlaying(false);
      if (isNowPlayingSourceRef.current) {
        isNowPlayingSourceRef.current = false;
        nowPlaying.setPlaying(false);
      }
    });
    ws.on("finish", () => {
      setPlaying(false);
      if (isNowPlayingSourceRef.current) {
        isNowPlayingSourceRef.current = false;
        nowPlaying.stop();
      }
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <Surface variant="inset" className="p-4 flex items-center gap-4">
      <PlayPauseButton
        playing={playing}
        label="loop"
        onToggle={() => {
          const ws = wsRef.current;
          if (!ws) return;
          if (playing) ws.pause();
          else {
            onPlay();
            void ws.play();
          }
        }}
      />
      <div className="flex-1 min-w-0" ref={containerRef} data-testid="loop-waveform" />
      <div className="font-mono text-xs text-muted whitespace-nowrap">
        {formatTime(startSec)} to {formatTime(endSec)}
      </div>
      <SaveSampleButton
        trackId={trackId}
        stemKey="loop"
        stemLabel="loop"
        songTitle={songTitle}
        startSec={startSec}
        endSec={endSec}
        samples={samples}
        onSaved={onSampleSaved}
      />
    </Surface>
  );
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  local: "Local",
  youtube: "YouTube",
};

export interface SlicerTabProps {
  engineApi?: ReturnType<typeof useAudioEngine>;
  /** Shared playback controller; App owns it so the header transport drives the stem tracks. */
  syncApi?: ReturnType<typeof useSyncPlayback>;
  /** Called after any action that changes the song library (fetch, split, save/export). */
  onLibraryChanged?: () => void;
  /** Saved samples, for showing which tracks already have a sample and refreshing the Samples drawer. */
  samples?: Sample[];
  onSampleSaved?: () => void;
}

export function SlicerTab({ engineApi, syncApi, onLibraryChanged, samples = [], onSampleSaved }: SlicerTabProps = {}) {
  const ownEngine = useAudioEngine();
  const { engine, fetchAudio, importLocal, trimLoop, separateStems, separateInstruments, separateKaraoke, newLink } = engineApi ?? ownEngine;
  const ownSync = useSyncPlayback();
  const sync = syncApi ?? ownSync;
  const [url, setUrl] = useState(SEED_URL);
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 15 });
  const [sourceWavUrl, setSourceWavUrl] = useState<string | null>(null);
  const [splitSuccess, setSplitSuccess] = useState(false);
  const [useQuickEq, setUseQuickEq] = useState(false);
  const [kept, setKept] = useState(false);

  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [passStates, setPassStates] = useState<Record<string, PassState>>({});
  const [passReasons, setPassReasons] = useState<Record<string, string>>({});
  const [karaokeRunning, setKaraokeRunning] = useState(false);
  const [karaokeSuccess, setKaraokeSuccess] = useState(false);
  const [splitLeadBacking, setSplitLeadBacking] = useState(false);
  const [karaokePassStates, setKaraokePassStates] = useState<Record<string, PassState>>({});
  const [karaokePassReasons, setKaraokePassReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    backend.engineStatus().then(setEngineStatus);
  }, []);

  // Keep the source waveform, range and Keep toggle in sync whenever a (different) track becomes current,
  // e.g. after opening a song from the library.
  useEffect(() => {
    if (!engine.track) return;
    let cancelled = false;
    backend.resolveWavUrl(engine.track.wavPath).then((u) => {
      if (!cancelled) setSourceWavUrl(u);
    });
    setRange(
      engine.loop
        ? { start: engine.loop.startSec, end: engine.loop.endSec }
        : { start: 0, end: engine.track.durationSec }
    );
    backend.listLibrary().then((entries) => {
      if (cancelled) return;
      const found = entries.find((e) => e.id === engine.track!.id);
      setKept(found?.kept ?? false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.track?.id]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onProgress((payload: ProgressPayload) => {
      if (payload.stage !== "separate" || !payload.pass) return;
      if (karaokeRunning) {
        setKaraokePassStates((prev) => {
          const next = { ...prev };
          for (const def of KARAOKE_PASS_DEFS) {
            if (def.pass === payload.pass) {
              next[def.pass] = payload.failed ? "failed" : payload.percent >= 100 ? "done" : "running";
            } else if (!next[def.pass]) {
              next[def.pass] = "pending";
            }
          }
          return next;
        });
        if (payload.failed) {
          setKaraokePassReasons((prev) => ({ ...prev, [payload.pass as string]: payload.message }));
        }
        return;
      }
      setPassStates((prev) => {
        const next = { ...prev };
        for (const def of PASS_DEFS) {
          if (def.pass === payload.pass) {
            next[def.pass] = payload.failed ? "failed" : payload.percent >= 100 ? "done" : "running";
          } else if (!next[def.pass]) {
            next[def.pass] = "pending";
          }
        }
        return next;
      });
      if (payload.failed) {
        setPassReasons((prev) => ({ ...prev, [payload.pass as string]: payload.message }));
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [karaokeRunning]);

  const handleFetch = async () => {
    const track = await fetchAudio(url);
    const wavUrl = await backend.resolveWavUrl(track.wavPath);
    setSourceWavUrl(wavUrl);
    setRange({ start: 0, end: track.durationSec });
    setKept(false);
    onLibraryChanged?.();
  };

  const handleNewLinkFetch = async () => {
    newLink(sync.stopAll);
    setSourceWavUrl(null);
    setUseQuickEq(false);
    await handleFetch();
  };

  const handleImportLocal = async (path: string) => {
    const track = await importLocal(path);
    const wavUrl = await backend.resolveWavUrl(track.wavPath);
    setSourceWavUrl(wavUrl);
    setRange({ start: 0, end: track.durationSec });
    setKept(false);
    onLibraryChanged?.();
  };

  const handleNewLinkImportLocal = async (path: string) => {
    newLink(sync.stopAll);
    setSourceWavUrl(null);
    setUseQuickEq(false);
    await handleImportLocal(path);
  };

  const handleToggleKept = async () => {
    if (!engine.track) return;
    const next = !kept;
    setKept(next);
    await backend.setKept(engine.track.id, next);
    onLibraryChanged?.();
  };

  const handleCut = async () => {
    if (!engine.track) return;
    await trimLoop(engine.track.id, range.start, range.end);
  };

  const handleInstallEngine = async () => {
    setInstalling(true);
    try {
      const status = await backend.engineInstall();
      setEngineStatus(status);
    } finally {
      setInstalling(false);
    }
  };

  const handleSplit = async () => {
    if (!engine.track) return;
    setPassStates(Object.fromEntries(PASS_DEFS.map((p) => [p.pass, "pending" as PassState])));
    setPassReasons({});
    await separateInstruments(engine.track.id);
    setSplitSuccess(true);
    onLibraryChanged?.();
    setTimeout(() => setSplitSuccess(false), 1500);
  };

  const handleKaraoke = async () => {
    if (!engine.track) return;
    setKaraokeRunning(true);
    setKaraokePassStates(Object.fromEntries(KARAOKE_PASS_DEFS.filter((p) => splitLeadBacking || p.pass !== "lead").map((p) => [p.pass, "pending" as PassState])));
    setKaraokePassReasons({});
    try {
      await separateKaraoke(engine.track.id, splitLeadBacking);
      setKaraokeSuccess(true);
      onLibraryChanged?.();
      setTimeout(() => setKaraokeSuccess(false), 1500);
    } finally {
      setKaraokeRunning(false);
    }
  };

  const handleQuickEq = async () => {
    if (!engine.track) return;
    setUseQuickEq(true);
    await separateStems(engine.track.id);
    setSplitSuccess(true);
    onLibraryChanged?.();
    setTimeout(() => setSplitSuccess(false), 1500);
  };

  const isFetching = engine.state === "fetching";
  const isTrimming = engine.state === "trimming";
  const isSeparating = engine.state === "separating";
  const isBusy = isFetching || isTrimming || isSeparating;
  const splitEnabled = !!engineStatus?.installed && !isBusy;

  if (!engine.track) {
    return (
      <div className="flex flex-col gap-6 px-6 py-16 w-full">
        <SourcePicker
          onImportLocal={handleImportLocal}
          url={url}
          onUrlChange={setUrl}
          onFetch={handleFetch}
          busy={isFetching}
        />
        {engine.progress && (
          <div className="max-w-2xl mx-auto w-full flex flex-col gap-1">
            <div className="h-2 rounded-full neu-surface-inset overflow-hidden">
              <div className="h-full bg-accent transition-all duration-200" style={{ width: `${engine.progress.percent}%` }} />
            </div>
            <span className="text-xs text-muted">{engine.progress.message}</span>
          </div>
        )}
        {engine.error && <span className="text-xs text-danger text-center">{engine.error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-6 py-4 max-w-5xl mx-auto w-full">
      <Surface variant="raised" className="p-4 flex flex-col gap-3">
        <SourcePicker
          onImportLocal={handleNewLinkImportLocal}
          url={url}
          onUrlChange={setUrl}
          onFetch={handleNewLinkFetch}
          busy={isFetching}
          compact
        />
        <p className="text-[11px] text-muted">
          This song is a scan. Press Keep to hold it, or save the tracks you want as samples. Older scans are removed as you fetch new links.
        </p>
        {engine.progress && (
          <div className="flex flex-col gap-1">
            <div className="h-2 rounded-full neu-surface-inset overflow-hidden">
              <div className="h-full bg-accent transition-all duration-200" style={{ width: `${engine.progress.percent}%` }} />
            </div>
            <span className="text-xs text-muted">{engine.progress.message}</span>
          </div>
        )}
        {engine.error && <span className="text-xs text-danger">{engine.error}</span>}
      </Surface>

      <div className="flex items-center gap-2 -mt-2">
        <h3 className="text-sm font-medium truncate flex-1 min-w-0">{engine.track.title}</h3>
        {engine.track.sourceKind && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted bg-surface neu-surface-inset rounded-md px-1.5 py-0.5">
            {SOURCE_KIND_LABEL[engine.track.sourceKind] ?? engine.track.sourceKind}
          </span>
        )}
        <button
          type="button"
          aria-pressed={kept}
          title="Kept songs are never auto-removed"
          onClick={handleToggleKept}
          className={clsx(
            "shrink-0 rounded-lg p-1.5 transition-colors flex items-center gap-1 text-xs",
            kept ? "text-stem-bass" : "text-muted hover:text-text"
          )}
        >
          <Bookmark size={16} fill={kept ? "currentColor" : "none"} />
          Keep
        </button>
      </div>

      {sourceWavUrl && engine.track && !engine.loop && (
        <div className="flex flex-col gap-3" id="step-source">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">1. Source</h2>
          <RegionSelector
            key={engine.track.id}
            wavUrl={sourceWavUrl}
            initialStart={range.start}
            initialEnd={range.end}
            durationSec={engine.track.durationSec}
            peaks={engine.track.peaks}
            bpm={engine.analysis?.bpm ?? null}
            onChange={(start, end) => setRange({ start, end })}
          />
          <div className="flex justify-end">
            <Button variant="primary" busy={isTrimming} busyLabel="Cutting" onClick={handleCut} disabled={isBusy}>
              Cut selection
            </Button>
          </div>
        </div>
      )}

      {engine.loop && (
        <div className="flex flex-col gap-3" id="step-loop">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">2. Loop</h2>
          <LoopPreview
            key={engine.track.id}
            wavPath={engine.loop.wavPath}
            startSec={engine.loop.startSec}
            endSec={engine.loop.endSec}
            peaks={engine.loop.peaks}
            onPlay={sync.stopAll}
            trackId={engine.track.id}
            songTitle={engine.track.title}
            samples={samples}
            onSampleSaved={() => onSampleSaved?.()}
          />

          {!engine.stems && !engine.instruments && (
            <EngineStatusCard status={engineStatus} installing={installing} onInstall={handleInstallEngine} />
          )}

          {isSeparating && !useQuickEq && !karaokeRunning && (
            <Surface variant="raised" className="p-4">
              <PassChecklist passStates={passStates} reasons={passReasons} />
            </Surface>
          )}

          {karaokeRunning && (
            <Surface variant="raised" className="p-4">
              <PassChecklist
                passStates={karaokePassStates}
                reasons={karaokePassReasons}
                defs={KARAOKE_PASS_DEFS.filter((p) => splitLeadBacking || p.pass !== "lead")}
              />
            </Surface>
          )}

          {!engine.stems && !engine.instruments && (
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                <Button variant="primary" busy={isSeparating && !useQuickEq && !karaokeRunning} busyLabel="Splitting" success={splitSuccess} onClick={handleSplit} disabled={!splitEnabled}>
                  Split
                </Button>
                {!engine.karaoke && (
                  <Button busy={karaokeRunning} busyLabel="Splitting" success={karaokeSuccess} onClick={handleKaraoke} disabled={!splitEnabled}>
                    Karaoke
                  </Button>
                )}
              </div>
              <button type="button" onClick={handleQuickEq} className="text-xs text-muted underline hover:text-text">
                Quick EQ bands instead
              </button>
              {!engine.karaoke && (
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={splitLeadBacking}
                    onChange={(e) => setSplitLeadBacking(e.target.checked)}
                  />
                  Split lead &amp; backing
                </label>
              )}
            </div>
          )}
          {(engine.stems || engine.instruments) && !engine.karaoke && (
            <div className="flex flex-col items-end gap-2">
              <Button busy={karaokeRunning} busyLabel="Splitting" success={karaokeSuccess} onClick={handleKaraoke} disabled={!splitEnabled}>
                Karaoke
              </Button>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={splitLeadBacking}
                  onChange={(e) => setSplitLeadBacking(e.target.checked)}
                />
                Split lead &amp; backing
              </label>
            </div>
          )}
        </div>
      )}

      {engine.instruments && engine.track && (
        <div className="flex flex-col gap-3" id="step-stems">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">3. Instruments</h2>
          <InstrumentTrackList
            key={engine.track.id}
            trackId={engine.track.id}
            stems={engine.instruments}
            tracks={sync.tracks}
            currentTime={sync.currentTime}
            mode={sync.mode}
            auditionId={sync.auditionId}
            onUpsertTrack={sync.upsertTrack}
            onRegisterInstance={sync.registerInstance}
            onUnregisterInstance={sync.unregisterInstance}
            onTimeUpdate={sync.handleTimeUpdate}
            onFinish={sync.handleFinish}
            onAudition={sync.auditionTrack}
            onSeek={sync.seek}
            onSaved={onLibraryChanged}
            songTitle={engine.track.title}
            loopStartSec={engine.loop?.startSec}
            loopEndSec={engine.loop?.endSec}
            samples={samples}
            onSampleSaved={onSampleSaved}
          />
        </div>
      )}

      {engine.stems && engine.track && (
        <div className="flex flex-col gap-3" id="step-stems-eq">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">3. Quick EQ bands</h2>
          <StemGroup
            key={engine.track.id}
            trackId={engine.track.id}
            stems={engine.stems}
            tracks={sync.tracks}
            currentTime={sync.currentTime}
            mode={sync.mode}
            auditionId={sync.auditionId}
            analysis={engine.analysis}
            onUpsertTrack={sync.upsertTrack}
            onRegisterInstance={sync.registerInstance}
            onUnregisterInstance={sync.unregisterInstance}
            onTimeUpdate={sync.handleTimeUpdate}
            onFinish={sync.handleFinish}
            onAudition={sync.auditionTrack}
            onSeek={sync.seek}
            onSaved={onLibraryChanged}
            songTitle={engine.track.title}
            loopStartSec={engine.loop?.startSec}
            loopEndSec={engine.loop?.endSec}
            samples={samples}
            onSampleSaved={onSampleSaved}
          />
        </div>
      )}

      {engine.karaoke && engine.track && (
        <div className="flex flex-col gap-3" id="step-karaoke">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Karaoke</h2>
          <InstrumentTrackList
            key={`${engine.track.id}:karaoke`}
            trackId={engine.track.id}
            stems={engine.karaoke}
            tracks={sync.tracks}
            currentTime={sync.currentTime}
            mode={sync.mode}
            auditionId={sync.auditionId}
            onUpsertTrack={sync.upsertTrack}
            onRegisterInstance={sync.registerInstance}
            onUnregisterInstance={sync.unregisterInstance}
            onTimeUpdate={sync.handleTimeUpdate}
            onFinish={sync.handleFinish}
            onAudition={sync.auditionTrack}
            onSeek={sync.seek}
            onSaved={onLibraryChanged}
            songTitle={engine.track.title}
            loopStartSec={engine.loop?.startSec}
            loopEndSec={engine.loop?.endSec}
            samples={samples}
            onSampleSaved={onSampleSaved}
          />
        </div>
      )}
    </div>
  );
}
