/**
 * Pure helpers for the Melodyne-style note editor (Autotune tab): analysis types coming from the
 * pitchcore WebAssembly engine, scales and snapping, coordinate mapping, blob outlines, hit-testing,
 * the Correct Pitch macro, undo/restore planning and a WAV encoder. Everything here is DOM-free so it
 * can be unit-tested in isolation.
 */

// ---------------------------------------------------------------------------------------------
// Engine analysis types (shape of PitchSession.analysisJson())
// ---------------------------------------------------------------------------------------------

export interface EngineNote {
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  /** Detected fractional MIDI center. */
  center: number;
  /** Desired center (fractional MIDI); equals `center` while untouched. */
  target: number;
  /** 1 keeps the note's slow pitch wander, 0 flattens it. */
  drift: number;
  /** Vibrato amount: 1 keep, 0 flat, up to 2. */
  modulation: number;
  peakDb: number;
}

export interface EngineKey {
  tonic: string | number;
  mode: string;
  confidence: number;
}

export interface Analysis {
  hopSec: number;
  durationSec: number;
  pitch: (number | null)[];
  editedPitch: (number | null)[];
  db: number[];
  notes: EngineNote[];
  key: EngineKey | null;
}

/** One chunk of re-rendered output audio, to be written at `startSec` into the output buffer. */
export interface AudioPatch {
  startSec: number;
  samples: Float32Array;
}

export interface NoteParams {
  target: number;
  drift: number;
  modulation: number;
}

export interface NoteEdit extends NoteParams {
  index: number;
}

// ---------------------------------------------------------------------------------------------
// Note names, keys and scales
// ---------------------------------------------------------------------------------------------

export const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Maps flats/sharps/numbers ("Gb", "F#", 6) to a pitch class 0..11; unknown -> 0. */
export function parseTonic(tonic: string | number | null | undefined): number {
  if (typeof tonic === "number" && Number.isFinite(tonic)) return ((Math.round(tonic) % 12) + 12) % 12;
  if (typeof tonic !== "string") return 0;
  const t = tonic.trim();
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const letter = base[t.charAt(0).toUpperCase()];
  if (letter === undefined) return 0;
  let pc = letter;
  for (const ch of t.slice(1)) {
    if (ch === "#" || ch === "♯") pc += 1;
    else if (ch === "b" || ch === "♭") pc -= 1;
  }
  return ((pc % 12) + 12) % 12;
}

export type ScaleMode =
  | "major"
  | "minor"
  | "harmonic minor"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "major pentatonic"
  | "minor pentatonic"
  | "blues"
  | "chromatic";

export const SCALE_INTERVALS: Record<ScaleMode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  "major pentatonic": [0, 2, 4, 7, 9],
  "minor pentatonic": [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const SCALE_MODES = Object.keys(SCALE_INTERVALS) as ScaleMode[];

/** Normalises an engine mode string to one of our modes ("Minor" -> "minor", unknown -> "major"). */
export function parseMode(mode: string | null | undefined): ScaleMode {
  const m = (mode ?? "").trim().toLowerCase();
  if ((SCALE_MODES as string[]).includes(m)) return m as ScaleMode;
  if (m.startsWith("min") || m === "aeolian") return "minor";
  if (m === "ionian") return "major";
  return "major";
}

/** Sorted pitch classes (0..11) of a tonic+mode. */
export function scalePitchClasses(tonicPc: number, mode: ScaleMode): number[] {
  return SCALE_INTERVALS[mode].map((i) => (i + tonicPc) % 12).sort((a, b) => a - b);
}

export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function isInScale(midi: number, pcs: readonly number[]): boolean {
  return pcs.includes(pitchClass(midi));
}

/** "C4" for MIDI 60, "F#4" for 66. */
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${PITCH_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** "F# minor" style label for a detected key; null when unknown. */
export function keyLabel(key: EngineKey | null | undefined): string | null {
  if (!key) return null;
  return `${PITCH_NAMES[parseTonic(key.tonic)]} ${parseMode(key.mode)}`;
}

// ---------------------------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------------------------

export type SnapMode = "scale" | "chromatic" | "off";

const ALL_PCS = SCALE_INTERVALS.chromatic;

/** Pitch classes a snap mode allows; "off" still uses the chromatic grid for explicit snaps (double-click, macro). */
export function allowedPitchClasses(snap: SnapMode, scalePcs: readonly number[]): readonly number[] {
  return snap === "scale" && scalePcs.length > 0 ? scalePcs : ALL_PCS;
}

/** Nearest integer MIDI note whose pitch class is allowed. Ties go to the lower note. */
export function nearestAllowed(midi: number, pcs: readonly number[]): number {
  const allowed = pcs.length > 0 ? pcs : ALL_PCS;
  const base = Math.round(midi);
  let best = base;
  let bestDist = Infinity;
  for (let off = -12; off <= 12; off++) {
    const n = base + off;
    if (!allowed.includes(pitchClass(n))) continue;
    const d = Math.abs(n - midi);
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && n < best)) {
      best = n;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Snaps a raw (fractional) pitch for dragging: returns it unchanged when `free` (Alt held) or the snap
 * mode is "off", else the nearest allowed note so the center lands exactly on it.
 */
export function snapPitch(raw: number, snap: SnapMode, scalePcs: readonly number[], free = false): number {
  if (free || snap === "off") return raw;
  return nearestAllowed(raw, allowedPitchClasses(snap, scalePcs));
}

/** Next allowed note strictly above (dir=1) or below (dir=-1) `midi` (arrow keys). */
export function stepAllowed(midi: number, dir: 1 | -1, pcs: readonly number[]): number {
  const allowed = pcs.length > 0 ? pcs : ALL_PCS;
  const eps = 1e-6;
  let n = dir > 0 ? Math.floor(midi + eps) + 1 : Math.ceil(midi - eps) - 1;
  for (let i = 0; i < 24; i++, n += dir) {
    if (allowed.includes(pitchClass(n))) return n;
  }
  return midi + dir;
}

/** Nearest chromatic note of the grid + signed cents off it (what the inspector shows). */
export function pitchReadout(midi: number): { name: string; cents: number } {
  const n = Math.round(midi);
  let cents = Math.round((midi - n) * 100);
  if (Object.is(cents, -0)) cents = 0;
  return { name: noteName(n), cents };
}

export function formatCents(cents: number): string {
  if (cents === 0) return "0 cents";
  return `${cents > 0 ? "+" : "-"}${Math.abs(cents)} cents`;
}

// ---------------------------------------------------------------------------------------------
// Correct Pitch macro
// ---------------------------------------------------------------------------------------------

/**
 * Melodyne's Correct Pitch macro for one note: moves the center `centerPct` (0..1) of the way from its
 * detected center to the nearest allowed note, and flattens drift by `driftPct` (0..1).
 */
export function correctPitch(
  note: Pick<EngineNote, "center" | "modulation">,
  centerPct: number,
  driftPct: number,
  pcs: readonly number[]
): NoteParams {
  const c = clamp01(centerPct);
  const d = clamp01(driftPct);
  const goal = nearestAllowed(note.center, pcs);
  const target = c >= 1 ? goal : note.center + c * (goal - note.center);
  return { target, drift: 1 - d, modulation: note.modulation };
}

export function isNoteEdited(n: Pick<EngineNote, "center" | "target" | "drift" | "modulation">): boolean {
  return Math.abs(n.target - n.center) > 1e-4 || Math.abs(n.drift - 1) > 1e-4 || Math.abs(n.modulation - 1) > 1e-4;
}

// ---------------------------------------------------------------------------------------------
// Layout and coordinate mapping
// ---------------------------------------------------------------------------------------------

export const PITCH_RULER_W = 56;
export const TIME_RULER_H = 24;
export const WAVE_H = 56;
export const GRID_H = 440;
export const MIN_ROW_PX = 9;
export const MAX_ROW_PX = 30;
export const MAX_PX_PER_SEC = 3000;

export interface EditorLayout {
  width: number;
  height: number;
  gridLeft: number;
  gridWidth: number;
  timeRulerTop: number;
  waveTop: number;
  waveHeight: number;
  gridTop: number;
  gridHeight: number;
}

export function computeLayout(width: number, gridHeight = GRID_H): EditorLayout {
  const w = Math.max(PITCH_RULER_W + 100, Math.round(width));
  return {
    width: w,
    height: TIME_RULER_H + WAVE_H + gridHeight,
    gridLeft: PITCH_RULER_W,
    gridWidth: w - PITCH_RULER_W,
    timeRulerTop: 0,
    waveTop: TIME_RULER_H,
    waveHeight: WAVE_H,
    gridTop: TIME_RULER_H + WAVE_H,
    gridHeight,
  };
}

export interface Viewport {
  /** Time (s) at the grid's left edge. */
  scrollSec: number;
  pxPerSec: number;
  /** Fractional MIDI value at the grid's top edge. */
  topMidi: number;
  /** Pixels per semitone. */
  rowPx: number;
}

export function timeToX(sec: number, vp: Viewport, layout: EditorLayout): number {
  return layout.gridLeft + (sec - vp.scrollSec) * vp.pxPerSec;
}

export function xToTime(x: number, vp: Viewport, layout: EditorLayout): number {
  return vp.scrollSec + (x - layout.gridLeft) / vp.pxPerSec;
}

/** y of a (fractional) pitch; an integer MIDI note's row is centered on this line. */
export function midiToY(midi: number, vp: Viewport, layout: EditorLayout): number {
  return layout.gridTop + (vp.topMidi - midi) * vp.rowPx;
}

export function yToMidi(y: number, vp: Viewport, layout: EditorLayout): number {
  return vp.topMidi - (y - layout.gridTop) / vp.rowPx;
}

export type EditorRegion = "time-ruler" | "wave" | "pitch-ruler" | "grid" | "none";

export function regionAt(x: number, y: number, layout: EditorLayout): EditorRegion {
  if (x < 0 || y < 0 || x > layout.width || y > layout.height) return "none";
  if (y < layout.waveTop) return "time-ruler";
  if (y < layout.gridTop) return "wave";
  if (x < layout.gridLeft) return "pitch-ruler";
  return "grid";
}

/** Pitch range (integer MIDI, inclusive) covering all notes' centers and targets, ±`pad` semitones. */
export function pitchRange(notes: readonly Pick<EngineNote, "center" | "target">[], pad = 4): { lo: number; hi: number } {
  if (notes.length === 0) return { lo: 60 - pad - 6, hi: 60 + pad + 6 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    lo = Math.min(lo, n.center, n.target);
    hi = Math.max(hi, n.center, n.target);
  }
  return { lo: Math.floor(lo) - pad, hi: Math.ceil(hi) + pad };
}

/** Rows are never drawn smaller than this by the automatic fit, so blobs stay readable. */
export const FIT_MIN_ROW_PX = 16;
/** Seconds shown when a vocal first opens (Melodyne opens on a readable section, not the whole take). */
export const OPEN_WINDOW_SEC = 12;

/** Pitch range holding most of the singing: duration-weighted 5th..95th percentile of note
 * centers ±`pad`, so a few stray notes do not squash the rows. */
export function corePitchRange(
  notes: readonly Pick<EngineNote, "center" | "target" | "startSec" | "endSec">[],
  pad = 3
): { lo: number; hi: number } {
  if (notes.length === 0) return pitchRange(notes);
  const pts = notes
    .map((n) => ({ m: n.target, w: Math.max(0.01, n.endSec - n.startSec) }))
    .sort((a, b) => a.m - b.m);
  const total = pts.reduce((s, p) => s + p.w, 0);
  const at = (q: number) => {
    let acc = 0;
    for (const p of pts) {
      acc += p.w;
      if (acc >= q * total) return p.m;
    }
    return pts[pts.length - 1].m;
  };
  return { lo: Math.floor(at(0.05)) - pad, hi: Math.ceil(at(0.95)) + pad };
}

/**
 * Viewport fitted to the singing. `windowSec` limits the time span shown (the opening view);
 * omit it for the whole duration (the "Fit" button).
 */
export function fitViewport(
  notes: readonly Pick<EngineNote, "center" | "target" | "startSec" | "endSec">[],
  durationSec: number,
  layout: EditorLayout,
  windowSec?: number
): Viewport {
  const { lo, hi } = corePitchRange(notes);
  const rows = hi - lo + 1;
  const rowPx = Math.max(FIT_MIN_ROW_PX, Math.min(MAX_ROW_PX, layout.gridHeight / rows));
  const visibleRows = layout.gridHeight / rowPx;
  const mid = (lo + hi) / 2;
  const span = Math.max(0.5, windowSec ? Math.min(windowSec, durationSec) : durationSec);
  const firstNote = notes.length ? Math.max(0, notes[0].startSec - 0.5) : 0;
  return clampScroll(
    {
      scrollSec: windowSec ? firstNote : 0,
      pxPerSec: layout.gridWidth / span,
      topMidi: clampTopMidi(mid + visibleRows / 2, rowPx, layout),
      rowPx,
    },
    durationSec,
    layout
  );
}

export function clampTopMidi(topMidi: number, rowPx: number, layout: EditorLayout): number {
  const visibleRows = layout.gridHeight / rowPx;
  return Math.max(visibleRows - 0.5, Math.min(127.5, topMidi));
}

export function clampScroll(vp: Viewport, durationSec: number, layout: EditorLayout): Viewport {
  const visibleSec = layout.gridWidth / vp.pxPerSec;
  const maxScroll = Math.max(0, durationSec - visibleSec);
  return {
    ...vp,
    scrollSec: Math.max(0, Math.min(maxScroll, vp.scrollSec)),
    topMidi: clampTopMidi(vp.topMidi, vp.rowPx, layout),
  };
}

/** Horizontal zoom around `anchorX`, keeping the time under the cursor fixed; never zooms out past fit. */
export function zoomHorizontal(vp: Viewport, factor: number, anchorX: number, durationSec: number, layout: EditorLayout): Viewport {
  const minPx = layout.gridWidth / Math.max(0.5, durationSec);
  const pxPerSec = Math.max(minPx, Math.min(MAX_PX_PER_SEC, vp.pxPerSec * factor));
  const anchorSec = xToTime(anchorX, vp, layout);
  const scrollSec = anchorSec - (anchorX - layout.gridLeft) / pxPerSec;
  return clampScroll({ ...vp, pxPerSec, scrollSec }, durationSec, layout);
}

/** Auto-scroll during playback: page forward/back when the playhead leaves the visible window. */
export function followPlayhead(vp: Viewport, sec: number, durationSec: number, layout: EditorLayout): Viewport {
  const visibleSec = layout.gridWidth / vp.pxPerSec;
  if (sec >= vp.scrollSec && sec <= vp.scrollSec + visibleSec * 0.92) return vp;
  const next = clampScroll({ ...vp, scrollSec: sec - visibleSec * 0.1 }, durationSec, layout);
  return Math.abs(next.scrollSec - vp.scrollSec) < 1e-9 ? vp : next;
}

/** Time-ruler tick spacing (s) giving at least `minPx` between labels. */
export function rulerStep(pxPerSec: number, minPx = 64): number {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const s of steps) if (s * pxPerSec >= minPx) return s;
  return steps[steps.length - 1];
}

/** "0:05", "1:02.5" style time labels. */
export function formatTime(sec: number, step = 1): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const fixed = rest.toFixed(decimals);
  const [whole, frac] = fixed.split(".");
  const padded = whole.padStart(2, "0");
  return frac ? `${m}:${padded}.${frac}` : `${m}:${padded}`;
}

// ---------------------------------------------------------------------------------------------
// Blobs (amplitude-shaped note outlines)
// ---------------------------------------------------------------------------------------------

export const BLOB_MAX_THICKNESS = 0.9;
export const BLOB_MIN_THICKNESS = 0.16;
const BLOB_RANGE_DB = 48;

/** Loudest frame (dBFS), used as the 0 dB reference for blob thickness. */
export function referenceDb(db: readonly number[]): number {
  let max = -Infinity;
  for (const v of db) if (Number.isFinite(v) && v > max) max = v;
  return Number.isFinite(max) ? max : 0;
}

/** Maps a frame level to a total blob thickness in rows (BLOB_MIN..BLOB_MAX). */
export function dbToThickness(db: number, refDb: number): number {
  if (!Number.isFinite(db)) return BLOB_MIN_THICKNESS;
  const norm = clamp01((db - (refDb - BLOB_RANGE_DB)) / BLOB_RANGE_DB);
  return BLOB_MIN_THICKNESS + (BLOB_MAX_THICKNESS - BLOB_MIN_THICKNESS) * Math.pow(norm, 0.85);
}

/**
 * Half-thickness (in rows) of a note's blob for every frame startFrame..endFrame (inclusive): the
 * amplitude envelope, lightly smoothed, with rounded (quarter-circle) caps at both ends.
 */
export function blobProfile(
  note: Pick<EngineNote, "startFrame" | "endFrame">,
  db: readonly number[],
  refDb: number
): Float32Array {
  const start = Math.max(0, Math.floor(note.startFrame));
  const end = Math.max(start, Math.floor(note.endFrame));
  const n = end - start + 1;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = start + i;
    raw[i] = dbToThickness(f < db.length ? db[f] : -Infinity, refDb);
  }
  const out = new Float32Array(n);
  const cap = Math.max(1, Math.min(6, Math.floor(n / 3)));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < n) {
        sum += raw[j];
        cnt++;
      }
    }
    const edge = Math.min(i, n - 1 - i);
    const t = Math.min(1, (edge + 0.5) / cap);
    const round = Math.sqrt(1 - (1 - t) * (1 - t));
    out[i] = (sum / cnt / 2) * round;
  }
  return out;
}

/** Half-thickness (rows) of a blob at time `sec`, 0 outside the note. */
export function profileAt(profile: Float32Array, note: Pick<EngineNote, "startFrame">, sec: number, hopSec: number): number {
  const i = Math.round(sec / hopSec) - Math.floor(note.startFrame);
  if (i < 0 || i >= profile.length) return 0;
  return profile[i];
}

// ---------------------------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------------------------

/** Minimum clickable half-height of a blob, in rows, so thin/quiet notes remain easy to grab. */
export const MIN_HIT_HALF_ROWS = 0.42;

export interface NoteHit {
  index: number;
  /** "top" = upper third of the blob (double-click splits there), "body" = the rest. */
  zone: "top" | "body";
}

/**
 * Finds the note under (x, y). `displayTarget(i)` gives the pitch each note is currently drawn at.
 * Overlapping candidates resolve to the one whose center line is closest.
 */
export function hitTestNotes(
  x: number,
  y: number,
  notes: readonly EngineNote[],
  profiles: readonly Float32Array[],
  hopSec: number,
  vp: Viewport,
  layout: EditorLayout,
  displayTarget: (i: number) => number = (i) => notes[i].target
): NoteHit | null {
  if (regionAt(x, y, layout) !== "grid") return null;
  const sec = xToTime(x, vp, layout);
  let best: NoteHit | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (sec < n.startSec || sec > n.endSec) continue;
    const cy = midiToY(displayTarget(i), vp, layout);
    const half = Math.max(profiles[i] ? profileAt(profiles[i], n, sec, hopSec) : 0, MIN_HIT_HALF_ROWS) * vp.rowPx;
    const dy = y - cy;
    if (Math.abs(dy) > half) continue;
    if (Math.abs(dy) < bestDist) {
      bestDist = Math.abs(dy);
      best = { index: i, zone: y < cy - half / 3 ? "top" : "body" };
    }
  }
  return best;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Indices of notes whose drawn blob center line intersects the (unordered) marquee rectangle. */
export function notesInRect(
  rect: Rect,
  notes: readonly EngineNote[],
  vp: Viewport,
  layout: EditorLayout,
  displayTarget: (i: number) => number = (i) => notes[i].target
): number[] {
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);
  const out: number[] = [];
  notes.forEach((n, i) => {
    const nx0 = timeToX(n.startSec, vp, layout);
    const nx1 = timeToX(n.endSec, vp, layout);
    const cy = midiToY(displayTarget(i), vp, layout);
    const half = MIN_HIT_HALF_ROWS * vp.rowPx;
    if (nx1 >= x0 && nx0 <= x1 && cy + half >= y0 && cy - half <= y1) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pitch curve helpers
// ---------------------------------------------------------------------------------------------

/** Contiguous runs of voiced frames within [startFrame, endFrame] as [firstFrame, lastFrame] pairs. */
export function voicedRuns(pitch: readonly (number | null)[], startFrame: number, endFrame: number): [number, number][] {
  const runs: [number, number][] = [];
  let runStart = -1;
  const end = Math.min(endFrame, pitch.length - 1);
  for (let f = Math.max(0, startFrame); f <= end; f++) {
    const v = pitch[f];
    const voiced = v !== null && v !== undefined && Number.isFinite(v);
    if (voiced && runStart < 0) runStart = f;
    if (!voiced && runStart >= 0) {
      runs.push([runStart, f - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push([runStart, end]);
  return runs;
}

/** Last voiced frame of a note (for transition lines), or null. */
export function lastVoiced(pitch: readonly (number | null)[], startFrame: number, endFrame: number): number | null {
  for (let f = Math.min(endFrame, pitch.length - 1); f >= startFrame; f--) {
    const v = pitch[f];
    if (v !== null && v !== undefined && Number.isFinite(v)) return f;
  }
  return null;
}

export function firstVoiced(pitch: readonly (number | null)[], startFrame: number, endFrame: number): number | null {
  for (let f = Math.max(0, startFrame); f <= Math.min(endFrame, pitch.length - 1); f++) {
    const v = pitch[f];
    if (v !== null && v !== undefined && Number.isFinite(v)) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Edits applied locally (optimistic updates while the engine catches up)
// ---------------------------------------------------------------------------------------------

/** Returns a copy of `notes` with the given params merged in (by index). */
export function applyNoteParams(notes: readonly EngineNote[], edits: readonly NoteEdit[]): EngineNote[] {
  const next = notes.slice();
  for (const e of edits) {
    const n = next[e.index];
    if (!n) continue;
    next[e.index] = { ...n, target: e.target, drift: e.drift, modulation: e.modulation };
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Undo: snapshots of note state and a restore planner that handles split/merge
// ---------------------------------------------------------------------------------------------

export interface NoteSnapshot {
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  target: number;
  drift: number;
  modulation: number;
}

export function snapshotNotes(notes: readonly EngineNote[]): NoteSnapshot[] {
  return notes.map((n) => ({
    startFrame: n.startFrame,
    endFrame: n.endFrame,
    startSec: n.startSec,
    endSec: n.endSec,
    target: n.target,
    drift: n.drift,
    modulation: n.modulation,
  }));
}

export type StructuralOp = { kind: "split"; index: number; sec: number } | { kind: "merge"; index: number };

/**
 * One split/merge that brings the current note layout closer to `target`'s, or null when both have the
 * same note boundaries (within `tol` frames). Apply it, re-read the notes, and call again.
 */
export function nextStructuralOp(
  current: readonly Pick<NoteSnapshot, "startFrame" | "endFrame">[],
  target: readonly Pick<NoteSnapshot, "startFrame" | "endFrame" | "startSec">[],
  tol = 0
): StructuralOp | null {
  // A target note starting strictly inside a current note -> that current note must be split there.
  for (let i = 0; i < current.length; i++) {
    const c = current[i];
    for (const t of target) {
      if (t.startFrame > c.startFrame + tol && t.startFrame < c.endFrame - tol) {
        return { kind: "split", index: i, sec: t.startSec };
      }
    }
  }
  // A current boundary that no target note starts at, between two notes covered by one target note -> merge.
  for (let i = 0; i + 1 < current.length; i++) {
    const next = current[i + 1];
    const startsTarget = target.some((t) => Math.abs(t.startFrame - next.startFrame) <= tol);
    if (startsTarget) continue;
    const owner = target.find((t) => t.startFrame <= current[i].startFrame + tol && t.endFrame >= next.startFrame - tol);
    if (owner && owner.endFrame >= next.endFrame - tol) return { kind: "merge", index: i };
  }
  return null;
}

/** Pairs each snapshot note with the current note starting at the same frame (±tol): [currentIndex, snapshot]. */
export function matchSnapshot(
  current: readonly Pick<NoteSnapshot, "startFrame">[],
  target: readonly NoteSnapshot[],
  tol = 0
): [number, NoteSnapshot][] {
  const out: [number, NoteSnapshot][] = [];
  for (const t of target) {
    let best = -1;
    let bestD = Infinity;
    current.forEach((c, i) => {
      const d = Math.abs(c.startFrame - t.startFrame);
      if (d <= tol && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best >= 0) out.push([best, t]);
  }
  return out;
}

/** Bounded undo/redo stack of snapshots, with optional coalescing of rapid same-key pushes (slider drags). */
export class UndoStack<T> {
  private undoList: T[] = [];
  private redoList: T[] = [];
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(private readonly limit = 200, private readonly coalesceMs = 1000) {}

  /** Records `state` (the state BEFORE an edit). Same `key` within coalesceMs of the last push is merged. */
  push(state: T, key?: string, now: number = Date.now()): void {
    if (key && key === this.lastKey && now - this.lastAt < this.coalesceMs) {
      this.lastAt = now;
      this.redoList = [];
      return;
    }
    this.undoList.push(state);
    if (this.undoList.length > this.limit) this.undoList.shift();
    this.redoList = [];
    this.lastKey = key ?? null;
    this.lastAt = now;
  }

  undo(current: T): T | null {
    const s = this.undoList.pop();
    if (s === undefined) return null;
    this.redoList.push(current);
    this.lastKey = null;
    return s;
  }

  redo(current: T): T | null {
    const s = this.redoList.pop();
    if (s === undefined) return null;
    this.undoList.push(current);
    this.lastKey = null;
    return s;
  }

  get canUndo(): boolean {
    return this.undoList.length > 0;
  }

  get canRedo(): boolean {
    return this.redoList.length > 0;
  }

  clear(): void {
    this.undoList = [];
    this.redoList = [];
    this.lastKey = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------------------------

/** Averages channels into one mono track. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return new Float32Array(channels[0]);
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i] * g;
  return out;
}

/** Writes `src` into `dest` starting at `startSample`, clipped to dest's bounds. Returns [start, end) written. */
export function patchSamples(dest: Float32Array, startSample: number, src: Float32Array): [number, number] {
  const start = Math.max(0, Math.round(startSample));
  const skip = start - Math.round(startSample);
  const count = Math.max(0, Math.min(src.length - skip, dest.length - start));
  if (count <= 0) return [start, start];
  dest.set(src.subarray(skip, skip + count), start);
  return [start, start + count];
}

export const PEAK_BLOCK = 128;

/** Max-abs per block of `block` samples (waveform lane). */
export function computePeaks(data: Float32Array, block = PEAK_BLOCK): Float32Array {
  const peaks = new Float32Array(Math.ceil(data.length / block));
  updatePeaks(peaks, data, block, 0, data.length);
  return peaks;
}

/** Recomputes the peak blocks covering samples [start, end). */
export function updatePeaks(peaks: Float32Array, data: Float32Array, block: number, start: number, end: number): void {
  const b0 = Math.max(0, Math.floor(start / block));
  const b1 = Math.min(peaks.length, Math.ceil(end / block));
  for (let b = b0; b < b1; b++) {
    let m = 0;
    const s1 = Math.min(data.length, (b + 1) * block);
    for (let s = b * block; s < s1; s++) {
      const v = Math.abs(data[s]);
      if (v > m) m = v;
    }
    peaks[b] = m;
  }
}

/** 16-bit PCM mono WAV file bytes. */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return buf;
}

/** Merges overlapping/adjacent [start, end] spans (seconds). */
export function mergeSpans(spans: readonly [number, number][]): [number, number][] {
  const sorted = spans.filter(([a, b]) => b > a).slice().sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
