import { useEffect, useMemo, useRef, useState } from "react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { backend } from "@/lib/backend";
import { groupInstruments } from "@/lib/instruments";
import { camelotFor } from "@/lib/notesTheory";
import { buildSpectrumPaths } from "@/lib/spectrumPath";
import type { FrequencyResult, InstrumentStem, Sample, TrackInfo } from "@/lib/types";

export interface FrequenciesTabProps {
  track: TrackInfo | null;
  instruments?: InstrumentStem[] | null;
  analysis: FrequencyResult | null;
  samples?: Sample[];
}

interface SourceOption {
  key: string;
  label: string;
  path: string;
  group: string;
}

const BAND_BLURBS: Record<string, string> = {
  sub: "The deep rumble you feel more than hear.",
  bass: "The low punch of bass and kick.",
  lowMid: "Warmth and body.",
  mid: "Where most instruments and vocals sit.",
  highMid: "Attack and clarity.",
  presence: "Crispness and detail.",
  air: "The sparkle at the very top.",
};

const CHART_WIDTH = 720;
const CHART_HEIGHT = 220;
const GRID_HZ = [100, 1000, 10000];
const GRID_DB = [0, -20, -40, -60, -80, -100, -120];

function buildSourceOptions(instruments: InstrumentStem[] | null | undefined, samples: Sample[]): SourceOption[] {
  const options: SourceOption[] = [];
  if (instruments && instruments.length > 0) {
    for (const node of groupInstruments(instruments)) {
      options.push({ key: node.stem.key, label: node.stem.displayLabel ?? node.stem.label, path: node.stem.path, group: "Instrument stems" });
      for (const child of node.children) {
        options.push({ key: child.key, label: `${node.stem.displayLabel ?? node.stem.label}  /  ${child.label}`, path: child.path, group: "Instrument stems" });
      }
    }
  }
  for (const sample of samples) {
    options.push({ key: sample.id, label: sample.name, path: sample.path, group: "Saved samples" });
  }
  return options;
}

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function tuningColor(absCents: number): string {
  if (absCents <= 5) return "text-ok";
  if (absCents <= 15) return "text-accent";
  return "text-danger";
}

export function FrequenciesTab({ track, instruments, analysis, samples = [] }: FrequenciesTabProps) {
  const sources = useMemo(() => buildSourceOptions(instruments, samples), [instruments, samples]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [result, setResult] = useState<FrequencyResult | null>(analysis ?? null);
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    if (sources.length > 0 && !sources.some((s) => s.path === selectedPath)) {
      setSelectedPath(sources[0].path);
    }
    if (sources.length === 0) setSelectedPath("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  useEffect(() => {
    if (!loading || startedAt === null) return;
    tickRef.current = window.setInterval(() => {
      setElapsedSec((Date.now() - startedAt) / 1000);
    }, 100);
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, [loading, startedAt]);

  const selectedSource = sources.find((s) => s.path === selectedPath) ?? null;

  const handleAnalyze = async () => {
    if (!selectedSource) return;
    const start = Date.now();
    setStartedAt(start);
    setElapsedSec(0);
    setLoading(true);
    try {
      const freq = await backend.analyzeFrequencies({ path: selectedSource.path });
      setResult(freq);
      setElapsedSec((Date.now() - start) / 1000);
    } finally {
      setLoading(false);
    }
  };

  const { linePath, areaPath } = useMemo(
    () => buildSpectrumPaths(result?.spectrum ?? [], CHART_WIDTH, CHART_HEIGHT),
    [result]
  );

  const camelot = result?.key ? camelotFor(result.key.tonic, result.key.mode) : null;

  const tuning = result?.tuning ?? null;
  const absCents = tuning ? Math.abs(tuning.avgCentsOff) : 0;
  const refDiff = tuning ? tuning.estimatedRefHz - 440 : 0;
  const refNote =
    tuning && refDiff !== 0 ? `a touch ${refDiff > 0 ? "sharp" : "flat"} of the 440 standard` : null;

  return (
    <div className="flex flex-col gap-6 px-6 py-4 max-w-5xl mx-auto w-full">
      {sources.length === 0 ? (
        <Surface variant="raised" className="p-6 text-center text-sm text-muted">
          Split a song or save a sample, then pick a source to see its frequencies.
        </Surface>
      ) : (
        <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-3">
          <select
            value={selectedPath}
            onChange={(e) => setSelectedPath(e.target.value)}
            className="bg-surface neu-surface-inset rounded-lg px-3 py-2 text-sm text-text min-w-[220px]"
            aria-label="Source"
          >
            {Object.entries(
              sources.reduce<Record<string, SourceOption[]>>((acc, s) => {
                (acc[s.group] ??= []).push(s);
                return acc;
              }, {})
            ).map(([group, opts]) => (
              <optgroup key={group} label={group}>
                {opts.map((opt) => (
                  <option key={opt.key + opt.path} value={opt.path}>
                    {opt.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Button variant="primary" onClick={handleAnalyze} disabled={!track || !selectedSource || loading} busy={loading}>
            Analyze
          </Button>
          {loading && <span className="text-xs text-muted tabular-nums">{formatMmSs(elapsedSec)}</span>}
          {!loading && result && elapsedSec > 0 && (
            <span className="text-xs text-muted">Read in {elapsedSec.toFixed(1)} s</span>
          )}
        </Surface>
      )}

      {!result ? (
        <Surface variant="raised" className="p-6 text-center text-sm text-muted">
          Pick a stem or sample, then Analyze to see its frequencies and tuning.
        </Surface>
      ) : (
        <>
          <Surface variant="raised" className="p-4 flex flex-col gap-2">
            <div className="text-xs text-muted uppercase tracking-wide">Spectrum</div>
            <div className="overflow-x-auto">
              <svg
                data-testid="spectrum-chart"
                width={CHART_WIDTH + 40}
                height={CHART_HEIGHT + 20}
                viewBox={`0 0 ${CHART_WIDTH + 40} ${CHART_HEIGHT + 20}`}
              >
                <g transform="translate(40, 0)">
                  {GRID_DB.map((db) => (
                    <line
                      key={`db-${db}`}
                      x1={0}
                      x2={CHART_WIDTH}
                      y1={(1 - (db - -120) / 120) * CHART_HEIGHT}
                      y2={(1 - (db - -120) / 120) * CHART_HEIGHT}
                      stroke="rgba(255,255,255,0.06)"
                    />
                  ))}
                  {GRID_HZ.map((hz) => {
                    const x = (Math.log(hz / 20) / Math.log(20000 / 20)) * CHART_WIDTH;
                    return (
                      <line
                        key={`hz-${hz}`}
                        x1={x}
                        x2={x}
                        y1={0}
                        y2={CHART_HEIGHT}
                        stroke="rgba(255,255,255,0.06)"
                      />
                    );
                  })}
                  {areaPath && <path d={areaPath} fill="#F2B33D" opacity={0.18} />}
                  {linePath && <path d={linePath} fill="none" stroke="#F2B33D" strokeWidth={1.5} />}
                </g>
                {GRID_HZ.map((hz) => {
                  const x = 40 + (Math.log(hz / 20) / Math.log(20000 / 20)) * CHART_WIDTH;
                  const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
                  return (
                    <text key={`hzl-${hz}`} x={x} y={CHART_HEIGHT + 14} fontSize={10} textAnchor="middle" fill="currentColor" className="text-muted">
                      {label}
                    </text>
                  );
                })}
                {GRID_DB.map((db) => (
                  <text
                    key={`dbl-${db}`}
                    x={2}
                    y={(1 - (db - -120) / 120) * CHART_HEIGHT + 3}
                    fontSize={10}
                    fill="currentColor"
                    className="text-muted"
                  >
                    {db}
                  </text>
                ))}
              </svg>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 flex flex-col gap-2">
            <div className="text-xs text-muted uppercase tracking-wide">Bands</div>
            <div className="flex flex-col gap-1.5">
              {result.bands.map((band) => (
                <div key={band.key} className="flex items-center gap-3">
                  <div className="flex items-center gap-1 w-24 text-xs text-text">
                    {band.name}
                    <InfoTip term={band.name} text={BAND_BLURBS[band.key] ?? ""} />
                  </div>
                  <div className="flex-1 h-2.5 rounded-full neu-surface-inset overflow-hidden">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${Math.max(0, Math.min(100, band.sharePct))}%` }}
                    />
                  </div>
                  <div className="w-14 text-right text-xs text-muted tabular-nums">{band.db.toFixed(1)} dB</div>
                </div>
              ))}
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 flex flex-col gap-3">
            <div className="text-xs text-muted uppercase tracking-wide flex items-center gap-1.5">
              Tuning
              <InfoTip term="cents" text="100 cents is one semitone; 0 means perfectly in tune." />
            </div>
            {tuning && (
              <>
                <div className="flex flex-wrap items-baseline gap-6">
                  <div>
                    <div className={`text-4xl font-bold tabular-nums ${tuningColor(absCents)}`}>
                      {tuning.avgCentsOff > 0 ? "+" : ""}
                      {tuning.avgCentsOff.toFixed(0)}
                    </div>
                    <div className="text-xs text-muted mt-1">avg cents off</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{Math.round(tuning.inTunePct * 100)}%</div>
                    <div className="text-xs text-muted mt-1">In tune</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 text-sm text-text">
                      Sits closest to A={tuning.estimatedRefHz} Hz
                      <InfoTip term="reference" text="The A note most instruments tune to, normally 440 Hz." />
                    </div>
                    {refNote && <div className="text-xs text-muted mt-1">{refNote}</div>}
                  </div>
                  {result.key && (
                    <div>
                      <div className="text-sm text-text">
                        {result.key.tonic} {result.key.mode}
                      </div>
                      {camelot && <div className="text-xs text-muted mt-1">Camelot {camelot}</div>}
                    </div>
                  )}
                </div>
                <div className="text-xs text-muted">
                  0 cents is perfectly in tune. Even a few cents off is audible on long notes.
                </div>
              </>
            )}
          </Surface>
        </>
      )}
    </div>
  );
}
