"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

// Shown to non-authenticated visitors on public-dashboard pages so they know
// they're seeing a masked view (IP / CPU temp / latency hidden) and can jump
// to /login instead. Dismissal is kept in sessionStorage so a full-tab reload
// doesn't nag on every navigation, but re-opening the tab surfaces it again.
const DISMISS_KEY = "wolf.guestModalDismissed";

export default function GuestLoginModal() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* private mode / sandbox — fall through and just show it */
    }
    setOpen(true);
  }, []);

  if (!open) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore — user just sees the modal again next navigation */
    }
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 id="guest-modal-title" className="mb-2 text-base font-semibold text-foreground">
          {t("guestModalTitle")}
        </h2>
        <p className="mb-5 text-sm text-muted-foreground">{t("guestModalDesc")}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={dismiss}>
            {t("guestModalContinue")}
          </Button>
          <Button
            onClick={() => {
              window.location.href = "/login";
            }}
          >
            {t("guestModalLogin")}
          </Button>
        </div>
      </div>
    </div>
  );
}
