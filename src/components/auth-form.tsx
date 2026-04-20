"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, FieldLabel, Surface } from "@/components/ui/primitives";

type AuthFormProps = {
  mode: "login" | "signup";
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSignup = mode === "signup";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          isSignup
            ? { name, email, password }
            : {
                email,
                password,
              }
        ),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        setError(data?.error ?? "Request failed.");
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Surface
      tone="raised"
      padding="lg"
      className="targ-panel-shadow targ-fade-panel w-full max-w-md"
    >
      <div>
        <h1 className="targ-page-title text-[var(--color-text-primary)] sm:text-[28px] sm:leading-[34px]">
          {isSignup ? "Sign up" : "Log in"}
        </h1>
        <p className="mt-3 targ-body">
          {isSignup
            ? "Your personal workspace is created on first sign-in. Start there, then turn incidents into diagnosis, proof, and an action plan."
            : "Return to your cases, evidence, and saved diagnosis drafts."}
        </p>
        <div className="mt-4 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/80 bg-[rgba(255,255,255,0.02)] px-3 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
            Inside Targ
          </p>
          <ul className="mt-2 space-y-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
            <li>Ground a diagnosis in logs, screenshots, notes, and pasted evidence.</li>
            <li>See proof, contradictions, and missing evidence before acting.</li>
            <li>Save a handoff draft when you want the plan pinned on the case.</li>
          </ul>
        </div>
      </div>

      <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
        {isSignup ? (
          <div>
            <FieldLabel>Name</FieldLabel>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="targ-input"
              placeholder="Morgan Lee"
              autoComplete="name"
              required
            />
          </div>
        ) : null}

        <div>
          <FieldLabel>Email</FieldLabel>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="targ-input"
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
        </div>

        <div>
          <FieldLabel>Password</FieldLabel>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="targ-input"
            placeholder={isSignup ? "At least 8 characters" : "Your password"}
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
          />
        </div>

        {error ? (
          <div className="targ-callout-critical text-sm">{error}</div>
        ) : null}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting
            ? isSignup
              ? "Creating…"
              : "Signing in…"
            : isSignup
              ? "Create account"
              : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 targ-body">
        {isSignup ? "Already have an account?" : "Need an account?"}{" "}
        <Link
          href={isSignup ? "/login" : "/signup"}
          className="font-medium text-[var(--color-text-primary)] transition-colors duration-[140ms] hover:text-[var(--color-accent-primary)]"
        >
          {isSignup ? "Log in" : "Sign up"}
        </Link>
      </p>
    </Surface>
  );
}
