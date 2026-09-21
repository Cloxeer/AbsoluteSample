import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { backend } from "@/lib/backend";
import type { InstrumentStem, LoopAnalysis, Sample, SliceInfo, StemInfo, TrackInfo, LoopInfo } from "@/lib/types";
import { BeatMatrix } from "@/components/stems/BeatMatrix";
import { peaksOptions } from "@/lib/wavePeaks";

export interface InspectorTabProps {
  track: TrackInfo | null;
  loop: LoopInfo | null;
  stems: StemInfo[] | null;
  instruments?: InstrumentStem[] | null;
  analysis: LoopAnalysis | null;
  onAnalyze: () => Promise<LoopAnalysis>;
  samples?: Sample[];
  currentTime?: number;
  isPlaying?: boolean;
}

function OnsetPlot({ analysis }: { analysis: LoopAnalysis }) {
  const width = 800;
  const height = 120;
  const points = analysis.onsetEnvelope
    .map((v, i) => {
      const x = (i / Math.max(1, analysis.onsetEnvelope.length - 1)) * width;
      const y = height - v * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const durationSec = analysis.onsetEnvelope.length / 86;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-32">
      <polyline points={points} fill="none" stroke="#F25F5C" strokeWidth={1.5} />
      {analysis.beatGrid.map((t, i) => (
        <line
          key={`beat-${i}`}
          x1={(t / durationSec) * width}
          x2={(t / durationSec) * width}
          y1={0}
          y2={height}
          stroke="#4CC9F0"
          strokeOpacity={0.35}
          strokeWidth={1}
        />
      ))}
      {analysis.transients.map((t, i) => (
        <circle key={`t-${i}`} cx={(t / durationSec) * width} cy={8} r={2.5} fill="#FF6B6B" />
      ))}
    </svg>
  );
}

export function InspectorTab({ track, loop, stems: _stems, instruments, analysis, onAnalyze, samples = [], currentTime = 0, isPlaying = false }: InspectorTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [loopWavUrl, setLoopWavUrl] = useState<string | null>(null);
  const [divisions, setDivisions] = useState(16);
  const [slices, setSlices] = useState<SliceInfo[]>([]);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    if (!track || !loop) return;
    (async () => {
      const url = await backend.resolveWavUrl(loop.wavPath);
      setLoopWavUrl(url);
    })();
  }, [track, loop]);

  useEffect(() => {
    if (!containerRef.current || !loopWavUrl || !loop) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#F25F5C",
      progressColor: "#4CC9F0",
      cursorColor: "#4CC9F0",
      height: 80,
      cursorWidth: 0,
      url: loopWavUrl,
      ...peaksOptions(loop.peaks, loop.durationSec),
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopWavUrl]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      await onAnalyze();
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSliceBeats = async () => {
    if (!track || !analysis) return;
    const result = await backend.sliceBeats({ trackId: track.id, stemKey: null, bpm: analysis.bpm, divisions });
    setSlices(result);
  };

  return (
    <div className="flex flex-col gap-6 px-6 py-4 max-w-5xl mx-auto w-full">
      <Surface variant="raised" className="p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-xs text-muted uppercase tracking-wide">BPM</div>
            <div className="text-3xl font-bold text-accent tabular-nums">
              {analysis ? analysis.bpm.toFixed(1) : "--"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted uppercase tracking-wide">Confidence</div>
            <div className="w-32 h-2 rounded-full neu-surface-inset overflow-hidden mt-2">
              <div
                className="h-full bg-cyan"
                style={{ width: `${(analysis?.confidence ?? 0) * 100}%` }}
              />
            </div>
          </div>
          <div>
            <div className="text-xs text-muted uppercase tracking-wide">Bars</div>
            <div className="text-xl font-semibold tabular-nums">{analysis?.bars ?? "--"}</div>
          </div>
        </div>
        <Button variant="primary" onClick={handleAnalyze} disabled={!track || analyzing}>
          Analyze
        </Button>
      </Surface>

      {loopWavUrl && (
        <Surface variant="raised" className="p-4 flex flex-col gap-3">
          {analysis && <OnsetPlot analysis={analysis} />}
          <div ref={containerRef} data-testid="inspector-waveform" />
        </Surface>
      )}

      {analysis && (
        <Surface variant="raised" className="p-4 flex flex-col gap-2 overflow-x-auto">
          <BeatMatrix analysis={analysis} instruments={instruments ?? null} samples={samples} currentTime={currentTime} isPlaying={isPlaying} />
        </Surface>
      )}

      {analysis && (
        <Surface variant="raised" className="p-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="text-sm text-muted flex items-center gap-2">
              Divisions
              <input
                type="number"
                min={1}
                max={64}
                value={divisions}
                onChange={(e) => setDivisions(Number(e.target.value))}
                className="w-20 bg-surface neu-surface-inset rounded-lg px-2 py-1 text-text text-sm"
              />
            </label>
            <Button variant="primary" onClick={handleSliceBeats}>
              Slice to beats
            </Button>
          </div>
          {slices.length > 0 && (
            <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {slices.map((slice) => (
                <li key={slice.index} className="flex items-center justify-between text-xs text-muted px-2 py-1 neu-surface-inset rounded-lg">
                  <span>
                    Slice {slice.index + 1} ({slice.startSec.toFixed(2)}s - {slice.endSec.toFixed(2)}s)
                  </span>
                  <div className="flex gap-2">
                    <Button
                      className="!px-2 !py-1 text-[10px]"
                      onClick={() => wsRef.current?.play(slice.startSec, slice.endSec)}
                    >
                      Play
                    </Button>
                    <Button
                      className="!px-2 !py-1 text-[10px]"
                      onClick={async () => {
                        const url = await backend.resolveWavUrl(slice.path);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = slice.path.split(/[\\/]/).pop() ?? "slice.wav";
                        a.click();
                      }}
                    >
                      Download
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Surface>
      )}
    </div>
  );
}
