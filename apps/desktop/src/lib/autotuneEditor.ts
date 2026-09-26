import type { AutotuneNoteEdit, PitchNote, PitchPoint } from "./types";

/** A single (x, y) pixel coordinate on the pitch editor's SVG canvas. */
export interface Vec2 {
  x: number;
  y: number;
}

export interface AutotuneLayout {
  minMidi: number;
  maxMidi: number;
  rowCount: number;
  rowHeight: number;
  height: number;
  pxPerSec: number;
  durationSec: number;
  width: number;
  /** Top y-coordinate (px) of the row for a given (possibly fractional) MIDI pitch. */
  yForMidi(midi: number): number;
  /** Inverse of yForMidi: the (fractional) MIDI pitch at a given y-coordinate (px). */
  midiForY(y: number): number;
  /** X-coordinate (px) for a given time in seconds. */
  xForSec(sec: number): number;
  /** Inverse of xForSec: the time in seconds at a given x-coordinate (px). */
  secForX(x: number): number;
}

/** Width (px) of the piano-keyboard column to the left of the pitch grid; the waveform lane above it
 * is padded by the same amount so both lanes share one x-axis and one playhead. */
export const KEYBOARD_WIDTH = 44;

/**
 * The single source of truth for the playhead's x-position, shared by the waveform lane and the
 * pitch grid so exactly one playhead bar is ever drawn, and it always lines up across both lanes.
 */
export function playheadX(layout: AutotuneLayout, sec: number, keyboardWidth: number = KEYBOARD_WIDTH): number {
  return keyboardWidth + layout.xForSec(sec);
}

const MIN_SEMITONE_SPAN = 24; // 2 octaves
const PAD_SEMITONES = 2;
const DEFAULT_ROW_HEIGHT = 10;
const DEFAULT_PX_PER_SEC = 80;
const DEFAULT_MID_MIDI = 60; // C4, used when there are no notes to size the range from

/** True for MIDI pitches whose piano key is black. */
export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Formats a MIDI pitch as a note name with octave, e.g. 60 -> "C4". */
export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

/**
 * Computes the pitch range (min 2 octaves, padded by PAD_SEMITONES beyond the notes' own range)
 * and the time<->x / pitch<->y mapping for the Autotune editor's piano roll, from a PitchResult's
 * notes and f0. Pure and deterministic so it can be unit tested without rendering anything.
 */
export function computeAutotuneLayout(
  notes: PitchNote[],
  f0: PitchPoint[],
  opts?: { rowHeight?: number; pxPerSec?: number }
): AutotuneLayout {
  const rowHeight = opts?.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const pxPerSec = opts?.pxPerSec ?? DEFAULT_PX_PER_SEC;

  let loMidi: number;
  let hiMidi: number;
  if (notes.length === 0) {
    loMidi = DEFAULT_MID_MIDI - MIN_SEMITONE_SPAN / 2;
    hiMidi = DEFAULT_MID_MIDI + MIN_SEMITONE_SPAN / 2;
  } else {
    loMidi = Math.min(...notes.map((n) => n.midi)) - PAD_SEMITONES;
    hiMidi = Math.max(...notes.map((n) => n.midi)) + PAD_SEMITONES;
  }

  const span = hiMidi - loMidi;
  if (span < MIN_SEMITONE_SPAN) {
    const pad = MIN_SEMITONE_SPAN - span;
    const padLo = Math.floor(pad / 2);
    const padHi = pad - padLo;
    loMidi -= padLo;
    hiMidi += padHi;
  }
  loMidi = Math.max(0, Math.floor(loMidi));
  hiMidi = Math.min(127, Math.ceil(hiMidi));

  const minMidi = loMidi;
  const maxMidi = hiMidi;
  const rowCount = maxMidi - minMidi + 1;
  const height = rowCount * rowHeight;

  const noteEnd = notes.length > 0 ? Math.max(...notes.map((n) => n.endSec)) : 0;
  const f0End = f0.length > 0 ? f0[f0.length - 1].t : 0;
  const durationSec = Math.max(noteEnd, f0End);
  const width = Math.max(1, durationSec * pxPerSec);

  return {
    minMidi,
    maxMidi,
    rowCount,
    rowHeight,
    height,
    pxPerSec,
    durationSec,
    width,
    yForMidi(midi: number): number {
      // Highest pitch drawn at the top; works for fractional pitches too (for the f0 contour).
      return (maxMidi - midi) * rowHeight;
    },
    midiForY(y: number): number {
      return maxMidi - y / rowHeight;
    },
    xForSec(sec: number): number {
      return sec * pxPerSec;
    },
    secForX(x: number): number {
      return x / pxPerSec;
    },
  };
}

/** Cents deviation bucket used to color a note block by tuning accuracy. */
export type TuningBucket = "in-tune" | "close" | "off";

/** Buckets an absolute cents deviation into a tuning-accuracy tier: <=5 in tune, <=20 close, else off. */
export function tuningBucket(cents: number): TuningBucket {
  const abs = Math.abs(cents);
  if (abs <= 5) return "in-tune";
  if (abs <= 20) return "close";
  return "off";
}

/** Scale name understood by buildScalePitchClasses. */
export type ScaleName = "chromatic" | "major" | "minor" | "dorian" | "mixolydian";

const SCALE_STEPS: Record<Exclude<ScaleName, "chromatic">, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/**
 * Builds the pitch-class set (0..11) for a scale name + tonic pitch class, or null for "Chromatic"
 * (meaning: no scale restriction, snap to nearest semitone instead).
 */
export function buildScalePitchClasses(scale: ScaleName, tonicPc: number): number[] | null {
  if (scale === "chromatic") return null;
  const steps = SCALE_STEPS[scale];
  const pc = ((tonicPc % 12) + 12) % 12;
  return steps.map((s) => (s + pc) % 12).sort((a, b) => a - b);
}

/** Retune Speed (0 = Slow/natural, 100 = Fast/hard) mapped to the engine's snapStrength (0..1) and transitionMs. */
export interface RetuneParams {
  snapStrength: number;
  transitionMs: number;
}

const RETUNE_MIN_STRENGTH = 0.3;
const RETUNE_MAX_STRENGTH = 1.0;
const RETUNE_MAX_TRANSITION_MS = 150;

/**
 * Maps a single "Retune Speed" 0..100 control (Auto-Tune's headline knob) to the underlying
 * snapStrength/transitionMs: Fast (100) is the classic hard-autotune sound (strength 1.0, ~0ms
 * transition); Slow (0) keeps a natural, more human transition between notes.
 */
export function retuneSpeedToParams(speed: number): RetuneParams {
  const clamped = Math.max(0, Math.min(100, speed));
  const t = clamped / 100;
  return {
    snapStrength: Number((RETUNE_MIN_STRENGTH + t * (RETUNE_MAX_STRENGTH - RETUNE_MIN_STRENGTH)).toFixed(3)),
    transitionMs: Math.round(RETUNE_MAX_TRANSITION_MS * (1 - t)),
  };
}

/** Humanize 0..100 adds a little extra smoothing on top of the Retune Speed's transition, for subtler wobble. */
export function applyHumanize(transitionMs: number, humanize: number): number {
  const clamped = Math.max(0, Math.min(100, humanize));
  return Math.round(transitionMs + clamped * 0.4);
}

/** The nearest MIDI pitch to `midi` whose pitch class is in `scalePcs` (ties broken toward the lower pitch). */
export function nearestScaleMidi(midi: number, scalePcs: number[]): number {
  if (scalePcs.length === 0) return Math.round(midi);
  const rounded = Math.round(midi);
  let best = rounded;
  let bestDist = Infinity;
  for (let candidate = rounded - 12; candidate <= rounded + 12; candidate++) {
    const pc = ((candidate % 12) + 12) % 12;
    if (!scalePcs.includes(pc)) continue;
    const dist = Math.abs(candidate - midi);
    if (dist < bestDist - 1e-9) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/** Edit-model note: a detected PitchNote plus the (possibly user-set) target MIDI to tune it to. */
export interface EditableNote extends PitchNote {
  /** The MIDI pitch this note should be tuned to; starts equal to the detected (rounded) midi. */
  targetMidi: number;
}

/** Builds the initial edit-model notes from freshly analyzed PitchNotes: targetMidi = detected midi. */
export function buildEditableNotes(notes: PitchNote[]): EditableNote[] {
  return notes.map((n) => ({ ...n, targetMidi: Math.round(n.midi) }));
}

/** Resets every note's targetMidi back to its originally detected pitch. */
export function resetEditableNotes(notes: EditableNote[]): EditableNote[] {
  return notes.map((n) => ({ ...n, targetMidi: Math.round(n.midi) }));
}

/** Sets every note's targetMidi to the nearest note in the given scale (null scale = nearest semitone, i.e. unchanged rounding). */
export function tuneNotesToScale(notes: EditableNote[], scalePcs: number[] | null): EditableNote[] {
  return notes.map((n) => ({
    ...n,
    targetMidi: scalePcs ? nearestScaleMidi(n.midi, scalePcs) : Math.round(n.midi),
  }));
}

/** Updates a single note's targetMidi by index, snapping to the nearest whole semitone. */
export function setNoteTarget(notes: EditableNote[], index: number, targetMidi: number): EditableNote[] {
  return notes.map((n, i) => (i === index ? { ...n, targetMidi: Math.round(targetMidi) } : n));
}

/** Converts the edit-model notes into the AutotuneEdits.notes payload sent to the backend. */
export function toAutotuneNoteEdits(notes: EditableNote[]): AutotuneNoteEdit[] {
  return notes.map((n) => ({ startSec: n.startSec, endSec: n.endSec, targetMidi: n.targetMidi }));
}

/** Median gap (seconds) between consecutive f0 points, used as the "one hop" unit when a hop isn't given explicitly. */
function inferHopSec(points: PitchPoint[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].t - points[i - 1].t);
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Splits a PitchResult's f0 contour into drawable polyline segments (as pixel coordinates via the
 * given layout), breaking the line wherever a point is unvoiced or wherever consecutive voiced
 * points are separated by more than ~2 analysis hops (a gap in the contour, not continuous pitch).
 * Unvoiced points are excluded entirely so the rendered line never bridges a silent/unpitched gap.
 */
export function buildF0Segments(
  points: PitchPoint[],
  layout: AutotuneLayout,
  opts?: { xOffset?: number; hopSec?: number }
): Vec2[][] {
  const xOffset = opts?.xOffset ?? 0;
  const hopSec = opts?.hopSec ?? inferHopSec(points);
  const maxGapSec = hopSec > 0 ? hopSec * 2 : Infinity;

  const segments: Vec2[][] = [];
  let current: Vec2[] = [];
  let lastT: number | null = null;

  for (const p of points) {
    if (!p.voiced || p.midi === null || p.midi === undefined) {
      if (current.length > 1) segments.push(current);
      current = [];
      lastT = null;
      continue;
    }
    if (lastT !== null && p.t - lastT > maxGapSec) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push({ x: xOffset + layout.xForSec(p.t), y: layout.yForMidi(p.midi) });
    lastT = p.t;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/** Maps a y-coordinate (px) from a pointer drag to the nearest whole-semitone MIDI pitch, clamped to [minMidi, maxMidi]. */
export function snapYToMidi(y: number, layout: AutotuneLayout): number {
  const raw = Math.round(layout.midiForY(y));
  return Math.max(layout.minMidi, Math.min(layout.maxMidi, raw));
}
