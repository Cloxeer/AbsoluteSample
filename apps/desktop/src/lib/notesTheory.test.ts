import { describe, expect, it } from "vitest";
import { camelotFor, explainKey, noteToPc } from "./notesTheory";
import type { NotesResult } from "./types";

describe("noteToPc", () => {
  it("parses natural and sharp note names", () => {
    expect(noteToPc("C")).toBe(0);
    expect(noteToPc("G")).toBe(7);
    expect(noteToPc("F#")).toBe(6);
  });

  it("returns null for unrecognized names", () => {
    expect(noteToPc("H")).toBeNull();
  });
});

describe("camelotFor", () => {
  it("matches known camelot codes", () => {
    expect(camelotFor("C", "major")).toBe("8B");
    expect(camelotFor("G", "major")).toBe("9B");
    expect(camelotFor("A", "minor")).toBe("8A");
  });
});

function resultFor(tonic: string, mode: "major" | "minor", chordNames: string[]): NotesResult {
  return {
    notes: [],
    key: { tonic, mode, confidence: 0.9 },
    chords: chordNames.map((name, i) => ({ startSec: i, endSec: i + 1, name, notes: [] })),
    scale: ["C", "D", "E", "F", "G", "A", "B"],
    bpm: 120,
    midPath: "mock/notes.mid",
    elapsedSec: 0.4,
  };
}

describe("explainKey", () => {
  it("describes a major key with tonic, dominant and subdominant chords", () => {
    const text = explainKey(resultFor("G", "major", ["G", "C", "D"]));
    expect(text).toContain("This is in G major");
    expect(text).toContain("Its home note is G");
    expect(text).toContain("G is the happy home chord");
    expect(text).toContain("D wants to go back home to G");
    expect(text).toContain("C feels like a step away from home");
  });

  it("describes a minor key with a serious/sad mood", () => {
    const text = explainKey(resultFor("A", "minor", ["A"]));
    expect(text).toContain("sounds more serious or sad");
    expect(text).toContain("A is the serious home chord");
  });

  it("handles a missing key gracefully", () => {
    const result = resultFor("C", "major", []);
    result.key = null;
    expect(explainKey(result)).toMatch(/not enough notes/i);
  });
});
