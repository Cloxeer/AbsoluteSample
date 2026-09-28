/**
 * "Fix harmonies": turns a lead plus rough harmony takes into a clean vocal stack without asking the
 * user for a single note name.
 *
 *  1. The lead is tuned gently to the key (sustained notes only; slides and short notes are left
 *     alone, and most of the natural wander and all vibrato are kept).
 *  2. Each harmony's ROLE is read from how it sits against the lead (e.g. "3rd above"), weighted by
 *     how long each note is held.
 *  3. Each harmony note gets the best nearby note of the key, chosen for a whole phrase at once
 *     (Viterbi), balancing: closeness to what was sung (the singer's intent), how it sounds against
 *     the lead note at that moment, keeping the harmony's role, the sung melodic shape, and not
 *     rubbing against harmonies already placed.
 *
 * Pure and fast (milliseconds): no model, no audio. Times are timeline seconds as HEARD.
 */
import { nearestAllowed, pitchClass, type EngineNote, type NoteEdit } from "./melodyneEditor";

/** Notes shorter than this are slides/ornaments: never retuned. */
export const MIN_NOTE_SEC = 0.09;

/** Roughness of an interval against the lead, by semitones mod 12 (0 = smooth). */
export const DISSONANCE = [0, 2.1, 0.55, 0, 0, 0.3, 1.2, 0.05, 0.1, 0.05, 0.5, 1.9];
const W_DIST = 0.9;
const W_ROLE = 0.35;
const W_CONTOUR = 0.5;
const W_OTHER_CLASH = 0.8;
const W_OTHER_UNISON = 0.2;
const SEARCH_SEMIS = 2.5;

export interface StackTrack {
  id: string;
  /** Notes as heard, in the track's own time (add offsetSec for the timeline). */
  notes: readonly EngineNote[];
  offsetSec: number;
  isLead: boolean;
}

export interface FixOptions {
  scalePcs: readonly number[];
  /** 0 = natural (keeps most of the wander), 1 = tight (steadier, more "produced"). */
  tight: number;
}

export interface HarmonyRole {
  /** Scale steps from the lead (0 = double, +2 = 3rd above, -2 = 3rd below, ...); null = free. */
  steps: number | null;
  semitones: number | null;
  label: string;
}

export interface TrackFix {
  id: string;
  edits: NoteEdit[];
  role: HarmonyRole | null;
  /** Notes moved by more than 15 cents. */
  fixed: number;
  clashesBefore: number;
  clashesAfter: number;
}

export type SectionKind = "lead" | "stack" | "harmony";
export interface Section {
  startSec: number;
  endSec: number;
  kind: SectionKind;
}

export interface FixPlan {
  tracks: TrackFix[];
  sections: Section[];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
const dur = (n: Pick<EngineNote, "startSec" | "endSec">) => n.endSec - n.startSec;
const mod12 = (v: number) => ((v % 12) + 12) % 12;

const sortedCache = new WeakMap<readonly number[], number[]>();
const sortedPcs = (scalePcs: readonly number[]) => {
  let v = sortedCache.get(scalePcs);
  if (!v) sortedCache.set(scalePcs, (v = [...scalePcs].sort((a, b) => a - b)));
  return v;
};

/** Index of an in-scale MIDI note along the scale (steps), for any integer MIDI (snapped first). */
export function scaleStep(midi: number, scalePcs: readonly number[]): number {
  const m = nearestAllowed(Math.round(midi), scalePcs);
  const pcs = sortedPcs(scalePcs);
  const oct = Math.floor(m / 12);
  const idx = pcs.indexOf(pitchClass(m));
  return oct * pcs.length + Math.max(0, idx);
}

export function isClash(semitones: number): boolean {
  const pc = mod12(Math.round(semitones));
  return pc === 1 || pc === 11 || pc === 6;
}

interface Overlap {
  target: number;
  weight: number;
}

interface Span {
  s: number;
  e: number;
  target: number;
}

/** Spans sorted by start, for O(log n) overlap queries (songs have thousands of notes). */
interface SpanSet {
  items: Span[];
  maxLen: number;
}

function spanSet(items: readonly Span[]): SpanSet {
  const sorted = [...items].sort((x, y) => x.s - y.s);
  return { items: sorted, maxLen: sorted.reduce((m, x) => Math.max(m, x.e - x.s), 0) };
}

/** Notes sounding during [a, b) (timeline), weighted by the share of the span they cover. */
function overlaps(set: SpanSet, a: number, b: number): Overlap[] {
  const out: Overlap[] = [];
  const span = Math.max(1e-6, b - a);
  const { items } = set;
  let lo = 0;
  let hi = items.length;
  const from = a - set.maxLen;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].s < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < items.length && items[i].s < b; i++) {
    const l = items[i];
    const o = Math.min(b, l.e) - Math.max(a, l.s);
    if (o > 0) out.push({ target: l.target, weight: o / span });
  }
  return out;
}

const INTERVAL_NAMES = ["unison", "minor 2nd", "2nd", "minor 3rd", "3rd", "4th", "tritone", "5th", "minor 6th", "6th", "minor 7th", "7th"];

function roleLabel(steps: number | null, semis: number | null): string {
  if (steps === null || semis === null) return "Free harmony";
  if (semis === 0) return "Double (same notes as the lead)";
  const abs = Math.abs(semis);
  if (abs % 12 === 0) return `Octave double ${semis > 0 ? "above" : "below"}`;
  const name = INTERVAL_NAMES[abs % 12] + (abs > 12 ? " + octave" : "");
  return `${semis > 0 ? "High" : "Low"} harmony (${name} ${semis > 0 ? "above" : "below"})`;
}

/** The harmony's typical position against the lead, by held time. */
export function detectRole(notes: readonly EngineNote[], offsetSec: number, leadSpans: readonly Span[] | SpanSet, scalePcs: readonly number[]): HarmonyRole {
  const lead = "items" in leadSpans ? leadSpans : spanSet(leadSpans);
  const stepVotes = new Map<number, number>();
  const semiVotes = new Map<number, number[]>();
  let covered = 0;
  let total = 0;
  for (const n of notes) {
    if (dur(n) < MIN_NOTE_SEC) continue;
    const a = n.startSec + offsetSec;
    const b = n.endSec + offsetSec;
    total += b - a;
    const ov = overlaps(lead, a, b);
    if (ov.length === 0) continue;
    const main = ov.reduce((x, y) => (y.weight > x.weight ? y : x));
    const w = ov.reduce((s, o) => s + o.weight, 0) * (b - a);
    covered += w;
    const h = nearestAllowed(Math.round(n.center), scalePcs);
    const l = Math.round(main.target);
    const st = scaleStep(h, scalePcs) - scaleStep(l, scalePcs);
    stepVotes.set(st, (stepVotes.get(st) ?? 0) + w);
    const arr = semiVotes.get(st) ?? [];
    arr.push(h - l);
    semiVotes.set(st, arr);
  }
  if (total === 0 || covered < 0.3 * total || stepVotes.size === 0) return { steps: null, semitones: null, label: roleLabel(null, null) };
  let best = 0;
  let bestW = -1;
  for (const [st, w] of stepVotes)
    if (w > bestW) {
      bestW = w;
      best = st;
    }
  // Not a consistent role unless it holds for at least ~40% of the covered time.
  if (bestW < 0.4 * covered) return { steps: null, semitones: null, label: roleLabel(null, null) };
  const semis = [...(semiVotes.get(best) ?? [0])].sort((a, b) => a - b);
  const median = semis[Math.floor(semis.length / 2)];
  return { steps: best, semitones: median, label: roleLabel(best, median) };
}

function candidatesFor(center: number, scalePcs: readonly number[]): number[] {
  const out: number[] = [];
  for (let m = Math.ceil(center - SEARCH_SEMIS); m <= Math.floor(center + SEARCH_SEMIS); m++) if (scalePcs.includes(pitchClass(m))) out.push(m);
  if (out.length === 0) out.push(nearestAllowed(center, scalePcs));
  return out;
}

interface Placed {
  s: number;
  e: number;
  target: number;
}

/**
 * Chooses a note for every sustained harmony note (Viterbi over the take, in time order).
 * Returns MIDI targets per note index (short notes are absent).
 */
function chooseTargets(
  notes: readonly EngineNote[],
  offsetSec: number,
  lead: SpanSet,
  others: SpanSet,
  role: HarmonyRole,
  scalePcs: readonly number[]
): Map<number, number> {
  const idx = notes.map((_, i) => i).filter((i) => dur(notes[i]) >= MIN_NOTE_SEC);
  const result = new Map<number, number>();
  if (idx.length === 0) return result;
  const cands = idx.map((i) => candidatesFor(notes[i].center, scalePcs));
  const emission = idx.map((i, k) => {
    const n = notes[i];
    const a = n.startSec + offsetSec;
    const b = n.endSec + offsetSec;
    const ov = overlaps(lead, a, b);
    const main = ov.length > 0 ? ov.reduce((x, y) => (y.weight > x.weight ? y : x)) : null;
    const oth = overlaps(others, a, b);
    return cands[k].map((m) => {
      let c = W_DIST * (m - n.center) ** 2;
      for (const o of ov) c += o.weight * DISSONANCE[mod12(m - Math.round(o.target))];
      if (main && role.steps !== null) {
        const st = scaleStep(m, scalePcs) - scaleStep(Math.round(main.target), scalePcs);
        if (st !== role.steps) c += W_ROLE * Math.min(1, ov.reduce((s, o) => s + o.weight, 0));
      }
      for (const o of oth) {
        const iv = m - Math.round(o.target);
        if (isClash(iv)) c += o.weight * W_OTHER_CLASH;
        else if (iv === 0 && role.semitones !== 0) c += o.weight * W_OTHER_UNISON;
      }
      return c;
    });
  });
  // Viterbi
  const cost: number[][] = [emission[0].slice()];
  const back: number[][] = [emission[0].map(() => -1)];
  for (let k = 1; k < idx.length; k++) {
    const prev = notes[idx[k - 1]];
    const cur = notes[idx[k]];
    const linked = cur.startSec - prev.endSec < 0.4;
    const sung = cur.center - prev.center;
    const row: number[] = [];
    const bk: number[] = [];
    cands[k].forEach((m, j) => {
      let best = Infinity;
      let arg = 0;
      cands[k - 1].forEach((pm, p) => {
        const t = linked ? W_CONTOUR * (m - pm - sung) ** 2 : 0.1 * W_CONTOUR * (m - pm - sung) ** 2;
        const v = cost[k - 1][p] + t;
        if (v < best) {
          best = v;
          arg = p;
        }
      });
      row.push(best + emission[k][j]);
      bk.push(arg);
    });
    cost.push(row);
    back.push(bk);
  }
  let j = cost[cost.length - 1].indexOf(Math.min(...cost[cost.length - 1]));
  for (let k = idx.length - 1; k >= 0; k--) {
    result.set(idx[k], cands[k][j]);
    j = back[k][j];
  }
  return result;
}

function unionSpans(spans: [number, number][], joinGap: number): [number, number][] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a - last[1] <= joinGap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Timeline sections: lead alone, lead with harmonies ("stack"), harmonies without the lead. */
export function findSections(tracks: readonly StackTrack[]): Section[] {
  const spansOf = (ts: readonly StackTrack[]) =>
    unionSpans(
      ts.flatMap((t) => t.notes.map((n) => [n.startSec + t.offsetSec, n.endSec + t.offsetSec] as [number, number])),
      0.35
    );
  const lead = spansOf(tracks.filter((t) => t.isLead));
  const harm = spansOf(tracks.filter((t) => !t.isLead));
  const cuts = [...new Set([...lead.flat(), ...harm.flat()])].sort((a, b) => a - b);
  const inside = (spans: [number, number][], t: number) => spans.some(([a, b]) => t >= a && t < b);
  const out: Section[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const mid = (a + b) / 2;
    const l = inside(lead, mid);
    const h = inside(harm, mid);
    if (!l && !h) continue;
    const kind: SectionKind = l && h ? "stack" : l ? "lead" : "harmony";
    const last = out[out.length - 1];
    if (last && last.kind === kind && Math.abs(last.endSec - a) < 1e-9) last.endSec = b;
    else out.push({ startSec: a, endSec: b, kind });
  }
  // Fold slivers (< 0.2 s) into the section they touch.
  const merged: Section[] = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    const touching = last !== undefined && Math.abs(last.endSec - s.startSec) < 1e-9;
    if (touching && (last.kind === s.kind || s.endSec - s.startSec < 0.2)) last.endSec = s.endSec;
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * The whole "Fix harmonies" plan. `include` lists the harmony ids to fix (the lead is always the
 * reference and is tuned gently too).
 */
export function planFixHarmonies(tracks: readonly StackTrack[], include: ReadonlySet<string>, opts: FixOptions): FixPlan {
  const { scalePcs, tight } = opts;
  const lead = tracks.find((t) => t.isLead) ?? null;
  const out: TrackFix[] = [];
  let leadPlaced: Placed[] = [];

  if (lead) {
    const edits: NoteEdit[] = [];
    let fixed = 0;
    for (let i = 0; i < lead.notes.length; i++) {
      const n = lead.notes[i];
      const sustained = dur(n) >= MIN_NOTE_SEC;
      const target = sustained ? nearestAllowed(n.center, scalePcs) : n.center;
      leadPlaced.push({ s: n.startSec + lead.offsetSec, e: n.endSec + lead.offsetSec, target });
      if (!sustained || !include.has(lead.id)) continue;
      if (Math.abs(target - n.center) > 0.15) fixed++;
      edits.push({ index: i, target, drift: lerp(0.75, 0.35, tight), modulation: lerp(1, 0.85, tight) });
    }
    out.push({ id: lead.id, edits, role: null, fixed, clashesBefore: 0, clashesAfter: 0 });
  } else leadPlaced = [];

  const placedOthers: Placed[] = [];
  for (const t of tracks) {
    if (t.isLead || !include.has(t.id)) continue;
    const leadSet = spanSet(leadPlaced);
    const role = detectRole(t.notes, t.offsetSec, leadSet, scalePcs);
    const targets = chooseTargets(t.notes, t.offsetSec, leadSet, spanSet(placedOthers), role, scalePcs);
    const edits: NoteEdit[] = [];
    let fixed = 0;
    let before = 0;
    let after = 0;
    for (const [i, m] of [...targets].sort((x, y) => x[0] - y[0])) {
      const n = t.notes[i];
      const a = n.startSec + t.offsetSec;
      const b = n.endSec + t.offsetSec;
      const ov = overlaps(leadSet, a, b);
      if (ov.length > 0) {
        const main = ov.reduce((x, y) => (y.weight > x.weight ? y : x));
        if (isClash(Math.round(n.center) - Math.round(main.target))) before++;
        if (isClash(m - Math.round(main.target))) after++;
      }
      if (Math.abs(m - n.center) > 0.15) fixed++;
      edits.push({ index: i, target: m, drift: lerp(0.7, 0.25, tight), modulation: lerp(1, 0.8, tight) });
      placedOthers.push({ s: a, e: b, target: m });
    }
    out.push({ id: t.id, edits, role, fixed, clashesBefore: before, clashesAfter: after });
  }
  return { tracks: out, sections: findSections(tracks) };
}
