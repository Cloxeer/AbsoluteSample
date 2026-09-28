/**
 * Vocal coach: plain-words feedback so you learn to sing it right, not just fix it afterwards.
 *  - per note: which note to aim for, how far off you were, how steady you held it;
 *  - per take: pitch accuracy, steadiness, and the few notes most worth practising;
 *  - melody hints: where a note in the key usually wants to go next (the "rules" of melody that
 *    songwriters learn first, e.g. the 7th rises to home, the 4th falls to the 3rd);
 *  - a guide tone: the target melody as a soft tone you can sing along to.
 */
import { nearestAllowed, noteName, pitchClass, type Analysis, type EngineNote } from "./melodyneEditor";

/** Notes shorter than this are too quick to judge. */
export const COACH_MIN_SEC = 0.15;
/** Within this many cents of a note of the key counts as "on pitch". */
export const ON_PITCH_CENTS = 25;

export interface NoteCoach {
  aim: number;
  aimName: string;
  /** Sung center relative to the aim, cents (negative = flat). */
  cents: number;
  /** 0..1 (1 = rock steady), null for notes too short to judge. */
  steadiness: number | null;
  verdict: string;
}

/** How steady a note is held: wander of the vibrato-free pitch curve around its own center. */
export function steadiness(pitch: readonly (number | null)[], note: Pick<EngineNote, "startFrame" | "endFrame" | "startSec" | "endSec">): number | null {
  if (note.endSec - note.startSec < COACH_MIN_SEC) return null;
  const vals: number[] = [];
  for (let f = Math.max(0, note.startFrame); f <= Math.min(pitch.length - 1, note.endFrame); f++) {
    const p = pitch[f];
    if (p !== null && p !== undefined) vals.push(p);
  }
  // Skip the first/last 15% (scoops into and out of a note are normal).
  const cut = Math.floor(vals.length * 0.15);
  const core = vals.slice(cut, vals.length - cut);
  if (core.length < 6) return null;
  // Moving average over ~150 ms removes vibrato (5-7 Hz), leaving the slow wander.
  const w = 7;
  const smooth = core.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(core.length - 1, i + w); k++) {
      s += core[k];
      c++;
    }
    return s / c;
  });
  const mean = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  const rmsCents = Math.sqrt(smooth.reduce((a, b) => a + (b - mean) ** 2, 0) / smooth.length) * 100;
  return Math.max(0, Math.min(1, 1 - (rmsCents - 6) / 40));
}

export function coachNote(n: EngineNote, pitch: readonly (number | null)[], scalePcs: readonly number[]): NoteCoach {
  const aim = nearestAllowed(n.center, scalePcs);
  const cents = Math.round((n.center - aim) * 100);
  const st = steadiness(pitch, n);
  const abs = Math.abs(cents);
  let verdict: string;
  if (abs <= ON_PITCH_CENTS) verdict = "On pitch";
  else if (abs <= 50) verdict = cents < 0 ? "A little flat: lift it slightly" : "A little sharp: ease it down";
  else verdict = cents < 0 ? "Flat: aim higher" : "Sharp: aim lower";
  if (st !== null && st < 0.55) verdict += " · hold it steadier";
  return { aim, aimName: noteName(aim), cents, steadiness: st, verdict };
}

export interface PracticeNote {
  index: number;
  aimName: string;
  cents: number;
  startSec: number;
}

export interface CoachSummary {
  /** Share of held notes within ±25 cents of a key note (0..1); null without held notes. */
  accuracy: number | null;
  /** Average steadiness of held notes (0..1). */
  steadiness: number | null;
  heldNotes: number;
  /** The notes most worth practising (furthest off), in time order. */
  practice: PracticeNote[];
}

export function coachSummary(a: Analysis, scalePcs: readonly number[], maxPractice = 3): CoachSummary {
  let held = 0;
  let onPitch = 0;
  let stSum = 0;
  let stN = 0;
  const off: PracticeNote[] = [];
  a.notes.forEach((n, index) => {
    if (n.endSec - n.startSec < COACH_MIN_SEC) return;
    held++;
    const c = coachNote(n, a.pitch, scalePcs);
    if (Math.abs(c.cents) <= ON_PITCH_CENTS) onPitch++;
    else off.push({ index, aimName: c.aimName, cents: c.cents, startSec: n.startSec });
    if (c.steadiness !== null) {
      stSum += c.steadiness;
      stN++;
    }
  });
  const practice = off
    .sort((x, y) => Math.abs(y.cents) - Math.abs(x.cents))
    .slice(0, maxPractice)
    .sort((x, y) => x.startSec - y.startSec);
  return { accuracy: held > 0 ? onPitch / held : null, steadiness: stN > 0 ? stSum / stN : null, heldNotes: held, practice };
}

export interface NextHint {
  midi: number;
  name: string;
  why: string;
}

/**
 * Where a melody usually goes from `midi` in this key: the pull of the scale degrees (tendency
 * tones) first, then step-wise neighbours. For learning the rules before breaking them.
 */
export function nextNoteHints(midi: number, tonicPc: number, scalePcs: readonly number[]): NextHint[] {
  const m = nearestAllowed(Math.round(midi), scalePcs);
  const pcs = [...scalePcs].sort((a, b) => mod(a - tonicPc) - mod(b - tonicPc));
  const deg = pcs.indexOf(pitchClass(m));
  const up = (steps: number) => stepFrom(m, steps, scalePcs);
  const hints: NextHint[] = [];
  const add = (x: number, why: string) => {
    if (!hints.some((h) => h.midi === x)) hints.push({ midi: x, name: noteName(x), why });
  };
  if (pcs.length === 7 && deg >= 0) {
    switch (deg) {
      case 0:
        add(m, "You're home (the key note): holding it sounds settled");
        add(up(1), "Step up to start a new idea");
        add(up(2), "Leap to the 3rd: bright and open");
        break;
      case 1:
        add(up(-1), "The 2nd likes to step down home");
        add(up(1), "…or up to the 3rd");
        break;
      case 2:
        add(up(-1), "Step down toward home");
        add(up(1), "Step up to the 4th");
        add(up(2), "Leap to the 5th: strong and stable");
        break;
      case 3:
        add(up(-1), "The 4th leans down to the 3rd");
        add(up(1), "…or climbs to the 5th");
        break;
      case 4:
        add(up(-4), "The 5th often lands back home");
        add(up(1), "Step up to the 6th");
        add(up(3), "Or jump up to home");
        break;
      case 5:
        add(up(-1), "The 6th falls to the 5th");
        add(up(1), "…or rises to the 7th");
        break;
      case 6:
        add(up(1), "The 7th wants to rise to home: it sounds resolved");
        add(up(-1), "…or falls to the 6th");
        break;
    }
  } else {
    add(up(-1), "Step down in the key");
    add(up(1), "Step up in the key");
  }
  return hints.slice(0, 3);
}

const mod = (v: number) => ((v % 12) + 12) % 12;

function stepFrom(m: number, steps: number, scalePcs: readonly number[]): number {
  let x = m;
  const dir = steps > 0 ? 1 : -1;
  for (let k = 0; k < Math.abs(steps); k++) {
    do x += dir;
    while (!scalePcs.includes(pitchClass(x)));
  }
  return x;
}

/**
 * A soft guide tone of the target melody (what to sing), `durationSec` long at `sampleRate`, in the
 * track's own time. Only held notes; each fades in/out so it never clicks.
 */
export function renderGuide(notes: readonly EngineNote[], sampleRate: number, durationSec: number): Float32Array {
  const out = new Float32Array(Math.max(1, Math.round(durationSec * sampleRate)));
  const att = Math.round(0.03 * sampleRate);
  const rel = Math.round(0.06 * sampleRate);
  for (const n of notes) {
    if (n.endSec - n.startSec < 0.12) continue;
    const a = Math.max(0, Math.round(n.startSec * sampleRate));
    const b = Math.min(out.length, Math.round(n.endSec * sampleRate));
    const w = (2 * Math.PI * 440 * Math.pow(2, (Math.round(n.target) - 69) / 12)) / sampleRate;
    for (let i = a; i < b; i++) {
      const k = i - a;
      const env = Math.min(1, k / att, (b - i) / rel);
      const ph = w * k;
      out[i] += 0.16 * env * (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph));
    }
  }
  return out;
}
