"use client";

import { useEffect, useState } from "react";
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

export default function AuthForm({ mode }: { mode: "setup" | "login" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        location.href = "/settings";
      } else {
        setError(d.error ?? `error ${res.status}`);
      }
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  const isSetup = mode === "setup";

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
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "…" : isSetup ? "Create account" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
