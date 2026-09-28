/**
 * Track state for the multitrack Autotune editor (lead vocal + harmony takes). Each track owns its own
 * pitch engine (Web Worker + wasm session), undo stack, waveform peaks and export state; all tracks
 * play through one multitrack player so they stay in time. Analysis runs in the background with at
 * most MAX_CONCURRENT_ANALYSES tracks working at once, so ready tracks stay playable and editable.
 */
import { useEffect, useRef, useState } from "react";
import type { AutotuneSourceValue } from "@/components/layout/AutotuneSource";
import { backend } from "@/lib/backend";
import { autotunedName, encodeWav, exportSpec, type DecodedTrack, type SourceFormat } from "@/lib/audioFormat";
import type { AlignResult } from "@/lib/alignment";
import {
  computePeaks,
  patchSamples,
  updatePeaks,
  PEAK_BLOCK,
  UndoStack,
  type Analysis,
  type EngineNote,
  type NoteSnapshot,
} from "@/lib/melodyneEditor";
import type { EditResult, PitchEngine } from "@/lib/pitchEngine";
import type { MultiTrackPlayer } from "@/lib/multiTrackPlayer";
import { warpAnalysis, type WarpSegment } from "@/lib/timeWarp";
import type { HarmonyRole } from "@/lib/harmonizer";
import { renderPolished } from "@/lib/vocalPolish";

/** Injectable dependencies (tests pass in-process fakes; jsdom has no Worker, wasm or Web Audio). */
export interface AutotuneDeps {
  createEngine: () => PitchEngine;
  createPlayer: () => MultiTrackPlayer;
  decode: (source: AutotuneSourceValue) => Promise<DecodedTrack>;
  estimateOffset: (lead: Float32Array, other: Float32Array, sampleRate: number) => AlignResult;
  /** Studio polish for exports (EQ, compression, plate); same channels and exact length. */
  polish?: (channels: Float32Array[], sampleRate: number) => Promise<Float32Array[]>;
}

/** Distinct track colors; the first (lead) keeps the editor's classic orange. */
export const TRACK_COLORS = ["#F0A04B", "#4FC3F7", "#B388FF", "#7BD88F", "#FF7AB6", "#FFD54F", "#4DD0C4", "#FF8A65"];
export const MAX_CONCURRENT_ANALYSES = 2;
/** Below this, "Line up" refuses to move the take. */
export const MIN_ALIGN_CONFIDENCE = 0.3;
/** Takes are lined up automatically on load only when the match is this clear. */
export const AUTO_ALIGN_CONFIDENCE = 0.5;
export const ALIGN_FAILED_MESSAGE = "No clear match found, so it was left where it is (it may already be in time). Use − / + to nudge by ear.";

export interface AlignNote {
  ok: boolean;
  message: string;
}

export type TrackStatus = "queued" | "decoding" | "analyzing" | "ready" | "error";

export interface SavedExport {
  name: string;
  /** Desktop path in Downloads; null for a browser download. */
  path: string | null;
  /** The exact tuning that was saved (the button stays "Saved" until it changes). */
  forAnalysis: Analysis | null;
  polished?: boolean;
  warps?: WarpSegment[];
}

export interface TuneTrack {
  id: string;
  name: string;
  color: string;
  source: AutotuneSourceValue;
  status: TrackStatus;
  error: string | null;
  analysis: Analysis | null;
  sampleRate: number;
  format: SourceFormat | null;
  /** Frames (samples per channel) of the source file. */
  frames: number;
  channelCount: number;
  offsetSec: number;
  volume: number;
  muted: boolean;
  solo: boolean;
  isLead: boolean;
  includeInTuneAll: boolean;
  analyzeSec: number | null;
  /** performance.now() when loading started (drives the progress bar). */
  startedAt: number;
  peaks: Float32Array | null;
  peakMax: number;
  peaksVersion: number;
  saved: SavedExport | null;
  undoVersion: number;
  /** Timing edits ("Tighten timing"), in the take's own time. */
  warps: WarpSegment[];
  /** Harmony role found by the last "Fix harmonies" (e.g. "High harmony (3rd above)"). */
  role: HarmonyRole | null;
  /** Result of the last line-up (automatic or by button). */
  alignNote: AlignNote | null;
}

/** The track's notes and curves as they will be HEARD (timing edits applied). */
export function heardAnalysis(t: Pick<TuneTrack, "analysis" | "warps">): Analysis | null {
  return t.analysis ? warpAnalysis(t.analysis, t.warps) : null;
}

interface Runtime {
  engine: PitchEngine | null;
  chain: Promise<unknown>;
  undo: UndoStack<NoteSnapshot[]>;
  /** Original mono mix (alignment). */
  mono: Float32Array | null;
  /** Tuned mono output (waveform). */
  output: Float32Array | null;
  disposed: boolean;
}

export type MixPatch = Partial<Pick<TuneTrack, "muted" | "solo" | "volume">>;

const FALLBACK_FORMAT: SourceFormat = { container: "other", sampleRate: null, channels: null, bitDepth: null, float: false };

/** Linear resampling (only used to compare takes recorded at different rates). */
function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to || x.length === 0) return x;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const a = Math.floor(p);
    const f = p - a;
    const x0 = x[Math.min(a, x.length - 1)];
    const x1 = x[Math.min(a + 1, x.length - 1)];
    out[i] = x0 + (x1 - x0) * f;
  }
  return out;
}

/** Pads/trims every channel to exactly `frames` samples. */
function fitFrames(channels: Float32Array[], frames: number): Float32Array[] {
  if (frames <= 0) return channels;
  return channels.map((ch) => {
    if (ch.length === frames) return ch;
    const out = new Float32Array(frames);
    out.set(ch.subarray(0, Math.min(frames, ch.length)));
    return out;
  });
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function useAutotuneTracks(deps: AutotuneDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [player] = useState<MultiTrackPlayer>(() => deps.createPlayer());

  const tracksRef = useRef<TuneTrack[]>([]);
  const [tracks, setTracksState] = useState<TuneTrack[]>([]);
  const runtimes = useRef(new Map<string, Runtime>());
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const unmounted = useRef(false);

  const commit = (next: TuneTrack[]) => {
    tracksRef.current = next;
    if (!unmounted.current) setTracksState(next);
  };
  const update = (id: string, patch: Partial<TuneTrack> | ((t: TuneTrack) => Partial<TuneTrack>)) =>
    commit(tracksRef.current.map((t) => (t.id === id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)));
  const getTrack = (id: string | null) => (id ? tracksRef.current.find((t) => t.id === id) ?? null : null);
  const setActiveId = (id: string | null) => {
    activeRef.current = id;
    setActiveIdState(id);
  };

  useEffect(() => {
    unmounted.current = false;
    const rts = runtimes.current;
    return () => {
      unmounted.current = true;
      for (const rt of rts.values()) {
        rt.disposed = true;
        rt.engine?.dispose();
      }
      rts.clear();
      player.dispose();
    };
  }, [player]);

  // ---- Background analysis (bounded concurrency) ----
  const analyse = async (id: string) => {
    const rt = runtimes.current.get(id);
    const t = getTrack(id);
    if (!rt || !t || rt.disposed) return;
    const t0 = performance.now();
    update(id, { status: "decoding", error: null, startedAt: t0 });
    try {
      const decoded = await depsRef.current.decode(t.source);
      if (rt.disposed) return;
      const { channels, mono, sampleRate } = decoded;
      if (mono.length === 0) throw new Error("That file has no audio in it.");
      const chs = channels.length > 0 ? channels : [mono];
      update(id, { status: "analyzing", sampleRate, format: decoded.format, frames: mono.length, channelCount: chs.length });
      const cur = getTrack(id);
      player.addTrack(id, chs, sampleRate, { offsetSec: cur?.offsetSec ?? 0, volume: cur?.volume ?? 1, muted: cur?.muted, solo: cur?.solo });
      rt.engine ??= depsRef.current.createEngine();
      const a = await rt.engine.load(mono, sampleRate, chs);
      if (rt.disposed) return;
      rt.mono = mono;
      rt.output = new Float32Array(mono);
      const peaks = computePeaks(rt.output, PEAK_BLOCK);
      let pm = 0;
      for (const p of peaks) if (p > pm) pm = p;
      update(id, (tr) => ({
        status: "ready",
        analysis: a,
        peaks,
        peakMax: pm || 1,
        peaksVersion: tr.peaksVersion + 1,
        analyzeSec: (performance.now() - t0) / 1000,
      }));
      autoAlignAround(id);
    } catch (err) {
      if (rt.disposed) return;
      player.removeTrack(id);
      update(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const pump = () => {
    while (running.current < MAX_CONCURRENT_ANALYSES && queue.current.length > 0) {
      const id = queue.current.shift() as string;
      if (!runtimes.current.has(id)) continue;
      running.current++;
      void analyse(id).finally(() => {
        running.current--;
        pump();
      });
    }
  };

  // ---- Track management ----
  const addSources = (values: AutotuneSourceValue[]): string[] => {
    if (values.length === 0) return [];
    const existing = tracksRef.current;
    const used = new Set(existing.map((t) => t.color));
    const added: TuneTrack[] = values.map((source, i) => {
      const id = `track-${++counter.current}`;
      const color = TRACK_COLORS.find((c) => !used.has(c)) ?? TRACK_COLORS[(existing.length + i) % TRACK_COLORS.length];
      used.add(color);
      runtimes.current.set(id, { engine: null, chain: Promise.resolve(), undo: new UndoStack<NoteSnapshot[]>(), mono: null, output: null, disposed: false });
      return {
        id,
        name: source.label,
        color,
        source,
        status: "queued",
        error: null,
        analysis: null,
        sampleRate: 44100,
        format: null,
        frames: 0,
        channelCount: 1,
        offsetSec: 0,
        volume: 1,
        muted: false,
        solo: false,
        isLead: existing.length === 0 && i === 0,
        includeInTuneAll: true,
        analyzeSec: null,
        startedAt: performance.now(),
        peaks: null,
        peakMax: 1,
        peaksVersion: 0,
        saved: null,
        undoVersion: 0,
        warps: [],
        role: null,
        alignNote: null,
      };
    });
    commit([...existing, ...added]);
    if (!activeRef.current) setActiveId(added[0].id);
    queue.current.push(...added.map((t) => t.id));
    pump();
    return added.map((t) => t.id);
  };

  const removeTrack = (id: string) => {
    const rt = runtimes.current.get(id);
    if (rt) {
      rt.disposed = true;
      rt.engine?.dispose();
      runtimes.current.delete(id);
    }
    queue.current = queue.current.filter((q) => q !== id);
    player.removeTrack(id);
    const removed = getTrack(id);
    let next = tracksRef.current.filter((t) => t.id !== id);
    if (removed?.isLead && next.length > 0) next = next.map((t, i) => (i === 0 ? { ...t, isLead: true } : t));
    commit(next);
    if (activeRef.current === id) setActiveId(next.find((t) => t.isLead)?.id ?? next[0]?.id ?? null);
  };

  const setLead = (id: string) => commit(tracksRef.current.map((t) => ({ ...t, isLead: t.id === id })));

  const setMix = (id: string, patch: MixPatch) => {
    update(id, patch);
    if (patch.muted !== undefined) player.setMuted(id, patch.muted);
    if (patch.solo !== undefined) player.setSolo(id, patch.solo);
    if (patch.volume !== undefined) player.setVolume(id, patch.volume);
  };

  const setOffset = (id: string, sec: number) => {
    const rounded = Math.round(sec * 1000) / 1000;
    update(id, { offsetSec: rounded });
    player.setOffset(id, rounded);
  };

  const setIncluded = (id: string, include: boolean) => update(id, { includeInTuneAll: include });

  /** Lines a take up with the lead by its syllable onsets. Refuses (and leaves it) when unsure. */
  const alignToLead = (id: string, auto = false): AlignNote | null => {
    const lead = tracksRef.current.find((t) => t.isLead);
    const t = getTrack(id);
    const leadMono = lead ? runtimes.current.get(lead.id)?.mono : null;
    const mono = runtimes.current.get(id)?.mono;
    if (!lead || !t || lead.id === id || !leadMono || !mono) return auto ? null : { ok: false, message: "Wait until both takes are analyzed." };
    let note: AlignNote | null;
    if (auto && t.frames === lead.frames && t.sampleRate === lead.sampleRate) {
      // Same length as the lead: exported from the same session, so already in time.
      note = { ok: true, message: "In sync with the lead (same start and length)" };
    } else {
      const other = resampleLinear(mono, t.sampleRate, lead.sampleRate);
      const r = depsRef.current.estimateOffset(leadMono, other, lead.sampleRate);
      const need = auto ? AUTO_ALIGN_CONFIDENCE : MIN_ALIGN_CONFIDENCE;
      if (!(r.confidence >= need)) note = auto ? null : { ok: false, message: ALIGN_FAILED_MESSAGE };
      else {
        const offset = lead.offsetSec + r.offsetSec;
        setOffset(id, offset);
        const ms = `${offset >= 0 ? "+" : ""}${Math.round(offset * 1000)} ms`;
        note = { ok: true, message: auto ? `Lined up with the lead automatically (${ms})` : `Lined up with the lead (${ms})` };
      }
    }
    if (note) update(id, { alignNote: note });
    return note;
  };

  /** After a take finishes analysing: line it (or, for the lead, every waiting take) up automatically. */
  const autoAlignAround = (id: string) => {
    const t = getTrack(id);
    if (!t) return;
    const lead = tracksRef.current.find((x) => x.isLead);
    if (!lead || lead.status !== "ready") return;
    const targets = t.isLead ? tracksRef.current.filter((x) => !x.isLead && x.status === "ready") : [t];
    for (const x of targets) if (x.alignNote === null && x.offsetSec === 0) alignToLead(x.id, true);
  };

  const clearAlignNote = (id: string) => update(id, { alignNote: null });

  // ---- Engine operations (strictly serialised per track) ----
  function enqueue<T>(id: string, fn: (engine: PitchEngine) => Promise<T>): Promise<T> {
    const rt = runtimes.current.get(id);
    if (!rt || !rt.engine) return Promise.reject(new Error("That track is not ready."));
    const engine = rt.engine;
    const p = rt.chain.then(() => fn(engine));
    rt.chain = p.catch(() => undefined);
    return p;
  }

  const applyResult = (id: string, r: EditResult, withAnalysis: boolean) => {
    const t = getTrack(id);
    const rt = runtimes.current.get(id);
    if (!t || !rt) return;
    for (const p of r.patches) {
      const start = Math.round(p.startSec * t.sampleRate);
      if (rt.output) {
        const [a, b] = patchSamples(rt.output, start, p.samples);
        if (t.peaks) updatePeaks(t.peaks, rt.output, PEAK_BLOCK, a, b);
      }
      player.patch(id, start, p.channels ?? new Array<Float32Array>(Math.max(1, t.channelCount)).fill(p.samples));
    }
    if (r.patches.length > 0 || withAnalysis)
      update(id, (tr) => ({
        ...(withAnalysis ? { analysis: r.analysis } : {}),
        ...(r.patches.length > 0 ? { peaksVersion: tr.peaksVersion + 1 } : {}),
      }));
  };

  const runOp = (
    id: string,
    task: (engine: PitchEngine, current: Analysis) => Promise<EditResult>,
    opts: { applyAnalysis?: () => boolean; after?: (r: EditResult) => void } = {}
  ): Promise<void> => {
    setBusy((b) => b + 1);
    return enqueue(id, async (engine) => {
      const rt = runtimes.current.get(id);
      const cur = getTrack(id)?.analysis;
      if (!cur || !rt || rt.disposed) return;
      const r = await task(engine, cur);
      if (rt.disposed) return;
      applyResult(id, r, opts.applyAnalysis ? opts.applyAnalysis() : true);
      opts.after?.(r);
    })
      .catch((err) => {
        if (!unmounted.current) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!unmounted.current) setBusy((b) => b - 1);
      });
  };

  /** Replaces a take's timing edits; resolves false if the engine refused them. */
  const setWarps = async (id: string, segments: WarpSegment[]): Promise<boolean> => {
    let ok = false;
    await runOp(id, (e) => e.setWarps(segments), {
      after: (r) => {
        ok = r.ok;
        if (r.ok) update(id, { warps: segments });
      },
    });
    return ok;
  };

  const setRole = (id: string, role: HarmonyRole | null) => update(id, { role });

  const setLocalNotes = (id: string, notes: EngineNote[]) => update(id, (t) => (t.analysis ? { analysis: { ...t.analysis, notes } } : {}));

  const undoOf = (id: string): UndoStack<NoteSnapshot[]> | null => runtimes.current.get(id)?.undo ?? null;
  const bumpUndo = (id: string) => update(id, (t) => ({ undoVersion: t.undoVersion + 1 }));

  /** Renders a track with every channel at its exact source length and saves "<name>-autotuned.wav". */
  const exportTrack = async (id: string, opts: { polish?: boolean } = {}): Promise<SavedExport> => {
    const t = getTrack(id);
    if (!t || t.status !== "ready") throw new Error("That track is not ready.");
    const forAnalysis = t.analysis;
    const rendered = await enqueue(id, (e) => e.renderAllChannels());
    let channels = fitFrames(rendered, t.frames);
    if (opts.polish) channels = fitFrames(await (depsRef.current.polish ?? renderPolished)(channels, t.sampleRate), t.frames);
    const wav = encodeWav(channels, exportSpec(t.format ?? FALLBACK_FORMAT, t.sampleRate));
    const fileName = autotunedName(t.name);
    const path = await backend.saveExport(fileName, new Uint8Array(wav));
    const saved: SavedExport = { name: path ? basename(path) : fileName, path, forAnalysis, polished: !!opts.polish, warps: t.warps };
    update(id, { saved });
    return saved;
  };

  return {
    player,
    tracks,
    tracksRef,
    getTrack,
    activeId,
    activeRef,
    setActiveId,
    busy,
    error,
    setError,
    addSources,
    removeTrack,
    setLead,
    setMix,
    setOffset,
    setIncluded,
    alignToLead,
    clearAlignNote,
    setWarps,
    setRole,
    enqueue,
    runOp,
    setLocalNotes,
    undoOf,
    bumpUndo,
    exportTrack,
  };
}

export type AutotuneTracks = ReturnType<typeof useAutotuneTracks>;
