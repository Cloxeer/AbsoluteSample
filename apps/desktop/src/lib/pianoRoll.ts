import type { NoteEvent } from "./types";

export interface PianoRollLayout {
  minMidi: number;
  maxMidi: number;
  rowCount: number;
  rowHeight: number;
  height: number;
  pxPerSec: number;
  durationSec: number;
  width: number;
  /** Top y-coordinate (px) of the row for a given MIDI pitch. */
  yForMidi(midi: number): number;
  /** X-coordinate (px) for a given time in seconds. */
  xForSec(sec: number): number;
}

const MIN_SEMITONE_SPAN = 24; // 2 octaves
const DEFAULT_ROW_HEIGHT = 10;
const DEFAULT_PX_PER_SEC = 60;
const DEFAULT_MID_MIDI = 60; // C4, used when there are no notes to size the range from

/** True for MIDI pitches whose piano key is black (used to tint piano-roll rows). */
export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

/**
 * Computes the pitch range (min 2 octaves, centered on the notes' own range when narrower)
 * and the time->x / pitch->y mapping for the Notes tab's piano roll, from a NotesResult's notes.
 * Pure and deterministic so it can be unit tested without rendering anything.
 */
export function computePianoRollLayout(
  notes: NoteEvent[],
  opts?: { rowHeight?: number; pxPerSec?: number }
): PianoRollLayout {
  const rowHeight = opts?.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const pxPerSec = opts?.pxPerSec ?? DEFAULT_PX_PER_SEC;

  let loMidi: number;
  let hiMidi: number;
  if (notes.length === 0) {
    loMidi = DEFAULT_MID_MIDI - MIN_SEMITONE_SPAN / 2;
    hiMidi = DEFAULT_MID_MIDI + MIN_SEMITONE_SPAN / 2;
  } else {
    loMidi = Math.min(...notes.map((n) => n.midi));
    hiMidi = Math.max(...notes.map((n) => n.midi));
  }

  const span = hiMidi - loMidi;
  if (span < MIN_SEMITONE_SPAN) {
    const pad = MIN_SEMITONE_SPAN - span;
    const padLo = Math.floor(pad / 2);
    const padHi = pad - padLo;
    loMidi -= padLo;
    hiMidi += padHi;
  }
  loMidi = Math.max(0, loMidi);
  hiMidi = Math.min(127, hiMidi);

  const minMidi = loMidi;
  const maxMidi = hiMidi;
  const rowCount = maxMidi - minMidi + 1;
  const height = rowCount * rowHeight;

  const durationSec = notes.length > 0 ? Math.max(...notes.map((n) => n.endSec)) : 0;
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
      // Highest pitch drawn at the top.
      return (maxMidi - midi) * rowHeight;
    },
    xForSec(sec: number): number {
      return sec * pxPerSec;
    },
  };
}
