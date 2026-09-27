import { useEffect, useState } from "react";
import { Button } from "@/components/neumorphic/Button";
import { backend } from "@/lib/backend";
import { onModelsChanged } from "@/lib/events";
import { toastStore } from "@/lib/toast";
import type { ModelsStatus } from "@/lib/types";
import type { GateFn } from "./BusyGate";

export const MODELS_TOOLTIP =
  "Keeps the AI models in GPU memory so the next split or Enhance starts instantly. Offload frees that memory again (for example before gaming).";

type Phase = "idle" | "loading" | "loaded" | "offloading";

export function modelsPhase(status: ModelsStatus | null, action: "loading" | "offloading" | null): Phase {
  if (action === "offloading") return "offloading";
  if (action === "loading" || status?.loading) return "loading";
  if (status?.loaded || status?.kept) return "loaded";
  return "idle";
}

const LABELS: Record<Phase, string> = {
  idle: "Keep models loaded",
  loading: "Loading models…",
  loaded: "Offload models",
  offloading: "Offloading…",
};

/**
 * "Keep models loaded" / "Offload models" toggle. Starts from modelsStatus(), follows
 * engine://models, and shows a small notice when the app offloads them by itself (with the reason).
 */
export function ModelsButton({ gate, className }: { gate?: GateFn; className?: string }) {
  const [status, setStatus] = useState<ModelsStatus | null>(null);
  const [action, setAction] = useState<"loading" | "offloading" | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    backend
      .modelsStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    onModelsChanged((payload) => {
      if (cancelled) return;
      const { reason, ...next } = payload;
      setStatus(next);
      if (reason) {
        toastStore.publish(reason); // the backend sends a complete sentence
      }
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const phase = modelsPhase(status, action);

  const keep = async () => {
    setAction("loading");
    try {
      setStatus(await backend.keepModelsLoaded());
    } catch (err) {
      toastStore.publish(`Could not load the models: ${String(err)}`);
    } finally {
      setAction(null);
    }
  };

  const offload = async () => {
    setAction("offloading");
    try {
      setStatus(await backend.offloadModels());
    } catch (err) {
      toastStore.publish(`Could not offload the models: ${String(err)}`);
    } finally {
      setAction(null);
    }
  };

  const handleClick = () => {
    if (phase === "loaded") void offload();
    else if (phase === "idle") {
      if (gate) void gate("Loading the models", () => keep());
      else void keep();
    }
  };

  return (
    <Button
      onClick={handleClick}
      disabled={phase === "loading" || phase === "offloading"}
      title={MODELS_TOOLTIP}
      aria-label={LABELS[phase]}
      className={className}
    >
      {LABELS[phase]}
    </Button>
  );
}
