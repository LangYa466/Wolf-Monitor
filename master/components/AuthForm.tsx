"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radar } from "lucide-react";

// Public site key is baked in at build time. When unset the widget is skipped
// entirely and the form behaves like it did before Turnstile was added.
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileGlobal {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
    },
  ) => string;
  reset: (widgetId?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

// Load the Turnstile script once, memoised across component remounts.
let turnstileLoader: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TURNSTILE_SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      turnstileLoader = null;
      reject(new Error("failed to load Turnstile"));
    };
    document.head.appendChild(s);
  });
  return turnstileLoader;
}

export default function AuthForm({ mode }: { mode: "setup" | "login" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const captchaRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  // Turnstile only gates the login form. Setup runs on first boot before any
  // captcha config could exist; requiring one there would lock the operator out.
  const showCaptcha = mode === "login" && Boolean(TURNSTILE_SITE_KEY);

  const resetCaptcha = useCallback(() => {
    setCaptchaToken("");
    if (window.turnstile && widgetIdRef.current) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, []);

  // Route to the correct page based on current state.
  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) location.href = "/settings";
        else if (mode === "setup" && d.setupDone) location.href = "/login";
        else if (mode === "login" && !d.setupDone) location.href = "/setup";
      })
      .catch(() => {});
  }, [mode]);

  // Render the Turnstile widget once the container mounts.
  useEffect(() => {
    if (!showCaptcha) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled) return;
        if (!captchaRef.current || !window.turnstile) return;
        if (widgetIdRef.current) return; // already rendered
        widgetIdRef.current = window.turnstile.render(captchaRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: "auto",
          callback: (token: string) => setCaptchaToken(token),
          "expired-callback": () => setCaptchaToken(""),
          "error-callback": () => setCaptchaToken(""),
        });
      })
      .catch(() => {
        setError("failed to load captcha");
      });
    return () => {
      cancelled = true;
    };
  }, [showCaptcha]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body: Record<string, string> = { email, password };
      if (showCaptcha) body.turnstileToken = captchaToken;
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        location.href = "/settings";
      } else if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after")) || 60;
        setError(`Too many attempts. Try again in ${retry}s.`);
        resetCaptcha();
      } else {
        setError(d.error ?? `error ${res.status}`);
        resetCaptcha();
      }
    } catch {
      setError("network error");
      resetCaptcha();
    } finally {
      setBusy(false);
    }
  }

  const isSetup = mode === "setup";
  const submitDisabled = busy || (showCaptcha && !captchaToken);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Radar className="size-5 text-primary" /> Wolf-Monitor — {isSetup ? "Setup" : "Sign in"}
          </CardTitle>
          <CardDescription>
            {isSetup
              ? "Create the admin account. This runs once."
              : "Sign in to manage your monitors."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Real <form> with autocomplete so Chrome / password managers offer
              to generate & save a strong password (new-password on setup). */}
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isSetup ? "new-password" : "current-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSetup ? "At least 8 characters" : "Your password"}
              />
            </div>
            {showCaptcha && <div ref={captchaRef} className="flex justify-center" />}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitDisabled}>
              {busy ? "…" : isSetup ? "Create account" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
