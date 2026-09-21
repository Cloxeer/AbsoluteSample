import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LaneSelectionChips } from "./LaneSelection";

describe("LaneSelectionChips", () => {
  it("renders nothing when there is no selection", () => {
    const { container } = render(<LaneSelectionChips selection={null} durationSec={180} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when durationSec is not known yet", () => {
    const { container } = render(<LaneSelectionChips selection={{ start: 1, end: 2 }} durationSec={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("formats In/Out chips as mm:ss.mmm", () => {
    render(<LaneSelectionChips selection={{ start: 30, end: 45.612 }} durationSec={180} />);
    expect(screen.getByText("00:30.000")).toBeInTheDocument();
    expect(screen.getByText("00:45.612")).toBeInTheDocument();
    expect(screen.getByLabelText("In 00:30.000")).toBeInTheDocument();
    expect(screen.getByLabelText("Out 00:45.612")).toBeInTheDocument();
  });
});
