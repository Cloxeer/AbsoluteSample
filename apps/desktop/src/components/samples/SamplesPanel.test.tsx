import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SamplesPanel } from "./SamplesPanel";
import type { Sample } from "@/lib/types";

vi.mock("@/lib/backend", () => ({
  backend: {
    resolveWavUrl: vi.fn().mockResolvedValue("blob:mock"),
  },
}));

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
    ...overrides,
  };
}

describe("SamplesPanel", () => {
  it("renders nothing when closed", () => {
    render(
      <SamplesPanel
        open={false}
        samples={[makeSample()]}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReveal={vi.fn()}
        onExport={vi.fn()}
      />
    );
    expect(screen.queryByText(/My song/)).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no samples", () => {
    render(
      <SamplesPanel open samples={[]} onClose={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} onExport={vi.fn()} />
    );
    expect(screen.getByText(/No samples yet/)).toBeInTheDocument();
  });

  it("renders a sample row with name, song, stem chip, length and size", () => {
    render(
      <SamplesPanel
        open
        samples={[makeSample()]}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReveal={vi.fn()}
        onExport={vi.fn()}
      />
    );
    expect(screen.getByText("My song - Drums 0:30-0:45")).toBeInTheDocument();
    expect(screen.getByText("My song")).toBeInTheDocument();
    expect(screen.getByText("Drums / Sub")).toBeInTheDocument();
    expect(screen.getByText("0:15")).toBeInTheDocument();
    expect(screen.getByText("120.0 BPM")).toBeInTheDocument();
    expect(screen.getByText("0.9 MB")).toBeInTheDocument();
  });

  it("renames a sample on Enter after double-clicking the name", () => {
    const onRename = vi.fn();
    render(
      <SamplesPanel
        open
        samples={[makeSample()]}
        onClose={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
        onReveal={vi.fn()}
        onExport={vi.fn()}
      />
    );
    fireEvent.doubleClick(screen.getByText("My song - Drums 0:30-0:45"));
    const input = screen.getByLabelText("Rename My song - Drums 0:30-0:45") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("s1", "New name");
  });

  it("deletes a sample after confirming", () => {
    const onDelete = vi.fn();
    render(
      <SamplesPanel
        open
        samples={[makeSample()]}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
        onReveal={vi.fn()}
        onExport={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("Delete My song - Drums 0:30-0:45"));
    fireEvent.click(screen.getByText("Yes"));
    expect(onDelete).toHaveBeenCalledWith("s1");
  });

  it("reveals a sample's folder", () => {
    const onReveal = vi.fn();
    render(
      <SamplesPanel
        open
        samples={[makeSample()]}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReveal={onReveal}
        onExport={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("Reveal My song - Drums 0:30-0:45 in folder"));
    expect(onReveal).toHaveBeenCalledWith("s1");
  });

  it("exports selected samples and export all", () => {
    const onExport = vi.fn();
    const s1 = makeSample({ id: "s1", name: "First" });
    const s2 = makeSample({ id: "s2", name: "Second" });
    render(
      <SamplesPanel open samples={[s1, s2]} onClose={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} onExport={onExport} />
    );

    // Export selected is disabled until something is checked.
    expect(screen.getByText("Export selected")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Select First"));
    fireEvent.click(screen.getByText("Export selected"));
    expect(onExport).toHaveBeenCalledWith(["s1"]);

    fireEvent.click(screen.getByText("Export all"));
    expect(onExport).toHaveBeenCalledWith(["s1", "s2"]);
  });

  it("shows the total samples size in the footer", () => {
    const s1 = makeSample({ id: "s1", bytes: 1_000_000 });
    const s2 = makeSample({ id: "s2", bytes: 2_000_000 });
    render(
      <SamplesPanel open samples={[s1, s2]} onClose={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()} onExport={vi.fn()} />
    );
    expect(screen.getByText("3.0 MB total")).toBeInTheDocument();
  });
});
