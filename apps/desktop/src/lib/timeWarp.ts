/**
 * Timing edits ("Tighten timing"): each segment maps OUTPUT time to INPUT time through anchors and
 * is the identity at both ends (the pitchcore engine refuses anything else), so audio outside it is
 * untouched and files keep their exact length. The engine keeps its analysis in input time; the
 * editor shows notes where they will be heard, via `warpAnalysis`.
 */
import type { Analysis, EngineNote } from "./melodyneEditor";

export interface WarpSegment {
  /** (output sec, input sec), strictly increasing, identity at both ends. */
  anchors: [number, number][];
}

/** Same limits as the engine (input seconds per output second). */
export const MIN_SLOPE = 0.5;
export const MAX_SLOPE = 2.0;

export function segmentBounds(s: WarpSegment): [number, number] {
  return [s.anchors[0][0], s.anchors[s.anchors.length - 1][0]];
}

export function isValidSegment(s: WarpSegment): boolean {
  const a = s.anchors;
  if (a.length < 2) return false;
  const eps = 1e-4;
  if (Math.abs(a[0][0] - a[0][1]) > eps || Math.abs(a[a.length - 1][0] - a[a.length - 1][1]) > eps || a[0][0] < 0) return false;
  for (let i = 1; i < a.length; i++) {
    const dOut = a[i][0] - a[i - 1][0];
    const dIn = a[i][1] - a[i - 1][1];
    if (!(dOut > 0 && dIn > 0)) return false;
    const slope = dIn / dOut;
    if (slope < MIN_SLOPE || slope > MAX_SLOPE) return false;
  }
  return true;
}

function interp(a: readonly [number, number][], t: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  if (t <= a[0][from] || t >= a[a.length - 1][from]) return t;
  let k = 1;
  while (k < a.length - 1 && a[k][from] <= t) k++;
  const p = a[k - 1];
  const q = a[k];
  return p[to] + ((t - p[from]) * (q[to] - p[to])) / (q[from] - p[from]);
}

/** Where the audio heard at output time `t` comes from. */
export function outToIn(segs: readonly WarpSegment[], t: number): number {
  for (const s of segs) {
    const [a, b] = segmentBounds(s);
    if (t > a && t < b) return interp(s.anchors, t, 0);
  }
  return t;
}

/** When input time `t` is heard. */
export function inToOut(segs: readonly WarpSegment[], t: number): number {
  for (const s of segs) {
    const [a, b] = segmentBounds(s);
    if (t > a && t < b) return interp(s.anchors, t, 1);
  }
  return t;
}

/** Engine wire format: [n, out0, in0, out1, in1, ..., n2, ...]. */
export function flattenWarps(segs: readonly WarpSegment[]): Float32Array {
  const out: number[] = [];
  for (const s of segs) {
    out.push(s.anchors.length);
    for (const [o, i] of s.anchors) out.push(o, i);
  }
  return Float32Array.from(out);
}

/** Grows render spans to whole warped segments (a segment is always rebuilt in one piece). */
export function expandSpans(spans: readonly [number, number][], segs: readonly WarpSegment[]): [number, number][] {
  return spans.map(([a, b]) => {
    let lo = a;
    let hi = b;
    for (const s of segs) {
      const [sa, sb] = segmentBounds(s);
      if (sb > lo && sa < hi) {
        lo = Math.min(lo, sa);
        hi = Math.max(hi, sb);
      }
    }
    return [lo, hi] as [number, number];
  });
}

const cache = new WeakMap<Analysis, { segs: readonly WarpSegment[]; out: Analysis }>();

/**
 * The analysis as it will be HEARD: notes moved to their output times and the per-frame curves
 * (pitch, edited pitch, level) resampled onto the output timeline. Note order and indices are
 * unchanged, so edits still address the engine's notes. Cached per (analysis, warps).
 */
export function warpAnalysis(a: Analysis, segs: readonly WarpSegment[]): Analysis {
  if (segs.length === 0) return a;
  const hit = cache.get(a);
  if (hit && hit.segs === segs) return hit.out;
  const hop = a.hopSec;
  const frames = a.pitch.length;
  const pick = <T>(arr: readonly T[], f: number): T => {
    const src = Math.round(outToIn(segs, f * hop) / hop);
    return arr[Math.max(0, Math.min(arr.length - 1, src))];
  };
  const pitch = new Array<number | null>(frames);
  const editedPitch = new Array<number | null>(frames);
  const db = new Array<number>(frames);
  for (let f = 0; f < frames; f++) {
    pitch[f] = pick(a.pitch, f);
    editedPitch[f] = pick(a.editedPitch, f);
    db[f] = pick(a.db, f);
  }
  const notes: EngineNote[] = a.notes.map((n) => {
    const startSec = inToOut(segs, n.startSec);
    const endSec = Math.max(startSec + hop, inToOut(segs, n.endSec));
    return { ...n, startSec, endSec, startFrame: Math.round(startSec / hop), endFrame: Math.max(Math.round(startSec / hop) + 1, Math.round(endSec / hop)) };
  });
  const out: Analysis = { ...a, pitch, editedPitch, db, notes };
  cache.set(a, { segs, out });
  return out;
}
