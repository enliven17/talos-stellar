"use client";

import { memo, useMemo } from "react";

/**
 * Deterministic 8-bit robot face avatar for agents.
 * Each name produces a unique combination of head shape, visor, eyes,
 * mouth, antenna, ears, and decorations on a 12×12 pixel grid.
 */

type P = [number, number];

// Cache hash results per (str, seed) pair across renders
const hashCache = new Map<string, number>();

function hash(str: string, seed = 0): number {
  const key = `${seed}:${str}`;
  const cached = hashCache.get(key);
  if (cached !== undefined) return cached;
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  const result = Math.abs(h);
  hashCache.set(key, result);
  return result;
}

function pick<T>(arr: T[], name: string, seed: number): T {
  return arr[hash(name, seed) % arr.length];
}

// ── Color palettes ──────────────────────────────────────────────

const PALETTE = [
  { bg: "#FBEFEF", face: "#6366f1", accent: "#a5b4fc", glow: "#6366f180" },
  { bg: "#FBEFEF", face: "#8b5cf6", accent: "#c4b5fd", glow: "#8b5cf680" },
  { bg: "#FBEFEF", face: "#ec4899", accent: "#f9a8d4", glow: "#ec489980" },
  { bg: "#FBEFEF", face: "#14b8a6", accent: "#5eead4", glow: "#14b8a680" },
  { bg: "#FBEFEF", face: "#f59e0b", accent: "#fcd34d", glow: "#f59e0b80" },
  { bg: "#FBEFEF", face: "#10b981", accent: "#6ee7b7", glow: "#10b98180" },
  { bg: "#FBEFEF", face: "#3b82f6", accent: "#93c5fd", glow: "#3b82f680" },
  { bg: "#FBEFEF", face: "#ef4444", accent: "#fca5a5", glow: "#ef444480" },
  { bg: "#FBEFEF", face: "#06b6d4", accent: "#67e8f9", glow: "#06b6d480" },
  { bg: "#FBEFEF", face: "#f97316", accent: "#fdba74", glow: "#f9731680" },
  { bg: "#FBEFEF", face: "#a855f7", accent: "#d8b4fe", glow: "#a855f780" },
  { bg: "#FBEFEF", face: "#84cc16", accent: "#bef264", glow: "#84cc1680" },
];

// ── Head shapes (12×12 grid, rows 2-11, symmetric) ──────────────
// Each is an array of [x,y] pixels that form the head silhouette.
// Only left half specified; mirrored automatically around x=5.5

function mirror(half: P[]): P[] {
  const full = new Set<string>();
  for (const [x, y] of half) {
    full.add(`${x},${y}`);
    full.add(`${11 - x},${y}`);
  }
  return [...full].map((s) => s.split(",").map(Number) as P);
}

function rect(x1: number, y1: number, x2: number, y2: number): P[] {
  const ps: P[] = [];
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++) ps.push([x, y]);
  return ps;
}

const HEAD_SHAPES: (() => P[])[] = [
  // 0: Classic box
  () => mirror([...rect(2, 3, 5, 10)]),
  // 1: Rounded top
  () => mirror([...rect(3, 2, 5, 2), ...rect(2, 3, 5, 10)]),
  // 2: Narrow chin
  () => mirror([...rect(2, 3, 5, 8), ...rect(3, 9, 5, 10)]),
  // 3: Wide jaw
  () => mirror([...rect(3, 2, 5, 3), ...rect(2, 4, 5, 8), ...rect(1, 9, 5, 10)]),
  // 4: Hexagonal
  () => mirror([...rect(3, 2, 5, 2), ...rect(2, 3, 5, 9), ...rect(3, 10, 5, 10)]),
  // 5: Tall narrow
  () => mirror([...rect(3, 1, 5, 10)]),
  // 6: Dome head
  () => mirror([...rect(4, 1, 5, 1), ...rect(3, 2, 5, 2), ...rect(2, 3, 5, 10)]),
  // 7: Angular (diamond-ish top)
  () => mirror([...rect(4, 1, 5, 2), ...rect(3, 3, 5, 3), ...rect(2, 4, 5, 9), ...rect(3, 10, 5, 10)]),
];

// ── Antenna variants ────────────────────────────────────────────

const ANTENNAS: P[][] = [
  // 0: single spike
  [[5, 0], [5, 1], [6, 0], [6, 1]],
  // 1: rabbit ears
  [[3, 0], [3, 1], [8, 0], [8, 1]],
  // 2: wide T
  [[3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [5, 1], [6, 1]],
  // 3: lightning bolt
  [[4, 0], [5, 0], [5, 1], [6, 1], [7, 0], [7, 1]],
  // 4: triple dot
  [[3, 0], [5, 0], [6, 0], [8, 0]],
  // 5: horn
  [[2, 1], [3, 0], [8, 0], [9, 1]],
  // 6: crown
  [[3, 0], [5, 0], [6, 0], [8, 0], [4, 1], [5, 1], [6, 1], [7, 1]],
  // 7: none
  [],
];

// ── Eye variants (left eye coords; right eye is mirrored) ───────

const EYES: { left: P[]; right: P[] }[] = [
  // 0: square 2×2
  { left: [[3, 5], [4, 5], [3, 6], [4, 6]], right: [[7, 5], [8, 5], [7, 6], [8, 6]] },
  // 1: single pixel
  { left: [[3, 5]], right: [[8, 5]] },
  // 2: horizontal bar
  { left: [[3, 5], [4, 5]], right: [[7, 5], [8, 5]] },
  // 3: vertical bar
  { left: [[3, 5], [3, 6]], right: [[8, 5], [8, 6]] },
  // 4: L-shape
  { left: [[3, 5], [3, 6], [4, 6]], right: [[8, 5], [8, 6], [7, 6]] },
  // 5: cross
  { left: [[3, 5], [4, 5], [3, 6], [2, 5]], right: [[8, 5], [7, 5], [8, 6], [9, 5]] },
  // 6: visor (connected bar)
  { left: [[3, 5], [4, 5], [5, 5]], right: [[6, 5], [7, 5], [8, 5]] },
  // 7: diagonal
  { left: [[3, 5], [4, 6]], right: [[8, 5], [7, 6]] },
  // 8: big + small (asymmetric)
  { left: [[3, 5], [4, 5], [3, 6], [4, 6]], right: [[8, 5]] },
  // 9: hollow square
  { left: [[2, 4], [3, 4], [4, 4], [2, 5], [4, 5], [2, 6], [3, 6], [4, 6]], right: [[7, 4], [8, 4], [9, 4], [7, 5], [9, 5], [7, 6], [8, 6], [9, 6]] },
];

// ── Visor / forehead decoration ─────────────────────────────────

const VISORS: P[][] = [
  // 0: none
  [],
  // 1: brow line
  [[3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4]],
  // 2: full visor band
  [[2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4]],
  // 3: split brow
  [[3, 4], [4, 4], [7, 4], [8, 4]],
  // 4: chevron
  [[5, 3], [6, 3], [4, 4], [7, 4]],
  // 5: dots
  [[3, 3], [5, 3], [6, 3], [8, 3]],
];

// ── Mouth variants ──────────────────────────────────────────────

const MOUTHS: P[][] = [
  // 0: straight line
  [[4, 8], [5, 8], [6, 8], [7, 8]],
  // 1: small
  [[5, 8], [6, 8]],
  // 2: smile
  [[4, 8], [5, 9], [6, 9], [7, 8]],
  // 3: grille (3 dots)
  [[4, 8], [6, 8], [8, 8]],
  // 4: wide open
  [[4, 8], [5, 8], [6, 8], [7, 8], [4, 9], [7, 9]],
  // 5: fangs
  [[4, 8], [5, 8], [6, 8], [7, 8], [4, 9], [7, 9], [5, 9], [6, 9]],
  // 6: speaker grille
  [[3, 8], [5, 8], [7, 8], [3, 9], [5, 9], [7, 9]],
  // 7: zigzag
  [[3, 8], [4, 9], [5, 8], [6, 9], [7, 8], [8, 9]],
  // 8: none
  [],
];

// ── Ear / side attachments ──────────────────────────────────────

const EARS: P[][] = [
  [],
  [[0, 5], [0, 6], [11, 5], [11, 6]],
  [[0, 4], [0, 5], [0, 6], [0, 7], [11, 4], [11, 5], [11, 6], [11, 7]],
  [[0, 6], [11, 6]],
  [[1, 4], [0, 5], [0, 6], [1, 7], [10, 4], [11, 5], [11, 6], [10, 7]],
  [[0, 5], [0, 6], [0, 7], [11, 5], [11, 6], [11, 7], [1, 4], [10, 4]],
];

// ── Chin / jaw decoration ───────────────────────────────────────

const CHINS: P[][] = [
  [],
  [[5, 11], [6, 11]],
  [[4, 11], [5, 11], [6, 11], [7, 11]],
  [[5, 11], [6, 11], [4, 11], [7, 11], [3, 11], [8, 11]],
];

// ── Cheek marks / scars ─────────────────────────────────────────

const CHEEKS: P[][] = [
  [],
  [[2, 7], [9, 7]],
  [[2, 6], [2, 7], [9, 6], [9, 7]],
  [[2, 7], [2, 8], [9, 7], [9, 8]],
  [[2, 5], [9, 5]],
];

// ── Component ───────────────────────────────────────────────────

interface AgentAvatarProps {
  name: string;
  size?: number;
  className?: string;
}

export const AgentAvatar = memo(function AgentAvatar({ name, size = 32, className = "" }: AgentAvatarProps) {
  const { colors, headCoords, antenna, eyes, visor, mouth, ears, chin, cheeks, headSet } = useMemo(() => {
    const c = pick(PALETTE, name, 0);
    const hc = pick(HEAD_SHAPES, name, 1)();
    return {
      colors: c,
      headCoords: hc,
      antenna: pick(ANTENNAS, name, 2),
      eyes: pick(EYES, name, 3),
      visor: pick(VISORS, name, 4),
      mouth: pick(MOUTHS, name, 5),
      ears: pick(EARS, name, 6),
      chin: pick(CHINS, name, 7),
      cheeks: pick(CHEEKS, name, 8),
      headSet: new Set(hc.map(([x, y]) => `${x},${y}`)),
    };
  }, [name]);

  const G = 12;
  const px = size / G;

  const dot = (key: string, x: number, y: number, fill: string, opacity = 1) => (
    <rect
      key={key}
      x={x * px}
      y={y * px}
      width={px + 0.5}
      height={px + 0.5}
      fill={fill}
      opacity={opacity}
    />
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={`${name} avatar`}
    >
      {/* Background */}
      <rect width={size} height={size} fill={colors.bg} rx={size * 0.12} />

      {/* Glow behind head */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={size * 0.35}
        fill={colors.glow}
      />

      {/* Head body */}
      {headCoords.map(([x, y]) => dot(`h${x}-${y}`, x, y, colors.face, 0.35))}

      {/* Antenna */}
      {antenna.map(([x, y]) => dot(`a${x}-${y}`, x, y, colors.accent, 0.9))}

      {/* Visor / brow */}
      {visor
        .filter(([x, y]) => headSet.has(`${x},${y}`) || y <= 4)
        .map(([x, y]) => dot(`v${x}-${y}`, x, y, colors.face, 0.55))}

      {/* Eyes */}
      {[...eyes.left, ...eyes.right].map(([x, y]) =>
        dot(`e${x}-${y}`, x, y, colors.accent)
      )}

      {/* Mouth */}
      {mouth
        .filter(([x, y]) => headSet.has(`${x},${y}`))
        .map(([x, y]) => dot(`m${x}-${y}`, x, y, colors.accent, 0.6))}

      {/* Ears */}
      {ears.map(([x, y]) => dot(`r${x}-${y}`, x, y, colors.face, 0.45))}

      {/* Chin */}
      {chin.map(([x, y]) => dot(`c${x}-${y}`, x, y, colors.face, 0.3))}

      {/* Cheek marks */}
      {cheeks
        .filter(([x, y]) => headSet.has(`${x},${y}`))
        .map(([x, y]) => dot(`k${x}-${y}`, x, y, colors.accent, 0.3))}
    </svg>
  );
});
