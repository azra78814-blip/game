// The whole game speaks in ink washes on aged rice paper, with a single
// vermilion accent (the "seal red" of East Asian brush painting). Keeping the
// palette tiny is what makes the art direction read as cohesive.

export const Palette = {
  paper: "#e9e2d0",
  paperDeep: "#d8cdb2",
  paperEdge: "#c3b795",

  ink: "#14110c",
  ink90: "rgba(20, 17, 12, 0.9)",
  ink70: "rgba(20, 17, 12, 0.7)",
  ink50: "rgba(24, 20, 14, 0.5)",
  ink30: "rgba(28, 24, 16, 0.3)",
  ink15: "rgba(30, 26, 18, 0.15)",
  ink08: "rgba(30, 26, 18, 0.08)",

  wash: "#5c5344",
  washLight: "#8b8170",

  vermilion: "#b3392a",
  vermilionSoft: "rgba(179, 57, 42, 0.55)",
  seal: "#a8321f",
  gold: "#b98a3c",

  jade: "#5b7d6a",
  indigo: "#3f4d63",
} as const;

export type InkTone = number; // 0 = pale wash, 1 = deep black ink

/** Map an ink tone [0..1] to an rgba string at a given alpha. */
export function inkTone(tone: number, alpha = 1): string {
  // Deeper tone -> darker and warmer-black.
  const t = Math.max(0, Math.min(1, tone));
  const r = Math.round(150 - 132 * t);
  const g = Math.round(140 - 122 * t);
  const b = Math.round(124 - 110 * t);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
