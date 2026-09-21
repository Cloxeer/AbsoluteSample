import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SaveSampleButton } from "./SaveSampleButton";
import { backend } from "@/lib/backend";
import type { Sample } from "@/lib/types";

vi.mock("@/lib/backend", () => ({
  backend: {
    saveSample: vi.fn(),
  },
}));

describe("SaveSampleButton", () => {
  beforeEach(() => {
    vi.mocked(backend.saveSample).mockReset();
  });

  it("opens a popover prefilled with the default name pattern, and saves on click", async () => {
    const sample: Sample = {
      id: "s1",
      name: "My song - Drums / Sub 0:30-0:45",
      path: "mock/path.wav",
      bytes: 1000,
      songId: "track1",
      songTitle: "My song",
      stemKey: "drums_sub",
      stemLabel: "Drums / Sub",
      group: "band",
      startSec: 30,
      endSec: 45,
      durationSec: 15,
      bpm: 120,
      createdAt: new Date().toISOString(),
    };
    vi.mocked(backend.saveSample).mockResolvedValue(sample);

    const onSaved = vi.fn();
    render(
      <SaveSampleButton
        trackId="track1"
        stemKey="drums_sub"
        stemLabel="Drums / Sub"
        songTitle="My song"
        startSec={30}
        endSec={45}
        samples={[]}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByLabelText("Save Drums / Sub as sample"));
    const input = screen.getByLabelText("Sample name") as HTMLInputElement;
    expect(input.value).toBe("My song - Drums / Sub 0:30-0:45");

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(backend.saveSample).toHaveBeenCalledWith({
        trackId: "track1",
        stemKey: "drums_sub",
        name: "My song - Drums / Sub 0:30-0:45",
      });
      expect(onSaved).toHaveBeenCalledWith(sample);
    });
  });

  it("closes the popover on Cancel without saving", () => {
    render(
      <SaveSampleButton
        trackId="track1"
        stemKey="drums_sub"
        stemLabel="Drums / Sub"
        songTitle="My song"
        startSec={30}
        endSec={45}
        samples={[]}
      />
    );
    fireEvent.click(screen.getByLabelText("Save Drums / Sub as sample"));
    expect(screen.getByLabelText("Sample name")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByLabelText("Sample name")).not.toBeInTheDocument();
    expect(backend.saveSample).not.toHaveBeenCalled();
  });

  it("shows a pressed, filled state when a sample already exists for this track/stem/range", () => {
    const existing: Sample = {
      id: "s1",
      name: "existing",
      path: "p",
      bytes: 1,
      songId: "track1",
      songTitle: "My song",
      stemKey: "drums_sub",
      stemLabel: "Drums / Sub",
      group: "band",
      startSec: 30,
      endSec: 45,
      durationSec: 15,
      bpm: null,
      createdAt: new Date().toISOString(),
    };
    render(
      <SaveSampleButton
        trackId="track1"
        stemKey="drums_sub"
        stemLabel="Drums / Sub"
        songTitle="My song"
        startSec={30}
        endSec={45}
        samples={[existing]}
      />
    );
    expect(screen.getByLabelText("Save Drums / Sub as sample")).toHaveAttribute("aria-pressed", "true");
  });
});
