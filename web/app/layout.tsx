import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme-context";

// Font choices: Inter is closest to Söhne (what Claude.ai uses) without
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

// viewport-fit=cover lets the body extend under iOS notch / home
// indicator, so we can apply env(safe-area-inset-*) padding instead of
// having the system reserve dead space at the top/bottom. user-
// scalable=no would block pinch-zoom (accessibility regression on
// mobile), so we leave maximumScale at the default 'no limit'.
//
// themeColor matches the painted body background on each scheme so
// iOS Safari blends the URL bar into the app rather than flashing
// white against a dark UI.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

// suppressHydrationWarning on <html> is intentional: the inline init
// script flips the .dark class before React hydrates, which would
// otherwise mismatch the server-rendered (always-light) markup.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${instrumentSerif.variable} ${jetBrainsMono.variable} h-full antialiased`}
    >
      <head>
        {/* Painted before React hydrates so the page never flashes the
            wrong palette on dark-mode users. See lib/theme-context.tsx. */}
        <script
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body className="h-full overflow-hidden">
        <ThemeProvider>
          <WorkspaceShell>{children}</WorkspaceShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
