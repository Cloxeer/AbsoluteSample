import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Check, Loader2 } from "lucide-react";
import clsx from "clsx";

export type ButtonTone = "default" | "amber" | "red" | "cyan" | "accent";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary";
  pressed?: boolean;
  /** Fill color used when `pressed` is true (toggle buttons only get an obvious ON color). */
  tone?: ButtonTone;
  /** Shows a spinner and disables the button while a long-running action is in flight. */
  busy?: boolean;
  /** Briefly shows a success check instead of children (caller controls the timeout). */
  success?: boolean;
  busyLabel?: string;
}

const TONE_PRESSED_CLASSES: Record<ButtonTone, string> = {
  default: "bg-surface text-text",
  amber: "bg-stem-bass text-[#1a1305]",
  red: "bg-stem-drums text-[#1a0505]",
  cyan: "bg-cyan text-[#04191f]",
  accent: "bg-accent text-white",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "default",
      pressed = false,
      tone = "default",
      busy = false,
      success = false,
      busyLabel,
      className,
      children,
      disabled,
      ...rest
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        aria-pressed={pressed}
        data-pressed={pressed || undefined}
        disabled={disabled || busy}
        className={clsx(
          "relative rounded-2xl px-4 py-2 text-sm font-medium select-none",
          "transition-[box-shadow,transform,background-color,color] duration-150 ease-out",
          "border border-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          "active:scale-[0.96] active:duration-[120ms] data-[pressed]:scale-100",
          pressed ? clsx("neu-surface-pressed", TONE_PRESSED_CLASSES[tone]) : "neu-surface-raised hover:border-white/10",
          !pressed && variant === "primary" && "bg-accent text-white shadow-[0_0_16px_rgba(124,92,255,0.45)]",
          !pressed && variant === "default" && "bg-surface text-text",
          (disabled || busy) && "opacity-40 cursor-not-allowed",
          className
        )}
        {...rest}
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            {busyLabel ?? children}
          </span>
        ) : success ? (
          <span className="inline-flex items-center gap-2 text-cyan">
            <Check size={14} />
            {children}
          </span>
        ) : (
          children
        )}
      </button>
    );
  }
);

Button.displayName = "Button";
