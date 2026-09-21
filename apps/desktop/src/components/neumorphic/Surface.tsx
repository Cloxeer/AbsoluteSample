import { forwardRef, type HTMLAttributes } from "react";
import clsx from "clsx";

export type SurfaceVariant = "raised" | "inset";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ variant = "raised", className, children, ...rest }, ref) => {
    return (
      <div
        ref={ref}
        className={clsx(
          "rounded-2xl bg-surface",
          variant === "raised" ? "neu-surface-raised" : "neu-surface-inset",
          className
        )}
        {...rest}
      >
        {children}
      </div>
    );
  }
);

Surface.displayName = "Surface";
