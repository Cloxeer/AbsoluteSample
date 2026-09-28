import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrackList } from "./TrackList";
import type { TuneTrack } from "@/hooks/useAutotuneTracks";

const track = (id: string, patch: Partial<TuneTrack>): TuneTrack =>
  ({
    id, name: `${id}.wav`, color: "#F0A04B", status: "ready", error: null, analysis: null, sampleRate: 44100,
    format: null, frames: 44100, channelCount: 2, offsetSec: 0, volume: 1, muted: false, solo: false, isLead: false,
    includeInTuneAll: true, analyzeSec: null, startedAt: 0, peaks: null, peakMax: 1, peaksVersion: 0, saved: null, undoVersion: 0,
    warps: [], role: null, alignNote: null,
    ...patch,
  }) as unknown as TuneTrack;

const handlers = () => ({
  onSelect: vi.fn(), onMakeLead: vi.fn(), onMix: vi.fn(), onNudge: vi.fn(), onAlign: vi.fn(),
  onInclude: vi.fn(), onRemove: vi.fn(), onAdd: vi.fn(),
});

describe("TrackList", () => {
  it("Line up waits until both the take and the lead are analyzed", () => {
    const h = handlers();
    const { rerender } = render(
      <TrackList tracks={[track("lead", { isLead: true, status: "analyzing" }), track("harm", {})]} activeId="lead" {...h} />
    );
    const align = screen.getByRole("button", { name: /line up harm\.wav with the lead/i });
    expect(align).toBeDisabled();
    expect(align).toHaveAttribute("title", expect.stringMatching(/once this take and the lead are analyzed/i));
    fireEvent.click(align);
    expect(h.onAlign).not.toHaveBeenCalled();

    rerender(<TrackList tracks={[track("lead", { isLead: true }), track("harm", {})]} activeId="lead" {...h} />);
    const ready = screen.getByRole("button", { name: /line up harm\.wav with the lead/i });
    expect(ready).toBeEnabled();
    fireEvent.click(ready);
    expect(h.onAlign).toHaveBeenCalledWith("harm");
  });

  it("shows the harmony role found by Fix harmonies and the line-up result", () => {
    const h = handlers();
    render(
      <TrackList
        tracks={[
          track("lead", { isLead: true }),
          track("harm", { role: { steps: 2, semitones: 4, label: "High harmony (3rd above)" }, alignNote: { ok: true, message: "In sync with the lead (same start and length)" } }),
        ]}
        activeId="lead"
        {...h}
      />
    );
    expect(screen.getByTestId("track-role-harm")).toHaveTextContent("High harmony (3rd above)");
    expect(screen.getByTestId("track-align-harm")).toHaveTextContent(/in sync with the lead/i);
    expect(screen.queryByTestId("track-role-lead")).toBeNull();
  });

  it("shows only 'Add harmony' with a single track", () => {
    const h = handlers();
    render(<TrackList tracks={[track("lead", { isLead: true })]} activeId="lead" {...h} />);
    fireEvent.click(screen.getByRole("button", { name: /add harmony/i }));
    expect(h.onAdd).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /line up/i })).toBeNull();
  });
});
