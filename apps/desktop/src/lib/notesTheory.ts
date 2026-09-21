import type { NotesResult } from "./types";

const PC_NAMES: Record<string, number> = {
  C: 0, "B#": 0,
  "C#": 1, DB: 1, "D♭": 1,
  D: 2,
  "D#": 3, EB: 3, "E♭": 3,
  E: 4, FB: 4,
  F: 5, "E#": 5,
  "F#": 6, GB: 6, "G♭": 6,
  G: 7,
  "G#": 8, AB: 8, "A♭": 8,
  A: 9,
  "A#": 10, BB: 10, "B♭": 10,
  B: 11, CB: 11,
};

/** Parses a note name like "G", "F#", "Bb" into a pitch class 0..11. Returns null if unrecognized. */
export function noteToPc(name: string): number | null {
  const key = name.trim().toUpperCase().replace("♭", "B");
  if (key in PC_NAMES) return PC_NAMES[key];
  return null;
}

// Camelot wheel, indexed by tonic pitch class.
const MAJOR_CAMELOT: Record<number, string> = {
  0: "8B", 7: "9B", 2: "10B", 9: "11B", 4: "12B", 11: "1B",
  6: "2B", 1: "3B", 8: "4B", 3: "5B", 10: "6B", 5: "7B",
};
const MINOR_CAMELOT: Record<number, string> = {
  9: "8A", 4: "9A", 11: "10A", 6: "11A", 1: "12A", 8: "1A",
  3: "2A", 10: "3A", 5: "4A", 0: "5A", 7: "6A", 2: "7A",
};

/** Camelot wheel code (e.g. "9B") for a tonic + mode, or null if the tonic name isn't recognized. */
export function camelotFor(tonic: string, mode: "major" | "minor"): string | null {
  const pc = noteToPc(tonic);
  if (pc === null) return null;
  return (mode === "major" ? MAJOR_CAMELOT : MINOR_CAMELOT)[pc] ?? null;
}

function chordRootPc(chordName: string): number | null {
  const m = chordName.match(/^([A-Ga-g])([#b♭]?)/);
  if (!m) return null;
  return noteToPc(`${m[1].toUpperCase()}${m[2] === "b" ? "b" : m[2]}`);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function chordRoleSentence(chordName: string, tonic: string, tonicPc: number, mode: "major" | "minor"): string | null {
  const rootPc = chordRootPc(chordName);
  if (rootPc === null) return null;
  const interval = ((rootPc - tonicPc) % 12 + 12) % 12;
  if (interval === 0) {
    return mode === "minor"
      ? `${chordName} is the serious home chord.`
      : `${chordName} is the happy home chord.`;
  }
  if (interval === 7) {
    return `${chordName} wants to go back home to ${tonic}.`;
  }
  if (interval === 5) {
    return `${chordName} feels like a step away from home.`;
  }
  return null;
}

/** Builds the kid-level "in plain words" explanation of a NotesResult's key, scale and chords. */
export function explainKey(result: NotesResult): string {
  if (!result.key) {
    return "Not enough notes were found yet to tell what key this is in.";
  }
  const { tonic, mode } = result.key;
  const tonicPc = noteToPc(tonic);
  const moodPhrase = mode === "minor" ? "sounds more serious or sad" : "sounds bright and happy";

  const sentences: string[] = [];
  sentences.push(`This is in ${tonic} ${mode}, which ${moodPhrase}.`);
  sentences.push(`Its home note is ${tonic}.`);
  if (result.scale.length > 0) {
    sentences.push(`It mostly uses these ${result.scale.length} notes: ${result.scale.join(" ")}.`);
  }

  const chordNames = Array.from(new Set(result.chords.map((c) => c.name)));
  if (chordNames.length > 0) {
    sentences.push(`The chords you hear are ${joinList(chordNames)}.`);
    if (tonicPc !== null) {
      const roleSentences = chordNames
        .map((name) => chordRoleSentence(name, tonic, tonicPc, mode))
        .filter((s): s is string => Boolean(s));
      if (roleSentences.length > 0) sentences.push(roleSentences.join(" "));
    }
  }

  return sentences.join(" ");
}
