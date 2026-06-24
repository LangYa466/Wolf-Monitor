import "./globals.css";
import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { Geist, Noto_Sans_SC, JetBrains_Mono } from "next/font/google";
import AppShell from "@/components/AppShell";
import { I18nProvider } from "@/lib/i18n";
import { NavProgress } from "@/components/NavProgress";

// Self-hosted at build time via next/font — no runtime CDN fetch, no Referer leak.
const geist = Geist({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--font-geist" });
const noto = Noto_Sans_SC({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--font-noto-sc" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--font-jetbrains-mono" });

export const metadata: Metadata = {
  title: "Wolf-Monitor",
  description: "Wolf-Monitor — 輕量級伺服器監控 (探针)",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant" className={`dark ${geist.variable} ${noto.variable} ${mono.variable}`}>
      <head>
        {/*
          OS / distro logo icon font (font-logos). Pinned to an exact version
          with SRI so a CDN compromise / MITM cannot swap the stylesheet.
          sha384 computed against font-logos@1.3.0/assets/font-logos.css
          (sha256 cross-checked vs data.jsdelivr.com/v1/package/npm/font-logos@1.3.0).
          Consider self-hosting under public/fonts/font-logos/ for air-gapped deployments.
        */}
        <link
          rel="stylesheet"
          href="https://fastly.jsdelivr.net/npm/font-logos@1.3.0/assets/font-logos.css"
          integrity="sha384-9ahg1cM+ThuA73RLYWsNs0EKFHGadMLdhA4DIkglNeixmh/gf6nc67GdQ76DXFnv"
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
        />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        <I18nProvider>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
