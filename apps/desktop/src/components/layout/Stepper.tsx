import { Check } from "lucide-react";
import clsx from "clsx";

export interface StepDef {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: StepDef[];
  currentId: string;
  completedIds: string[];
  onStepClick?: (id: string) => void;
}

/** Pipeline breadcrumb: 1 Source -> 2 Loop -> 3 Stems -> 4 Beat Matrix. */
export function Stepper({ steps, currentId, completedIds, onStepClick }: StepperProps) {
  return (
    <nav aria-label="Pipeline steps" className="flex items-center gap-2 px-6">
      {steps.map((step, i) => {
        const isCompleted = completedIds.includes(step.id);
        const isCurrent = step.id === currentId;
        const clickable = isCompleted && !!onStepClick;
        return (
          <div key={step.id} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onStepClick?.(step.id)}
              aria-current={isCurrent ? "step" : undefined}
              className={clsx(
                "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                clickable ? "cursor-pointer hover:text-text" : "cursor-default",
                isCurrent
                  ? "bg-accent/15 text-accent border border-accent/40"
                  : isCompleted
                    ? "text-cyan border border-cyan/30 bg-cyan/5"
                    : "text-muted border border-white/[0.06]"
              )}
            >
              <span
                className={clsx(
                  "flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold",
                  isCompleted ? "bg-cyan text-[#04191f]" : isCurrent ? "bg-accent text-white" : "bg-white/10"
                )}
              >
                {isCompleted ? <Check size={10} /> : i + 1}
              </span>
              {step.label}
            </button>
            {i < steps.length - 1 && <span className="text-muted/40 text-xs">&rarr;</span>}
          </div>
        );
      })}
    </nav>
  );
}
