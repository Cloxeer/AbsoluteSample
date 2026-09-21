import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Play, Square } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { RegionSelector } from "@/components/waveform/RegionSelector";
import { StemGroup } from "@/components/stems/StemGroup";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useSyncPlayback } from "@/hooks/useSyncPlayback";
import { backend } from "@/lib/backend";
import { formatTime } from "@/lib/format";

const SEED_URL = "https://youtu.be/nRKgT3d6xoE";

/** Compact waveform of the copy-trimmed loop with its own play/stop transport (pauses the stem mix first). */
function LoopPreview({
  wavPath,
  startSec,
  endSec,
  onPlay,
}: {
  wavPath: string;
  startSec: number;
  endSec: number;
  onPlay: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

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
      waveColor: "#7C5CFF",
      progressColor: "#35D0FF",
      cursorColor: "#35D0FF",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
    });
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [url]);

  return (
    <Surface variant="inset" className="p-4 flex items-center gap-4">
      <Button
        variant="default"
        tone="accent"
        pressed={playing}
        className="h-10 w-10 !p-0 flex items-center justify-center"
        aria-label={playing ? "Stop loop" : "Play loop only"}
        onClick={() => {
          const ws = wsRef.current;
          if (!ws) return;
          if (playing) {
            ws.stop();
          } else {
            onPlay();
            void ws.play();
          }
        }}
      >
        {playing ? <Square size={16} /> : <Play size={16} />}
      </Button>
      <div className="flex-1 min-w-0" ref={containerRef} data-testid="loop-waveform" />
      <div className="font-mono text-xs text-muted whitespace-nowrap">
        {formatTime(startSec)} to {formatTime(endSec)}
      </div>
    </Surface>
  );
}

function HeroEmpty({ url, onUrlChange, onFetch, busy }: { url: string; onUrlChange: (v: string) => void; onFetch: () => void; busy: boolean }) {
  return (
    <Surface variant="raised" className="p-10 flex flex-col items-center gap-6 text-center max-w-2xl mx-auto w-full">
      <h1 className="text-2xl font-semibold">Paste a YouTube link to start</h1>
      <div className="flex gap-2 w-full max-w-md">
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="Paste a YouTube URL…"
          className="flex-1 bg-surface neu-surface-inset rounded-xl px-4 py-2 text-text text-sm outline-none"
        />
        <Button variant="primary" busy={busy} busyLabel="Fetching…" onClick={onFetch} disabled={!url}>
          Fetch
        </Button>
      </div>
      <div className="flex items-center gap-6 text-xs text-muted">
        <span className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-accent/20 text-accent flex items-center justify-center font-bold">
            1
          </span>
          Fetch source audio
        </span>
        <span className="text-muted/40">&rarr;</span>
        <span className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-accent/20 text-accent flex items-center justify-center font-bold">
            2
          </span>
          Cut a loop
        </span>
        <span className="text-muted/40">&rarr;</span>
        <span className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-accent/20 text-accent flex items-center justify-center font-bold">
            3
          </span>
          Split into 4 stems
        </span>
      </div>
    </Surface>
  );
}

export interface SlicerTabProps {
  engineApi?: ReturnType<typeof useAudioEngine>;
  /** Shared playback controller; App owns it so the header transport drives the stem tracks. */
  syncApi?: ReturnType<typeof useSyncPlayback>;
}

export function SlicerTab({ engineApi, syncApi }: SlicerTabProps = {}) {
  const ownEngine = useAudioEngine();
  const { engine, fetchAudio, trimLoop, separateStems } = engineApi ?? ownEngine;
  const ownSync = useSyncPlayback();
  const sync = syncApi ?? ownSync;
  const [url, setUrl] = useState(SEED_URL);
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 30, end: 45 });
  const [sourceWavUrl, setSourceWavUrl] = useState<string | null>(null);
  const [splitSuccess, setSplitSuccess] = useState(false);

  const handleFetch = async () => {
    const track = await fetchAudio(url);
    const wavUrl = await backend.resolveWavUrl(track.wavPath);
    setSourceWavUrl(wavUrl);
  };

  const handleTrim = async () => {
    if (!engine.track) return;
    await trimLoop(engine.track.id, range.start, range.end);
  };

  const handleSplit = async () => {
    if (!engine.track) return;
    await separateStems(engine.track.id);
    setSplitSuccess(true);
    setTimeout(() => setSplitSuccess(false), 1500);
  };

  const isFetching = engine.state === "fetching";
  const isTrimming = engine.state === "trimming";
  const isSeparating = engine.state === "separating";
  const isBusy = isFetching || isTrimming || isSeparating;

  if (!engine.track) {
    return (
      <div className="flex flex-col gap-6 px-6 py-16 w-full">
        <HeroEmpty url={url} onUrlChange={setUrl} onFetch={handleFetch} busy={isFetching} />
        {engine.progress && (
          <div className="max-w-2xl mx-auto w-full flex flex-col gap-1">
            <div className="h-2 rounded-full neu-surface-inset overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{ width: `${engine.progress.percent}%` }}
              />
            </div>
            <span className="text-xs text-muted">{engine.progress.message}</span>
          </div>
        )}
        {engine.error && <span className="text-xs text-stem-drums text-center">{engine.error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-6 py-4 max-w-5xl mx-auto w-full">
      <Surface variant="raised" className="p-4 flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a YouTube URL…"
            className="flex-1 bg-surface neu-surface-inset rounded-xl px-4 py-2 text-text text-sm outline-none"
          />
          <Button variant="primary" busy={isFetching} busyLabel="Fetching…" onClick={handleFetch} disabled={isBusy || !url}>
            Fetch
          </Button>
        </div>
        {engine.progress && (
          <div className="flex flex-col gap-1">
            <div className="h-2 rounded-full neu-surface-inset overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{ width: `${engine.progress.percent}%` }}
              />
            </div>
            <span className="text-xs text-muted">{engine.progress.message}</span>
          </div>
        )}
        {engine.error && <span className="text-xs text-stem-drums">{engine.error}</span>}
      </Surface>

      {sourceWavUrl && engine.track && (
        <div className="flex flex-col gap-3" id="step-source">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">1. Source</h2>
          <RegionSelector
            wavUrl={sourceWavUrl}
            initialStart={range.start}
            initialEnd={range.end}
            onChange={(start, end) => setRange({ start, end })}
          />
          <div className="flex justify-end">
            <Button variant="primary" busy={isTrimming} busyLabel="Cutting…" onClick={handleTrim} disabled={isBusy}>
              Cut {formatTime(range.start)} &rarr; {formatTime(range.end)}
            </Button>
          </div>
        </div>
      )}

      {engine.loop && (
        <div className="flex flex-col gap-3" id="step-loop">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">2. Loop</h2>
          <LoopPreview
            wavPath={engine.loop.wavPath}
            startSec={engine.loop.startSec}
            endSec={engine.loop.endSec}
            onPlay={sync.stopAll}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              busy={isSeparating}
              busyLabel="Splitting…"
              success={splitSuccess}
              onClick={handleSplit}
              disabled={isBusy}
            >
              Split into 4 stems
            </Button>
          </div>
        </div>
      )}

      {engine.stems && engine.track && (
        <div className="flex flex-col gap-3" id="step-stems">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">3. Stems</h2>
          <StemGroup
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
          />
        </div>
      )}
    </div>
  );
}
