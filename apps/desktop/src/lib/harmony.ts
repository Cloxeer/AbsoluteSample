/**
 * Multitrack helpers for harmonies: one key for all takes, and the interval of a harmony note to the
 * lead note sounding at the same time (so you can see "3rd above lead" while dragging).
 */

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyNote {
  startSec: number;
  endSec: number;
  /** Pitch the note is (or will be) sung at, fractional MIDI. */
  target: number;
}

export interface KeyTrack {
  notes: readonly KeyNote[];
  /** Relative weight (e.g. lead 2, harmonies 1). */
  weight: number;
}

export interface KeyEstimate {
  tonicPc: number;
  mode: "major" | "minor";
  confidence: number;
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / 12;
  const mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}

/** Krumhansl-Schmuckler over every track's notes, weighted by duration x track weight. */
export function detectKeyAcross(tracks: readonly KeyTrack[]): KeyEstimate | null {
  const hist = new Array<number>(12).fill(0);
  for (const t of tracks)
    for (const n of t.notes) hist[((Math.round(n.target) % 12) + 12) % 12] += Math.max(0, n.endSec - n.startSec) * t.weight;
  if (hist.every((v) => v === 0)) return null;
  let best: KeyEstimate & { r: number } = { tonicPc: 0, mode: "major", confidence: 0, r: -2 };
  for (const [mode, prof] of [["major", KS_MAJOR], ["minor", KS_MINOR]] as const)
    for (let tonic = 0; tonic < 12; tonic++) {
      const rot = Array.from({ length: 12 }, (_, i) => prof[(i - tonic + 12) % 12]);
      const r = correlation(hist, rot);
      if (r > best.r) best = { tonicPc: tonic, mode, confidence: (r + 1) / 2, r };
    }
  return { tonicPc: best.tonicPc, mode: best.mode, confidence: best.confidence };
}

const NAMES = ["unison", "minor 2nd", "2nd", "minor 3rd", "3rd", "4th", "tritone", "5th", "minor 6th", "6th", "minor 7th", "7th"];

export interface Interval {
  semitones: number;
  /** e.g. "3rd above lead", "octave below lead" */
  label: string;
  /** Minor 2nd / major 7th / tritone against the lead: sounds harsh when held. */
  clash: boolean;
}

export function intervalTo(leadMidi: number, harmonyMidi: number): Interval {
  const semitones = Math.round(harmonyMidi) - Math.round(leadMidi);
  const abs = Math.abs(semitones);
  const pc = abs % 12;
  const octaves = Math.floor(abs / 12);
  let name = NAMES[pc];
  if (pc === 0) name = octaves === 0 ? "unison" : octaves === 1 ? "octave" : `${octaves} octaves`;
  else if (octaves > 0) name = `${name} + ${octaves === 1 ? "octave" : `${octaves} octaves`}`;
  const dir = semitones === 0 ? "with" : semitones > 0 ? "above" : "below";
  return { semitones, label: semitones === 0 ? "unison with lead" : `${name} ${dir} lead`, clash: pc === 1 || pc === 11 || pc === 6 };
}

/** The lead note sounding at timeline time `sec` (lead notes in lead-local time, lead offset given). */
export function leadNoteAt(leadNotes: readonly KeyNote[], leadOffsetSec: number, sec: number): KeyNote | null {
  const t = sec - leadOffsetSec;
  for (const n of leadNotes) if (t >= n.startSec && t < n.endSec) return n;
  return null;
}
