import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Cpu, Loader2 } from "lucide-react";
import { Surface } from "@/components/neumorphic/Surface";
import { Button } from "@/components/neumorphic/Button";
import { onEngineProgress } from "@/lib/events";
import type { EngineProgressPayload, EngineStatus } from "@/lib/types";
import clsx from "clsx";

export interface EngineStatusCardProps {
  status: EngineStatus | null;
  installing: boolean;
  onInstall: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  python: "Python",
  venv: "Venv",
  torch: "Torch",
  separator: "Separator",
  verify: "Verify",
};

export function EngineStatusCard({ status, installing, onInstall }: EngineStatusCardProps) {
  const [log, setLog] = useState<EngineProgressPayload[]>([]);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onEngineProgress((payload) => {
      setLog((prev) => [...prev.slice(-30), payload]);
    }).then((unlisten) => {
      unlistenRef.current = unlisten;
    });
    return () => unlistenRef.current?.();
  }, []);

  if (!status) return null;

  if (status.installed) {
    return (
      <Surface variant="raised" className="px-4 py-2 flex items-center gap-3 text-xs">
        <CheckCircle2 size={14} className="text-ok" />
        <span className="text-text font-medium">AI engine ready</span>
        {status.gpuName && <span className="text-muted">{status.gpuName}</span>}
      </Surface>
    );
  }

  const lastStage = log.length > 0 ? log[log.length - 1].stage : null;

  return (
    <Surface variant="raised" className="p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Cpu size={18} className="text-accent shrink-0 mt-0.5" />
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">AI engine</h3>
          <p className="text-xs text-muted max-w-md">
            Instrument separation is free and runs locally. Installing it sets up a Python
            environment, PyTorch with CUDA, and about 1.5 GB of model weights.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="primary" busy={installing} busyLabel="Installing engine" onClick={onInstall} disabled={installing}>
          Install engine
        </Button>
        {installing && (
          <div className="flex items-center gap-1.5">
            {(["python", "venv", "torch", "separator", "verify"] as const).map((stage) => (
              <span
                key={stage}
                className={clsx(
                  "text-[10px] px-2 py-1 rounded-full border font-mono",
                  stage === lastStage ? "border-accent/50 bg-accent/15 text-accent" : "border-white/10 text-muted"
                )}
              >
                {STAGE_LABELS[stage]}
              </span>
            ))}
          </div>
        )}
      </div>
      {installing && log.length > 0 && (
        <div className="flex flex-col gap-0.5 max-h-28 overflow-y-auto rounded-xl neu-surface-inset p-2">
          {log.map((entry, i) => (
            <div key={i} className="text-[10px] font-mono text-muted flex items-center gap-1.5">
              <Loader2 size={10} className="animate-spin shrink-0" />
              {entry.message}
            </div>
          ))}
        </div>
      )}
    </Surface>
  );
}
