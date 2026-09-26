import { useEffect, useMemo, useRef, useState } from "react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { backend } from "@/lib/backend";
import { groupInstruments } from "@/lib/instruments";
import { camelotFor, explainKey } from "@/lib/notesTheory";
import { computePianoRollLayout, isBlackKey } from "@/lib/pianoRoll";
import { notePlayer, type NotePlayerState } from "@/lib/notePlayer";
import { samplePlayer, type SamplePlayerState } from "@/lib/samplePlayer";
import type { InstrumentStem, LoopAnalysis, LoopInfo, NoteEvent, NotesResult, Sample, TrackInfo } from "@/lib/types";

/** Stem/sample keys that are drum sounds: their audio has no meaningful pitch, so Notes renders a step sequencer instead of a piano roll. */
const DRUM_KEYS = new Set(["drums", "kick", "snare", "toms", "hihat", "ride", "crash"]);

function isDrumSource(key: string, group: string): boolean {
  return group === "drums" || DRUM_KEYS.has(key);
}

export interface NotesTabProps {
  track: TrackInfo | null;
  loop: LoopInfo | null;
  instruments?: InstrumentStem[] | null;
  analysis: LoopAnalysis | null;
  samples?: Sample[];
  onAnalyze?: () => Promise<LoopAnalysis>;
}

interface SourceOption {
  key: string;
  label: string;
  path: string;
  /** UI grouping ("Instrument stems" / "Saved samples"), distinct from the InstrumentGroup/drum-kind check below. */
  group: string;
  isDrum: boolean;
}

function buildSourceOptions(instruments: InstrumentStem[] | null | undefined, samples: Sample[]): SourceOption[] {
  const options: SourceOption[] = [];
  if (instruments && instruments.length > 0) {
    for (const node of groupInstruments(instruments)) {
      options.push({
        key: node.stem.key,
        label: node.stem.displayLabel ?? node.stem.label,
        path: node.stem.path,
        group: "Instrument stems",
        isDrum: isDrumSource(node.stem.key, node.stem.group),
      });
      for (const child of node.children) {
        options.push({
          key: child.key,
          label: `${node.stem.displayLabel ?? node.stem.label}  /  ${child.label}`,
          path: child.path,
          group: "Instrument stems",
          isDrum: isDrumSource(child.key, child.group),
        });
      }
    }
  }
  for (const sample of samples) {
    // Saved samples always carry their own real, absolute path: that's what must reach extractNotes.
    options.push({
      key: sample.id,
      label: sample.name,
      path: sample.path,
      group: "Saved samples",
      isDrum: isDrumSource(sample.stemKey, sample.group),
    });
  }
  return options;
}

function formatMmSs(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Plays a single MIDI pitch briefly with a plain sine oscillator, for auditioning a piano-roll note. */
function playPitch(midi: number): void {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.32);
    osc.onended = () => {
      void ctx.close();
    };
  } catch {
    // WebAudio unavailable (e.g. jsdom in tests): auditioning is a no-op.
  }
}

function velocityColor(velocity: number): string {
  const t = Math.max(0, Math.min(1, velocity / 127));
  const lightness = 70 - t * 35;
  return `hsl(190, 80%, ${lightness}%)`;
}

export function NotesTab({ track, loop: _loop, instruments, analysis, samples = [], onAnalyze: _onAnalyze }: NotesTabProps) {
  const sources = useMemo(() => buildSourceOptions(instruments, samples), [instruments, samples]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [result, setResult] = useState<NotesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [noteState, setNoteState] = useState<NotePlayerState>(() => notePlayer.getState());
  /** Set by clicking the piano roll background; consumed (and cleared) by the next Play press. */
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const [sampleState, setSampleState] = useState<SamplePlayerState>(() => samplePlayer.getState());

  useEffect(() => {
    if (sources.length > 0 && !sources.some((s) => s.path === selectedPath)) {
      setSelectedPath(sources[0].path);
    }
    if (sources.length === 0) setSelectedPath("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  useEffect(() => {
    return notePlayer.subscribe(setNoteState);
  }, []);

  useEffect(() => {
    return samplePlayer.subscribe(setSampleState);
  }, []);

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
  /** The samplePlayer id used while auditioning the drum stem's audio for the step sequencer's "Play". */
  const drumId = selectedSource ? `notes-drum-${selectedSource.path}` : null;

  // Stop any note/drum playback still going for a result that's no longer selected/loaded.
  useEffect(() => {
    return () => {
      if (notePlayer.isPlaying) notePlayer.stop();
      if (drumId && samplePlayer.isPlaying(drumId)) samplePlayer.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReadNotes = async () => {
    if (!selectedSource) return;
    if (notePlayer.isPlaying) notePlayer.stop();
    if (drumId && samplePlayer.isPlaying(drumId)) samplePlayer.stop();
    setPendingStart(null);
    const start = Date.now();
    setStartedAt(start);
    setElapsedSec(0);
    setLoading(true);
    try {
      const notes = await backend.extractNotes({
        path: selectedSource.path,
        bpm: analysis?.bpm,
        kind: selectedSource.isDrum ? "drums" : undefined,
      });
      setResult(notes);
      setElapsedSec(notes.elapsedSec > 0 ? notes.elapsedSec : (Date.now() - start) / 1000);
    } finally {
      setLoading(false);
    }
  };

  const isDrumResult = !!result?.drum;
  const isDrumPlaying = !!drumId && sampleState.id === drumId;

  const handleTogglePlay = () => {
    if (!result) return;
    if (isDrumResult) {
      if (isDrumPlaying) {
        samplePlayer.stop();
      } else if (selectedSource && drumId) {
        void backend.resolveWavUrl(selectedSource.path).then((url) => {
          samplePlayer.playPath(drumId, url, { label: selectedSource.label, kind: "sample" });
        });
      }
      return;
    }
    if (noteState.isPlaying) {
      notePlayer.pause();
    } else {
      const fromSec = pendingStart ?? noteState.currentTime;
      notePlayer.play(result, fromSec, selectedSource?.label ?? "Notes");
      setPendingStart(null);
    }
  };

  /** Converts a click on the piano roll into a time (seconds) and stores it as the next play position. */
  const handleRollClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!result) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - 40;
    const sec = Math.max(0, Math.min(layout.durationSec, x / layout.pxPerSec));
    setPendingStart(sec);
    if (noteState.isPlaying) {
      notePlayer.play(result, sec, selectedSource?.label ?? "Notes");
      setPendingStart(null);
    }
  };

  const handleExport = async () => {
    if (!result) return;
    await backend.exportMidi({ path: result.midPath });
  };

  const layout = useMemo(() => computePianoRollLayout(result?.notes ?? []), [result]);

  const drumCellSize = 22;
  const drumLabelWidth = 64;
  const drumLayout = useMemo(() => {
    const steps = result?.drum?.steps ?? 16;
    const lanes = result?.drum?.lanes.length ?? 1;
    return {
      cellSize: drumCellSize,
      labelWidth: drumLabelWidth,
      width: drumLabelWidth + steps * drumCellSize,
      height: lanes * drumCellSize,
    };
  }, [result]);
  /** Column index (16th-note step) the drum playhead currently sits on, from the sample player's audio time. */
  const activeStep = useMemo(() => {
    if (!result?.drum || !isDrumPlaying) return -1;
    const stepSec = 60 / result.drum.bpm / 4;
    if (!Number.isFinite(stepSec) || stepSec <= 0) return -1;
    return Math.floor(sampleState.currentTime / stepSec) % Math.max(1, result.drum.steps);
  }, [result, isDrumPlaying, sampleState.currentTime]);

  const camelot = result?.key ? camelotFor(result.key.tonic, result.key.mode) : null;
  const explanation = result ? explainKey(result) : "";

  const displayTime = noteState.isPlaying ? noteState.currentTime : pendingStart ?? noteState.currentTime;
  const showPlayhead = !!result && (noteState.isPlaying || pendingStart !== null);
  const currentChord =
    result?.chords.find((c) => noteState.isPlaying && displayTime >= c.startSec && displayTime < c.endSec) ?? null;

  const rows: number[] = [];
  for (let m = layout.maxMidi; m >= layout.minMidi; m--) rows.push(m);

  return (
    <div className="flex flex-col gap-6 px-6 py-4 max-w-5xl mx-auto w-full">
      <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-8">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-muted uppercase tracking-wide">
            BPM
            <InfoTip term="BPM" text="Beats per minute: how fast the pulse is." />
          </div>
          <div className="text-3xl font-bold text-accent tabular-nums">{result?.bpm ? result.bpm.toFixed(1) : "--"}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <div className="w-24 h-1.5 rounded-full neu-surface-inset overflow-hidden">
              <div className="h-full bg-cyan" style={{ width: `${(result?.key?.confidence ?? 0) * 100}%` }} />
            </div>
            <InfoTip term="Confidence" text="How sure the tempo guess is." />
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1.5 text-xs text-muted uppercase tracking-wide">
            Key
            <InfoTip term="Key" text="The home note and scale the song is built on." />
          </div>
          <div className="text-3xl font-bold tabular-nums">
            {result?.key ? `${result.key.tonic} ${result.key.mode}` : "--"}
          </div>
          {camelot && <div className="text-xs text-muted mt-1">Camelot {camelot}</div>}
        </div>
      </Surface>

      {sources.length === 0 ? (
        <Surface variant="raised" className="p-6 text-center text-sm text-muted">
          Split a song or save a sample, then pick a source to read its notes.
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
          <Button variant="primary" onClick={handleReadNotes} disabled={!track || !selectedSource || loading} busy={loading}>
            Read notes
          </Button>
          <PlayPauseButton
            playing={isDrumResult ? isDrumPlaying : noteState.isPlaying}
            onToggle={handleTogglePlay}
            label="notes"
            tone="cyan"
            disabled={!result}
          />
          {loading && <span className="text-xs text-muted tabular-nums">{formatMmSs(elapsedSec)}</span>}
          {!loading && result && elapsedSec > 0 && (
            <span className="text-xs text-muted">Read in {elapsedSec.toFixed(1)} s</span>
          )}
        </Surface>
      )}

      {result && isDrumResult && result.drum && (
        <>
          <Surface variant="raised" className="p-4 flex flex-col gap-2">
            <div className="text-xs text-muted uppercase tracking-wide">Step sequencer</div>
            <div className="overflow-x-auto">
              <svg data-testid="drum-step-grid" width={drumLayout.width} height={drumLayout.height} viewBox={`0 0 ${drumLayout.width} ${drumLayout.height}`}>
                {/* bar separators every 16 steps */}
                {Array.from({ length: Math.floor(result.drum.steps / 16) + 1 }, (_, b) => b).map((b) => (
                  <line
                    key={`bar-${b}`}
                    x1={drumLayout.labelWidth + b * 16 * drumLayout.cellSize}
                    x2={drumLayout.labelWidth + b * 16 * drumLayout.cellSize}
                    y1={0}
                    y2={drumLayout.height}
                    stroke="rgba(255,255,255,0.12)"
                    strokeWidth={1}
                  />
                ))}
                {result.drum.lanes.map((lane, rowIndex) => (
                  <g key={lane.key}>
                    <text
                      x={0}
                      y={rowIndex * drumLayout.cellSize + drumLayout.cellSize / 2 + 4}
                      className="fill-current text-text"
                      fontSize={11}
                    >
                      {lane.label}
                    </text>
                    {Array.from({ length: result.drum!.steps }, (_, col) => col).map((col) => {
                      const isHit = lane.hits.includes(col);
                      const isActive = isDrumPlaying && activeStep === col;
                      return (
                        <rect
                          key={col}
                          x={drumLayout.labelWidth + col * drumLayout.cellSize + 1}
                          y={rowIndex * drumLayout.cellSize + 1}
                          width={drumLayout.cellSize - 2}
                          height={drumLayout.cellSize - 2}
                          rx={2}
                          fill={isHit ? "#F2B33D" : "rgba(255,255,255,0.06)"}
                          stroke={isActive ? "#3DD68C" : "none"}
                          strokeWidth={isActive ? 2 : 0}
                        />
                      );
                    })}
                  </g>
                ))}
              </svg>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 text-sm leading-relaxed text-text">
            <div className="text-xs text-muted uppercase tracking-wide mb-2">In plain words</div>
            Each lit block is a hit. Rows are drum sounds, columns are 16th notes.
          </Surface>
        </>
      )}

      {result && !isDrumResult && (
        <>
          <Surface variant="raised" className="p-4 flex flex-col gap-2">
            <div className="text-xs text-muted uppercase tracking-wide">Piano roll</div>
            <div className="overflow-x-auto">
              <svg
                data-testid="piano-roll"
                width={layout.width + 40}
                height={layout.height}
                viewBox={`0 0 ${layout.width + 40} ${layout.height}`}
                onClick={handleRollClick}
                className="cursor-pointer"
              >
                {rows.map((midi) => (
                  <rect
                    key={midi}
                    x={0}
                    y={layout.yForMidi(midi)}
                    width={layout.width + 40}
                    height={layout.rowHeight}
                    fill={isBlackKey(midi) ? "rgba(255,255,255,0.04)" : "transparent"}
                  />
                ))}
                {/* ruler */}
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
                {result.notes.map((n: NoteEvent, i: number) => (
                  <rect
                    key={i}
                    x={40 + layout.xForSec(n.startSec)}
                    y={layout.yForMidi(n.midi) + 1}
                    width={Math.max(2, layout.xForSec(n.endSec) - layout.xForSec(n.startSec))}
                    height={layout.rowHeight - 2}
                    rx={2}
                    fill={velocityColor(n.velocity)}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      playPitch(n.midi);
                    }}
                  >
                    <title>{n.name}</title>
                  </rect>
                ))}
                {showPlayhead && (
                  <line
                    x1={40 + layout.xForSec(displayTime)}
                    x2={40 + layout.xForSec(displayTime)}
                    y1={0}
                    y2={layout.height}
                    stroke="#F2B33D"
                    strokeWidth={1.5}
                  />
                )}
              </svg>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 flex flex-col gap-2">
            <div className="text-xs text-muted uppercase tracking-wide">Chords</div>
            <div className="flex gap-1 overflow-x-auto">
              {result.chords.map((c, i) => (
                <div
                  key={i}
                  style={{ minWidth: Math.max(32, (c.endSec - c.startSec) * layout.pxPerSec) }}
                  className={`px-2 py-1 rounded-lg text-center text-xs font-semibold neu-surface-inset ${
                    currentChord === c ? "bg-accent text-accent-ink" : "text-text"
                  }`}
                >
                  {c.name}
                </div>
              ))}
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 text-sm leading-relaxed text-text">
            <div className="text-xs text-muted uppercase tracking-wide mb-2">In plain words</div>
            {explanation}
          </Surface>

          <div>
            <Button variant="primary" onClick={handleExport}>
              Export MIDI
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
