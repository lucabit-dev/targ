import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

type SurfaceProps = ComponentPropsWithoutRef<"div"> & {
  tone?: "base" | "raised" | "overlay";
  padding?: "none" | "sm" | "md" | "lg";
};

export function Surface({
  className,
  tone = "base",
  padding = "md",
  ...props
}: SurfaceProps) {
  return (
    <div
      className={cn(
        tone === "base" && "targ-surface-base",
        tone === "raised" && "targ-surface-raised",
        tone === "overlay" && "targ-surface-overlay",
        padding === "sm" && "p-4",
        padding === "md" && "p-6",
        padding === "lg" && "p-8",
        className
      )}
      {...props}
    />
  );
}

type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: "primary" | "secondary" | "tertiary";
};

export function Button({
  className,
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "targ-btn",
        variant === "primary" && "targ-btn-primary",
        variant === "secondary" && "targ-btn-secondary",
        variant === "tertiary" && "targ-btn-tertiary",
        className
      )}
      {...props}
    />
  );
}

type ChipProps = ComponentPropsWithoutRef<"span"> & {
  tone?: "subtle" | "success" | "warning" | "critical" | "confidence";
};

export function Chip({
  children,
  className,
  tone = "subtle",
  ...props
}: ChipProps) {
  return (
    <span
      className={cn(
        "targ-chip",
        tone === "subtle" && "targ-chip-subtle",
        tone === "success" && "targ-chip-status-success",
        tone === "warning" && "targ-chip-status-warning",
        tone === "critical" && "targ-chip-status-critical",
        tone === "confidence" && "targ-chip-confidence",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function FieldLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <label className={cn("mb-2 block targ-section-title", className)}>{children}</label>;
}
