import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { save } from "@tauri-apps/plugin-dialog";
import { InstrumentTrackList } from "./InstrumentTrackList";
import { backend } from "@/lib/backend";
import type { InstrumentStem } from "@/lib/types";

vi.mock("wavesurfer.js", () => ({
  default: {
    create: vi.fn(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      setTime: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 15),
      setVolume: vi.fn(),
      isPlaying: vi.fn(() => false),
    })),
  },
}));

vi.mock("wavesurfer.js/dist/plugins/regions.esm.js", () => ({
  default: { create: vi.fn(() => ({ on: vi.fn(), un: vi.fn(), enableDragSelection: vi.fn() })) },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

vi.mock("@/lib/backend", () => ({
  backend: {
    resolveWavUrl: vi.fn(async (p: string) => `blob:${p}`),
    stemFile: vi.fn(async ({ key }: { key: string }) => `C:/work/t1/instruments/_derived/${key}.wav`),
    saveStem: vi.fn(async () => "ok"),
    openWorkDir: vi.fn(),
    saveSample: vi.fn(),
    cutRegion: vi.fn(),
    sliceHits: vi.fn(),
  },
}));

const peaks = Array.from({ length: 50 }, (_, i) => Math.abs(Math.sin(i)));

function stem(key: string, over: Partial<InstrumentStem> = {}): InstrumentStem {
  return {
    key,
    label: key[0].toUpperCase() + key.slice(1),
    group: key === "vocals" ? "vocals" : key === "drums" ? "drums" : "other",
    parent: null,
    path: `C:/work/t1/instruments/${key}.flac`,
    bytes: 100,
    peakDb: -3,
    rmsDb: -18,
    model: "m",
    order: key === "vocals" ? 0 : key === "drums" ? 1 : 5,
    peaks,
    durationSec: 15,
    ...over,
  };
}

const QUICK: InstrumentStem[] = [
  stem("vocals"),
  stem("drums"),
  stem("other", { path: "", derived: { plus: ["mix"], minus: ["vocals", "drums"], mixGain: 0.9 } }),
];

const baseProps = {
  trackId: "t1",
  tracks: [],
  currentTime: 0,
  mode: "mix" as const,
  auditionId: null,
  onUpsertTrack: vi.fn(),
  onRegisterInstance: vi.fn(),
  onUnregisterInstance: vi.fn(),
  onTimeUpdate: vi.fn(),
  onFinish: vi.fn(),
  onAudition: vi.fn(),
};

describe("InstrumentTrackList v11", () => {
  beforeEach(() => {
    vi.mocked(backend.stemFile).mockClear();
    vi.mocked(backend.saveStem).mockClear();
    vi.mocked(save).mockReset();
  });

  it("always shows the vocals/drums sub-part toggles and splits them on demand", async () => {
    const onSplitSubstems = vi.fn(async () => {});
    render(<InstrumentTrackList {...baseProps} stems={QUICK} onSplitSubstems={onSplitSubstems} />);

    fireEvent.click(screen.getByText(/Show lead & backing/));
    const splitVocals = screen.getByRole("button", { name: "Split lead & backing" });
    fireEvent.click(splitVocals);
    await waitFor(() => expect(onSplitSubstems).toHaveBeenCalledWith("vocals"));

    fireEvent.click(screen.getByText(/Show kit/));
    fireEvent.click(screen.getByRole("button", { name: "Split drum kit" }));
    await waitFor(() => expect(onSplitSubstems).toHaveBeenCalledWith("drums"));
  });

  it("shows existing children instead of the split button", () => {
    const withKids = [
      ...QUICK,
      stem("lead_vocals", { parent: "vocals", group: "vocals", order: 1 }),
      stem("backing_vocals", { parent: "vocals", group: "vocals", order: 2, path: "", derived: { plus: ["vocals"], minus: ["lead_vocals"] } }),
    ];
    render(<InstrumentTrackList {...baseProps} stems={withKids} onSplitSubstems={vi.fn()} />);
    fireEvent.click(screen.getByText(/Show lead & backing \(2\)/));
    expect(screen.queryByRole("button", { name: "Split lead & backing" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Backing_vocals track" })).toBeInTheDocument();
  });

  it("downloads a derived stem through stemFile, keeping the stem key and the real extension", async () => {
    vi.mocked(save).mockResolvedValue("D:/out/other.wav");
    render(<InstrumentTrackList {...baseProps} stems={QUICK} />);
    fireEvent.click(screen.getByLabelText("Download Other"));
    await waitFor(() => expect(backend.saveStem).toHaveBeenCalled());
    expect(backend.stemFile).toHaveBeenCalledWith({ trackId: "t1", key: "other" });
    expect(save).toHaveBeenCalledWith({ defaultPath: "other.wav", filters: [{ name: "WAV", extensions: ["wav"] }] });
    expect(backend.saveStem).toHaveBeenCalledWith({ srcPath: "C:/work/t1/instruments/_derived/other.wav", destPath: "D:/out/other.wav" });
  });

  it("downloads a stored FLAC stem under its key with a FLAC filter (versioned names dropped)", async () => {
    vi.mocked(save).mockResolvedValue("D:/out/vocals.flac");
    const stems = [stem("vocals", { path: "C:/work/t1/instruments/vocals.3.flac" })];
    render(<InstrumentTrackList {...baseProps} stems={stems} />);
    fireEvent.click(screen.getByLabelText("Download Vocals"));
    await waitFor(() => expect(backend.saveStem).toHaveBeenCalled());
    expect(backend.stemFile).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({ defaultPath: "vocals.flac", filters: [{ name: "FLAC", extensions: ["flac"] }] });
  });

  it("publishes file, derived and hidden mix sources to the player", async () => {
    const onSetSources = vi.fn();
    render(<InstrumentTrackList {...baseProps} stems={QUICK} mixPath="C:/work/t1/loop.wav" onSetSources={onSetSources} />);
    await waitFor(() => {
      const last = onSetSources.mock.calls.at(-1)?.[1] ?? [];
      expect(last).toHaveLength(4);
    });
    const defs = onSetSources.mock.calls.at(-1)![1];
    expect(defs).toEqual(
      expect.arrayContaining([
        { id: "vocals", url: "blob:C:/work/t1/instruments/vocals.flac" },
        { id: "other", derive: { plus: ["mix"], minus: ["vocals", "drums"], mixGain: 0.9 } },
        { id: "mix", url: "blob:C:/work/t1/loop.wav", hidden: true },
      ])
    );
  });

  it("shows a placeholder row while the rest of a split is still running, and marks enhanced spans", () => {
    render(
      <InstrumentTrackList {...baseProps} stems={[stem("vocals")]} pendingLabel="Separating instruments…" enhanced={[{ start: 3, end: 6 }]} />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Separating instruments…");
    expect(screen.queryByText("Export All")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("enhanced-band")).toHaveLength(1);
  });
});
