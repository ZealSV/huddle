import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Caveat, Funnel_Display, Funnel_Sans } from "next/font/google";
import "./globals.css";

const display = Funnel_Display({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-display" });
const sans = Funnel_Sans({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-sans" });
const hand = Caveat({ subsets: ["latin"], weight: "500", variable: "--font-hand" });

export const metadata: Metadata = {
  title: "Huddle",
  description: "Shared context for a team of coding agents.",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${hand.variable}`}>
      <body>{children}</body>
    </html>
  );
}
