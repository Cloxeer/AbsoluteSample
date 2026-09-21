import { describe, expect, it, beforeEach, vi } from "vitest";

// Fresh module instance per test so the in-memory library store resets.
async function freshMock() {
  vi.resetModules();
  return import("./backend.mock");
}

describe("backend.mock library pruning (v4: scans vs kept songs)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("seeds the kept track and two extra unkept scan entries", async () => {
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

  it("keeps the 3 most recently opened unkept scans and prunes the oldest beyond that", async () => {
    const mock = await freshMock();
    // Seed already has 2 unkept scans. Fetching 3 more distinct unkept videos pushes the
    // unkept count past MAX_SCANS = 3, so the oldest unkept scan gets pruned.
    await mock.fetchAudio({ url: "https://youtu.be/newvideoid1" });
    await mock.fetchAudio({ url: "https://youtu.be/newvideoid2" });
    await mock.fetchAudio({ url: "https://youtu.be/newvideoid3" });

    const after = await mock.listLibrary();
    expect(after.some((e) => e.id === "ZAz3rnLGthg")).toBe(false);
    expect(after.some((e) => e.id === "XEolg577-DA")).toBe(true);
    expect(after.some((e) => e.id === "newvideoid1")).toBe(true);
    expect(after.some((e) => e.id === "newvideoid2")).toBe(true);
    expect(after.some((e) => e.id === "newvideoid3")).toBe(true);
  });

  it("keeps kept and split entries across a prune regardless of scan count", async () => {
    const mock = await freshMock();
    await mock.fetchAudio({ url: "https://youtu.be/newvideoid4" });
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

  it("does not mark a track kept when stems, instruments or a save happen (v4: no auto-keep)", async () => {
    const mock = await freshMock();
    await mock.separateStems({ trackId: "nRKgT3d6xoE" });
    const entries = await mock.listLibrary();
    const seed = entries.find((e) => e.id === "nRKgT3d6xoE");
    // Seed was already kept=true from seeding; verify split does not *newly* force it for an unkept one.
    await mock.fetchAudio({ url: "https://youtu.be/newvideoid5" });
    await mock.separateStems({ trackId: "newvideoid5" });
    const after = await mock.listLibrary();
    const fresh = after.find((e) => e.id === "newvideoid5");
    expect(fresh!.kept).toBe(false);
    expect(seed).toBeTruthy();
  });
});

describe("backend.mock samples", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("saves a sample with a default name derived from the song, stem and loop range", async () => {
    const mock = await freshMock();
    const sample = await mock.saveSample({ trackId: "nRKgT3d6xoE", stemKey: "drums_sub" });
    expect(sample.songId).toBe("nRKgT3d6xoE");
    expect(sample.stemKey).toBe("drums_sub");
    expect(sample.name).toContain("Drums / Sub");
  });

  it("lists, renames and deletes samples", async () => {
    const mock = await freshMock();
    const sample = await mock.saveSample({ trackId: "nRKgT3d6xoE", stemKey: "drums_sub", name: "My take" });
    let all = await mock.listSamples();
    expect(all.some((s) => s.id === sample.id)).toBe(true);

    const renamed = await mock.renameSample({ id: sample.id, name: "Renamed" });
    expect(renamed.name).toBe("Renamed");

    await mock.deleteSample({ id: sample.id });
    all = await mock.listSamples();
    expect(all.some((s) => s.id === sample.id)).toBe(false);
  });

  it("exports samples to fake destination paths", async () => {
    const mock = await freshMock();
    const sample = await mock.saveSample({ trackId: "nRKgT3d6xoE", stemKey: "drums_sub", name: "Export me" });
    const paths = await mock.exportSamples({ ids: [sample.id], destDir: "D:/out" });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("D:/out");
  });
});
