import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SlicerTab } from "./SlicerTab";

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

vi.mock("wavesurfer.js/dist/plugins/regions.esm.js", () => {
  return {
    default: {
      create: vi.fn(() => ({
        on: vi.fn(),
        addRegion: vi.fn(() => ({ setOptions: vi.fn(), start: 30, end: 45 })),
      })),
    },
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

describe("SlicerTab", () => {
  it("renders with the seeded YouTube URL in the input", () => {
    render(<SlicerTab />);
    const input = screen.getByPlaceholderText("Paste a YouTube URL…") as HTMLInputElement;
    expect(input.value).toBe("https://youtu.be/nRKgT3d6xoE");
  });

  it("renders a Fetch button", () => {
    render(<SlicerTab />);
    expect(screen.getByText("Fetch")).toBeInTheDocument();
  });
});
