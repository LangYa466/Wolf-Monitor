import "./globals.css";
import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import AppShell from "@/components/AppShell";
import { I18nProvider } from "@/lib/i18n";
import { NavProgress } from "@/components/NavProgress";

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
    <html lang="zh-Hant" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap"
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
