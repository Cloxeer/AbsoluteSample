import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/neumorphic/Button";
import { Surface } from "@/components/neumorphic/Surface";
import { backend } from "@/lib/backend";
import type { SystemLoad } from "@/lib/types";

export interface GateRunOptions {
  /** True when the user chose "Run anyway (low priority)". */
  lowPriority?: boolean;
}

/**
 * Runs `run` right away when the PC has room for heavy AI work; otherwise asks the user first
 * (wait and start automatically / run anyway at low priority / cancel). Resolves once the decision
 * is made (it does not wait for `run` to finish).
 */
export type GateFn = (label: string, run: (opts: GateRunOptions) => Promise<unknown>) => Promise<void>;

export const BUSY_POLL_MS = 10_000;

interface Pending {
  label: string;
  load: SystemLoad;
  run: (opts: GateRunOptions) => Promise<unknown>;
}

function start(run: (opts: GateRunOptions) => Promise<unknown>, opts: GateRunOptions): void {
  // Callers handle their own errors; never let a failed run surface as an unhandled rejection here.
  void run(opts).catch(() => {});
}

/**
 * PC busy check before Split, Karaoke, Enhance, sub-part splits and loading models. Returns the
 * `gate` function and the element (modal + waiting notice) to render once, near the actions.
 */
export function useBusyGate(pollMs: number = BUSY_POLL_MS): { gate: GateFn; element: React.ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const [waiting, setWaiting] = useState<Pending | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const gate = useCallback<GateFn>(async (label, run) => {
    let load: SystemLoad;
    try {
      load = await backend.systemLoad();
    } catch {
      // The check itself failed (e.g. an older backend): don't block the user.
      start(run, {});
      return;
    }
    if (load.verdict === "ok") {
      start(run, {});
      return;
    }
    setPending({ label, load, run });
  }, []);

  const handleCancel = () => setPending(null);

  const handleRunAnyway = () => {
    if (!pending) return;
    const { run } = pending;
    setPending(null);
    start(run, { lowPriority: true });
  };

  const handleWait = () => {
    if (!pending) return;
    const job = pending;
    setPending(null);
    setWaiting(job);
    stopPolling();
    let checking = false;
    timerRef.current = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const load = await backend.systemLoad();
        if (load.verdict === "ok" && timerRef.current) {
          stopPolling();
          setWaiting(null);
          start(job.run, {});
        } else {
          setWaiting((w) => (w ? { ...w, load } : w));
        }
      } catch {
        // keep waiting; the next tick tries again
      } finally {
        checking = false;
      }
    }, pollMs);
  };

  const handleStopWaiting = () => {
    stopPolling();
    setWaiting(null);
  };

  const element = (
    <>
      {pending && (
        <BusyModal load={pending.load} label={pending.label} onWait={handleWait} onRunAnyway={handleRunAnyway} onCancel={handleCancel} />
      )}
      {waiting && (
        <div className="fixed bottom-4 right-4 z-50">
          <Surface variant="raised" role="status" className="flex items-center gap-3 px-4 py-2 text-xs text-text">
            <Loader2 size={14} className="animate-spin text-accent shrink-0" />
            <span>
              Waiting for your PC to free up, then {waiting.label.toLowerCase()} starts by itself.
            </span>
            <button type="button" className="text-accent font-medium underline shrink-0" onClick={handleStopWaiting}>
              Cancel
            </button>
          </Surface>
        </div>
      )}
    </>
  );

  return { gate, element };
}

export function busyTitle(load: SystemLoad): string {
  return load.verdict === "insufficient" ? "Not enough free memory" : "Your PC is busy";
}

function BusyModal({
  load,
  label,
  onWait,
  onRunAnyway,
  onCancel,
}: {
  load: SystemLoad;
  label: string;
  onWait: () => void;
  onRunAnyway: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onCancel}>
      <Surface
        variant="raised"
        role="dialog"
        aria-modal="true"
        aria-labelledby="busy-gate-title"
        className="w-full max-w-sm p-5 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="busy-gate-title" className="text-sm font-semibold">
          {busyTitle(load)}
        </h2>
        <p className="text-xs text-muted">
          {label} needs a lot of memory and graphics power.{" "}
          {load.verdict === "insufficient" ? "Close some apps, or wait for them to finish." : "Something else is using your PC right now."}
        </p>
        {load.reasons.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-text list-disc pl-4">
            {load.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 pt-1">
          <Button variant="primary" onClick={onWait}>
            Wait and start automatically
          </Button>
          {load.verdict === "busy" && <Button onClick={onRunAnyway}>Run anyway (low priority)</Button>}
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </Surface>
    </div>
  );
}
