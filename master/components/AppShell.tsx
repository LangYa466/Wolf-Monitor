"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import {
  Activity as LatencyIcon,
  Settings as SettingsIcon,
  LogOut as LogOutIcon,
  LogIn as LogInIcon,
  Languages as LangIcon,
  Radar,
} from "lucide-react";

// A round icon button used in the header's right-hand cluster — Komari's
// 40px circular hover targets.
function IconButton({
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]",
        props.className,
      )}
    >
      {children}
    </button>
  );
}
function IconLink({
  children,
  ...props
}: React.ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]",
        props.className,
      )}
    >
      {children}
    </Link>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t, locale, toggle } = useI18n();
  const [auth, setAuth] = React.useState<{ authenticated: boolean; email: string | null }>({
    authenticated: false,
    email: null,
  });

  React.useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => setAuth({ authenticated: !!d.authenticated, email: d.email ?? null }))
      .catch(() => {});
  }, [pathname]);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    location.href = "/login";
  }

  // Standalone auth pages: centered content, no header chrome.
  if (pathname === "/login" || pathname === "/setup") {
    return <main className="mx-auto w-full max-w-7xl px-5 py-7">{children}</main>;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-16 w-full max-w-[1100px] items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Radar className="size-6 text-primary" />
            <span className="text-[17px] font-bold tracking-tight">Wolf-Monitor</span>
          </Link>

          <div className="flex-1" />

          <nav className="flex items-center gap-1">
            <IconButton
              onClick={toggle}
              aria-label={t("language")}
              title={t("language")}
              className="relative"
            >
              <LangIcon />
              <span className="absolute -bottom-0.5 -right-0.5 rounded-sm bg-secondary px-1 text-[8px] font-bold leading-tight text-foreground">
                {locale === "en" ? "EN" : "中"}
              </span>
            </IconButton>
            <IconLink href="/latency" aria-label={t("latency")} title={t("latency")}>
              <LatencyIcon />
            </IconLink>
            {auth.authenticated && (
              <IconLink href="/settings" aria-label={t("settings")} title={t("settings")}>
                <SettingsIcon />
              </IconLink>
            )}
            {auth.authenticated ? (
              <IconButton onClick={logout} aria-label={t("logout")} title={t("logout")}>
                <LogOutIcon />
              </IconButton>
            ) : (
              <IconLink href="/login" aria-label={t("login")} title={t("login")}>
                <LogInIcon />
              </IconLink>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
