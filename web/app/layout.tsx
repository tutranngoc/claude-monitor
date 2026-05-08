import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { WorkspaceShell } from "@/components/workspace-shell";

// Font choices — Inter is closest to Söhne (what Claude.ai uses) without
// licensing; Instrument Serif gives the home hero an editorial flourish;
// JetBrains Mono replaces Geist Mono so Vietnamese diacritics inside code
// blocks render in the same monospace face as the rest of the snippet
// (Geist Mono ships latin-only, so Vietnamese chars used to fall through
// to a serif system font and looked unstyled mid-code).
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin", "vietnamese"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "vietnamese"],
});

export const metadata: Metadata = {
  title: "claude-monitor",
  description: "Web orchestrator for claude-monitor accounts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSerif.variable} ${jetBrainsMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden">
        <WorkspaceShell>{children}</WorkspaceShell>
      </body>
    </html>
  );
}
