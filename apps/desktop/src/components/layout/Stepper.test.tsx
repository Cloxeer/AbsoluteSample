import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Stepper } from "./Stepper";

const steps = [
  { id: "source", label: "Source" },
  { id: "loop", label: "Loop" },
  { id: "stems", label: "Stems" },
  { id: "matrix", label: "Beat Matrix" },
];

describe("Stepper", () => {
  it("marks completed steps distinctly from the current step", () => {
    render(<Stepper steps={steps} currentId="stems" completedIds={["source", "loop"]} />);
    const current = screen.getByText("Stems").closest("button");
    expect(current).toHaveAttribute("aria-current", "step");
    const completed = screen.getByText("Source").closest("button");
    expect(completed).not.toHaveAttribute("aria-current");
  });

  it("calls onStepClick only for completed steps", () => {
    const onStepClick = vi.fn();
    render(<Stepper steps={steps} currentId="stems" completedIds={["source"]} onStepClick={onStepClick} />);
    fireEvent.click(screen.getByText("Source").closest("button")!);
    expect(onStepClick).toHaveBeenCalledWith("source");

    fireEvent.click(screen.getByText("Beat Matrix").closest("button")!);
    expect(onStepClick).toHaveBeenCalledTimes(1);
  });
});
