import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { mergeSubstems, useAudioEngine } from "./useAudioEngine";
import { backend } from "@/lib/backend";
import { emitMockStemReady } from "@/lib/events";
import type { InstrumentsResult, InstrumentStem } from "@/lib/types";

function stem(key: string, over: Partial<InstrumentStem> = {}): InstrumentStem {
  return { key, label: key, group: "other", parent: null, path: `w/${key}.flac`, bytes: 1, peakDb: -3, rmsDb: -18, model: "m", order: 0, ...over };
}

async function loadedEngine() {
  const hook = renderHook(() => useAudioEngine());
  await act(async () => {
    await hook.result.current.fetchAudio("https://youtu.be/nRKgT3d6xoE");
  });
  await act(async () => {
    await hook.result.current.trimLoop(hook.result.current.engine.track!.id, 0, 15);
  });
  return hook;
}

describe("useAudioEngine v11", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows stems that are ready early while the split runs, then replaces them with the final list", async () => {
    const { result } = await loadedEngine();
    const trackId = result.current.engine.track!.id;
    let resolveSplit!: (r: InstrumentsResult) => void;
    const spy = vi.spyOn(backend, "separateInstruments").mockReturnValue(new Promise((r) => (resolveSplit = r)));

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.separateInstruments(trackId);
    });
    expect(spy).toHaveBeenCalledWith({ trackId, lowPriority: false, quality: "quick" });
    expect(result.current.engine.state).toBe("separating");

    act(() => {
      emitMockStemReady({ trackId, stem: stem("vocals", { group: "vocals" }) });
      emitMockStemReady({ trackId: "some-other-song", stem: stem("drums") });
    });
    await waitFor(() => expect(result.current.engine.partialInstruments?.map((s) => s.key)).toEqual(["vocals"]));

    act(() => {
      emitMockStemReady({ trackId, stem: stem("drums", { group: "drums" }) });
    });
    await waitFor(() => expect(result.current.engine.partialInstruments?.map((s) => s.key)).toEqual(["vocals", "drums"]));
    expect(result.current.engine.instruments).toBeNull();

    const final = [stem("vocals"), stem("drums"), stem("bass"), stem("other", { path: "", derived: { plus: ["mix"], minus: ["vocals", "drums", "bass"], mixGain: 0.9 } })];
    await act(async () => {
      resolveSplit({ stems: final, elapsedSec: 1, passSeconds: {}, device: "cuda", failedPasses: [], quality: "quick", mixPath: "w/loop.wav", mixGain: 0.9, enhanced: [] });
      await pending;
    });
    expect(result.current.engine.instruments).toBe(final);
    expect(result.current.engine.partialInstruments).toBeNull();
    expect(result.current.engine.instrumentsMeta?.mixPath).toBe("w/loop.wav");

    // Late stem events after the split finished are ignored.
    act(() => {
      emitMockStemReady({ trackId, stem: stem("guitar") });
    });
    expect(result.current.engine.partialInstruments).toBeNull();
  });

  it("quick-splits with the mock backend, then Enhance replaces the stems with new versioned files and records the span", async () => {
    const { result } = await loadedEngine();
    const trackId = result.current.engine.track!.id;
    await act(async () => {
      await result.current.separateInstruments(trackId);
    });
    const before = result.current.engine.instruments!;
    expect(before.every((s) => s.parent === null)).toBe(true);
    expect(before.find((s) => s.key === "other")?.derived?.plus).toEqual(["mix"]);
    expect(result.current.engine.instrumentsMeta?.quality).toBe("quick");

    const spy = vi.spyOn(backend, "enhanceRegion");
    await act(async () => {
      await result.current.enhanceRegion(trackId, 2, 5);
    });
    expect(spy).toHaveBeenCalledWith({ trackId, startSec: 2, endSec: 5 });
    const after = result.current.engine.instruments!;
    const vocalsBefore = before.find((s) => s.key === "vocals")!.path;
    const vocalsAfter = after.find((s) => s.key === "vocals")!.path;
    expect(vocalsAfter).not.toBe(vocalsBefore);
    expect(vocalsAfter).toMatch(/vocals\.1\.flac$/);
    expect(after.find((s) => s.key === "other")!.path).toBe("");
    expect(result.current.engine.instrumentsMeta?.enhanced).toEqual([{ start: 2, end: 5 }]);
  });

  it("splits sub-parts on demand and merges them under their parent", async () => {
    const { result } = await loadedEngine();
    const trackId = result.current.engine.track!.id;
    await act(async () => {
      await result.current.separateInstruments(trackId);
    });
    const spy = vi.spyOn(backend, "splitSubstems");
    await act(async () => {
      await result.current.splitSubstems(trackId, "vocals");
    });
    expect(spy).toHaveBeenCalledWith({ trackId, parent: "vocals" });
    const kids = result.current.engine.instruments!.filter((s) => s.parent === "vocals");
    expect(kids.map((k) => k.key).sort()).toEqual(["backing_vocals", "lead_vocals"]);
    expect(kids.find((k) => k.key === "backing_vocals")?.derived).toMatchObject({ plus: ["vocals"], minus: ["lead_vocals"] });
  });
});

describe("mergeSubstems", () => {
  const top = [stem("vocals"), stem("drums"), stem("kick", { parent: "drums" })];

  it("replaces only that parent's children when the result lists children only", () => {
    const next = mergeSubstems(top, "vocals", [stem("lead_vocals", { parent: "vocals" })]);
    expect(next.map((s) => s.key)).toEqual(["vocals", "drums", "kick", "lead_vocals"]);
  });

  it("takes a full list as-is", () => {
    const full = [stem("vocals"), stem("lead_vocals", { parent: "vocals" })];
    expect(mergeSubstems(top, "vocals", full)).toBe(full);
  });
});
