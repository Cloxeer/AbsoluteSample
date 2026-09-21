import { describe, expect, it, beforeEach, vi } from "vitest";

// Fresh module instance per test so the in-memory library store resets.
async function freshMock() {
  vi.resetModules();
  return import("./backend.mock");
}

describe("backend.mock library pruning", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("seeds the kept track and two extra fake entries", async () => {
    const mock = await freshMock();
    const entries = await mock.listLibrary();
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const songTwo = entries.find((e) => e.id === "ZAz3rnLGthg");
    const songThree = entries.find((e) => e.id === "XEolg577-DA");
    expect(songTwo).toBeTruthy();
    expect(songTwo!.kept).toBe(false);
    expect(songTwo!.hasLoop).toBe(false);
    expect(songTwo!.hasBands).toBe(false);
    expect(songTwo!.hasInstruments).toBe(false);
    expect(songThree).toBeTruthy();
    expect(songThree!.hasLoop).toBe(true);
    expect(songThree!.hasBands).toBe(false);
    expect(songThree!.kept).toBe(false);
  });

  it("prunes unkept, no-split entries when fetching a new id", async () => {
    const mock = await freshMock();
    const before = await mock.listLibrary();
    expect(before.some((e) => e.id === "ZAz3rnLGthg")).toBe(true);

    await mock.fetchAudio({ url: "https://youtu.be/newvideoid1" });

    const after = await mock.listLibrary();
    // The unkept fetch-only and unkept loop-only entries should be gone.
    expect(after.some((e) => e.id === "ZAz3rnLGthg")).toBe(false);
    expect(after.some((e) => e.id === "XEolg577-DA")).toBe(false);
    // The new track and the kept seed track survive.
    expect(after.some((e) => e.id === "newvideoid1")).toBe(true);
  });

  it("keeps kept and split entries across a prune", async () => {
    const mock = await freshMock();
    // seed track is kept=true with bands, so it must survive.
    await mock.fetchAudio({ url: "https://youtu.be/newvideoid2" });
    const after = await mock.listLibrary();
    expect(after.some((e) => e.id === "nRKgT3d6xoE")).toBe(true);
  });

  it("never prunes the id currently being fetched", async () => {
    const mock = await freshMock();
    // Fetching the fetch-only extra entry's own id should not remove it, even though it
    // is unkept and has no split.
    const track = await mock.fetchAudio({ url: "https://youtu.be/ZAz3rnLGthg" });
    expect(track.id).toBe("ZAz3rnLGthg");
    const after = await mock.listLibrary();
    expect(after.some((e) => e.id === "ZAz3rnLGthg")).toBe(true);
  });
});
