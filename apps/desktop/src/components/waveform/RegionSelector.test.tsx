import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RegionSelector } from "./RegionSelector";

let readyCallback: (() => void) | null = null;
let regionUpdatedCallback: ((r: any) => void) | null = null;

vi.mock("wavesurfer.js", () => {
  return {
    default: {
      create: vi.fn(() => ({
        on: vi.fn((event: string, cb: any) => {
          if (event === "ready") readyCallback = cb;
        }),
        destroy: vi.fn(),
        play: vi.fn(),
        pause: vi.fn(),
        setTime: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 180),
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
        on: vi.fn((event: string, cb: any) => {
          if (event === "region-updated") regionUpdatedCallback = cb;
        }),
        addRegion: vi.fn(() => ({ setOptions: vi.fn(), start: 0, end: 15 })),
      })),
    },
  };
});

describe("RegionSelector", () => {
  it("does not commit In/Out edits until blur or Enter", () => {
    const onChange = vi.fn();
    render(<RegionSelector wavUrl="blob:mock" initialStart={0} initialEnd={15} durationSec={180} onChange={onChange} />);
    readyCallback?.();
    onChange.mockClear();

    const inInput = screen.getByLabelText("In") as HTMLInputElement;
    fireEvent.change(inInput, { target: { value: "5" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(inInput);
    expect(onChange).toHaveBeenCalledWith(5, 15);
  });

  it("commits on Enter as well as blur", () => {
    const onChange = vi.fn();
    render(<RegionSelector wavUrl="blob:mock" initialStart={0} initialEnd={15} durationSec={180} onChange={onChange} />);
    readyCallback?.();
    onChange.mockClear();

    const outInput = screen.getByLabelText("Out") as HTMLInputElement;
    fireEvent.change(outInput, { target: { value: "20" } });
    fireEvent.keyDown(outInput, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(0, 20);
  });

  it("rejects an Out value that is not after In", () => {
    const onChange = vi.fn();
    render(<RegionSelector wavUrl="blob:mock" initialStart={5} initialEnd={15} durationSec={180} onChange={onChange} />);
    readyCallback?.();
    onChange.mockClear();

    const outInput = screen.getByLabelText("Out") as HTMLInputElement;
    fireEvent.change(outInput, { target: { value: "2" } });
    fireEvent.blur(outInput);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Select all spans the full duration, not a fixed short clip", () => {
    const onChange = vi.fn();
    render(<RegionSelector wavUrl="blob:mock" initialStart={0} initialEnd={15} durationSec={180} onChange={onChange} />);
    readyCallback?.();
    onChange.mockClear();

    fireEvent.click(screen.getByText("Select all"));
    expect(onChange).toHaveBeenCalledWith(0, 180);
  });

  it("has a primary play control for the selection and a stop control", () => {
    render(<RegionSelector wavUrl="blob:mock" initialStart={0} initialEnd={15} durationSec={180} onChange={vi.fn()} />);
    readyCallback?.();
    expect(screen.getByLabelText("Play selection")).toBeInTheDocument();
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });
});
