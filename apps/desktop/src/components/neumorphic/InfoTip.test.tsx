import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InfoTip } from "./InfoTip";

describe("InfoTip", () => {
  it("shows the explanatory text on hover and hides it on mouse leave", () => {
    render(<InfoTip term="RMS" text="How loud it feels on average." />);
    const btn = screen.getByLabelText("What is RMS");
    expect(screen.queryByText("How loud it feels on average.")).not.toBeInTheDocument();
    fireEvent.mouseEnter(btn);
    expect(screen.getByText("How loud it feels on average.")).toBeInTheDocument();
    fireEvent.mouseLeave(btn);
    expect(screen.queryByText("How loud it feels on average.")).not.toBeInTheDocument();
  });

  it("shows the text on keyboard focus and closes on Escape", () => {
    render(<InfoTip term="PK" text="The loudest single moment in this track." />);
    const btn = screen.getByLabelText("What is PK");
    fireEvent.focus(btn);
    expect(screen.getByText("The loudest single moment in this track.")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("The loudest single moment in this track.")).not.toBeInTheDocument();
  });
});
