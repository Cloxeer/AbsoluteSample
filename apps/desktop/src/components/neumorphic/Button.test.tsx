import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children and handles click", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    const btn = screen.getByText("Click me");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("reflects pressed state via aria-pressed", () => {
    render(<Button pressed>Pressed</Button>);
    expect(screen.getByText("Pressed")).toHaveAttribute("aria-pressed", "true");
  });

  it("disables interaction when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Disabled
      </Button>
    );
    fireEvent.click(screen.getByText("Disabled"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
