import { describe, expect, it } from "vitest";
import { groupInstruments } from "./instruments";
import type { InstrumentStem } from "./types";

function stem(overrides: Partial<InstrumentStem>): InstrumentStem {
  return {
    key: "x",
    label: "X",
    group: "other",
    parent: null,
    path: "mock/x.wav",
    bytes: 100,
    peakDb: -3,
    rmsDb: -12,
    model: "htdemucs_6s",
    order: 0,
    ...overrides,
  };
}

describe("groupInstruments", () => {
  it("returns only top-level (parent null) tracks, sorted by order", () => {
    const stems = [
      stem({ key: "bass", parent: null, order: 2 }),
      stem({ key: "vocals", parent: null, order: 0 }),
      stem({ key: "drums", parent: null, order: 1 }),
    ];
    const nodes = groupInstruments(stems);
    expect(nodes.map((n) => n.stem.key)).toEqual(["vocals", "drums", "bass"]);
  });

  it("attaches children to their parent, sorted by order, and top-level nodes are inMix", () => {
    const stems = [
      stem({ key: "drums", parent: null, order: 0 }),
      stem({ key: "drums_hihat", parent: "drums", order: 3 }),
      stem({ key: "drums_kick", parent: "drums", order: 0 }),
      stem({ key: "drums_snare", parent: "drums", order: 1 }),
      stem({ key: "vocals", parent: null, order: 1 }),
      stem({ key: "vocals_lead", parent: "vocals", order: 0 }),
    ];
    const nodes = groupInstruments(stems);
    const drums = nodes.find((n) => n.stem.key === "drums")!;
    expect(drums.inMix).toBe(true);
    expect(drums.children.map((c) => c.key)).toEqual(["drums_kick", "drums_snare", "drums_hihat"]);

    const vocals = nodes.find((n) => n.stem.key === "vocals")!;
    expect(vocals.children.map((c) => c.key)).toEqual(["vocals_lead"]);
  });

  it("never lists a child stem itself as a top-level (inMix) node", () => {
    const stems = [
      stem({ key: "drums", parent: null, order: 0 }),
      stem({ key: "drums_kick", parent: "drums", order: 0 }),
    ];
    const nodes = groupInstruments(stems);
    expect(nodes.some((n) => n.stem.key === "drums_kick")).toBe(false);
  });

  it("returns an empty list for no stems", () => {
    expect(groupInstruments([])).toEqual([]);
  });
});
