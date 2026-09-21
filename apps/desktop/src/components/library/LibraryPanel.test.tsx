import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LibraryPanel } from "./LibraryPanel";
import type { LibraryEntry } from "@/lib/types";

function makeEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: "abc12345678",
    title: "Some song",
    url: "https://youtu.be/abc12345678",
    durationSec: 200,
    fetchedAt: "2024-01-01T00:00:00.000Z",
    lastOpenedAt: "2024-01-02T00:00:00.000Z",
    kept: false,
    hasLoop: true,
    loopStartSec: 30,
    loopEndSec: 45,
    hasBands: false,
    hasInstruments: true,
    instrumentCount: 6,
    bytes: 12_500_000,
    ...overrides,
  };
}

describe("LibraryPanel", () => {
  it("renders nothing when closed", () => {
    render(
      <LibraryPanel
        open={false}
        entries={[makeEntry()]}
        currentTrackId={null}
        sizeBytes={0}
        onClose={vi.fn()}
        onOpenTrack={vi.fn()}
        onSetKept={vi.fn()}
        onDeleteTrack={vi.fn()}
      />
    );
    expect(screen.queryByText("Some song")).not.toBeInTheDocument();
  });

  it("renders entries with title, duration, loop and split chips", () => {
    render(
      <LibraryPanel
        open
        entries={[makeEntry()]}
        currentTrackId={null}
        sizeBytes={12_500_000}
        onClose={vi.fn()}
        onOpenTrack={vi.fn()}
        onSetKept={vi.fn()}
        onDeleteTrack={vi.fn()}
      />
    );
    expect(screen.getByText("Some song")).toBeInTheDocument();
    expect(screen.getByText("3:20")).toBeInTheDocument();
    expect(screen.getByText("Loop 0:30 to 0:45")).toBeInTheDocument();
    expect(screen.getByText("Split (6)")).toBeInTheDocument();
    expect(screen.getByText("12.5 MB")).toBeInTheDocument();
    expect(screen.getByText("12.5 MB in 1 song")).toBeInTheDocument();
  });

  it("shows the empty-state text when there are no entries", () => {
    render(
      <LibraryPanel
        open
        entries={[]}
        currentTrackId={null}
        sizeBytes={0}
        onClose={vi.fn()}
        onOpenTrack={vi.fn()}
        onSetKept={vi.fn()}
        onDeleteTrack={vi.fn()}
      />
    );
    expect(screen.getByText(/No songs yet/)).toBeInTheDocument();
  });

  it("reflects the kept state via aria-pressed on the bookmark toggle", () => {
    render(
      <LibraryPanel
        open
        entries={[makeEntry({ kept: true })]}
        currentTrackId={null}
        sizeBytes={0}
        onClose={vi.fn()}
        onOpenTrack={vi.fn()}
        onSetKept={vi.fn()}
        onDeleteTrack={vi.fn()}
      />
    );
    const toggle = screen.getByTitle("Kept songs are never auto-removed");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onSetKept, onDeleteTrack and onOpenTrack when interacted with", () => {
    const onSetKept = vi.fn();
    const onDeleteTrack = vi.fn();
    const onOpenTrack = vi.fn();
    render(
      <LibraryPanel
        open
        entries={[makeEntry()]}
        currentTrackId={null}
        sizeBytes={0}
        onClose={vi.fn()}
        onOpenTrack={onOpenTrack}
        onSetKept={onSetKept}
        onDeleteTrack={onDeleteTrack}
      />
    );

    fireEvent.click(screen.getByTitle("Kept songs are never auto-removed"));
    expect(onSetKept).toHaveBeenCalledWith("abc12345678", true);

    fireEvent.click(screen.getByLabelText("Delete track"));
    fireEvent.click(screen.getByText("Yes"));
    expect(onDeleteTrack).toHaveBeenCalledWith("abc12345678");

    fireEvent.click(screen.getByText("Some song"));
    expect(onOpenTrack).toHaveBeenCalledWith("abc12345678");
  });
});
