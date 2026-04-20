import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export function AdminPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl lg:max-w-4xl xl:max-w-5xl pb-16 pt-1">
      <header className="mb-6 border-b border-[var(--color-border-subtle)] pb-6">
        <p className="targ-micro font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-[22px] font-semibold leading-[28px] tracking-[-0.03em] text-[var(--color-text-primary)]">
          {title}
        </h1>
        <p className="mt-2 targ-meta leading-[18px] text-[var(--color-text-muted)]">
          {description}
        </p>
      </header>

      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

export function AdminSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--color-border-subtle)]",
        "bg-[rgba(255,255,255,0.015)]"
      )}
    >
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-3.5 sm:px-5">
        <h2 className="text-[14px] font-semibold leading-[20px] text-[var(--color-text-primary)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 targ-meta leading-[17px] text-[var(--color-text-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="px-4 py-1 sm:px-5">{children}</div>
    </section>
  );
}

/** Subheading inside an AdminSection (e.g. integration groups). */
export function AdminGroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-0 mt-4 border-t border-[var(--color-border-subtle)] pt-4 first:mt-0 first:border-t-0 first:pt-0 targ-micro font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
      {children}
    </p>
  );
}

export function AdminItem({
  label,
  value,
  hint,
  className,
  mono,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** Use for IDs and technical values. */
  mono?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-t border-[var(--color-border-subtle)] py-3.5 first:border-t-0 first:pt-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:py-3",
        className
      )}
    >
      <div className="min-w-0 shrink-0 sm:w-[40%]">
        <div className="targ-meta text-[var(--color-text-secondary)]">{label}</div>
        {hint ? (
          <div className="mt-1 targ-micro leading-[16px] text-[var(--color-text-muted)]">
            {hint}
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "min-w-0 flex-1 text-[14px] leading-[21px] text-[var(--color-text-primary)] sm:text-right",
          mono && "font-mono text-[12px] leading-[18px] text-[var(--color-text-secondary)]"
        )}
      >
        {value}
      </div>
    </div>
  );
}
