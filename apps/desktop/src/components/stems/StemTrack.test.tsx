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
  it("calls onToggleSolo when S is clicked", () => {
    const onToggleSolo = vi.fn();
    render(
      <StemTrack
        stem={stem}
        wavUrl="blob:mock"
        solo={false}
        mute={false}
        volume={1}
        onToggleSolo={onToggleSolo}
        onToggleMute={vi.fn()}
        onVolumeChange={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("Solo"));
    expect(onToggleSolo).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleMute when M is clicked", () => {
    const onToggleMute = vi.fn();
    render(
      <StemTrack
        stem={stem}
        wavUrl="blob:mock"
        solo={false}
        mute={false}
        volume={1}
        onToggleSolo={vi.fn()}
        onToggleMute={onToggleMute}
        onVolumeChange={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("Mute"));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it("calls onDownload when download button is clicked", () => {
    const onDownload = vi.fn();
    render(
      <StemTrack
        stem={stem}
        wavUrl="blob:mock"
        solo={false}
        mute={false}
        volume={1}
        onToggleSolo={vi.fn()}
        onToggleMute={vi.fn()}
        onVolumeChange={vi.fn()}
        onDownload={onDownload}
      />
    );
    fireEvent.click(screen.getByLabelText("Download WAV"));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});
