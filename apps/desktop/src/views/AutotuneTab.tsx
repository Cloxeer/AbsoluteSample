import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Download, Maximize2, Merge, Redo2, RotateCcw, Undo2, Wand2, ZoomIn, ZoomOut } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Slider } from "@/components/neumorphic/Slider";
import { AutotuneSource, type AutotuneSourceValue } from "@/components/layout/AutotuneSource";
import { NoteCanvas, type NoteCanvasHandle } from "@/components/autotune/NoteCanvas";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/mediaUrl";
import { samplePlayer } from "@/lib/samplePlayer";
import { mixEngine } from "@/lib/mixEngine";
import {
  noteAtTime,
  allowedPitchClasses,
  applyNoteParams,
  computePeaks,
  correctPitch,
  encodeWav16,
  formatCents,
  keyLabel,
  nearestAllowed,
  parseMode,
  parseTonic,
  patchSamples,
  PEAK_BLOCK,
  PITCH_NAMES,
  pitchReadout,
  SCALE_MODES,
  scalePitchClasses,
  snapshotNotes,
  stepAllowed,
  UndoStack,
  updatePeaks,
  type Analysis,
  type EngineNote,
  type NoteEdit,
  type NoteSnapshot,
  type ScaleMode,
  type SnapMode,
} from "@/lib/melodyneEditor";
import { createWorkerPitchEngine, restoreSnapshot, type EditResult, type PitchEngine } from "@/lib/pitchEngine";
import { createTunePlayer, decodeToMono, type PlaySource, type TunePlayer } from "@/lib/tunePlayer";
import type { InstrumentStem, Sample, TrackInfo } from "@/lib/types";

/** Injectable dependencies (tests pass in-process fakes; jsdom has no Worker, wasm or Web Audio). */
export interface AutotuneDeps {
  createEngine: () => PitchEngine;
  createPlayer: () => TunePlayer;
  decode: (source: AutotuneSourceValue) => Promise<{ samples: Float32Array; sampleRate: number }>;
}

export interface AutotuneTabProps {
  track: TrackInfo | null;
  instruments: InstrumentStem[] | null;
  samples: Sample[];
  deps?: Partial<AutotuneDeps>;
}

const URLISH = /^(\/|\.\/|https?:|blob:|data:|asset:)/i;

/** Reads the chosen source's bytes without any Python backend: the dropped File, a URL, or a desktop path. */
async function defaultDecode(src: AutotuneSourceValue): Promise<{ samples: Float32Array; sampleRate: number }> {
  let bytes: ArrayBuffer;
  if (src.file) {
    bytes = await src.file.arrayBuffer();
  } else if (isTauri() && !URLISH.test(src.path)) {
    // Desktop: read through the backend so files outside the app folder (e.g. Downloads) work.
    bytes = await backend.readAudioFile(src.path);
  } else {
    const url = src.fileUrl ?? (!isTauri() && URLISH.test(src.path) ? src.path : await backend.resolveWavUrl(src.path));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load the audio (HTTP ${res.status}).`);
    bytes = await res.arrayBuffer();
  }
  return decodeToMono(bytes);
}

const DEFAULT_DEPS: AutotuneDeps = {
  createEngine: createWorkerPitchEngine,
  createPlayer: createTunePlayer,
  decode: defaultDecode,
};

type Status = "idle" | "decoding" | "analyzing" | "ready" | "error";

const MODE_LABELS: Record<ScaleMode, string> = {
  major: "Major",
  minor: "Minor",
  "harmonic minor": "Harmonic minor",
  dorian: "Dorian",
  phrygian: "Phrygian",
  lydian: "Lydian",
  mixolydian: "Mixolydian",
  "major pentatonic": "Major pentatonic",
  "minor pentatonic": "Minor pentatonic",
  blues: "Blues",
  chromatic: "Chromatic",
};

/** Small segmented toggle built from neumorphic buttons. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1 p-1 rounded-2xl neu-surface-inset bg-surface">
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          pressed={value === o.value}
          tone="accent"
          title={o.title}
          onClick={() => onChange(o.value)}
          className="!px-3 !py-1 !rounded-xl text-xs"
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function Label({ children, tip }: { children: React.ReactNode; tip?: { term: string; text: string } }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted uppercase tracking-wider">
      {children}
      {tip && <InfoTip term={tip.term} text={tip.text} />}
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
  tip,
  width = "w-32",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  tip?: { term: string; text: string };
  width?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-1.5", disabled && "opacity-40 pointer-events-none")}>
      <Label tip={tip}>{label}</Label>
      <div className="flex items-center gap-2">
        <Slider value={value} min={min} max={max} step={1} orientation="horizontal" onChange={onChange} label={label} className={width} />
        <span className="text-xs text-text w-10 tabular-nums font-mono">{Math.round(value)}%</span>
      </div>
    </div>
  );
}

/**
 * Melodyne-style note editor. The vocal is analysed and re-rendered entirely in the browser by the
 * pitchcore WebAssembly engine (in a Web Worker), so it behaves the same in the desktop app and on the web.
 */
export function AutotuneTab({ instruments, samples = [], deps: depsProp }: AutotuneTabProps) {
  const deps = useMemo(() => ({ ...DEFAULT_DEPS, ...depsProp }), [depsProp]);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [player] = useState<TunePlayer>(() => deps.createPlayer());
  const engineRef = useRef<PitchEngine | null>(null);
  const getEngine = () => (engineRef.current ??= depsRef.current.createEngine());

  const [source, setSource] = useState<AutotuneSourceValue | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [audioSec, setAudioSec] = useState(0);
  const [analyzeSec, setAnalyzeSec] = useState<number | null>(null);

  const [analysis, setAnalysisState] = useState<Analysis | null>(null);
  const analysisRef = useRef<Analysis | null>(null);
  const [sampleRate, setSampleRate] = useState(44100);
  const [sessionKey, setSessionKey] = useState("0");
  const sessionRef = useRef(0);

  const [selected, setSelectedState] = useState<Set<number>>(() => new Set());
  const selectedRef = useRef(selected);
  const [overrides, setOverrides] = useState<Map<number, number> | null>(null);

  const [snap, setSnap] = useState<SnapMode>("scale");
  const [tonicPc, setTonicPc] = useState(0);
  const [mode, setMode] = useState<ScaleMode>("major");
  const [centerPct, setCenterPct] = useState(90);
  const [driftPct, setDriftPct] = useState(70);

  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  /** Index of the note the info panel shows (selection, else the note at the playhead). */
  const focusRef = useRef<number | null>(null);
  const [abSource, setAbSource] = useState<PlaySource>("tuned");
  const [busy, setBusy] = useState(0);
  const [exporting, setExporting] = useState(false);

  const outputRef = useRef<Float32Array>(new Float32Array(0));
  const peaksRef = useRef<Float32Array | null>(null);
  const [peakMax, setPeakMax] = useState(1);
  const [peaksVersion, setPeaksVersion] = useState(0);

  const undoRef = useRef(new UndoStack<NoteSnapshot[]>());
  const [, setUndoVersion] = useState(0);
  const bumpUndo = () => setUndoVersion((v) => v + 1);

  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const liveRef = useRef<{ running: boolean; pending: NoteEdit[] | null; onDone?: (r: EditResult) => void; epoch: number }>({
    running: false,
    pending: null,
    epoch: 0,
  });
  const dragBeforeRef = useRef<NoteSnapshot[] | null>(null);
  const canvasRef = useRef<NoteCanvasHandle>(null);

  const setAnalysis = (a: Analysis | null) => {
    analysisRef.current = a;
    setAnalysisState(a);
  };
  const setSelected = (s: Set<number>) => {
    selectedRef.current = s;
    setSelectedState(s);
  };

  // ---- Lifecycle ----
  useEffect(() => {
    const sync = () => {
      setPlaying(player.isPlaying());
      setAbSource(player.getSource());
      setPlayheadSec(player.currentTime());
    };
    sync();
    return player.subscribe(sync);
  }, [player]);

  // While playing, keep the info panel on the note being heard (10x per second is plenty).
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setPlayheadSec(player.currentTime()), 100);
    return () => window.clearInterval(id);
  }, [playing, player]);

  useEffect(
    () => () => {
      player.dispose();
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    [player]
  );

  const loading = status === "decoding" || status === "analyzing";
  useEffect(() => {
    if (!loading) return;
    const id = window.setInterval(() => setElapsed((performance.now() - startedAt) / 1000), 100);
    return () => window.clearInterval(id);
  }, [loading, startedAt]);

  // Load + analyse whenever a source is picked.
  useEffect(() => {
    if (!source) return;
    const token = ++sessionRef.current;
    const t0 = performance.now();
    player.pause();
    setAnalysis(null);
    setSelected(new Set());
    setOverrides(null);
    undoRef.current.clear();
    bumpUndo();
    setError(null);
    setAnalyzeSec(null);
    setStartedAt(t0);
    setElapsed(0);
    setStatus("decoding");
    void (async () => {
      try {
        const { samples: mono, sampleRate: sr } = await depsRef.current.decode(source);
        if (token !== sessionRef.current) return;
        if (mono.length === 0) throw new Error("That file has no audio in it.");
        setAudioSec(mono.length / sr);
        setStatus("analyzing");
        const a = await getEngine().load(mono, sr);
        if (token !== sessionRef.current) return;
        outputRef.current = new Float32Array(mono);
        const peaks = computePeaks(outputRef.current, PEAK_BLOCK);
        peaksRef.current = peaks;
        let pm = 0;
        for (const p of peaks) if (p > pm) pm = p;
        setPeakMax(pm || 1);
        setPeaksVersion((v) => v + 1);
        player.load(mono, sr);
        setSampleRate(sr);
        if (a.key) {
          setTonicPc(parseTonic(a.key.tonic));
          setMode(parseMode(a.key.mode));
        }
        setAnalysis(a);
        setSessionKey(String(token));
        setAnalyzeSec((performance.now() - t0) / 1000);
        setStatus("ready");
      } catch (err) {
        if (token !== sessionRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // ---- Engine operations (strictly serialised) ----
  const applyResult = (r: EditResult, withAnalysis: boolean) => {
    const out = outputRef.current;
    const peaks = peaksRef.current;
    for (const p of r.patches) {
      const start = Math.round(p.startSec * sampleRateRef.current);
      const [a, b] = patchSamples(out, start, p.samples);
      if (peaks) updatePeaks(peaks, out, PEAK_BLOCK, a, b);
      player.patch(start, p.samples);
    }
    if (r.patches.length > 0) setPeaksVersion((v) => v + 1);
    if (withAnalysis) setAnalysis(r.analysis);
  };
  const sampleRateRef = useRef(sampleRate);
  sampleRateRef.current = sampleRate;

  function enqueue<T>(fn: (engine: PitchEngine) => Promise<T>): Promise<T> {
    const p = chainRef.current.then(() => fn(getEngine()));
    chainRef.current = p.catch(() => undefined);
    return p;
  }

  const runOp = (
    task: (engine: PitchEngine, current: Analysis) => Promise<EditResult>,
    opts: { applyAnalysis?: () => boolean; after?: (r: EditResult) => void } = {}
  ): Promise<void> => {
    const session = sessionRef.current;
    setBusy((b) => b + 1);
    return enqueue(async (engine) => {
      const cur = analysisRef.current;
      if (!cur || session !== sessionRef.current) return;
      const r = await task(engine, cur);
      if (session !== sessionRef.current) return;
      applyResult(r, opts.applyAnalysis ? opts.applyAnalysis() : true);
      opts.after?.(r);
    })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy((b) => b - 1));
  };

  /** Latest-wins live update (drag steps, slider moves): intermediate states are skipped when busy. */
  const pushLive = (edits: NoteEdit[], onDone?: (r: EditResult) => void) => {
    const L = liveRef.current;
    if (L.running) {
      L.pending = edits;
      L.onDone = onDone;
      return;
    }
    L.running = true;
    const epoch = L.epoch;
    void runOp((e) => e.setNotes(edits), {
      applyAnalysis: () => L.pending === null && epoch === L.epoch,
      after: (r) => {
        if (epoch === L.epoch) onDone?.(r);
      },
    }).finally(() => {
      L.running = false;
      const next = L.pending;
      const nextDone = L.onDone;
      L.pending = null;
      if (next) pushLive(next, nextDone);
    });
  };

  const setLocalNotes = (notes: EngineNote[]) => {
    const cur = analysisRef.current;
    if (cur) setAnalysis({ ...cur, notes });
  };

  const audition = (index: number, a: Analysis | null = analysisRef.current) => {
    const n = a?.notes[index];
    if (!n || player.isPlaying()) return;
    player.audition(n.startSec, Math.min(n.endSec, n.startSec + 1.6));
  };

  /** Pushes an undo step, updates the notes optimistically and sends the edits to the engine. */
  const commitEdits = (edits: NoteEdit[], opts: { undoKey?: string; audition?: number; live?: boolean } = {}) => {
    const cur = analysisRef.current;
    if (!cur || edits.length === 0) return;
    undoRef.current.push(snapshotNotes(cur.notes), opts.undoKey);
    bumpUndo();
    setLocalNotes(applyNoteParams(cur.notes, edits));
    const done = opts.audition !== undefined ? (r: EditResult) => audition(opts.audition as number, r.analysis) : undefined;
    if (opts.live) pushLive(edits, done);
    else void runOp((e) => e.setNotes(edits), { after: done });
  };

  const noteEdit = (i: number, patch: Partial<NoteEdit>): NoteEdit | null => {
    const n = analysisRef.current?.notes[i];
    if (!n) return null;
    return { index: i, target: n.target, drift: n.drift, modulation: n.modulation, ...patch };
  };

  // ---- Derived key/scale ----
  const scalePcs = useMemo(() => scalePitchClasses(tonicPc, mode), [tonicPc, mode]);
  const allowedPcs = useMemo(() => allowedPitchClasses(snap, scalePcs), [snap, scalePcs]);
  const allowedRef = useRef(allowedPcs);
  allowedRef.current = allowedPcs;

  // ---- Transport ----
  const togglePlay = () => {
    if (!analysisRef.current) return;
    if (player.isPlaying()) {
      player.pause();
      return;
    }
    if (samplePlayer.getState().id) samplePlayer.stop();
    mixEngine.pause();
    player.play();
  };

  // ---- Note actions ----
  const handleSelect = (s: Set<number>) => setSelected(s);

  const handleDragStart = () => {
    const cur = analysisRef.current;
    dragBeforeRef.current = cur ? snapshotNotes(cur.notes) : null;
  };

  const handleDragUpdate = (targets: Map<number, number>, primary: number) => {
    setOverrides(new Map(targets));
    const edits = [...targets].map(([i, t]) => noteEdit(i, { target: t })).filter((e): e is NoteEdit => e !== null);
    pushLive(edits, (r) => audition(primary, r.analysis));
  };

  const handleDragEnd = (targets: Map<number, number> | null) => {
    const cur = analysisRef.current;
    if (!targets || !cur) {
      setOverrides(null);
      return;
    }
    const L = liveRef.current;
    L.epoch++;
    L.pending = null;
    const edits = [...targets].map(([i, t]) => noteEdit(i, { target: t })).filter((e): e is NoteEdit => e !== null);
    undoRef.current.push(dragBeforeRef.current ?? snapshotNotes(cur.notes));
    bumpUndo();
    dragBeforeRef.current = null;
    setLocalNotes(applyNoteParams(cur.notes, edits));
    setOverrides(null);
    void runOp((e) => e.setNotes(edits));
  };

  const handleSnapNote = (i: number) => {
    const n = analysisRef.current?.notes[i];
    if (!n) return;
    setSelected(new Set([i]));
    const e = noteEdit(i, { target: nearestAllowed(n.target, allowedRef.current) });
    if (e) commitEdits([e], { audition: i });
  };

  const handleSplit = (i: number, sec: number) => {
    const cur = analysisRef.current;
    if (!cur) return;
    undoRef.current.push(snapshotNotes(cur.notes));
    bumpUndo();
    setSelected(new Set([i]));
    void runOp((e) => e.split(i, sec));
  };

  const handleMerge = () => {
    const cur = analysisRef.current;
    if (!cur || selectedRef.current.size === 0) return;
    const i = Math.min(...selectedRef.current);
    if (i + 1 >= cur.notes.length) return;
    undoRef.current.push(snapshotNotes(cur.notes));
    bumpUndo();
    setSelected(new Set([i]));
    void runOp((e) => e.merge(i));
  };

  const targetIndices = () => {
    const cur = analysisRef.current;
    if (!cur) return [];
    return selectedRef.current.size > 0 ? [...selectedRef.current].sort((a, b) => a - b) : cur.notes.map((_, i) => i);
  };

  const handleReset = () => {
    const cur = analysisRef.current;
    if (!cur) return;
    const edits = targetIndices()
      .map((i) => noteEdit(i, { target: cur.notes[i].center, drift: 1, modulation: 1 }))
      .filter((e): e is NoteEdit => e !== null);
    commitEdits(edits);
  };

  const applyCorrection = (cPct: number, dPct: number, pcs: readonly number[], indices = targetIndices()) => {
    const cur = analysisRef.current;
    if (!cur) return;
    const edits = indices.map((i) => ({ index: i, ...correctPitch(cur.notes[i], cPct / 100, dPct / 100, pcs) }));
    commitEdits(edits);
  };

  const handleTuneAll = () => {
    const cur = analysisRef.current;
    if (!cur) return;
    applyCorrection(100, 50, scalePcs, cur.notes.map((_, i) => i));
  };

  const handleParamSlider = (param: "modulation" | "drift") => (pct: number) => {
    // Acts on the selection, or on the note at the playhead when nothing is selected.
    const idx = selectedRef.current.size > 0 ? [...selectedRef.current] : focusRef.current !== null ? [focusRef.current] : [];
    const edits = idx
      .map((i) => noteEdit(i, { [param]: pct / 100 }))
      .filter((e): e is NoteEdit => e !== null);
    commitEdits(edits, { undoKey: param, live: true });
  };

  const stepSelected = (dir: 1 | -1) => {
    const cur = analysisRef.current;
    if (!cur || selectedRef.current.size === 0) return;
    const idx = [...selectedRef.current].sort((a, b) => a - b);
    const edits = idx
      .map((i) => noteEdit(i, { target: stepAllowed(cur.notes[i].target, dir, allowedRef.current) }))
      .filter((e): e is NoteEdit => e !== null);
    commitEdits(edits, { audition: idx[0] });
  };

  const handleUndo = (redo = false) => {
    const cur = analysisRef.current;
    if (!cur) return;
    const snapNow = snapshotNotes(cur.notes);
    const target = redo ? undoRef.current.redo(snapNow) : undoRef.current.undo(snapNow);
    bumpUndo();
    if (!target) return;
    setSelected(new Set());
    void runOp((e, current) => restoreSnapshot(e, current, target));
  };

  // ---- Keyboard ----
  const keyHandlersRef = useRef({ togglePlay, handleUndo, stepSelected });
  keyHandlersRef.current = { togglePlay, handleUndo, stepSelected };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!analysisRef.current) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      const h = keyHandlersRef.current;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        h.togglePlay();
      } else if (mod && key === "z") {
        e.preventDefault();
        h.handleUndo(e.shiftKey);
      } else if (mod && key === "y") {
        e.preventDefault();
        h.handleUndo(true);
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && t?.getAttribute("role") !== "slider") {
        e.preventDefault();
        h.stepSelected(e.key === "ArrowUp" ? 1 : -1);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // Deliberately non-destructive: notes are never deleted from a vocal.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Export ----
  const baseName = (source?.label ?? "vocal").replace(/\.[^.]+$/, "");
  const handleDownload = async () => {
    setExporting(true);
    try {
      const rendered = await enqueue((e) => e.renderAll());
      const wav = encodeWav16(rendered, sampleRateRef.current);
      const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}-tuned.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  // ---- Inspector values ----
  // The panel shows the selected note, or (with nothing selected) the note at the playhead.
  const atPlayhead = selected.size === 0 && analysis ? noteAtTime(analysis.notes, playheadSec) : null;
  const primary = selected.size > 0 ? Math.min(...selected) : atPlayhead?.index ?? null;
  focusRef.current = primary;
  const primaryNote = primary !== null ? analysis?.notes[primary] ?? null : null;
  const primaryPitch = primaryNote && primary !== null ? overrides?.get(primary) ?? primaryNote.target : null;
  const readout = primaryPitch !== null ? pitchReadout(primaryPitch) : null;
  const detected = keyLabel(analysis?.key);
  const hasSelection = selected.size > 0;
  const est = Math.max(1.5, audioSec * 0.1 + 0.5);
  const progress = status === "decoding" ? Math.min(0.15, elapsed / 4) : Math.min(0.96, 0.15 + (0.85 * elapsed) / est);

  return (
    <div className="flex flex-col gap-4 px-6 py-4 max-w-6xl mx-auto w-full">
      <AutotuneSource instruments={instruments} samples={samples} value={source} onChange={setSource} />

      {loading && (
        <Surface variant="raised" className="p-5 flex flex-col gap-3" data-testid="autotune-loading">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text font-medium">{status === "decoding" ? "Opening audio…" : "Analyzing vocal…"}</span>
            <span className="text-xs text-muted tabular-nums font-mono">{elapsed.toFixed(1)} s</span>
          </div>
          <div className="h-2 rounded-full neu-surface-inset overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#F0A04B] to-[#D8553A] transition-[width] duration-200"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span className="text-[11px] text-muted">
            Finding every note in {source?.label ?? "your vocal"}. This runs on your computer and takes a few seconds.
          </span>
        </Surface>
      )}

      {error && (
        <Surface variant="raised" className="p-4 text-sm text-danger" role="alert">
          {error}
        </Surface>
      )}

      {!analysis && !loading && (
        <Surface variant="raised" className="p-8 text-center text-sm text-muted">
          Drop your vocal or pick one from the song. It opens right here, ready to tune.
        </Surface>
      )}

      {analysis && (
        <>
          <Surface variant="raised" className="p-3 flex flex-col gap-3">
            {/* Transport, edit and key toolbar */}
            <div className="flex flex-wrap items-center gap-3">
              <PlayPauseButton playing={playing} onToggle={togglePlay} label="vocal" tone="accent" />
              <Segmented<PlaySource>
                label="Compare"
                value={abSource}
                onChange={(v) => player.setSource(v)}
                options={[
                  { value: "original", label: "Original" },
                  { value: "tuned", label: "Tuned" },
                ]}
              />
              <div className="w-px h-7 bg-white/5" />
              <Button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => handleUndo(false)} disabled={!undoRef.current.canUndo} className="!px-2.5">
                <Undo2 size={15} />
              </Button>
              <Button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={() => handleUndo(true)} disabled={!undoRef.current.canRedo} className="!px-2.5">
                <Redo2 size={15} />
              </Button>
              <Button type="button" onClick={handleMerge} disabled={!hasSelection} title="Join the selected note with the next one" className="!px-3 inline-flex items-center gap-1.5">
                <Merge size={14} /> Merge
              </Button>
              <div className="w-px h-7 bg-white/5" />
              <div className="flex items-center gap-2">
                <Label tip={{ term: "Snap", text: "Where dragged notes land: notes of the key, any semitone, or anywhere (hold Alt to drag freely)." }}>
                  Snap
                </Label>
                <Segmented<SnapMode>
                  label="Snap"
                  value={snap}
                  onChange={setSnap}
                  options={[
                    { value: "scale", label: "Scale" },
                    { value: "chromatic", label: "Chromatic" },
                    { value: "off", label: "Off" },
                  ]}
                />
              </div>
              <div className="flex items-center gap-2">
                <Label tip={{ term: "Key", text: "The song's key. Light rows are notes in the key; notes snap to them." }}>Key</Label>
                <select
                  value={tonicPc}
                  onChange={(e) => setTonicPc(Number(e.target.value))}
                  aria-label="Tonic"
                  className="bg-surface neu-surface-inset rounded-lg px-2 py-1.5 text-sm font-semibold text-text"
                >
                  {PITCH_NAMES.map((n, i) => (
                    <option key={n} value={i}>
                      {n}
                    </option>
                  ))}
                </select>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ScaleMode)}
                  aria-label="Scale mode"
                  className="bg-surface neu-surface-inset rounded-lg px-2 py-1.5 text-sm font-semibold text-text"
                >
                  {SCALE_MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
                {detected && <span className="text-[11px] text-muted whitespace-nowrap">Detected: {detected}</span>}
              </div>
              <div className="flex items-center gap-1 ml-auto">
                <Button type="button" aria-label="Zoom out" onClick={() => canvasRef.current?.zoom(1 / 1.5)} className="!px-2.5">
                  <ZoomOut size={15} />
                </Button>
                <Button type="button" aria-label="Zoom in" onClick={() => canvasRef.current?.zoom(1.5)} className="!px-2.5">
                  <ZoomIn size={15} />
                </Button>
                <Button type="button" onClick={() => canvasRef.current?.fit()} className="!px-3 inline-flex items-center gap-1.5" title="Show the whole vocal">
                  <Maximize2 size={14} /> Fit
                </Button>
              </div>
            </div>

            {/* Inspector + Correct Pitch macro */}
            <div className="flex flex-wrap items-end gap-5 px-1">
              <div className="flex flex-col gap-1.5 min-w-[150px]">
                <Label>{hasSelection ? "Selected note" : atPlayhead && !atPlayhead.sounding ? "Next note" : "Note at playhead"}</Label>
                <div data-testid="autotune-readout" className="flex items-baseline gap-2 h-8">
                  {readout ? (
                    <>
                      <span className="text-xl font-bold text-text font-mono">{readout.name}</span>
                      <span className={clsx("text-sm font-mono tabular-nums", readout.cents === 0 ? "text-[#F0A04B]" : "text-muted")}>
                        {formatCents(readout.cents)}
                      </span>
                      {selected.size > 1 && <span className="text-[10px] text-muted">+{selected.size - 1} more</span>}
                    </>
                  ) : (
                    <span className="text-xs text-muted">No singing here</span>
                  )}
                </div>
              </div>
              <SliderField
                label="Vibrato"
                value={primaryNote ? primaryNote.modulation * 100 : 100}
                min={0}
                max={200}
                onChange={handleParamSlider("modulation")}
                disabled={primaryNote === null}
                tip={{ term: "Vibrato", text: "100% keeps the singer's vibrato, 0% flattens it, 200% doubles it." }}
              />
              <SliderField
                label="Pitch drift"
                value={primaryNote ? primaryNote.drift * 100 : 100}
                min={0}
                max={100}
                onChange={handleParamSlider("drift")}
                disabled={primaryNote === null}
                tip={{ term: "Pitch drift", text: "100% keeps the slow wobble inside a note, 0% holds it perfectly steady." }}
              />
              <Button type="button" onClick={handleReset} className="inline-flex items-center gap-1.5" title="Put notes back to how they were sung">
                <RotateCcw size={14} /> {hasSelection ? "Reset" : "Reset all"}
              </Button>

              <div className="flex flex-wrap items-end gap-4 ml-auto pl-4 border-l border-white/5">
                <SliderField
                  label="Pitch center"
                  value={centerPct}
                  min={0}
                  max={100}
                  onChange={setCenterPct}
                  width="w-24"
                  tip={{ term: "Pitch center", text: "How far Correct Pitch pulls each note toward the nearest note of the key." }}
                />
                <SliderField
                  label="Drift"
                  value={driftPct}
                  min={0}
                  max={100}
                  onChange={setDriftPct}
                  width="w-24"
                  tip={{ term: "Drift", text: "How much Correct Pitch steadies the wobble inside each note." }}
                />
                <Button type="button" onClick={() => applyCorrection(centerPct, driftPct, allowedPcs)} title={hasSelection ? "Correct the selected notes" : "Correct every note"}>
                  Correct Pitch
                </Button>
                <Button type="button" variant="primary" onClick={handleTuneAll} className="inline-flex items-center gap-1.5 !text-[#1a1300] !bg-[#F0A04B] !shadow-[0_0_16px_rgba(240,160,75,0.35)]">
                  <Wand2 size={14} /> Tune all to key
                </Button>
              </div>
            </div>

            <div className="rounded-xl overflow-hidden neu-surface-inset">
              <NoteCanvas
                ref={canvasRef}
                analysis={analysis}
                sessionKey={sessionKey}
                overrides={overrides}
                selected={selected}
                scalePcs={scalePcs}
                tonicPc={tonicPc}
                snap={snap}
                peaks={peaksRef.current}
                peaksVersion={peaksVersion}
                peakBlock={PEAK_BLOCK}
                peakMax={peakMax}
                sampleRate={sampleRate}
                player={player}
                playing={playing}
                onSelect={handleSelect}
                onSeek={(sec) => player.seek(sec)}
                onDragStart={handleDragStart}
                onDragUpdate={handleDragUpdate}
                onDragEnd={handleDragEnd}
                onSnapNote={handleSnapNote}
                onSplit={handleSplit}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3 px-1">
              <span className="text-[11px] text-muted tabular-nums">
                {analysis.notes.length} notes
                {analyzeSec !== null && ` · analyzed in ${analyzeSec.toFixed(1)} s`}
              </span>
              {busy > 0 && <span className="text-[10px] text-muted uppercase tracking-wide animate-pulse">Rendering…</span>}
              <div className="flex items-center gap-2 ml-auto">
                {isTauri() && (
                  <Button type="button" disabled title="Saving into your sample library needs a desktop write command that isn't available yet. Use Download WAV.">
                    Save as sample
                  </Button>
                )}
                <Button type="button" onClick={handleDownload} busy={exporting} className="inline-flex items-center gap-1.5">
                  <Download size={14} /> Download WAV
                </Button>
              </div>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 text-sm leading-relaxed text-text">
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">In plain words</div>
            Drag a note up or down; it snaps to the song&apos;s key. Double-click a note to snap it; double-click its top to
            split it. Space plays. Click the time ruler to move the playhead, and flip Original / Tuned to compare.
          </Surface>
        </>
      )}
    </div>
  );
}
