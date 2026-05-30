"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/latency", label: "Latency" },
  { href: "/settings", label: "Settings" },
];

export default function Nav() {
  const path = usePathname();
  const [auth, setAuth] = useState<{ authenticated: boolean; email: string | null }>({
    authenticated: false,
    email: null,
  });

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => setAuth({ authenticated: !!d.authenticated, email: d.email ?? null }))
      .catch(() => {});
  }, [path]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  }

  // Hide chrome on the standalone auth pages.
  if (path === "/login" || path === "/setup") return null;

  return (
    <nav className="sticky top-0 z-20 border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-5">
        <Link href="/" className="flex items-center gap-2 text-base font-bold tracking-tight">
          <span aria-hidden>🐺</span> Wolf-Monitor
        </Link>
        <div className="flex items-center gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                path === l.href && "bg-accent text-accent-foreground",
              )}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {auth.authenticated ? (
            <>
              <span className="hidden text-muted-foreground sm:inline">{auth.email}</span>
              <button
                onClick={logout}
                className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                Sign out
              </button>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
