"use client";

import type { LucideIcon } from "lucide-react";
import { Building2, FolderOpen, Home, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { cn } from "@/lib/utils/cn";

type AppShellChromeApi = {
  setHomeOnboardingLayoutActive: (value: boolean) => void;
};

const AppShellChromeContext = createContext<AppShellChromeApi | null>(null);

export function useAppShellChrome() {
  return useContext(AppShellChromeContext);
}

type WorkspaceItem = {
  id: string;
  name: string;
};

type AppShellProps = {
  user: {
    name: string | null;
    email: string;
  };
  currentWorkspaceName: string;
  workspaces: WorkspaceItem[];
  children: React.ReactNode;
};

const primaryNavItems: { href: string; label: string; Icon: LucideIcon }[] = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/cases", label: "Cases", Icon: FolderOpen },
];

const secondaryNavItems: { href: string; label: string; Icon: LucideIcon }[] = [
  { href: "/workspace", label: "Workspace", Icon: Building2 },
  { href: "/settings", label: "Account", Icon: Settings },
];

function isNavItemActive(pathname: string, href: string) {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

function accountInitials(user: { name: string | null; email: string }) {
  const name = user.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? "";
    const b =
      parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    const pair = (a + b).toUpperCase();
    if (pair.length > 0) {
      return pair.slice(0, 2);
    }
  }
  const ch = user.email[0];
  return ch ? ch.toUpperCase() : "?";
}

export function AppShell({
  user,
  currentWorkspaceName,
  workspaces,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const initials = accountInitials(user);
  const [homeOnboardingLayoutActive, setHomeOnboardingLayoutActive] = useState(false);

  const setHomeOnboardingLayoutActiveStable = useCallback((value: boolean) => {
    setHomeOnboardingLayoutActive(value);
  }, []);

  const shellChromeApi = useMemo<AppShellChromeApi>(
    () => ({
      setHomeOnboardingLayoutActive: setHomeOnboardingLayoutActiveStable,
    }),
    [setHomeOnboardingLayoutActiveStable]
  );

  return (
    <AppShellChromeContext.Provider value={shellChromeApi}>
    <div className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-text-primary)] lg:h-[100dvh] lg:max-h-[100dvh] lg:overflow-hidden">
      <div className="flex min-h-screen w-full flex-col lg:h-full lg:min-h-0 lg:flex-row lg:overflow-hidden">
        <aside
          className={cn(
            "hidden w-[248px] shrink-0 flex-col border-r border-[var(--color-border-subtle)] bg-[rgba(21,24,27,0.82)] lg:flex lg:h-full lg:min-h-0 xl:w-[264px]",
            homeOnboardingLayoutActive && "lg:!hidden"
          )}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 space-y-3.5 px-4 pb-3 pt-[18px]">
              <Link
                href="/"
                className="block text-[18px] font-semibold leading-[1.15] tracking-[-0.03em] text-[var(--color-text-primary)] focus-visible:rounded-sm"
              >
                Targ
              </Link>

              <div className="min-w-0">
                <label
                  htmlFor="sidebar-workspace"
                  className="mb-1 block text-[11px] font-medium uppercase leading-4 tracking-[0.11em] text-[var(--color-text-muted)]"
                >
                  Workspace
                </label>
                <select
                  id="sidebar-workspace"
                  value={currentWorkspaceName}
                  disabled
                  title={
                    currentWorkspaceName ||
                    "One active workspace in this build. More workspaces later."
                  }
                  className="block w-full min-w-0 cursor-default appearance-none truncate border-0 bg-transparent py-0.5 pl-0 text-[13px] font-medium leading-[18px] text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,168,166,0.22)] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgba(21,24,27,0.82)] disabled:opacity-100"
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.name}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </div>

              <Link
                href="/"
                className="targ-btn targ-btn-primary w-full min-h-9 shrink-0 py-2 text-[13px] font-semibold leading-4"
              >
                New case
              </Link>
            </div>

            <nav
              className="shrink-0 space-y-0.5 px-4 pb-2 pt-1"
              aria-label="Primary"
            >
              {primaryNavItems.map((item) => {
                const isActive = isNavItemActive(pathname, item.href);
                const Icon = item.Icon;

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-md border-l-[3px] border-transparent py-2 pl-2 pr-2 text-[13px] leading-4 tracking-[-0.01em] transition-[color,background-color,border-color,box-shadow] duration-[var(--motion-base)] ease-out",
                      isActive
                        ? "border-[var(--color-accent-primary)] bg-[rgba(255,255,255,0.085)] font-semibold text-[var(--color-text-primary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                        : "font-medium text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.045)] hover:text-[var(--color-text-primary)]"
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0 transition-colors duration-[var(--motion-base)]",
                        isActive
                          ? "text-[var(--color-accent-primary)]"
                          : "text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]"
                      )}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <span className="min-w-0 truncate">{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="shrink-0 px-4 pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                Manage
              </p>
            </div>
            <nav
              className="shrink-0 space-y-0.5 px-4 pb-2 pt-1"
              aria-label="Secondary"
            >
              {secondaryNavItems.map((item) => {
                const isActive = isNavItemActive(pathname, item.href);
                const Icon = item.Icon;

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-md border-l-[3px] border-transparent py-2 pl-2 pr-2 text-[13px] leading-4 tracking-[-0.01em] transition-[color,background-color,border-color,box-shadow] duration-[var(--motion-base)] ease-out",
                      isActive
                        ? "border-[var(--color-accent-primary)] bg-[rgba(255,255,255,0.085)] font-semibold text-[var(--color-text-primary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                        : "font-medium text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.045)] hover:text-[var(--color-text-primary)]"
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0 transition-colors duration-[var(--motion-base)]",
                        isActive
                          ? "text-[var(--color-accent-primary)]"
                          : "text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]"
                      )}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <span className="min-w-0 truncate">{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="min-h-0 flex-1" aria-hidden />

            <div className="shrink-0 border-t border-[var(--color-border-subtle)]/40 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3.5">
              <div
                className="flex min-w-0 items-start gap-2.5"
                aria-label="Signed in as"
              >
                <div
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[rgba(255,255,255,0.07)] text-[11px] font-semibold tabular-nums tracking-[-0.02em] text-[var(--color-text-secondary)] ring-1 ring-inset ring-[rgba(255,255,255,0.08)]"
                  aria-hidden
                >
                  {initials}
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="truncate text-[12px] font-medium leading-4 tracking-[-0.01em] text-[var(--color-text-primary)]">
                    {user.name ?? user.email.split("@")[0]}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] font-medium leading-[14px] tracking-[0.02em] text-[var(--color-text-muted)]">
                    {user.email}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-hidden">
          <header
            className={cn(
              "sticky top-0 z-10 shrink-0 border-b border-[var(--color-border-subtle)] bg-[rgba(17,19,21,0.92)] px-5 py-4 backdrop-blur lg:hidden",
              homeOnboardingLayoutActive && "hidden"
            )}
          >
            <div className="flex items-center justify-between gap-4">
              <Link
                href="/"
                className="targ-page-title text-[18px] leading-[24px]"
              >
                Targ
              </Link>
              <div className="text-right">
                <div className="targ-section-title text-[var(--color-text-primary)]">
                  {currentWorkspaceName}
                </div>
                <div className="targ-meta">{user.email}</div>
              </div>
            </div>
            <nav className="mt-3 grid grid-cols-2 gap-1.5">
              {primaryNavItems.map((item) => {
                const isActive = isNavItemActive(pathname, item.href);
                const Icon = item.Icon;

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-md px-1.5 py-2 text-center text-[11px] font-medium leading-tight transition-[color,background-color,box-shadow] duration-[var(--motion-base)] ease-out",
                      isActive
                        ? "bg-[rgba(255,255,255,0.09)] font-semibold text-[var(--color-text-primary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
                        : "text-[var(--color-text-secondary)]"
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-[18px] shrink-0",
                        isActive
                          ? "text-[var(--color-accent-primary)]"
                          : "text-[var(--color-text-muted)]"
                      )}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <span className="line-clamp-2 w-full break-words">
                      {item.label}
                    </span>
                  </Link>
                );
              })}
            </nav>
            <div className="mt-3 flex items-center justify-center gap-4 border-t border-[var(--color-border-subtle)]/60 pt-3">
              {secondaryNavItems.map((item) => {
                const isActive = isNavItemActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "text-[11px] font-medium transition-colors duration-[var(--motion-base)]",
                      isActive
                        ? "text-[var(--color-text-primary)]"
                        : "text-[var(--color-text-muted)]"
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </header>

          <main
            className={cn(
              "flex flex-1 flex-col min-h-0 scroll-pt-8 px-4 py-6 sm:px-6 lg:min-h-0 lg:px-8 xl:px-10 2xl:px-12",
              homeOnboardingLayoutActive
                ? "overflow-hidden overscroll-none py-5 sm:py-5 lg:overflow-hidden lg:py-6 xl:py-6"
                : "lg:overflow-y-auto lg:overscroll-contain lg:py-8 xl:py-9"
            )}
          >
            {children}
          </main>
        </div>
      </div>
    </div>
    </AppShellChromeContext.Provider>
  );
}
