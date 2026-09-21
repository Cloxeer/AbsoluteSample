import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StemTrack } from "./StemTrack";
import type { StemInfo } from "@/lib/types";

vi.mock("wavesurfer.js", () => {
  return {
    default: {
      create: vi.fn(() => ({
        on: vi.fn(),
        destroy: vi.fn(),
        play: vi.fn(),
        pause: vi.fn(),
        setTime: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        setVolume: vi.fn(),
        isPlaying: vi.fn(() => false),
      })),
    },
  };
});

const stem: StemInfo = {
  index: 1,
  key: "drums_sub",
  label: "Drums / Sub",
  band: "LP 130 Hz (LR4)",
  path: "mock/track/stems/01_drums_sub.wav",
  bytes: 1000,
  peakDb: -2.5,
  rmsDb: -16,
};

describe("StemTrack", () => {
  it("calls onDownload when download button is clicked", () => {
    const onDownload = vi.fn();
    render(
      <StemTrack
        stem={stem}
        wavUrl="blob:mock"
        volume={1}
        onVolumeChange={vi.fn()}
        onDownload={onDownload}
      />
    );
    fireEvent.click(screen.getByLabelText("Download Drums / Sub WAV"));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("calls onAudition and reflects pressed state when the per-track play button is clicked", () => {
    const onAudition = vi.fn();
    const { rerender } = render(
      <StemTrack
        stem={stem}
        wavUrl="blob:mock"
        volume={1}
        isAuditioning={false}
        onVolumeChange={vi.fn()}
        onDownload={vi.fn()}
        onAudition={onAudition}
      />
    );
    const playBtn = screen.getByLabelText("Play Drums / Sub only");
    expect(playBtn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(playBtn);
    expect(onAudition).toHaveBeenCalledTimes(1);

    rerender(
      <StemTrack
        stem={stem}
        wavUrl="blob:mock"
        volume={1}
        isAuditioning
        onVolumeChange={vi.fn()}
        onDownload={vi.fn()}
        onAudition={onAudition}
      />
    );
    expect(screen.getByLabelText("Pause Drums / Sub only")).toHaveAttribute("aria-pressed", "true");
  });

  it("has no Solo or Mute buttons", () => {
    render(
      <StemTrack stem={stem} wavUrl="blob:mock" volume={1} onVolumeChange={vi.fn()} onDownload={vi.fn()} />
    );
    expect(screen.queryByLabelText("Solo")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mute")).not.toBeInTheDocument();
  });
});
