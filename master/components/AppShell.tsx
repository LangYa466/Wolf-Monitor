"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

// Inline SVG icon set (lookinglss has no lucide-react dependency). Each takes
// the ambient currentColor and is sized by the sidebar's [&_svg] rules.
type IconProps = React.SVGProps<SVGSVGElement>;
const svgBase = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function DashboardIcon(p: IconProps) {
  return (
    <svg {...svgBase} {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}
function LatencyIcon(p: IconProps) {
  return (
    <svg {...svgBase} {...p}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function SettingsIcon(p: IconProps) {
  return (
    <svg {...svgBase} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function MenuIcon(p: IconProps) {
  return (
    <svg {...svgBase} {...p}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}
function LogOutIcon(p: IconProps) {
  return (
    <svg {...svgBase} {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
function CloseIcon(p: IconProps) {
  return (
    <svg {...svgBase} {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

type Item = { label: string; href: string; icon: React.ReactNode };

const ITEMS: Item[] = [
  { label: "Dashboard", href: "/", icon: <DashboardIcon /> },
  { label: "Latency", href: "/latency", icon: <LatencyIcon /> },
  { label: "Settings", href: "/settings", icon: <SettingsIcon /> },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function Sidebar({
  pathname,
  onNav,
}: {
  pathname: string;
  onNav: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-border px-5">
        <span aria-hidden className="text-lg leading-none">🐺</span>
        <span className="text-base font-bold tracking-tight">Wolf-Monitor</span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        {ITEMS.map((it) => {
          const active = isActive(pathname, it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              onClick={onNav}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                "[&_svg]:size-[18px] [&_svg]:shrink-0",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              {it.icon}
              <span className="truncate">{it.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground tnum">
        Wolf-Monitor · live probe
      </div>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [auth, setAuth] = React.useState<{ authenticated: boolean; email: string | null }>({
    authenticated: false,
    email: null,
  });
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => setAuth({ authenticated: !!d.authenticated, email: d.email ?? null }))
      .catch(() => {});
  }, [pathname]);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => setMobileOpen(false), [pathname]);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    location.href = "/login";
  }

  // Standalone auth pages: render centered content, no shell chrome.
  if (pathname === "/login" || pathname === "/setup") {
    return (
      <main className="mx-auto w-full max-w-7xl px-5 py-7">{children}</main>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop sidebar — fixed, 232px wide. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[232px] flex-col border-r border-border bg-background lg:flex">
        <Sidebar pathname={pathname} onNav={() => {}} />
      </aside>

      {/* Mobile drawer (custom, no Radix dependency). */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[232px] border-r border-border bg-background shadow-xl">
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="absolute right-2 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-5"
            >
              <CloseIcon />
            </button>
            <Sidebar pathname={pathname} onNav={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      {/* Main column — leave 232px for the sidebar on desktop. */}
      <div className="flex min-h-screen flex-col lg:pl-[232px]">
        <header className="sticky top-0 z-30 h-14 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex h-full items-center gap-2 px-3 sm:px-4">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden [&_svg]:size-5"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <MenuIcon />
            </Button>
            <span className="flex items-center gap-1.5 font-bold tracking-tight lg:hidden">
              <span aria-hidden>🐺</span> Wolf-Monitor
            </span>
            <div className="flex-1" />
            {auth.authenticated ? (
              <>
                {auth.email && (
                  <Badge variant="muted" className="hidden font-normal sm:inline-flex">
                    {auth.email}
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={logout} className="[&_svg]:size-4">
                  <LogOutIcon />
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </>
            ) : (
              <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Sign in
              </Link>
            )}
          </div>
        </header>

        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 md:px-8 sm:py-7">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
