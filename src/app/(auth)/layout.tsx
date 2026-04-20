export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(95,168,166,0.12),_transparent_34%)]" />
      <div className="relative z-10 w-full max-w-6xl">
        <div className="mb-10 text-center">
          <div className="targ-page-title text-[var(--color-text-primary)]">
            Targ
          </div>
          <p className="mt-3 targ-body max-w-lg mx-auto">
            Standalone investigation workspace for technical problems.
          </p>
        </div>
        <div className="flex justify-center">{children}</div>
      </div>
    </div>
  );
}
