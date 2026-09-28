/**
 * "Tighten timing": the part that stops a stack sounding like a crowd. Each harmony syllable that
 * starts (or, at a phrase end, stops) a little before/after the lead is moved toward the lead's
 * timing, like Revoice/VocAlign do. Produces identity-ended warp segments (see ./timeWarp), one per
 * harmony phrase, placed in the silences around it. The lead is the reference and never moves.
 */
import type { EngineNote } from "./melodyneEditor";
import { MAX_SLOPE, MIN_SLOPE, type WarpSegment } from "./timeWarp";

/** Only differences in this range are treated as "the same syllable, a bit off". */
export const MIN_MOVE_SEC = 0.008;
export const MAX_ONSET_MOVE_SEC = 0.12;
export const MAX_END_MOVE_SEC = 0.15;
/** Harmony notes closer than this belong to the same phrase. */
const PHRASE_GAP_SEC = 0.12;
const EDGE_PAD_SEC = 0.25;
const MIN_ANCHOR_SPACING = 0.03;
/** Stay inside the engine's speed limits with some headroom. */
const SAFE_MIN = MIN_SLOPE * 1.12;
const SAFE_MAX = MAX_SLOPE / 1.12;
const MIN_NOTE_SEC = 0.08;

interface Mark {
  out: number;
  inp: number;
  /** false = pinned where it was sung. */
  move: boolean;
  /** The full move, when this one was shrunk to fit. */
  orig?: Mark;
}

/** How much of a move to keep when syllables are crowded. */
const SHRINK = [1, 0.75, 0.5, 0.25];

export interface TimingInput {
  /** Lead notes, timeline seconds. */
  lead: readonly { startSec: number; endSec: number }[];
  /** Harmony notes in the take's own (input) time. */
  notes: readonly EngineNote[];
  offsetSec: number;
  durationSec: number;
  /** 0 = natural (75% of the way), 1 = tight (all the way). */
  tight: number;
}

export interface TimingPlan {
  segments: WarpSegment[];
  /** Syllable starts/ends moved. */
  moved: number;
}

function phrases(notes: readonly EngineNote[]): [number, number][] {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  const out: [number, number][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n.startSec - last[1] < PHRASE_GAP_SEC) last[1] = Math.max(last[1], n.endSec);
    else out.push([n.startSec, n.endSec]);
  }
  return out;
}

const slopeOk = (p: [number, number], q: [number, number]) => {
  const dOut = q[0] - p[0];
  const dIn = q[1] - p[1];
  if (dOut < MIN_ANCHOR_SPACING || dIn < MIN_ANCHOR_SPACING) return false;
  const s = dIn / dOut;
  return s >= SAFE_MIN && s <= SAFE_MAX;
};

export function planTightTiming(input: TimingInput): TimingPlan {
  const { notes, offsetSec, durationSec } = input;
  const f = 0.75 + 0.25 * Math.max(0, Math.min(1, input.tight));
  // Lead in this take's own time.
  const lead = input.lead.map((l) => ({ s: l.startSec - offsetSec, e: l.endSec - offsetSec }));
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  // Marks: syllables to move onto the lead, and syllables that are already right, pinned so the
  // stretch between two moves never drags an in-time syllable off.
  const marks: Mark[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const n = sorted[k];
    if (n.endSec - n.startSec < MIN_NOTE_SEC) continue;
    // The lead note this syllable belongs to: the one starting closest to it (and overlapping it).
    let best: { s: number; e: number } | null = null;
    for (const l of lead) {
      const overlap = Math.min(n.endSec, l.e) - Math.max(n.startSec, l.s);
      if (overlap <= 0 && Math.abs(l.s - n.startSec) > MAX_ONSET_MOVE_SEC) continue;
      if (!best || Math.abs(l.s - n.startSec) < Math.abs(best.s - n.startSec)) best = l;
    }
    const d0 = best ? best.s - n.startSec : 0;
    const moveOn = Math.abs(d0) >= MIN_MOVE_SEC && Math.abs(d0) <= MAX_ONSET_MOVE_SEC;
    marks.push({ out: moveOn ? n.startSec + f * d0 : n.startSec, inp: n.startSec, move: moveOn });
    // Phrase-final releases matter too (the "s" at the end of a line).
    const next = sorted[k + 1];
    if (!next || next.startSec - n.endSec >= 0.05) {
      const d1 = best ? best.e - n.endSec : 0;
      const moveOff = Math.abs(d1) >= MIN_MOVE_SEC && Math.abs(d1) <= MAX_END_MOVE_SEC;
      marks.push({ out: moveOff ? n.endSec + f * d1 : n.endSec, inp: n.endSec, move: moveOff });
    }
  }
  marks.sort((a, b) => a.inp - b.inp);

  const ph = phrases(sorted);
  const segments: WarpSegment[] = [];
  let moved = 0;
  for (let p = 0; p < ph.length; p++) {
    const [s, e] = ph[p];
    const prevEnd = p > 0 ? ph[p - 1][1] : 0;
    const nextStart = p + 1 < ph.length ? ph[p + 1][0] : durationSec;
    const A = Math.max(0, s - Math.min(EDGE_PAD_SEC, (s - prevEnd) / 2));
    // A hair inside the file, so the end anchor can never round past the last sample.
    const B = Math.min(durationSec - 0.001, e + Math.min(EDGE_PAD_SEC, (nextStart - e) / 2));
    if (B - A < 0.1) continue;
    const chosen: Mark[] = [{ out: A, inp: A, move: false }];
    const pt = (m: Mark): [number, number] => [m.out, m.inp];
    const scaled = (m: Mark, k: number): Mark => ({ out: m.inp + k * (m.out - m.inp), inp: m.inp, move: k > 0 && m.move });
    for (const m of marks) {
      if (m.inp <= A || m.inp >= B || m.out <= A || m.out >= B) continue;
      const prev = chosen[chosen.length - 1];
      if (m.move) {
        // Crowded syllables: move less rather than squash the audio or drag a neighbour.
        const fit = SHRINK.map((k) => scaled(m, k)).find((c) => slopeOk(pt(prev), pt(c)));
        if (fit) chosen.push(fit);
        continue;
      }
      if (slopeOk(pt(prev), pt(m))) {
        chosen.push(m);
        continue;
      }
      // A pinned (in-time) syllable must not be dragged: shrink the move before it until both fit.
      if (prev.move && chosen.length > 1) {
        const before = chosen[chosen.length - 2];
        const orig = prev.orig ?? prev;
        for (const k of [...SHRINK.slice(1), 0]) {
          const c = { ...scaled(orig, k), orig };
          if (slopeOk(pt(before), pt(c)) && slopeOk(pt(c), pt(m))) {
            chosen[chosen.length - 1] = c;
            chosen.push(m);
            break;
          }
        }
      }
    }
    // The last anchors must still reach the end within the speed limits.
    while (chosen.length > 1 && !slopeOk(pt(chosen[chosen.length - 1]), [B, B])) chosen.pop();
    const moves = chosen.filter((m) => m.move).length;
    if (moves === 0) continue;
    moved += moves;
    segments.push({ anchors: [...chosen.map(pt), [B, B]] });
  }
  return { segments, moved };
}
