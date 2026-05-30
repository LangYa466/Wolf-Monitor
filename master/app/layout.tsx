import "./globals.css";
import type { Metadata } from "next";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Wolf-Monitor",
  description: "Wolf-Monitor — lightweight server monitoring (探针)",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-7xl px-5 py-7">{children}</main>
      </body>
    </html>
  );
}
