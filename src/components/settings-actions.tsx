"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/primitives";

export function SettingsActions() {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setError(null);
    setIsSigningOut(true);

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Could not sign out.");
      }

      router.push("/login");
      router.refresh();
    } catch {
      setError("Could not sign out right now. Try again.");
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <p className="text-[14px] leading-[21px] text-[var(--color-text-primary)]">
            Sign out on this browser
          </p>
          <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-muted)]">
            Clears the current session cookie and sends you back to login.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={isSigningOut}
          className="sm:px-5"
          onClick={handleSignOut}
        >
          {isSigningOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>
      {error ? (
        <p className="mt-3 text-[12px] leading-[18px] text-[var(--color-state-critical)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
