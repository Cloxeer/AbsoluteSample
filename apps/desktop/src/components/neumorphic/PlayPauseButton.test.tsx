import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlayPauseButton } from "./PlayPauseButton";

describe("PlayPauseButton", () => {
  it("shows Play label and icon state when idle", () => {
    render(<PlayPauseButton playing={false} onToggle={vi.fn()} label="Drums" />);
    const btn = screen.getByLabelText("Play Drums");
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("shows Pause label and pressed state when playing", () => {
    render(<PlayPauseButton playing onToggle={vi.fn()} label="Drums" />);
    const btn = screen.getByLabelText("Pause Drums");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("flips label and aria-pressed when the playing prop toggles", () => {
    const { rerender } = render(<PlayPauseButton playing={false} onToggle={vi.fn()} label="Loop" />);
    expect(screen.getByLabelText("Play Loop")).toBeInTheDocument();
    rerender(<PlayPauseButton playing onToggle={vi.fn()} label="Loop" />);
    expect(screen.getByLabelText("Pause Loop")).toBeInTheDocument();
    expect(screen.queryByLabelText("Play Loop")).not.toBeInTheDocument();
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<PlayPauseButton playing={false} onToggle={onToggle} label="Mix" />);
    fireEvent.click(screen.getByLabelText("Play Mix"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
