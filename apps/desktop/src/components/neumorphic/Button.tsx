import { forwardRef, type ButtonHTMLAttributes } from "react";
import clsx from "clsx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary";
  pressed?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", pressed = false, className, children, disabled, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        aria-pressed={pressed}
        disabled={disabled}
        className={clsx(
          "rounded-2xl px-4 py-2 text-sm font-medium transition-shadow duration-150 select-none",
          "border border-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          pressed ? "neu-surface-pressed" : "neu-surface-raised active:shadow-[var(--shadow-pressed)]",
          variant === "primary" ? "bg-accent text-white shadow-[0_0_16px_rgba(124,92,255,0.45)]" : "bg-surface text-text",
          disabled && "opacity-40 cursor-not-allowed",
          className
        )}
        {...rest}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
