import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LaneSelectionActions } from "./LaneSelectionActions";
import { backend } from "@/lib/backend";
import { samplePlayer } from "@/lib/samplePlayer";
import type { Sample } from "@/lib/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  backend: {
    saveSample: vi.fn(),
    cutRegion: vi.fn(),
    sliceHits: vi.fn(),
    saveStem: vi.fn(),
  },
}));

vi.mock("@/lib/samplePlayer", () => ({
  samplePlayer: {
    subscribe: vi.fn(() => () => {}),
    isPlaying: vi.fn(() => false),
    playPath: vi.fn(),
    stop: vi.fn(),
  },
}));

const hits: Sample[] = [
  {
    id: "h1",
    name: "Drums hit 01",
    path: "mock/hit1.wav",
    bytes: 100,
    songId: "track1",
    songTitle: "My song",
    stemKey: "drums_sub",
    stemLabel: "Drums",
    group: "band",
    startSec: 0,
    endSec: 0.5,
    durationSec: 0.5,
    bpm: 120,
    createdAt: new Date().toISOString(),
    kind: "hit",
  },
  {
    id: "h2",
    name: "Drums hit 02",
    path: "mock/hit2.wav",
    bytes: 100,
    songId: "track1",
    songTitle: "My song",
    stemKey: "drums_sub",
    stemLabel: "Drums",
    group: "band",
    startSec: 0.5,
    endSec: 1,
    durationSec: 0.5,
    bpm: 120,
    createdAt: new Date().toISOString(),
    kind: "hit",
  },
];

describe("LaneSelectionActions", () => {
  beforeEach(() => {
    vi.mocked(backend.sliceHits).mockReset();
    vi.mocked(samplePlayer.subscribe).mockReset().mockReturnValue(() => {});
  });

  const baseProps = {
    trackId: "track1",
    stemKey: "drums_sub",
    stemLabel: "Drums",
    songTitle: "My song",
    wavUrl: "blob:mock",
    selection: { start: 30, end: 45 },
    samples: [],
  };

  it("asks for confirmation before slicing, then calls sliceHits and reports the count", async () => {
    vi.mocked(backend.sliceHits).mockResolvedValue(hits);
    const onSaved = vi.fn();

    render(<LaneSelectionActions {...baseProps} onSaved={onSaved} />);

    fireEvent.click(screen.getByLabelText("Slice Drums selection into hits"));
    expect(screen.getByText("Create up to 64 one-shot samples from Drums?")).toBeInTheDocument();
    expect(backend.sliceHits).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(backend.sliceHits).toHaveBeenCalledWith({ trackId: "track1", stemKey: "drums_sub" });
      expect(onSaved).toHaveBeenCalled();
      expect(screen.getByText("2 hits saved")).toBeInTheDocument();
    });
  });

  it("cancels the slice confirmation without calling sliceHits", () => {
    render(<LaneSelectionActions {...baseProps} />);
    fireEvent.click(screen.getByLabelText("Slice Drums selection into hits"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Create up to 64 one-shot samples from Drums?")).not.toBeInTheDocument();
    expect(backend.sliceHits).not.toHaveBeenCalled();
  });
});
