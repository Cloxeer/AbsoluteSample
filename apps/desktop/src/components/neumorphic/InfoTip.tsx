import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

export interface InfoTipProps {
  /** The term this tip explains, used to build the accessible label ("What is <term>"). */
  term: string;
  /** One-sentence explanation shown in the popover. */
  text: string;
  className?: string;
}

/** Tiny circular "?" button that reveals a one-sentence popover on hover and keyboard focus. */
export function InfoTip({ term, text, className }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <span className={clsx("relative inline-flex", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`What is ${term}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="w-3.5 h-3.5 shrink-0 rounded-full border border-white/20 text-[8px] leading-none flex items-center justify-center text-muted hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-max max-w-[220px] rounded-lg bg-surface neu-surface-raised px-2 py-1.5 text-[10px] leading-snug text-text shadow-lg pointer-events-none"
        >
          {text}
        </span>
      )}
    </span>
  );
}
