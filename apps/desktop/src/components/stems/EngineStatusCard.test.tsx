import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EngineStatusCard } from "./EngineStatusCard";
import type { EngineStatus } from "@/lib/types";

const notInstalled: EngineStatus = {
  installed: false,
  pythonFound: true,
  pythonPath: null,
  venvPath: null,
  torchVersion: null,
  cuda: false,
  gpuName: null,
  modelsPresent: [],
  enginePath: "mock",
};

const installed: EngineStatus = {
  ...notInstalled,
  installed: true,
  torchVersion: "2.4.0+cu124",
  cuda: true,
  gpuName: "Mock GPU",
  modelsPresent: ["htdemucs_6s"],
};

describe("EngineStatusCard", () => {
  it("renders an Install engine button when installed is false", () => {
    render(<EngineStatusCard status={notInstalled} installing={false} onInstall={vi.fn()} />);
    expect(screen.getByText("Install engine")).toBeInTheDocument();
  });

  it("does not render an Install engine button when installed is true", () => {
    render(<EngineStatusCard status={installed} installing={false} onInstall={vi.fn()} />);
    expect(screen.queryByText("Install engine")).not.toBeInTheDocument();
    expect(screen.getByText("AI engine ready")).toBeInTheDocument();
  });
});
