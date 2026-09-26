import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Slider } from "@/components/neumorphic/Slider";
import { AutotuneSource, type AutotuneSourceValue } from "@/components/layout/AutotuneSource";
import { backend } from "@/lib/backend";
import { isTauri, mediaUrl } from "@/lib/mediaUrl";
import { peaksOptions } from "@/lib/wavePeaks";
import { samplePlayer, type SamplePlayerState } from "@/lib/samplePlayer";
import {
  applyHumanize,
  buildEditableNotes,
  buildF0Segments,
  buildScalePitchClasses,
  computeAutotuneLayout,
  computePreviewRegion,
  isBlackKey,
  KEYBOARD_WIDTH,
  midiToNoteName,
  playheadX,
  resetEditableNotes,
  retuneSpeedToParams,
  setNoteTarget,
  snapYToMidi,
  toAutotuneNoteEdits,
  tuneNotesToScale,
  tuningBucket,
  type EditableNote,
  type PreviewRegion,
  type ScaleName,
} from "@/lib/autotuneEditor";
import type { AutotuneEdits, AutotuneResult, InstrumentStem, PitchResult, Sample, TrackInfo } from "@/lib/types";

export interface AutotuneTabProps {
  track: TrackInfo | null;
  instruments: InstrumentStem[] | null;
  samples: Sample[];
}

const TONICS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TONIC_PC: Record<string, number> = TONICS.reduce((acc, name, i) => ({ ...acc, [name]: i }), {});
/** How long to wait after the last edit before rendering a fresh tuned preview in the background. */
const PREVIEW_DEBOUNCE_MS = 500;

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

/** Turns a buildF0Segments() point-array into an SVG path "d" string. */
function segmentToPath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/** Perf metrics captured off a backend result, for the "Performance" readout. */
interface PerfMetrics {
  seconds: number;
  peakRssMb: number;
}

/** Formats a PerfMetrics pair like "12.4 s, 60 MB", or its label variant "Preview 2.1 s, 60 MB". */
function formatPerf(label: string | null, m: PerfMetrics): string {
  const secs = `${m.seconds.toFixed(1)} s`;
  const mb = `${Math.round(m.peakRssMb)} MB`;
  return label ? `${label} ${secs}, ${mb}` : `${secs}, ${mb}`;
}

const SOURCE_PLAYER_ID = "autotune-source";

/** Antares Auto-Tune Pro Graph Mode-style pitch editor: analyze a vocal (the user's own file, or one from the song), drag notes onto pitch, apply. */
export function AutotuneTab({ track: _track, instruments, samples = [] }: AutotuneTabProps) {
  const [source, setSource] = useState<AutotuneSourceValue | null>(null);
  const [pitch, setPitch] = useState<PitchResult | null>(null);
  const [analyzedPath, setAnalyzedPath] = useState<string | null>(null);
  const [notes, setNotes] = useState<EditableNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const [retuneSpeed, setRetuneSpeed] = useState(70);
  const [humanize, setHumanize] = useState(0);
  const [scaleName, setScaleName] = useState<ScaleName>("chromatic");
  const [tonic, setTonic] = useState("C");

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragMidi, setDragMidi] = useState<number | null>(null);
  /** True once notes were snapped by "Tune to scale" and haven't been manually dragged since, so a
   * later Key/Scale change should re-snap them rather than leaving stale targets behind. */
  const [followingScale, setFollowingScale] = useState(false);

  const [applying, setApplying] = useState(false);
  const [tuned, setTuned] = useState<AutotuneResult | null>(null);
  /** Background-rendered preview of the current edits, refreshed on a debounce; this is what "Tuned"
   * plays before Apply is pressed. Apply promotes its latest value into `tuned`. */
  const [preview, setPreview] = useState<AutotuneResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** True while the in-flight/most recent preview render is a full-file render (no region), either
   * because the edit touched many notes / the whole track, or the computed region was too wide. */
  const [previewIsFull, setPreviewIsFull] = useState(false);
  /** The region (song-relative seconds) the currently loaded `preview` covers, or null if it's a
   * full-file render. Used to play back just that slice, and to know Apply's full render differs from it. */
  const [previewRegion, setPreviewRegion] = useState<PreviewRegion | null>(null);
  // Single-flight preview: at most ONE render runs at a time. New edits during a render
  // coalesce into a single pending run instead of spawning concurrent heavy processes.
  const previewInFlight = useRef(false);
  const previewPending = useRef<AutotuneEdits | null>(null);
  /** The note(s) that changed since the last preview render (start/end in song-relative seconds), used
   * to compute a tight region for the next render; null means "render the whole file" (e.g. a global
   * Retune Speed/Humanize/Key/Scale change, or before any specific note has been tracked). */
  const changedNotesRef = useRef<{ startSec: number; endSec: number }[] | null>(null);
  const [comparing, setComparing] = useState<"original" | "tuned">("original");

  const [analyzeMetrics, setAnalyzeMetrics] = useState<PerfMetrics | null>(null);
  const [lastRenderMetrics, setLastRenderMetrics] = useState<(PerfMetrics & { label: "Preview" | "Apply" }) | null>(null);

  const [playerState, setPlayerState] = useState<SamplePlayerState>(() => samplePlayer.getState());
  /** Where the next Play (or resumed drag-seek) should start from, in seconds; set by clicking the waveform/grid. */
  const [seekSec, setSeekSec] = useState(0);

  const waveContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);

  useEffect(() => samplePlayer.subscribe(setPlayerState), []);

  useEffect(() => {
    return () => {
      if (
        samplePlayer.isPlaying(SOURCE_PLAYER_ID) ||
        samplePlayer.isPlaying("autotune-original") ||
        samplePlayer.isPlaying("autotune-tuned")
      )
        samplePlayer.stop();
    };
  }, []);

  useEffect(() => {
    if (!loading || startedAt === null) return;
    const id = window.setInterval(() => setElapsedSec((Date.now() - startedAt) / 1000), 100);
    return () => window.clearInterval(id);
  }, [loading, startedAt]);

  const handleAnalyze = async () => {
    if (!source) return;
    if (samplePlayer.isPlaying("autotune-original") || samplePlayer.isPlaying("autotune-tuned")) samplePlayer.stop();
    const start = Date.now();
    setStartedAt(start);
    setElapsedSec(0);
    setLoading(true);
    setTuned(null);
    setPreview(null);
    setPreviewRegion(null);
    setPreviewIsFull(false);
    setLastRenderMetrics(null);
    setAnalyzeMetrics(null);
    changedNotesRef.current = null;
    setFollowingScale(false);
    try {
      const result = await backend.analyzePitch({ path: source.path });
      setPitch(result);
      setAnalyzedPath(source.path);
      setNotes(buildEditableNotes(result.notes));
      if (result.key) {
        setTonic(result.key.tonic);
        setScaleName(result.key.mode === "minor" ? "minor" : "major");
      }
      if (typeof result.seconds === "number" && typeof result.peakRssMb === "number") {
        setAnalyzeMetrics({ seconds: result.seconds, peakRssMb: result.peakRssMb });
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
    () =>
      pitch
        ? buildF0Segments(pitch.f0, layout, { xOffset: KEYBOARD_WIDTH, hopSec: pitch.hopSec }).map(segmentToPath)
        : [],
    [pitch, layout]
  );

  // Renders the waveform of the chosen source, sized to match the pitch grid's time axis.
  useEffect(() => {
    if (!waveContainerRef.current || !pitch || !analyzedPath) return;
    const url = source?.kind === "own" && source.fileUrl ? source.fileUrl : mediaUrl(analyzedPath);
    const ws = WaveSurfer.create({
      container: waveContainerRef.current,
      // No built-in wavesurfer cursor or progress tint: the single overlay playhead below (shared with
      // the pitch grid via KEYBOARD_WIDTH/xForSec) is the only playhead drawn, so it never doubles up.
      waveColor: "#E8935D",
      progressColor: "#E8935D",
      cursorColor: "transparent",
      height: 64,
      normalize: true,
      cursorWidth: 0,
      url,
      ...peaksOptions(source?.kind === "song" ? source.peaks : undefined, source?.kind === "song" ? source.durationSec : undefined),
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzedPath, pitch]);

  /** Marks every current note as changed, so the next preview covers the whole edit (region computation
   * will naturally fall back to a full-file render once the span is too wide, e.g. many/all notes). */
  const markAllNotesChanged = (ns: EditableNote[]) => {
    changedNotesRef.current = ns.map((n) => ({ startSec: n.startSec, endSec: n.endSec }));
  };

  /** Marks a single note (by song-relative start/end) as the one that changed, for a tight region preview. */
  const markNoteChanged = (n: { startSec: number; endSec: number }) => {
    changedNotesRef.current = [{ startSec: n.startSec, endSec: n.endSec }];
  };

  /** Global parameter changes (Retune Speed, Humanize, Key, Scale) affect the whole render, not just one note. */
  const markFullChange = () => {
    changedNotesRef.current = null;
  };

  const handleReset = () => {
    markAllNotesChanged(notes);
    setNotes((prev) => resetEditableNotes(prev));
    setFollowingScale(false);
  };

  const handleTuneToScale = () => {
    markAllNotesChanged(notes);
    setNotes((prev) => tuneNotesToScale(prev, scalePcs));
    setFollowingScale(true);
  };

  // Key/Scale changes re-snap targets that are still following the scale (i.e. weren't hand-dragged
  // since the last "Tune to scale"), so the correction stays consistent with whatever is now selected.
  useEffect(() => {
    if (!followingScale) return;
    markAllNotesChanged(notes);
    setNotes((prev) => tuneNotesToScale(prev, scalePcs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scalePcs]);

  const handleRetuneSpeedChange = (v: number) => {
    markFullChange();
    setRetuneSpeed(v);
  };

  const handleHumanizeChange = (v: number) => {
    markFullChange();
    setHumanize(v);
  };

  const handleTonicChange = (t: string) => {
    markFullChange();
    setTonic(t);
  };

  const handleScaleNameChange = (s: ScaleName) => {
    markFullChange();
    setScaleName(s);
  };

  const handleNotePointerDown = (index: number) => (e: React.PointerEvent<SVGRectElement>) => {
    e.stopPropagation();
    (e.target as SVGRectElement).setPointerCapture?.(e.pointerId);
    setDragIndex(index);
    setDragMidi(notes[index].targetMidi);
    markNoteChanged(notes[index]);
  };

  const handleNotePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragIndex === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const midi = snapYToMidi(y, layout);
    setDragMidi(midi);
    setFollowingScale(false);
    markNoteChanged(notes[dragIndex]);
    setNotes((prev) => setNoteTarget(prev, dragIndex, midi));
  };

  const handleNotePointerUp = () => {
    setDragIndex(null);
    setDragMidi(null);
  };

  const retuneParams = useMemo(() => retuneSpeedToParams(retuneSpeed), [retuneSpeed]);
  const transitionMs = useMemo(() => applyHumanize(retuneParams.transitionMs, humanize), [retuneParams, humanize]);

  const edits: AutotuneEdits = useMemo(
    () => ({
      snapStrength: retuneParams.snapStrength,
      scale: scalePcs,
      transitionMs,
      notes: toAutotuneNoteEdits(notes),
    }),
    [retuneParams, scalePcs, transitionMs, notes]
  );

  // Live tuned preview: whenever the edits change (a dragged note, Tune to scale, Key, Scale, Retune
  // Speed, or Humanize), debounce a background applyAutotune render so Compare's "Tuned" option always
  // has fresh audio to play, even before Apply is pressed. A monotonic request id discards any response
  // that arrives after a newer edit superseded it.
  const runPreview = useCallback(
    async (nextEdits: AutotuneEdits) => {
      if (!analyzedPath) return;
      if (previewInFlight.current) {
        previewPending.current = nextEdits; // coalesce; run once the current render finishes
        return;
      }
      // Compute (and consume) the region for THIS render from whatever note(s) changed since the
      // last one; null means render the whole file (global param change, or too many notes changed).
      const region = computePreviewRegion(changedNotesRef.current, layout.durationSec);
      changedNotesRef.current = null;
      previewInFlight.current = true;
      setPreviewLoading(true);
      setPreviewIsFull(region === null);
      try {
        const result = await backend.applyAutotune({
          path: analyzedPath,
          edits: nextEdits,
          pitchCachePath: pitch?.cachePath,
          ...(region ? { regionStartSec: region.startSec, regionEndSec: region.endSec } : {}),
        });
        setPreview(result);
        setPreviewRegion(region);
        if (typeof result.seconds === "number" && typeof result.peakRssMb === "number") {
          setLastRenderMetrics({ seconds: result.seconds, peakRssMb: result.peakRssMb, label: "Preview" });
        }
      } catch {
        // engine busy or a render error: keep the last good preview rather than piling on
      } finally {
        previewInFlight.current = false;
        setPreviewLoading(false);
        const pending = previewPending.current;
        previewPending.current = null;
        if (pending) void runPreview(pending);
      }
    },
    [analyzedPath, pitch, layout.durationSec],
  );

  useEffect(() => {
    if (!analyzedPath || notes.length === 0) return;
    const timer = window.setTimeout(() => void runPreview(edits), PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, analyzedPath]);

  const handleApply = async () => {
    if (!analyzedPath) return;
    setApplying(true);
    try {
      // Apply always renders the whole song (no region), for save/download.
      const result = await backend.applyAutotune({ path: analyzedPath, edits });
      setTuned(result);
      setPreview(result);
      setPreviewRegion(null);
      setPreviewIsFull(false);
      if (typeof result.seconds === "number" && typeof result.peakRssMb === "number") {
        setLastRenderMetrics({ seconds: result.seconds, peakRssMb: result.peakRssMb, label: "Apply" });
      }
      setComparing("tuned");
    } finally {
      setApplying(false);
    }
  };

  /** The tuned audio Compare's "Tuned" plays: the finalized Apply result once it exists, otherwise the
   * latest live preview render. */
  const tunedResult = tuned ?? preview;

  /** URL for the currently loaded source (before or after Apply); same resolution used by the waveform and Compare's Original. */
  const sourceUrl = analyzedPath
    ? source?.kind === "own" && source.fileUrl
      ? source.fileUrl
      : mediaUrl(analyzedPath)
    : null;

  const isPlayingSource = playerState.id === SOURCE_PLAYER_ID;

  /** Plays the currently loaded source from the start, or from `fromSec` when given (e.g. a grid/waveform click). */
  const handlePlaySource = (fromSec?: number) => {
    if (!sourceUrl) return;
    if (fromSec === undefined && samplePlayer.isPlaying(SOURCE_PLAYER_ID)) {
      samplePlayer.stop();
      return;
    }
    samplePlayer.playPath(SOURCE_PLAYER_ID, sourceUrl, {
      start: fromSec ?? seekSec,
      kind: "sample",
      label: "Autotune source",
    });
  };

  /** Converts a click's x-coordinate (relative to the grid, i.e. past the piano keyboard column) into a time and
   * stores it as the next play position, restarting playback there if the source is already playing. */
  const handleSeekAtX = (xInGrid: number) => {
    const sec = Math.max(0, Math.min(layout.durationSec, layout.secForX(xInGrid)));
    setSeekSec(sec);
    if (samplePlayer.isPlaying(SOURCE_PLAYER_ID)) handlePlaySource(sec);
  };

  const handleGridClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragIndex !== null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    handleSeekAtX(e.clientX - rect.left - KEYBOARD_WIDTH);
  };

  const handleWaveformClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    handleSeekAtX(e.clientX - rect.left);
  };

  const handlePlayOriginal = () => {
    if (!analyzedPath) return;
    setComparing("original");
    if (samplePlayer.isPlaying("autotune-original")) {
      samplePlayer.stop();
      return;
    }
    const url = source?.kind === "own" && source.fileUrl ? source.fileUrl : mediaUrl(analyzedPath);
    samplePlayer.playPath("autotune-original", url, { kind: "sample", label: "Autotune original" });
  };

  const handlePlayTuned = () => {
    if (!tunedResult) return;
    setComparing("tuned");
    if (samplePlayer.isPlaying("autotune-tuned")) {
      samplePlayer.stop();
      return;
    }
    samplePlayer.playPath("autotune-tuned", mediaUrl(tunedResult.path), { kind: "sample", label: "Autotune tuned" });
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
  // A loaded region preview's audio is just that slice starting at t=0, so while it plays, offset the
  // shared playhead by the region's song-relative start to keep it lined up with the waveform/grid.
  const isPlayingRegionPreview = isPlayingTuned && !tuned && previewRegion !== null;
  // One playhead sweeps the waveform lane and the pitch grid together, driven from a single time
  // source (samplePlayer's currentTime while any of the three players is active, else the last seek
  // position) and mapped through the shared playheadX/xForSec helper, so both lanes always agree.
  const isAnyAutotunePlaying = isPlayingSource || isPlayingOriginal || isPlayingTuned;
  const playheadTime = isAnyAutotunePlaying
    ? isPlayingRegionPreview
      ? playerState.currentTime + previewRegion!.startSec
      : playerState.currentTime
    : seekSec;
  const playheadPx = playheadX(layout, playheadTime, KEYBOARD_WIDTH);
  const showPlayhead = pitch !== null;

  return (
    <div className="flex flex-col gap-6 px-6 py-4 max-w-5xl mx-auto w-full">
      <AutotuneSource instruments={instruments} samples={samples} value={source} onChange={setSource} />

      <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={handleAnalyze} disabled={!source || loading} busy={loading}>
          Analyze
        </Button>
        {loading && <span className="text-xs text-muted tabular-nums">{elapsedSec.toFixed(1)} s</span>}
        {!loading && pitch && elapsedSec > 0 && (
          <span className="text-xs text-muted">Analyzed in {elapsedSec.toFixed(1)} s</span>
        )}
        {(analyzeMetrics || lastRenderMetrics) && (
          <span className="text-[10px] text-muted w-full">
            Performance:{" "}
            {analyzeMetrics && `Analyzed in ${analyzeMetrics.seconds.toFixed(1)} s`}
            {analyzeMetrics && lastRenderMetrics && " - "}
            {lastRenderMetrics && formatPerf(lastRenderMetrics.label, lastRenderMetrics)}
          </span>
        )}
      </Surface>

      {!pitch && (
        <Surface variant="raised" className="p-6 text-center text-sm text-muted">
          Drop your vocal or pick one from the song, then Analyze to tune it.
        </Surface>
      )}

      {pitch && (
        <>
          <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-6 bg-[#1b2230] neu-surface-raised">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs text-muted uppercase tracking-wide">
                Key
                <InfoTip term="Key" text="The home note your vocal is tuned to." />
              </div>
              <select
                value={tonic}
                onChange={(e) => handleTonicChange(e.target.value)}
                disabled={scaleName === "chromatic"}
                className="bg-surface neu-surface-inset rounded-lg px-3 py-2 text-base font-semibold text-text disabled:opacity-40"
                aria-label="Key"
              >
                {TONICS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs text-muted uppercase tracking-wide">
                Scale
                <InfoTip term="Scale" text="Which notes are allowed; the voice snaps to these." />
              </div>
              <select
                value={scaleName}
                onChange={(e) => handleScaleNameChange(e.target.value as ScaleName)}
                className="bg-surface neu-surface-inset rounded-lg px-3 py-2 text-base font-semibold text-text"
                aria-label="Scale"
              >
                <option value="chromatic">Chromatic</option>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
                <option value="dorian">Dorian</option>
                <option value="mixolydian">Mixolydian</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs text-muted uppercase tracking-wide">
                Retune speed
                <InfoTip term="Retune Speed" text="Fast is the classic autotune effect; slow keeps it natural." />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted">Slow</span>
                <Slider
                  value={retuneSpeed}
                  min={0}
                  max={100}
                  step={1}
                  orientation="horizontal"
                  onChange={handleRetuneSpeedChange}
                  label="Retune speed"
                  className="w-40"
                />
                <span className="text-[10px] text-muted">Fast</span>
                <span className="text-xs text-muted w-10 tabular-nums">{retuneSpeed}%</span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-xs text-muted uppercase tracking-wide">Humanize</div>
              <div className="flex items-center gap-2">
                <Slider
                  value={humanize}
                  min={0}
                  max={100}
                  step={1}
                  orientation="horizontal"
                  onChange={handleHumanizeChange}
                  label="Humanize"
                  className="w-28"
                />
                <span className="text-xs text-muted w-10 tabular-nums">{humanize}%</span>
              </div>
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <Button onClick={handleTuneToScale} disabled={scaleName === "chromatic"}>
                Tune to scale
              </Button>
              <Button onClick={handleReset}>Reset</Button>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 flex flex-col gap-2 bg-[#1b2230] neu-surface-raised">
            <div className="flex items-center gap-3">
              <PlayPauseButton
                playing={isPlayingSource}
                onToggle={() => handlePlaySource()}
                label="source"
                tone="accent"
                disabled={!sourceUrl}
              />
              <span className="text-xs text-muted uppercase tracking-wide">Vocal waveform</span>
              {previewLoading && (
                <span className="text-[10px] text-muted uppercase tracking-wide animate-pulse">
                  {previewIsFull ? "Rendering full preview..." : "Updating preview..."}
                </span>
              )}
            </div>
            {/* Waveform lane and pitch grid scroll together in one container, both starting at
                KEYBOARD_WIDTH and sized to layout.width, with a single playhead overlay spanning both
                so exactly one bar is ever drawn and it always lines up between the two lanes. */}
            <div className="overflow-x-auto">
              <div className="relative" style={{ width: layout.width + KEYBOARD_WIDTH }}>
                <div className="flex">
                  <div style={{ width: KEYBOARD_WIDTH }} className="shrink-0" />
                  <div
                    ref={waveContainerRef}
                    data-testid="autotune-waveform"
                    style={{ width: layout.width, cursor: "pointer" }}
                    onClick={handleWaveformClick}
                  />
                </div>

                <div className="text-xs text-muted uppercase tracking-wide mt-2 mb-1">Pitch editor (Graph Mode)</div>

                {showPlayhead && (
                  <div
                    data-testid="autotune-playhead"
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/70 z-10"
                    style={{ left: playheadPx }}
                  />
                )}

                <svg
                  data-testid="autotune-editor"
                  width={layout.width + KEYBOARD_WIDTH}
                  height={layout.height}
                  viewBox={`0 0 ${layout.width + KEYBOARD_WIDTH} ${layout.height}`}
                  onPointerMove={handleNotePointerMove}
                  onPointerUp={handleNotePointerUp}
                  onClick={handleGridClick}
                  className="rounded-lg"
                  style={{ background: "#161b26", cursor: "pointer" }}
                >
                {rows.map((midi) => {
                  const inScale = scalePcs ? scalePcs.includes(((midi % 12) + 12) % 12) : false;
                  const black = isBlackKey(midi);
                  return (
                    <g key={midi}>
                      {/* Piano keyboard column */}
                      <rect
                        x={0}
                        y={layout.yForMidi(midi)}
                        width={KEYBOARD_WIDTH}
                        height={layout.rowHeight}
                        fill={black ? "#0c0f16" : "#242b3a"}
                        stroke="#0a0c11"
                        strokeWidth={0.5}
                      />
                      <text
                        x={4}
                        y={layout.yForMidi(midi) + layout.rowHeight - 2}
                        fontSize={layout.rowHeight - 3}
                        fill="rgba(255,255,255,0.55)"
                      >
                        {midi % 12 === 0 ? midiToNoteName(midi) : ""}
                      </text>
                      {/* Pitch grid row */}
                      <rect
                        x={KEYBOARD_WIDTH}
                        y={layout.yForMidi(midi)}
                        width={layout.width}
                        height={layout.rowHeight}
                        fill={inScale ? "rgba(61,220,151,0.10)" : black ? "rgba(255,255,255,0.03)" : "transparent"}
                      />
                    </g>
                  );
                })}
                {Array.from({ length: Math.ceil(layout.durationSec) + 1 }, (_, s) => s).map((s) => (
                  <line
                    key={`ruler-${s}`}
                    x1={KEYBOARD_WIDTH + layout.xForSec(s)}
                    x2={KEYBOARD_WIDTH + layout.xForSec(s)}
                    y1={0}
                    y2={layout.height}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth={1}
                  />
                ))}
                {f0Paths.map((d, i) => (
                  <path key={`f0-${i}`} d={d} fill="none" stroke="#F2734F" strokeWidth={1.5} opacity={0.85} />
                ))}
                {notes.map((n, i) => {
                  const isDragging = dragIndex === i;
                  const midi = isDragging && dragMidi !== null ? dragMidi : n.targetMidi;
                  const originalMidi = Math.round(n.midi);
                  const corrected = midi !== originalMidi;
                  const x = KEYBOARD_WIDTH + layout.xForSec(n.startSec);
                  const width = Math.max(4, layout.xForSec(n.endSec) - layout.xForSec(n.startSec));
                  return (
                    <g key={i}>
                      {/* Faint outline at the originally-detected pitch when a correction moved the
                          block, so original vs corrected is visible even while not dragging. */}
                      {corrected && !isDragging && (
                        <rect
                          x={x}
                          y={layout.yForMidi(originalMidi) + 1}
                          width={width}
                          height={layout.rowHeight - 2}
                          rx={3}
                          fill="none"
                          stroke="rgba(255,255,255,0.35)"
                          strokeDasharray="2,2"
                          strokeWidth={1}
                        />
                      )}
                      <rect
                        x={x}
                        y={layout.yForMidi(midi) + 1}
                        width={width}
                        height={layout.rowHeight - 2}
                        rx={3}
                        fill={tuningColor(n.cents)}
                        opacity={isDragging ? 0.9 : 0.75}
                        stroke={isDragging || corrected ? "#ffffff" : "none"}
                        strokeWidth={isDragging ? 1 : corrected ? 0.75 : 0}
                        className="cursor-grab"
                        onPointerDown={handleNotePointerDown(i)}
                      >
                        <title>{`${midiToNoteName(Math.round(n.midi))} (${n.cents > 0 ? "+" : ""}${n.cents} cents) -> ${midiToNoteName(midi)}`}</title>
                      </rect>
                      {(isDragging || corrected) && (
                        <text x={x} y={layout.yForMidi(midi) - 3} fontSize={10} fill="#ffffff">
                          {midiToNoteName(midi)} ({midi - originalMidi >= 0 ? "+" : ""}
                          {midi - originalMidi} st)
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              </div>
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
              disabled={!tunedResult}
            />
            <span className="text-xs text-muted">
              Tuned{comparing === "tuned" ? " (selected)" : ""}
              {previewLoading && (
                <span className="ml-1 animate-pulse">{previewIsFull ? "Rendering full preview..." : "Updating preview..."}</span>
              )}
            </span>

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
            Drag a note up or down onto its line to tune it. Green means it is already in tune (0 cents). Key and
            Scale decide which notes are allowed; Retune Speed sets how hard the correction snaps, Fast is classic
            autotune, Slow keeps it natural.
          </Surface>
        </>
      )}
    </div>
  );
}
