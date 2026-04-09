import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Orchestrator",
  description: "Visual dashboard for the Claude Code orchestrator",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
