import { useEffect, useMemo, useState } from "react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Slider } from "@/components/neumorphic/Slider";
import { backend } from "@/lib/backend";
import { isTauri, mediaUrl } from "@/lib/mediaUrl";
import { samplePlayer, type SamplePlayerState } from "@/lib/samplePlayer";
import {
  buildEditableNotes,
  buildScalePitchClasses,
  computeAutotuneLayout,
  isBlackKey,
  midiToNoteName,
  resetEditableNotes,
  setNoteTarget,
  snapYToMidi,
  toAutotuneNoteEdits,
  tuneNotesToScale,
  tuningBucket,
  type EditableNote,
  type ScaleName,
} from "@/lib/autotuneEditor";
import type { AutotuneEdits, AutotuneResult, InstrumentStem, PitchResult, Sample, TrackInfo } from "@/lib/types";

export interface AutotuneTabProps {
  track: TrackInfo | null;
  instruments: InstrumentStem[] | null;
  samples: Sample[];
}

interface SourceOption {
  key: string;
  label: string;
  path: string;
  group: string;
}

const VOCAL_KEYS = new Set(["vocals", "lead_vocals", "backing_vocals"]);

function buildSourceOptions(instruments: InstrumentStem[] | null | undefined, samples: Sample[]): SourceOption[] {
  const options: SourceOption[] = [];
  const stems = instruments ?? [];
  // Vocal-ish stems first, then any other instrument stems (allowed, just listed after).
  const vocal = stems.filter((s) => VOCAL_KEYS.has(s.key));
  const other = stems.filter((s) => !VOCAL_KEYS.has(s.key));
  for (const stem of [...vocal, ...other]) {
    options.push({ key: stem.key, label: stem.displayLabel ?? stem.label, path: stem.path, group: "Instrument stems" });
  }
  for (const sample of samples) {
    options.push({ key: sample.id, label: sample.name, path: sample.path, group: "Saved samples" });
  }
  return options;
}

const TONICS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TONIC_PC: Record<string, number> = TONICS.reduce((acc, name, i) => ({ ...acc, [name]: i }), {});

function tuningColor(cents: number): string {
  switch (tuningBucket(cents)) {
    case "in-tune":
      return "#3DDC97";
    case "close":
      return "#F2B33D";
    default:
      return "#E85D5D";
  }
}

/** Builds an SVG path for a polyline through voiced f0 points, breaking the line across unvoiced gaps. */
function f0PolylinePaths(
  f0: PitchResult["f0"],
  xForSec: (sec: number) => number,
  yForMidi: (midi: number) => number,
  xOffset: number
): string[] {
  const paths: string[] = [];
  let current: string[] = [];
  for (const p of f0) {
    if (!p.voiced) {
      if (current.length > 1) paths.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${current.length === 0 ? "M" : "L"}${xOffset + xForSec(p.t)},${yForMidi(p.midi)}`);
  }
  if (current.length > 1) paths.push(current.join(" "));
  return paths;
}

/** Standalone Melodyne/Auto-Tune-style graphical pitch editor: analyze a vocal source, drag notes onto pitch, apply. */
export function AutotuneTab({ track: _track, instruments, samples = [] }: AutotuneTabProps) {
  const sources = useMemo(() => buildSourceOptions(instruments, samples), [instruments, samples]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [pitch, setPitch] = useState<PitchResult | null>(null);
  const [analyzedPath, setAnalyzedPath] = useState<string | null>(null);
  const [notes, setNotes] = useState<EditableNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const [snapStrength, setSnapStrength] = useState(70);
  const [scaleName, setScaleName] = useState<ScaleName>("chromatic");
  const [tonic, setTonic] = useState("C");
  const [transitionMs, setTransitionMs] = useState(40);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragMidi, setDragMidi] = useState<number | null>(null);

  const [applying, setApplying] = useState(false);
  const [tuned, setTuned] = useState<AutotuneResult | null>(null);
  const [comparing, setComparing] = useState<"original" | "tuned">("original");

  const [playerState, setPlayerState] = useState<SamplePlayerState>(() => samplePlayer.getState());

  useEffect(() => {
    if (sources.length > 0 && !sources.some((s) => s.path === selectedPath)) {
      setSelectedPath(sources[0].path);
    }
    if (sources.length === 0) setSelectedPath("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  useEffect(() => samplePlayer.subscribe(setPlayerState), []);

  useEffect(() => {
    return () => {
      if (samplePlayer.isPlaying("autotune-original") || samplePlayer.isPlaying("autotune-tuned")) samplePlayer.stop();
    };
  }, []);

  useEffect(() => {
    if (!loading || startedAt === null) return;
    const id = window.setInterval(() => setElapsedSec((Date.now() - startedAt) / 1000), 100);
    return () => window.clearInterval(id);
  }, [loading, startedAt]);

  const selectedSource = sources.find((s) => s.path === selectedPath) ?? null;

  const handleAnalyze = async () => {
    if (!selectedSource) return;
    if (samplePlayer.isPlaying("autotune-original") || samplePlayer.isPlaying("autotune-tuned")) samplePlayer.stop();
    const start = Date.now();
    setStartedAt(start);
    setElapsedSec(0);
    setLoading(true);
    setTuned(null);
    try {
      const result = await backend.analyzePitch({ path: selectedSource.path });
      setPitch(result);
      setAnalyzedPath(selectedSource.path);
      setNotes(buildEditableNotes(result.notes));
      if (result.key) {
        setTonic(result.key.tonic);
        setScaleName(result.key.mode === "minor" ? "minor" : "major");
      }
      setElapsedSec((Date.now() - start) / 1000);
    } finally {
      setLoading(false);
    }
  };

  const layout = useMemo(() => computeAutotuneLayout(notes, pitch?.f0 ?? []), [notes, pitch]);
  const scalePcs = useMemo(
    () => buildScalePitchClasses(scaleName, TONIC_PC[tonic] ?? 0),
    [scaleName, tonic]
  );

  const rows: number[] = [];
  for (let m = layout.maxMidi; m >= layout.minMidi; m--) rows.push(m);

  const f0Paths = useMemo(
    () => (pitch ? f0PolylinePaths(pitch.f0, layout.xForSec, layout.yForMidi, 40) : []),
    [pitch, layout]
  );

  const handleReset = () => setNotes((prev) => resetEditableNotes(prev));

  const handleTuneToScale = () => setNotes((prev) => tuneNotesToScale(prev, scalePcs));

  const handleNotePointerDown = (index: number) => (e: React.PointerEvent<SVGRectElement>) => {
    e.stopPropagation();
    (e.target as SVGRectElement).setPointerCapture(e.pointerId);
    setDragIndex(index);
    setDragMidi(notes[index].targetMidi);
  };

  const handleNotePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragIndex === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const midi = snapYToMidi(y, layout);
    setDragMidi(midi);
    setNotes((prev) => setNoteTarget(prev, dragIndex, midi));
  };

  const handleNotePointerUp = () => {
    setDragIndex(null);
    setDragMidi(null);
  };

  const edits: AutotuneEdits = useMemo(
    () => ({
      snapStrength: snapStrength / 100,
      scale: scalePcs,
      transitionMs,
      notes: toAutotuneNoteEdits(notes),
    }),
    [snapStrength, scalePcs, transitionMs, notes]
  );

  const handleApply = async () => {
    if (!analyzedPath) return;
    setApplying(true);
    try {
      const result = await backend.applyAutotune({ path: analyzedPath, edits });
      setTuned(result);
      setComparing("tuned");
    } finally {
      setApplying(false);
    }
  };

  const handlePlayOriginal = () => {
    if (!analyzedPath) return;
    setComparing("original");
    if (samplePlayer.isPlaying("autotune-original")) {
      samplePlayer.stop();
      return;
    }
    samplePlayer.playPath("autotune-original", mediaUrl(analyzedPath), { kind: "sample", label: "Autotune original" });
  };

  const handlePlayTuned = () => {
    if (!tuned) return;
    setComparing("tuned");
    if (samplePlayer.isPlaying("autotune-tuned")) {
      samplePlayer.stop();
      return;
    }
    samplePlayer.playPath("autotune-tuned", mediaUrl(tuned.path), { kind: "sample", label: "Autotune tuned" });
  };

  const handleSaveAsSample = async () => {
    if (!tuned) return;
    const basename = tuned.path.split(/[\\/]/).pop() ?? "tuned.wav";
    if (isTauri()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destPath = await save({ defaultPath: basename, filters: [{ name: "WAV", extensions: ["wav"] }] });
      if (!destPath) return;
      await backend.saveStem({ srcPath: tuned.path, destPath });
    } else {
      await backend.saveStem({ srcPath: tuned.path, destPath: basename });
    }
  };

  const handleDownload = async () => {
    if (!tuned) return;
    const basename = tuned.path.split(/[\\/]/).pop() ?? "tuned.wav";
    if (isTauri()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destPath = await save({ defaultPath: basename, filters: [{ name: "WAV", extensions: ["wav"] }] });
      if (!destPath) return;
      await backend.saveStem({ srcPath: tuned.path, destPath });
    } else {
      await backend.saveStem({ srcPath: tuned.path, destPath: basename });
    }
  };

  const isPlayingOriginal = playerState.id === "autotune-original";
  const isPlayingTuned = playerState.id === "autotune-tuned";

  return (
    <div className="flex flex-col gap-6 px-6 py-4 max-w-5xl mx-auto w-full">
      {sources.length === 0 ? (
        <Surface variant="raised" className="p-6 text-center text-sm text-muted">
          Pick a vocal stem or sample, then Analyze to tune it.
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
          <Button variant="primary" onClick={handleAnalyze} disabled={!selectedSource || loading} busy={loading}>
            Analyze
          </Button>
          {loading && <span className="text-xs text-muted tabular-nums">{elapsedSec.toFixed(1)} s</span>}
          {!loading && pitch && elapsedSec > 0 && (
            <span className="text-xs text-muted">Analyzed in {elapsedSec.toFixed(1)} s</span>
          )}
        </Surface>
      )}

      {!pitch && sources.length > 0 && (
        <Surface variant="raised" className="p-6 text-center text-sm text-muted">
          Pick a vocal stem or sample, then Analyze to tune it.
        </Surface>
      )}

      {pitch && (
        <>
          <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-6">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs text-muted uppercase tracking-wide">
                Snap strength
                <InfoTip
                  term="Snap strength"
                  text="How strongly notes are pulled to their target pitch. Natural keeps some human wobble; Full is classic hard autotune."
                />
              </div>
              <div className="flex items-center gap-2">
                <Slider
                  value={snapStrength}
                  min={0}
                  max={100}
                  step={1}
                  orientation="horizontal"
                  onChange={setSnapStrength}
                  label="Snap strength"
                  className="w-40"
                />
                <span className="text-xs text-muted w-24 tabular-nums">
                  {snapStrength === 0 ? "Natural" : snapStrength === 100 ? "Full" : `${snapStrength}%`}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-xs text-muted uppercase tracking-wide">Scale</div>
              <div className="flex items-center gap-2">
                <select
                  value={scaleName}
                  onChange={(e) => setScaleName(e.target.value as ScaleName)}
                  className="bg-surface neu-surface-inset rounded-lg px-2 py-1.5 text-sm text-text"
                  aria-label="Scale"
                >
                  <option value="chromatic">Chromatic</option>
                  <option value="major">Major</option>
                  <option value="minor">Minor</option>
                </select>
                <select
                  value={tonic}
                  onChange={(e) => setTonic(e.target.value)}
                  disabled={scaleName === "chromatic"}
                  className="bg-surface neu-surface-inset rounded-lg px-2 py-1.5 text-sm text-text disabled:opacity-40"
                  aria-label="Tonic"
                >
                  {TONICS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs text-muted uppercase tracking-wide">
                Transition
                <InfoTip term="Transition" text="How many milliseconds a pitch shift is smoothed over, to avoid a stepped, robotic sound." />
              </div>
              <div className="flex items-center gap-2">
                <Slider
                  value={transitionMs}
                  min={0}
                  max={200}
                  step={5}
                  orientation="horizontal"
                  onChange={setTransitionMs}
                  label="Transition ms"
                  className="w-32"
                />
                <span className="text-xs text-muted w-16 tabular-nums">{transitionMs} ms</span>
              </div>
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <Button onClick={handleTuneToScale} disabled={scaleName === "chromatic"}>
                Tune to scale
              </Button>
              <Button onClick={handleReset}>Reset</Button>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 flex flex-col gap-2">
            <div className="text-xs text-muted uppercase tracking-wide">Pitch editor</div>
            <div className="overflow-x-auto">
              <svg
                data-testid="autotune-editor"
                width={layout.width + 40}
                height={layout.height}
                viewBox={`0 0 ${layout.width + 40} ${layout.height}`}
                onPointerMove={handleNotePointerMove}
                onPointerUp={handleNotePointerUp}
              >
                {rows.map((midi) => {
                  const inScale = scalePcs ? scalePcs.includes(((midi % 12) + 12) % 12) : false;
                  return (
                    <g key={midi}>
                      <rect
                        x={0}
                        y={layout.yForMidi(midi)}
                        width={layout.width + 40}
                        height={layout.rowHeight}
                        fill={inScale ? "rgba(61,220,151,0.08)" : isBlackKey(midi) ? "rgba(255,255,255,0.04)" : "transparent"}
                      />
                      <text
                        x={2}
                        y={layout.yForMidi(midi) + layout.rowHeight - 2}
                        fontSize={layout.rowHeight - 3}
                        fill="rgba(255,255,255,0.35)"
                      >
                        {midi % 12 === 0 ? midiToNoteName(midi) : ""}
                      </text>
                    </g>
                  );
                })}
                {Array.from({ length: Math.ceil(layout.durationSec) + 1 }, (_, s) => s).map((s) => (
                  <line
                    key={`ruler-${s}`}
                    x1={40 + layout.xForSec(s)}
                    x2={40 + layout.xForSec(s)}
                    y1={0}
                    y2={layout.height}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth={1}
                  />
                ))}
                {f0Paths.map((d, i) => (
                  <path key={`f0-${i}`} d={d} fill="none" stroke="#59D9E6" strokeWidth={1} opacity={0.8} />
                ))}
                {notes.map((n, i) => {
                  const isDragging = dragIndex === i;
                  const midi = isDragging && dragMidi !== null ? dragMidi : n.targetMidi;
                  return (
                    <g key={i}>
                      <rect
                        x={40 + layout.xForSec(n.startSec)}
                        y={layout.yForMidi(midi) + 1}
                        width={Math.max(4, layout.xForSec(n.endSec) - layout.xForSec(n.startSec))}
                        height={layout.rowHeight - 2}
                        rx={3}
                        fill={tuningColor(n.cents)}
                        opacity={isDragging ? 0.9 : 0.75}
                        stroke={isDragging ? "#ffffff" : "none"}
                        strokeWidth={isDragging ? 1 : 0}
                        className="cursor-grab"
                        onPointerDown={handleNotePointerDown(i)}
                      >
                        <title>{`${midiToNoteName(Math.round(n.midi))} (${n.cents > 0 ? "+" : ""}${n.cents} cents) -> ${midiToNoteName(midi)}`}</title>
                      </rect>
                      {isDragging && (
                        <text
                          x={40 + layout.xForSec(n.startSec)}
                          y={layout.yForMidi(midi) - 3}
                          fontSize={10}
                          fill="#ffffff"
                        >
                          {midiToNoteName(midi)} ({midi - Math.round(n.midi) >= 0 ? "+" : ""}
                          {midi - Math.round(n.midi)} st)
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-4">
            <div className="text-xs text-muted uppercase tracking-wide w-full">Compare</div>
            <PlayPauseButton
              playing={isPlayingOriginal}
              onToggle={handlePlayOriginal}
              label="original"
              tone="cyan"
              disabled={!analyzedPath}
            />
            <span className="text-xs text-muted">Original</span>
            <PlayPauseButton
              playing={isPlayingTuned}
              onToggle={handlePlayTuned}
              label="tuned"
              tone="accent"
              disabled={!tuned}
            />
            <span className="text-xs text-muted">Tuned{comparing === "tuned" ? " (selected)" : ""}</span>

            <div className="flex items-center gap-2 ml-auto">
              <Button variant="primary" onClick={handleApply} busy={applying} disabled={!analyzedPath || applying}>
                Apply
              </Button>
              <Button onClick={handleSaveAsSample} disabled={!tuned}>
                Save as sample
              </Button>
              <Button onClick={handleDownload} disabled={!tuned}>
                Download
              </Button>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 text-sm leading-relaxed text-text">
            <div className="text-xs text-muted uppercase tracking-wide mb-2">In plain words</div>
            Drag a note up or down onto its line to tune it. Green means it is already in tune (0 cents). Snap
            strength sets how strongly it corrects; Full is classic autotune, lower keeps it natural.
          </Surface>
        </>
      )}
    </div>
  );
}
