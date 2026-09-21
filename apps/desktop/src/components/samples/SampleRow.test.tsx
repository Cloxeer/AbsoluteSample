import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SampleRow } from "./SampleRow";
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
});
