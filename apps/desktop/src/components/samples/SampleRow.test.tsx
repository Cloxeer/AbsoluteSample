import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SampleRow } from "./SampleRow";
import type { Sample } from "@/lib/types";

const cutSample = vi.fn().mockResolvedValue({ path: "mock/cut.wav", startSec: 1, endSec: 2, bars: null, peaks: [], durationSec: 1 });
const saveStem = vi.fn().mockResolvedValue("mock/cut.wav");

vi.mock("@/lib/backend", () => ({
  backend: {
    resolveWavUrl: vi.fn().mockResolvedValue("blob:mock"),
    cutSample: (...args: unknown[]) => cutSample(...args),
    saveStem: (...args: unknown[]) => saveStem(...args),
    saveSamplePart: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue("dest.wav"),
}));

vi.mock("wavesurfer.js", () => ({
  default: {
    create: vi.fn(() => ({
      on: vi.fn(),
      destroy: vi.fn(),
      seekTo: vi.fn(),
    })),
  },
}));

// SampleRow's regions selection is real drag-to-select and can't be driven from jsdom, so this
// mocks the hook entirely and lets tests control the reported selection.
let mockSelection: { start: number; end: number } | null = null;
vi.mock("@/components/waveform/LaneSelection", async () => {
  const actual = await vi.importActual<typeof import("@/components/waveform/LaneSelection")>("@/components/waveform/LaneSelection");
  return {
    ...actual,
    useLaneSelection: () => ({ regionsPlugin: {}, selection: mockSelection, clear: vi.fn() }),
  };
});

function makeSample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: "s1",
    name: "My song - Drums 0:30-0:45",
    path: "mock/sample.wav",
    bytes: 900_000,
    songId: "track1",
    songTitle: "My song",
    stemKey: "drums_sub",
    stemLabel: "Drums / Sub",
    group: "band",
    startSec: 30,
    endSec: 45,
    durationSec: 15,
    bpm: 120,
    createdAt: "2024-01-02T00:00:00.000Z",
    peaks: new Array(1000).fill(0.5),
    ...overrides,
  };
}

describe("SampleRow", () => {
  it("has a full-width hover target on the row itself", () => {
    const { container } = render(
      <SampleRow sample={makeSample()} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} />
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("w-full");
    expect(row.className).toContain("hover:bg-white/[0.04]");
  });

  it("swaps the action buttons for an inline confirm/cancel in the same slot when delete is clicked", () => {
    render(<SampleRow sample={makeSample()} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} />);

    expect(screen.getByLabelText("Delete My song - Drums 0:30-0:45")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Delete My song - Drums 0:30-0:45"));

    expect(screen.queryByLabelText("Delete My song - Drums 0:30-0:45")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Confirm delete My song - Drums 0:30-0:45")).toBeInTheDocument();
    expect(screen.getByLabelText("Cancel delete My song - Drums 0:30-0:45")).toBeInTheDocument();
  });

  it("calls onDelete when the inline confirm is clicked", () => {
    const onDelete = vi.fn();
    render(<SampleRow sample={makeSample()} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={onDelete} onReveal={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Delete My song - Drums 0:30-0:45"));
    fireEvent.click(screen.getByLabelText("Confirm delete My song - Drums 0:30-0:45"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("renders kind, bars and key chips derived from the sample", () => {
    render(
      <SampleRow
        sample={makeSample({ kind: "region", bars: 4, keyShort: "Am" })}
        selected={false}
        onToggleSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReveal={vi.fn()}
      />
    );
    expect(screen.getByText("Region")).toBeInTheDocument();
    expect(screen.getByText("4 bars")).toBeInTheDocument();
    expect(screen.getByText("Am")).toBeInTheDocument();
  });

  it("omits kind/bars/key chips when the sample doesn't have them", () => {
    render(
      <SampleRow sample={makeSample({ kind: undefined, bars: undefined, keyShort: undefined })} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} />
    );
    expect(screen.queryByText("Stem")).not.toBeInTheDocument();
    expect(screen.queryByText(/bars?$/)).not.toBeInTheDocument();
  });

  it("is draggable in the browser (non-Tauri) and sets text/plain data with the sample name on dragstart", () => {
    const { container } = render(
      <SampleRow sample={makeSample()} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} />
    );
    const row = container.querySelector('[data-testid="sample-row-s1"]') as HTMLElement;
    expect(row).toHaveAttribute("draggable", "true");

    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "My song - Drums 0:30-0:45");
  });

  it("shows the selection row only when there is a selection", async () => {
    mockSelection = null;
    const { rerender } = render(
      <SampleRow sample={makeSample()} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} />
    );
    await waitFor(() => expect(screen.queryByTestId("sample-selection-s1")).not.toBeInTheDocument());

    mockSelection = { start: 1, end: 2 };
    rerender(<SampleRow sample={makeSample()} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} />);
    expect(screen.getByTestId("sample-selection-s1")).toBeInTheDocument();
  });

  it("downloading the selection calls backend.cutSample with the selection range", async () => {
    mockSelection = { start: 1, end: 2 };
    render(<SampleRow sample={makeSample()} selected={false} onToggleSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Download My song - Drums 0:30-0:45 selection"));

    await waitFor(() => expect(cutSample).toHaveBeenCalledWith({ sampleId: "s1", startSec: 1, endSec: 2 }));
    await waitFor(() => expect(saveStem).toHaveBeenCalledWith({ srcPath: "mock/cut.wav", destPath: "dest.wav" }));
  });
});
