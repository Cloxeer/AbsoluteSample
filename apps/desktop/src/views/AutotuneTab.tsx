import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Check, Download, GraduationCap, Headphones, Maximize2, Merge, Redo2, RotateCcw, Sparkles, Undo2, Wand2, ZoomIn, ZoomOut } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { InfoTip } from "@/components/neumorphic/InfoTip";
import { PlayPauseButton } from "@/components/neumorphic/PlayPauseButton";
import { Slider } from "@/components/neumorphic/Slider";
import { AutotuneSource, type AutotuneSourceHandle, type AutotuneSourceValue } from "@/components/layout/AutotuneSource";
import { NoteCanvas, profilesFor, type NoteCanvasHandle } from "@/components/autotune/NoteCanvas";
import { TrackList } from "@/components/autotune/TrackList";
import { heardAnalysis, useAutotuneTracks, type AutotuneDeps, type SavedExport, type TuneTrack } from "@/hooks/useAutotuneTracks";
import { nowPlaying, type NowPlayingController } from "@/lib/nowPlaying";
import { findSections, isClash, MIN_NOTE_SEC, planFixHarmonies, type StackTrack } from "@/lib/harmonizer";
import { planTightTiming } from "@/lib/harmonyTiming";
import { outToIn, warpAnalysis, type WarpSegment } from "@/lib/timeWarp";
import { coachNote, coachSummary, nextNoteHints, renderGuide } from "@/lib/vocalCoach";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/mediaUrl";
import { samplePlayer } from "@/lib/samplePlayer";
import { mixEngine } from "@/lib/mixEngine";
import { autotunedName, decodeTrack, type DecodedTrack } from "@/lib/audioFormat";
import { estimateOffset } from "@/lib/alignment";
import { detectKeyAcross, intervalTo, leadNoteAt } from "@/lib/harmony";
import type { GhostTrack } from "@/lib/melodyneDraw";
import {
  noteAtTime,
  allowedPitchClasses,
  applyNoteParams,
  correctPitch,
  formatCents,
  formatTime,
  keyLabel,
  nearestAllowed,
  parseMode,
  parseTonic,
  PEAK_BLOCK,
  PITCH_NAMES,
  pitchReadout,
  SCALE_MODES,
  scalePitchClasses,
  snapshotNotes,
  stepAllowed,
  type Analysis,
  type NoteEdit,
  type NoteSnapshot,
  type ScaleMode,
  type SnapMode,
} from "@/lib/melodyneEditor";
import { createWorkerPitchEngine, restoreSnapshot, type EditResult, type PitchEngine } from "@/lib/pitchEngine";
import { createMultiTrackPlayer, type PlaySource } from "@/lib/multiTrackPlayer";
import type { InstrumentStem, Sample, TrackInfo } from "@/lib/types";

export type { AutotuneDeps } from "@/hooks/useAutotuneTracks";

export interface AutotuneTabProps {
  track: TrackInfo | null;
  instruments: InstrumentStem[] | null;
  samples: Sample[];
  deps?: Partial<AutotuneDeps>;
  /** False while another tab is shown (the editor stays mounted so your takes are kept). */
  active?: boolean;
}

/** The transport's name for this tab's audio. */
export const AUTOTUNE_TAB = "autotune";

const URLISH = /^(\/|\.\/|https?:|blob:|data:|asset:)/i;

/** Reads the chosen source's bytes without any Python backend (the dropped File, a URL, or a desktop
 * path) and decodes it at its native rate, keeping its channels so exports match the original. */
async function defaultDecode(src: AutotuneSourceValue): Promise<DecodedTrack> {
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
  return decodeTrack(bytes, src.file?.name ?? src.path);
}

const DEFAULT_DEPS: AutotuneDeps = {
  createEngine: createWorkerPitchEngine,
  createPlayer: () => createMultiTrackPlayer(),
  decode: defaultDecode,
  estimateOffset: (lead, other, sampleRate) => estimateOffset(lead, other, sampleRate),
};

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
 * Melodyne-style multitrack note editor: a lead vocal plus harmony takes, played together in time.
 * Each take is analysed and re-rendered in the browser by its own pitchcore WebAssembly engine (in a
 * Web Worker), so it behaves the same in the desktop app and on the web. The active track's notes are
 * editable; the other tracks are drawn behind it as ghosts in their colors.
 */
export function AutotuneTab({ track, instruments, samples = [], deps: depsProp, active: tabActive = true }: AutotuneTabProps) {
  const deps = useMemo<AutotuneDeps>(() => ({ ...DEFAULT_DEPS, ...depsProp }), [depsProp]);
  const T = useAutotuneTracks(deps);
  const { player, tracks } = T;
  const TRef = useRef(T);
  TRef.current = T;

  const active = tracks.find((t) => t.id === T.activeId) ?? null;
  // What you HEAR (timing edits applied); edits address the engine's notes by index, so this is safe.
  const analysis = active?.status === "ready" ? heardAnalysis(active) : null;
  const lead = tracks.find((t) => t.isLead) ?? null;
  const multi = tracks.length > 1;

  const [selected, setSelectedState] = useState<Set<number>>(() => new Set());
  const selectedRef = useRef(selected);
  const [overrides, setOverrides] = useState<Map<number, number> | null>(null);

  const [snap, setSnap] = useState<SnapMode>("scale");
  const [tonicPc, setTonicPc] = useState(0);
  const [mode, setMode] = useState<ScaleMode>("major");
  const [keyManual, setKeyManual] = useState(false);
  const [detected, setDetected] = useState<string | null>(null);
  const [centerPct, setCenterPct] = useState(90);
  const [driftPct, setDriftPct] = useState(70);
  /** Fix harmonies: 0 natural .. 100 tight. */
  const [tightPct, setTightPct] = useState(25);
  const [tightenTiming, setTightenTiming] = useState(true);
  const [fixSummary, setFixSummary] = useState<string | null>(null);
  const [guideOn, setGuideOn] = useState(false);
  const [polishOn, setPolishOn] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  /** Index of the note the info panel shows (selection, else the note at the playhead). */
  const focusRef = useRef<number | null>(null);
  const [abSource, setAbSource] = useState<PlaySource>("tuned");
  const [exporting, setExporting] = useState<"track" | "all" | null>(null);
  /** Files written by the last export (shown as a confirmation). */
  const [lastSaved, setLastSaved] = useState<SavedExport[] | null>(null);
  const [now, setNow] = useState(() => performance.now());

  const liveRef = useRef<{ running: boolean; pending: NoteEdit[] | null; onDone?: (r: EditResult) => void; epoch: number; trackId: string | null }>({
    running: false,
    pending: null,
    epoch: 0,
    trackId: null,
  });
  const dragBeforeRef = useRef<NoteSnapshot[] | null>(null);
  const canvasRef = useRef<NoteCanvasHandle>(null);
  const sourceRef = useRef<AutotuneSourceHandle>(null);

  const setSelected = (s: Set<number>) => {
    selectedRef.current = s;
    setSelectedState(s);
  };
  /** The edited track's id and current analysis (read at call time, never stale). */
  const aid = () => TRef.current.activeRef.current;
  const curAnalysis = (id = aid()): Analysis | null => {
    const t = TRef.current.getTrack(id);
    return t?.status === "ready" ? t.analysis : null;
  };
  /** The same, as heard (note times after timing edits). */
  const curHeard = (id = aid()): Analysis | null => {
    const t = TRef.current.getTrack(id);
    return t?.status === "ready" ? heardAnalysis(t) : null;
  };
  const tabActiveRef = useRef(tabActive);
  tabActiveRef.current = tabActive;

  // ---- Transport link: the big Play/Stop at the top drives these vocals like any other source ----
  const controllerRef = useRef<NowPlayingController | null>(null);
  controllerRef.current ??= {
    pause: () => player.pause(),
    resume: () => startPlayback(),
    stop: () => {
      player.pause();
      player.seek(0);
    },
  };
  const startPlayback = () => {
    if (!TRef.current.tracksRef.current.some((t) => t.status === "ready")) return;
    if (samplePlayer.getState().id) samplePlayer.stop();
    if (mixEngine.isPlaying) mixEngine.pause();
    player.play();
  };

  // ---- Lifecycle ----
  useEffect(() => {
    let was = player.isPlaying();
    const ctl = controllerRef.current as NowPlayingController;
    const sync = () => {
      const now = player.isPlaying();
      setPlaying(now);
      setAbSource(player.getSource());
      setPlayheadSec(player.currentTime());
      if (now && !was) nowPlaying.start("vocal", "Vocals", player.duration(), ctl);
      else if (!now && was && nowPlaying.isCurrent(ctl)) nowPlaying.setPlaying(false);
      if (nowPlaying.isCurrent(ctl)) nowPlaying.tick(player.currentTime());
      was = now;
    };
    sync();
    const off = player.subscribe(sync);
    return () => {
      off();
      if (nowPlaying.isCurrent(ctl)) nowPlaying.stop();
    };
  }, [player]);

  // While playing, keep the info panel (and the transport clock) on the note being heard.
  useEffect(() => {
    if (!playing) return;
    const ctl = controllerRef.current as NowPlayingController;
    const id = window.setInterval(() => {
      const t = player.currentTime();
      setPlayheadSec(t);
      if (nowPlaying.isCurrent(ctl)) nowPlaying.tick(t);
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, player]);

  // What "Play" means on this tab once a take is ready.
  const anyReady = tracks.some((t) => t.status === "ready");
  useEffect(() => {
    nowPlaying.setTabSource(AUTOTUNE_TAB, anyReady ? { kind: "vocal", label: "Vocals", start: () => startPlayback() } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyReady]);
  useEffect(() => () => nowPlaying.setTabSource(AUTOTUNE_TAB, null), []);

  // Progress bars of tracks still loading.
  const anyLoading = tracks.some((t) => t.status === "queued" || t.status === "decoding" || t.status === "analyzing");
  useEffect(() => {
    if (!anyLoading) return;
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, [anyLoading]);

  // A different track is being edited: its own selection starts empty.
  useEffect(() => {
    setSelected(new Set());
    setOverrides(null);
    const L = liveRef.current;
    L.epoch++;
    L.pending = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [T.activeId]);

  // Default key: over every ready track (lead counts double), until the user picks one.
  const readySig = tracks
    .filter((t) => t.status === "ready")
    .map((t) => `${t.id}${t.isLead ? "*" : ""}`)
    .join(",");
  useEffect(() => {
    const ready = TRef.current.tracksRef.current.filter((t) => t.status === "ready" && t.analysis);
    if (ready.length === 0) {
      setDetected(null);
      return;
    }
    let est: { tonicPc: number; mode: ScaleMode } | null = null;
    const only = ready.length === 1 ? ready[0].analysis : null;
    if (only?.key) {
      // One take: the engine's key uses the whole pitch contour, which is more reliable.
      est = { tonicPc: parseTonic(only.key.tonic), mode: parseMode(only.key.mode) };
    } else {
      const k = detectKeyAcross(ready.map((t) => ({ notes: (t.analysis as Analysis).notes, weight: t.isLead ? 2 : 1 })));
      if (k) est = { tonicPc: k.tonicPc, mode: k.mode };
    }
    setDetected(est ? keyLabel({ tonic: est.tonicPc, mode: est.mode, confidence: 1 }) : null);
    if (est && !keyManual) {
      setTonicPc(est.tonicPc);
      setMode(est.mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readySig]);

  // ---- Engine operations ----
  /** Latest-wins live update (drag steps, slider moves): intermediate states are skipped when busy. */
  const pushLive = (id: string, edits: NoteEdit[], onDone?: (r: EditResult) => void) => {
    const L = liveRef.current;
    if (L.running) {
      L.pending = edits;
      L.onDone = onDone;
      return;
    }
    L.running = true;
    L.trackId = id;
    const epoch = L.epoch;
    void TRef.current
      .runOp(id, (e) => e.setNotes(edits), {
        applyAnalysis: () => L.pending === null && epoch === L.epoch,
        after: (r) => {
          if (epoch === L.epoch) onDone?.(r);
        },
      })
      .finally(() => {
        L.running = false;
        const next = L.pending;
        const nextDone = L.onDone;
        L.pending = null;
        if (next && epoch === L.epoch) pushLive(id, next, nextDone);
      });
  };

  const audition = (id: string, index: number, raw: Analysis | null = curAnalysis(id)) => {
    const t = TRef.current.getTrack(id);
    const a = raw && t ? warpAnalysis(raw, t.warps) : null;
    const n = a?.notes[index];
    if (!n || !t || player.isPlaying()) return;
    player.audition(id, n.startSec + t.offsetSec, Math.min(n.endSec, n.startSec + 1.6) + t.offsetSec);
  };

  /** Pushes an undo step, updates the notes optimistically and sends the edits to the track's engine. */
  const commitEdits = (edits: NoteEdit[], opts: { undoKey?: string; audition?: number; live?: boolean; trackId?: string } = {}) => {
    const id = opts.trackId ?? aid();
    const cur = curAnalysis(id);
    if (!id || !cur || edits.length === 0) return;
    const T0 = TRef.current;
    T0.undoOf(id)?.push(snapshotNotes(cur.notes), opts.undoKey);
    T0.bumpUndo(id);
    T0.setLocalNotes(id, applyNoteParams(cur.notes, edits));
    const done = opts.audition !== undefined ? (r: EditResult) => audition(id, opts.audition as number, r.analysis) : undefined;
    if (opts.live) pushLive(id, edits, done);
    else void T0.runOp(id, (e) => e.setNotes(edits), { after: done });
  };

  const noteEdit = (i: number, patch: Partial<NoteEdit>): NoteEdit | null => {
    const n = curAnalysis()?.notes[i];
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
    if (player.isPlaying()) player.pause();
    else startPlayback();
  };

  // ---- Note actions (active track) ----
  const handleSelect = (s: Set<number>) => setSelected(s);

  const handleDragStart = () => {
    const cur = curAnalysis();
    dragBeforeRef.current = cur ? snapshotNotes(cur.notes) : null;
  };

  const handleDragUpdate = (targets: Map<number, number>, primary: number) => {
    const id = aid();
    if (!id) return;
    setOverrides(new Map(targets));
    const edits = [...targets].map(([i, t]) => noteEdit(i, { target: t })).filter((e): e is NoteEdit => e !== null);
    pushLive(id, edits, (r) => audition(id, primary, r.analysis));
  };

  const handleDragEnd = (targets: Map<number, number> | null) => {
    const id = aid();
    const cur = curAnalysis();
    if (!targets || !cur || !id) {
      setOverrides(null);
      return;
    }
    const L = liveRef.current;
    L.epoch++;
    L.pending = null;
    const edits = [...targets].map(([i, t]) => noteEdit(i, { target: t })).filter((e): e is NoteEdit => e !== null);
    const T0 = TRef.current;
    T0.undoOf(id)?.push(dragBeforeRef.current ?? snapshotNotes(cur.notes));
    T0.bumpUndo(id);
    dragBeforeRef.current = null;
    T0.setLocalNotes(id, applyNoteParams(cur.notes, edits));
    setOverrides(null);
    void T0.runOp(id, (e) => e.setNotes(edits));
  };

  const handleSnapNote = (i: number) => {
    const n = curAnalysis()?.notes[i];
    if (!n) return;
    setSelected(new Set([i]));
    const e = noteEdit(i, { target: nearestAllowed(n.target, allowedRef.current) });
    if (e) commitEdits([e], { audition: i });
  };

  const structural = (task: (e: PitchEngine) => Promise<EditResult>, select: number) => {
    const id = aid();
    const cur = curAnalysis();
    if (!id || !cur) return;
    const T0 = TRef.current;
    T0.undoOf(id)?.push(snapshotNotes(cur.notes));
    T0.bumpUndo(id);
    setSelected(new Set([select]));
    void T0.runOp(id, task);
  };

  // The canvas speaks heard time; the engine splits in the take's own time.
  const handleSplit = (i: number, sec: number) => {
    const warps = TRef.current.getTrack(aid())?.warps ?? [];
    const at = outToIn(warps, sec);
    structural((e) => e.split(i, at), i);
  };

  const handleMerge = () => {
    const cur = curAnalysis();
    if (!cur || selectedRef.current.size === 0) return;
    const i = Math.min(...selectedRef.current);
    if (i + 1 >= cur.notes.length) return;
    structural((e) => e.merge(i), i);
  };

  const targetIndices = () => {
    const cur = curAnalysis();
    if (!cur) return [];
    return selectedRef.current.size > 0 ? [...selectedRef.current].sort((a, b) => a - b) : cur.notes.map((_, i) => i);
  };

  const handleReset = () => {
    const cur = curAnalysis();
    if (!cur) return;
    const id = aid();
    const t = id ? TRef.current.getTrack(id) : null;
    if (t && selectedRef.current.size === 0 && t.warps.length > 0) void TRef.current.setWarps(t.id, []);
    const edits = targetIndices()
      .map((i) => noteEdit(i, { target: cur.notes[i].center, drift: 1, modulation: 1 }))
      .filter((e): e is NoteEdit => e !== null);
    commitEdits(edits);
  };

  const applyCorrection = (cPct: number, dPct: number, pcs: readonly number[]) => {
    const cur = curAnalysis();
    if (!cur) return;
    const edits = targetIndices().map((i) => ({ index: i, ...correctPitch(cur.notes[i], cPct / 100, dPct / 100, pcs) }));
    commitEdits(edits);
  };

  /** Correct Pitch at 100% / 50% on every note of every ready track that is included. */
  const handleTuneAll = () => {
    for (const t of TRef.current.tracksRef.current) {
      if (t.status !== "ready" || !t.analysis || !t.includeInTuneAll) continue;
      const edits = t.analysis.notes.map((n, i) => ({ index: i, ...correctPitch(n, 1, 0.5, scalePcs) }));
      commitEdits(edits, { trackId: t.id });
    }
  };

  /**
   * Fix harmonies: tighten each harmony's timing to the lead (optional), then give every held note the
   * best note of the key for the stack, gently. One undo step per track; the lead is the reference.
   */
  const handleFixHarmonies = async () => {
    const T0 = TRef.current;
    const ready = T0.tracksRef.current.filter((t) => t.status === "ready" && t.analysis);
    if (ready.length === 0) return;
    const lead = ready.find((t) => t.isLead) ?? ready[0];
    const tight = tightPct / 100;
    const include = new Set(ready.filter((t) => t.includeInTuneAll).map((t) => t.id));
    const leadHeard = heardAnalysis(lead) as Analysis;
    const leadTimeline = leadHeard.notes.map((n) => ({ startSec: n.startSec + lead.offsetSec, endSec: n.endSec + lead.offsetSec }));

    // 1. Timing (harmonies only).
    const warpsById = new Map<string, WarpSegment[]>();
    let syllables = 0;
    for (const t of ready) {
      if (t.id === lead.id || !include.has(t.id)) continue;
      if (!tightenTiming) {
        if (t.warps.length > 0) warpsById.set(t.id, []);
        continue;
      }
      const a = t.analysis as Analysis;
      const plan = planTightTiming({ lead: leadTimeline, notes: a.notes, offsetSec: t.offsetSec, durationSec: a.durationSec, tight });
      warpsById.set(t.id, plan.segments);
      syllables += plan.moved;
    }

    // 2. Notes, planned on the timing as it will be heard.
    const stack: StackTrack[] = ready.map((t) => ({
      id: t.id,
      notes: warpAnalysis(t.analysis as Analysis, warpsById.get(t.id) ?? t.warps).notes,
      offsetSec: t.offsetSec,
      isLead: t.id === lead.id,
    }));
    const plan = planFixHarmonies(stack, include, { scalePcs, tight });
    let fixed = 0;
    let clashesFixed = 0;
    for (const f of plan.tracks) {
      fixed += f.fixed;
      clashesFixed += Math.max(0, f.clashesBefore - f.clashesAfter);
      if (f.id !== lead.id) T0.setRole(f.id, f.role);
      if (f.edits.length > 0) commitEdits(f.edits, { trackId: f.id });
    }
    const pending: Promise<boolean>[] = [];
    for (const [id, segs] of warpsById) {
      const cur = T0.getTrack(id)?.warps ?? [];
      if (cur.length === 0 && segs.length === 0) continue;
      pending.push(T0.setWarps(id, segs));
    }
    const multiTrack = ready.length > 1;
    const parts = [`${fixed} note${fixed === 1 ? "" : "s"} tuned`];
    if (clashesFixed > 0) parts.push(`${clashesFixed} clash${clashesFixed === 1 ? "" : "es"} smoothed`);
    if (multiTrack && tightenTiming) parts.push(syllables > 0 ? `${syllables} syllable${syllables === 1 ? "" : "s"} tightened to the lead` : "timing already tight");
    setFixSummary(parts.join(" · "));
    await Promise.all(pending);
  };

  const handleTightenTiming = (on: boolean) => {
    setTightenTiming(on);
    if (on) return;
    // Off: put every take's timing back as it was sung.
    for (const t of TRef.current.tracksRef.current) if (t.warps.length > 0) void TRef.current.setWarps(t.id, []);
  };

  const handleParamSlider = (param: "modulation" | "drift") => (pct: number) => {
    // Acts on the selection, or on the note at the playhead when nothing is selected.
    const idx = selectedRef.current.size > 0 ? [...selectedRef.current] : focusRef.current !== null ? [focusRef.current] : [];
    const edits = idx.map((i) => noteEdit(i, { [param]: pct / 100 })).filter((e): e is NoteEdit => e !== null);
    commitEdits(edits, { undoKey: param, live: true });
  };

  const stepSelected = (dir: 1 | -1) => {
    const cur = curAnalysis();
    if (!cur || selectedRef.current.size === 0) return;
    const idx = [...selectedRef.current].sort((a, b) => a - b);
    const edits = idx
      .map((i) => noteEdit(i, { target: stepAllowed(cur.notes[i].target, dir, allowedRef.current) }))
      .filter((e): e is NoteEdit => e !== null);
    commitEdits(edits, { audition: idx[0] });
  };

  const handleUndo = (redo = false) => {
    const id = aid();
    const cur = curAnalysis();
    const stack = id ? TRef.current.undoOf(id) : null;
    if (!id || !cur || !stack) return;
    const snapNow = snapshotNotes(cur.notes);
    const target = redo ? stack.redo(snapNow) : stack.undo(snapNow);
    TRef.current.bumpUndo(id);
    if (!target) return;
    setSelected(new Set());
    void TRef.current.runOp(id, (e, current) => restoreSnapshot(e, current, target));
  };

  // ---- Tracks ----
  const handleAlign = (id: string) => {
    TRef.current.alignToLead(id);
  };
  const handleNudge = (id: string, delta: number) => {
    const t = TRef.current.getTrack(id);
    if (!t) return;
    TRef.current.setOffset(id, t.offsetSec + delta);
    if (t.alignNote) TRef.current.clearAlignNote(id);
  };
  const toggleMix = (which: "muted" | "solo") => {
    const t = TRef.current.getTrack(aid());
    if (t) TRef.current.setMix(t.id, { [which]: !t[which] });
  };

  // ---- Keyboard ----
  const keyHandlersRef = useRef({ handleUndo, stepSelected, toggleMix });
  keyHandlersRef.current = { handleUndo, stepSelected, toggleMix };
  useEffect(() => {
    // Space is handled once, by the app transport (it plays these vocals on this tab).
    const onKey = (e: KeyboardEvent) => {
      if (!tabActiveRef.current) return;
      if (!TRef.current.tracksRef.current.some((t) => t.status === "ready")) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      const h = keyHandlersRef.current;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
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
      } else if (!mod && !e.altKey && (key === "m" || key === "s")) {
        h.toggleMix(key === "m" ? "muted" : "solo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Export ----
  const isSaved = (t: TuneTrack) => t.saved !== null && t.saved.forAnalysis === t.analysis && !!t.saved.polished === polishOn;
  const readyTracks = tracks.filter((t) => t.status === "ready");
  const unsaved = readyTracks.filter((t) => !isSaved(t));
  const activeSaved = active !== null && isSaved(active);
  const exportName = active ? autotunedName(active.name) : "vocal-autotuned.wav";

  const saveTracks = async (ids: string[], kind: "track" | "all") => {
    if (exporting || ids.length === 0) return;
    setExporting(kind);
    const done: SavedExport[] = [];
    try {
      for (const id of ids) done.push(await TRef.current.exportTrack(id, { polish: polishOn }));
    } catch (err) {
      TRef.current.setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (done.length > 0) setLastSaved(done);
      setExporting(null);
    }
  };
  const handleDownload = () => {
    if (active && !activeSaved) void saveTracks([active.id], "track");
  };
  const handleDownloadAll = () => void saveTracks(unsaved.map((t) => t.id), "all");

  // ---- Timeline + ghosts ----
  const timelineSec = useMemo(
    () => Math.max(0, ...tracks.map((t) => t.offsetSec + (t.analysis?.durationSec ?? (t.frames > 0 ? t.frames / t.sampleRate : 0)))),
    [tracks]
  );
  const ghostSig = tracks
    .filter((t) => t.id !== active?.id && t.status === "ready")
    .map((t) => t.id)
    .join(",");
  const ghostTracksRef = useRef<GhostTrack[]>([]);
  const ghosts = useMemo(() => {
    const anySolo = tracks.some((t) => t.solo);
    const next: GhostTrack[] = tracks
      .filter((t) => t.id !== active?.id && t.status === "ready" && t.analysis)
      .map((t) => {
        const a = heardAnalysis(t) as Analysis;
        return { id: t.id, color: t.color, notes: a.notes, profiles: profilesFor(a), hopSec: a.hopSec, offsetSec: t.offsetSec, dim: t.muted || (anySolo && !t.solo) };
      });
    // Keep the same array when nothing a ghost draws has changed (avoids needless scene redraws).
    const prev = ghostTracksRef.current;
    const same =
      prev.length === next.length &&
      prev.every((g, i) => {
        const n = next[i];
        return g.id === n.id && g.notes === n.notes && g.color === n.color && g.offsetSec === n.offsetSec && g.dim === n.dim;
      });
    if (!same) ghostTracksRef.current = next;
    return ghostTracksRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, active?.id, ghostSig]);

  // ---- Inspector values ----
  // The panel shows the selected note, or (with nothing selected) the note at the playhead.
  const localPlayhead = playheadSec - (active?.offsetSec ?? 0);
  const atPlayhead = selected.size === 0 && analysis ? noteAtTime(analysis.notes, localPlayhead) : null;
  const primary = selected.size > 0 ? Math.min(...selected) : atPlayhead?.index ?? null;
  focusRef.current = primary;
  const primaryNote = primary !== null ? analysis?.notes[primary] ?? null : null;
  const dragged = overrides !== null && overrides.size > 0;
  const shownIndex = dragged && primary !== null && !overrides.has(primary) ? [...overrides.keys()][0] : primary;
  const shownNote = shownIndex !== null ? analysis?.notes[shownIndex] ?? null : null;
  const primaryPitch = shownNote && shownIndex !== null ? overrides?.get(shownIndex) ?? shownNote.target : null;
  const readout = primaryPitch !== null ? pitchReadout(primaryPitch) : null;
  const hasSelection = selected.size > 0;

  // Harmony help: interval of the edited harmony note to the lead note sounding at the same time.
  let interval: { label: string; clash: boolean } | null = null;
  const leadHeard = lead && lead.status === "ready" ? heardAnalysis(lead) : null;
  if (active && lead && lead.id !== active.id && leadHeard && shownNote && primaryPitch !== null && (hasSelection || dragged)) {
    const mid = (shownNote.startSec + shownNote.endSec) / 2 + active.offsetSec;
    const ln = leadNoteAt(leadHeard.notes, lead.offsetSec, mid);
    interval = ln ? intervalTo(ln.target, primaryPitch) : { label: "Lead is silent here", clash: false };
  }

  // Where the lead sings alone and where the stack is (only with harmonies loaded).
  const sections = useMemo(() => {
    const ready = tracks.filter((t) => t.status === "ready" && t.analysis);
    if (ready.length < 2) return undefined;
    return findSections(ready.map((t) => ({ id: t.id, notes: (heardAnalysis(t) as Analysis).notes, offsetSec: t.offsetSec, isLead: t.isLead })));
  }, [tracks]);
  // Harmony notes that rub against the lead get a red edge.
  const clashes = useMemo(() => {
    if (!analysis || !active || !leadHeard || !lead || lead.id === active.id) return undefined;
    const out = new Set<number>();
    analysis.notes.forEach((n, i) => {
      if (n.endSec - n.startSec < MIN_NOTE_SEC) return;
      const ln = leadNoteAt(leadHeard.notes, lead.offsetSec, (n.startSec + n.endSec) / 2 + active.offsetSec);
      if (ln && ln.endSec - ln.startSec >= MIN_NOTE_SEC && isClash(Math.round(n.target) - Math.round(ln.target))) out.add(i);
    });
    return out;
  }, [analysis, active, leadHeard, lead]);

  // Coach: judged on what was SUNG (the detected centers), so it tells you how to sing it next time.
  const coach = useMemo(() => (analysis ? coachSummary(analysis, scalePcs) : null), [analysis, scalePcs]);
  const noteTip = shownNote && analysis ? coachNote(shownNote, analysis.pitch, scalePcs) : null;
  const hints = primaryPitch !== null ? nextNoteHints(primaryPitch, tonicPc, scalePcs) : [];

  // Guide tone: the tuned melody of the edited track, quietly, so you can sing along to the right notes.
  const guideSig = guideOn && analysis && active ? `${active.id}:${active.offsetSec}` : null;
  useEffect(() => {
    if (!guideSig || !analysis || !active) {
      player.setGuide(null);
      return;
    }
    const tmr = window.setTimeout(() => player.setGuide(renderGuide(analysis.notes, active.sampleRate, analysis.durationSec), active.sampleRate, active.offsetSec), 150);
    return () => window.clearTimeout(tmr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideSig, analysis, player]);
  useEffect(() => player.setPolish(polishOn), [polishOn, player]);

  const jumpTo = (index: number) => {
    const n = analysis?.notes[index];
    if (!n || !active) return;
    setSelected(new Set([index]));
    const at = n.startSec + active.offsetSec;
    player.seek(Math.max(0, at - 0.5));
    canvasRef.current?.reveal(at);
  };

  const loadingTrack = active && active.status !== "ready" && active.status !== "error" ? active : null;
  const elapsed = loadingTrack ? Math.max(0, (now - loadingTrack.startedAt) / 1000) : 0;
  const audioSec = loadingTrack && loadingTrack.frames > 0 ? loadingTrack.frames / loadingTrack.sampleRate : 30;
  const est = Math.max(1.5, audioSec * 0.1 + 0.5);
  const progress = !loadingTrack
    ? 0
    : loadingTrack.status === "analyzing"
      ? Math.min(0.96, 0.15 + (0.85 * elapsed) / est)
      : Math.min(0.15, elapsed / 4);
  const shownError = T.error ?? (active?.status === "error" ? active.error : null);
  const undoStack = active ? T.undoOf(active.id) : null;

  const savedLine = lastSaved && lastSaved.length > 0 && (
    <span data-testid="autotune-saved" role="status" className="text-[11px] text-muted max-w-[460px] truncate" title={lastSaved.map((s) => s.name).join(", ")}>
      {lastSaved[0].path ? (
        <>
          {lastSaved.length === 1 ? (
            <>
              Saved to Downloads as <span className="text-text font-medium">{lastSaved[0].name}</span>
            </>
          ) : (
            <>
              Saved {lastSaved.length} files to Downloads: <span className="text-text font-medium">{lastSaved.map((s) => s.name).join(", ")}</span>
            </>
          )}
          {" · "}
          <button type="button" className="underline hover:text-text" onClick={() => void backend.revealDownload(lastSaved[0].path as string)}>
            Show in folder
          </button>
        </>
      ) : lastSaved.length === 1 ? (
        <>
          Downloaded <span className="text-text font-medium">{lastSaved[0].name}</span> (check your browser&apos;s downloads)
        </>
      ) : (
        <>
          Downloaded {lastSaved.length} files: <span className="text-text font-medium">{lastSaved.map((s) => s.name).join(", ")}</span> (check your
          browser&apos;s downloads)
        </>
      )}
    </span>
  );

  return (
    <div className="flex flex-col gap-4 px-6 py-4 max-w-6xl mx-auto w-full">
      <AutotuneSource
        ref={sourceRef}
        instruments={instruments}
        samples={samples}
        onAdd={(values) => void T.addSources(values)}
        hasTracks={tracks.length > 0}
        trackId={track?.id ?? null}
      />

      {tracks.length > 0 && (
        <Surface variant="raised" className="p-2.5">
          <TrackList
            tracks={tracks}
            activeId={T.activeId}
            onSelect={T.setActiveId}
            onMakeLead={T.setLead}
            onMix={T.setMix}
            onNudge={handleNudge}
            onAlign={handleAlign}
            onInclude={T.setIncluded}
            onRemove={(id) => {
              T.removeTrack(id);
              setLastSaved(null);
            }}
            onAdd={() => sourceRef.current?.choose()}
          />
        </Surface>
      )}

      {loadingTrack && (
        <Surface variant="raised" className="p-5 flex flex-col gap-3" data-testid="autotune-loading">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text font-medium">
              {loadingTrack.status === "analyzing" ? "Analyzing vocal…" : loadingTrack.status === "queued" ? "Waiting for the other takes…" : "Opening audio…"}
            </span>
            <span className="text-xs text-muted tabular-nums font-mono">{elapsed.toFixed(1)} s</span>
          </div>
          <div className="h-2 rounded-full neu-surface-inset overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#F0A04B] to-[#D8553A] transition-[width] duration-200"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span className="text-[11px] text-muted">
            Finding every note in {loadingTrack.name}. This runs on your computer and takes a few seconds.
          </span>
        </Surface>
      )}

      {shownError && (
        <Surface variant="raised" className="p-4 text-sm text-danger" role="alert">
          {shownError}
        </Surface>
      )}

      {tracks.length === 0 && (
        <Surface variant="raised" className="p-8 text-center text-sm text-muted">
          Drop your vocal or pick one from the song. Add harmony takes too: they play together and you can tune every one.
        </Surface>
      )}

      {analysis && active && (
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
              <Button
                type="button"
                pressed={polishOn}
                tone="cyan"
                aria-label="Studio polish"
                title="Studio polish: the finishing chain engineers use (rumble cut, less mud, presence and air, gentle compression, a short plate reverb). Also applied to downloads while on."
                onClick={() => setPolishOn((v) => !v)}
                className="!px-3 !py-1.5 inline-flex items-center gap-1.5 text-xs"
              >
                <Sparkles size={13} /> Polish
              </Button>
              <Button
                type="button"
                pressed={guideOn}
                tone="cyan"
                aria-label="Guide notes"
                title="Plays the right notes of this track as a soft tone under your voice, so you can learn to hit them"
                onClick={() => setGuideOn((v) => !v)}
                className="!px-3 !py-1.5 inline-flex items-center gap-1.5 text-xs"
              >
                <Headphones size={13} /> Guide notes
              </Button>
              <div className="w-px h-7 bg-white/5" />
              <Button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => handleUndo(false)} disabled={!undoStack?.canUndo} className="!px-2.5">
                <Undo2 size={15} />
              </Button>
              <Button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={() => handleUndo(true)} disabled={!undoStack?.canRedo} className="!px-2.5">
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
                <Label tip={{ term: "Key", text: "The song's key, found from every take. Blue rows are the notes in the key: stay on them and it sounds right. Notes snap to them." }}>Key</Label>
                <select
                  value={tonicPc}
                  onChange={(e) => {
                    setKeyManual(true);
                    setTonicPc(Number(e.target.value));
                  }}
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
                  onChange={(e) => {
                    setKeyManual(true);
                    setMode(e.target.value as ScaleMode);
                  }}
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
                <Label>
                  {multi && <span className="w-2 h-2 rounded-full inline-block" style={{ background: active.color }} aria-hidden />}
                  {hasSelection || dragged ? "Selected note" : atPlayhead && !atPlayhead.sounding ? "Next note" : "Note at playhead"}
                </Label>
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
                {interval && (
                  <span
                    data-testid="autotune-interval"
                    data-clash={interval.clash || undefined}
                    className={clsx("text-[11px] font-medium", interval.clash ? "text-[#F0C04B]" : "text-muted")}
                    title={interval.clash ? "This interval rubs against the lead when held" : undefined}
                  >
                    {interval.clash ? "⚠ " : ""}
                    {interval.label}
                  </span>
                )}
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
                <Button type="button" onClick={() => applyCorrection(centerPct, driftPct, allowedPcs)} title={hasSelection ? "Correct the selected notes" : "Correct every note of this track"}>
                  Correct Pitch
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleTuneAll}
                  title={multi ? "Correct every note of every ticked track" : "Correct every note"}
                  className="inline-flex items-center gap-1.5 !text-[#1a1300] !bg-[#F0A04B] !shadow-[0_0_16px_rgba(240,160,75,0.35)]"
                >
                  <Wand2 size={14} /> Tune all to key
                </Button>
              </div>
            </div>

            {/* Fix harmonies / Fix vocal */}
            <div className="flex flex-wrap items-end gap-4 px-1 pt-2 border-t border-white/5" data-testid="fix-harmonies">
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleFixHarmonies()}
                title={
                  multi
                    ? "Finds what each harmony is going for and snaps it to the best note of the key against the lead, gently (your voice, just in tune and in time)"
                    : "Tunes every held note gently to the key and keeps your natural slides and vibrato"
                }
                className="inline-flex items-center gap-1.5 !text-[#06202b] !bg-[#4FC3F7] !shadow-[0_0_16px_rgba(79,195,247,0.35)]"
              >
                <Sparkles size={14} /> {multi ? "Fix harmonies" : "Fix vocal"}
              </Button>
              <div className="flex flex-col gap-1.5">
                <Label tip={{ term: "Natural / Tight", text: "Natural keeps most of your voice's movement. Tight holds notes steadier for a polished, stacked sound." }}>
                  Natural ↔ Tight
                </Label>
                <div className="flex items-center gap-2">
                  <Slider value={tightPct} min={0} max={100} step={1} orientation="horizontal" onChange={setTightPct} label="Natural to tight" className="w-32" />
                  <span className="text-xs text-text w-10 tabular-nums font-mono">{Math.round(tightPct)}%</span>
                </div>
              </div>
              {multi && (
                <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer pb-1" title="Moves harmony syllables that start or end a little early/late onto the lead's timing (the lead never moves)">
                  <input type="checkbox" checked={tightenTiming} onChange={(e) => handleTightenTiming(e.target.checked)} aria-label="Tighten timing" className="accent-[#4FC3F7]" />
                  Tighten timing
                </label>
              )}
              {fixSummary && (
                <span role="status" data-testid="fix-summary" className="text-[11px] text-cyan pb-1">
                  {fixSummary}
                </span>
              )}
              {sections && (
                <span className="ml-auto flex items-center gap-3 text-[10px] text-muted pb-1" aria-label="Section colors">
                  <span className="inline-flex items-center gap-1"><span className="w-3 h-1 rounded bg-[#F0A04B]/70" /> Lead alone</span>
                  <span className="inline-flex items-center gap-1"><span className="w-3 h-1 rounded bg-[#4FC3F7]" /> Lead + harmonies</span>
                  <span className="inline-flex items-center gap-1"><span className="w-3 h-1 rounded bg-[#B388FF]/80" /> Harmonies alone</span>
                </span>
              )}
            </div>

            <div className="rounded-xl overflow-hidden neu-surface-inset">
              <NoteCanvas
                ref={canvasRef}
                analysis={analysis}
                sessionKey={active.id}
                overrides={overrides}
                selected={selected}
                scalePcs={scalePcs}
                tonicPc={tonicPc}
                snap={snap}
                peaks={active.peaks}
                peaksVersion={active.peaksVersion}
                peakBlock={PEAK_BLOCK}
                peakMax={active.peakMax}
                sampleRate={active.sampleRate}
                player={player}
                playing={playing}
                timeOffsetSec={active.offsetSec}
                timelineDurationSec={timelineSec}
                ghosts={ghosts}
                color={active.color}
                trackId={active.id}
                sections={sections}
                clashes={clashes}
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
                {multi && <span className="text-text">{active.name}: </span>}
                {analysis.notes.length} notes
                {active.analyzeSec !== null && ` · analyzed in ${active.analyzeSec.toFixed(1)} s`}
              </span>
              {T.busy > 0 && <span className="text-[10px] text-muted uppercase tracking-wide animate-pulse">Rendering…</span>}
              <div className="flex items-center gap-2 ml-auto">
                {isTauri() && (
                  <Button type="button" disabled title="Saving into your sample library needs a desktop write command that isn't available yet. Use Download WAV.">
                    Save as sample
                  </Button>
                )}
                {savedLine}
                <Button
                  type="button"
                  onClick={handleDownload}
                  busy={exporting === "track"}
                  disabled={activeSaved || exporting !== null}
                  title={activeSaved ? "This version is already saved. Change the tuning to save again." : `Save as ${exportName}`}
                  className="inline-flex items-center gap-1.5"
                >
                  {activeSaved ? (
                    <>
                      <Check size={14} /> Saved
                    </>
                  ) : (
                    <>
                      <Download size={14} /> {multi ? "Download track" : "Download WAV"}
                    </>
                  )}
                </Button>
                {multi && (
                  <Button
                    type="button"
                    onClick={handleDownloadAll}
                    busy={exporting === "all"}
                    disabled={unsaved.length === 0 || exporting !== null}
                    title={
                      unsaved.length === 0
                        ? "Every track is already saved. Change the tuning to save again."
                        : `Save ${unsaved.length} track${unsaved.length === 1 ? "" : "s"} as -autotuned.wav files (same length and start as the originals)`
                    }
                    className="inline-flex items-center gap-1.5"
                  >
                    {unsaved.length === 0 && readyTracks.length > 0 ? (
                      <>
                        <Check size={14} /> All saved
                      </>
                    ) : (
                      <>
                        <Download size={14} /> Download all
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          </Surface>

          <Surface variant="raised" className="p-4 flex flex-col gap-3 text-sm leading-relaxed text-text" data-testid="vocal-coach">
            <div className="flex items-center gap-2 text-[10px] text-muted uppercase tracking-wider">
              <GraduationCap size={13} className="text-cyan" /> Vocal coach{multi && <span className="normal-case tracking-normal">: {active.name}</span>}
            </div>
            {coach && coach.heldNotes > 0 ? (
              <div className="flex flex-wrap items-start gap-6">
                <div className="flex flex-col">
                  <span className="text-2xl font-bold font-mono tabular-nums" data-testid="coach-accuracy">
                    {Math.round((coach.accuracy ?? 0) * 100)}%
                  </span>
                  <span className="text-[11px] text-muted">notes sung on pitch</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-2xl font-bold font-mono tabular-nums" data-testid="coach-steadiness">
                    {coach.steadiness === null ? "–" : `${Math.round(coach.steadiness * 100)}%`}
                  </span>
                  <span className="text-[11px] text-muted">held steady</span>
                </div>
                <div className="flex flex-col gap-1.5 min-w-[220px]">
                  <span className="text-[11px] text-muted">{coach.practice.length > 0 ? "Practise these (click to hear where):" : "Every held note was close. Nice."}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {coach.practice.map((p) => (
                      <button
                        key={p.index}
                        type="button"
                        onClick={() => jumpTo(p.index)}
                        className="px-2 py-1 rounded-lg neu-surface-inset bg-surface text-[11px] hover:text-cyan"
                        title="Select this note and move the playhead there"
                      >
                        {formatTime(p.startSec + active.offsetSec, 0.1)} · aim {p.aimName} ({p.cents > 0 ? `${p.cents}¢ sharp` : `${-p.cents}¢ flat`})
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1 min-w-[240px] flex-1" data-testid="coach-note">
                  {noteTip ? (
                    <>
                      <span className="text-[11px] text-muted">This note ({hasSelection ? "selected" : "at the playhead"})</span>
                      <span>
                        Aim for <b className="font-mono">{noteTip.aimName}</b>
                        {Math.abs(noteTip.cents) > 5 && (
                          <span className="text-muted"> · you sang {Math.abs(noteTip.cents)}¢ {noteTip.cents < 0 ? "flat" : "sharp"}</span>
                        )}
                        {" · "}
                        <span className={clsx(noteTip.verdict.startsWith("On pitch") ? "text-cyan" : "text-[#F0C04B]")}>{noteTip.verdict}</span>
                      </span>
                      {hints.length > 0 && (
                        <span className="text-[12px] text-muted" data-testid="coach-next">
                          Where it likes to go next: {hints.map((h, i) => (
                            <span key={h.midi} title={h.why}>
                              {i > 0 && ", "}
                              <b className="text-text font-mono">{h.name}</b> <span className="text-[11px]">({h.why.toLowerCase()})</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-[12px] text-muted">Select a note (or press Play) to see which note to aim for and where the melody likes to go next.</span>
                  )}
                </div>
              </div>
            ) : (
              <span className="text-[12px] text-muted">Sing some held notes and the coach will show how close you were.</span>
            )}
            <div className="text-[12px] text-muted leading-relaxed border-t border-white/5 pt-2">
              Drag a note up or down; it snaps to the blue rows (the notes of the key). Double-click a note to snap it;
              double-click its top to split it. Space plays. Drag the bar under the notes to move through the song.
              {multi && " Click a track to edit it; the others show as outlines. Fix harmonies finds what each harmony is going for and locks it to the best note against the lead."}
            </div>
          </Surface>
        </>
      )}
    </div>
  );
}
