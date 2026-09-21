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

/** Compact waveform of the copy-trimmed loop with its own play/stop transport. */
function LoopPreview({ wavPath, startSec, endSec }: { wavPath: string; startSec: number; endSec: number }) {
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
        className="h-10 w-10 !p-0 flex items-center justify-center"
        aria-label={playing ? "Stop loop" : "Play loop"}
        onClick={() => {
          const ws = wsRef.current;
          if (!ws) return;
          if (playing) {
            ws.stop();
          } else {
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
  };

  const isBusy = engine.state === "fetching" || engine.state === "trimming" || engine.state === "separating";

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
          <Button variant="primary" onClick={handleFetch} disabled={isBusy || !url}>
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
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Source</h2>
          <RegionSelector
            wavUrl={sourceWavUrl}
            initialStart={range.start}
            initialEnd={range.end}
            onChange={(start, end) => setRange({ start, end })}
          />
          <div className="flex justify-end">
            <Button variant="primary" onClick={handleTrim} disabled={isBusy}>
              Trim Loop
            </Button>
          </div>
        </div>
      )}

      {engine.loop && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Loop</h2>
          <LoopPreview wavPath={engine.loop.wavPath} startSec={engine.loop.startSec} endSec={engine.loop.endSec} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={handleSplit} disabled={isBusy}>
              Split into 4 Stems
            </Button>
          </div>
        </div>
      )}

      {engine.stems && engine.track && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Stems</h2>
          <StemGroup
            trackId={engine.track.id}
            stems={engine.stems}
            tracks={sync.tracks}
            onUpsertTrack={sync.upsertTrack}
            onRegisterInstance={sync.registerInstance}
            onUnregisterInstance={sync.unregisterInstance}
            onTimeUpdate={sync.handleTimeUpdate}
            onFinish={sync.handleFinish}
          />
        </div>
      )}
    </div>
  );
}
