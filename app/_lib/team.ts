"use client";

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";

// Each teammate keeps one color, in the order they joined, like cursors in a multiplayer editor.
const PALETTE = ["#2563eb", "#c2410c", "#0c8a5e", "#9c36b5", "#c2255c", "#0b7285"];
export function createPalette() {
  const colors = new Map<string, string>();
  return (n: string) => {
    if (n === "orchestrator") return "#21201d";
    if (n === "human") return "#5d5b55";
    if (!colors.has(n)) colors.set(n, PALETTE[colors.size % PALETTE.length]);
    return colors.get(n)!;
  };
}
export const PaletteContext = createContext<(n: string) => string>(() => PALETTE[0]);
export const useColor = () => useContext(PaletteContext);
// Components read their color from --c.
export const tint = (color: string) => ({ "--c": color }) as CSSProperties;

export const label = (n: string) =>
  n === "orchestrator" ? "Huddle" : n === "human" ? "Someone on the dashboard" : n.charAt(0).toUpperCase() + n.slice(1);
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export const tidy = (s: string | undefined) => String(s ?? "").trim().replace(/[.!\s]+$/, "");
export const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export const isDoing = (s: string) => /^[a-z]+ing\b/i.test(s);
// "A", "A and B", "A, B and C"
export const listOf = (xs: ReactNode[]) => xs.flatMap((x, i) => (i === 0 ? [x] : [i === xs.length - 1 ? " and " : ", ", x]));
