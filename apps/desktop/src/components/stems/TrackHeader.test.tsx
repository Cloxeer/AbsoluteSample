import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TrackHeader } from "./TrackHeader";

const baseProps = {
  color: "#FF6B6B",
  name: "Drums / Sub",
  band: "LP 130 Hz (LR4)",
  isAuditioning: false,
  solo: false,
  mute: false,
  volume: 1,
  peakDb: -2.5,
  rmsDb: -16,
  onAudition: vi.fn(),
  onToggleSolo: vi.fn(),
  onToggleMute: vi.fn(),
  onVolumeChange: vi.fn(),
  onDownload: vi.fn(),
};

describe("TrackHeader", () => {
  it("calls onAudition and shows a pressed state when the per-track play button is clicked", () => {
    const onAudition = vi.fn();
    render(<TrackHeader {...baseProps} onAudition={onAudition} />);
    const btn = screen.getByLabelText("Play Drums / Sub only");
    fireEvent.click(btn);
    expect(onAudition).toHaveBeenCalledTimes(1);
  });

  it("reflects isAuditioning as a pressed Pause button", () => {
    render(<TrackHeader {...baseProps} isAuditioning />);
    const btn = screen.getByLabelText("Pause Drums / Sub only");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a MUTED tag when muted", () => {
    render(<TrackHeader {...baseProps} mute />);
    expect(screen.getByText("MUTED")).toBeInTheDocument();
  });

  it("renders as an accessible group", () => {
    render(<TrackHeader {...baseProps} />);
    expect(screen.getByRole("group", { name: "Drums / Sub track controls" })).toBeInTheDocument();
  });
});
