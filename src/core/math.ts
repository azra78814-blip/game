// Small, allocation-light math helpers used across the game.

export const TAU = Math.PI * 2;

export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y });

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

/** Frame-rate independent exponential smoothing. `rate` ~ higher = snappier. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.sqrt(dist2(ax, ay, bx, by));

export const len = (x: number, y: number): number => Math.hypot(x, y);

export const angleTo = (ax: number, ay: number, bx: number, by: number): number =>
  Math.atan2(by - ay, bx - ax);

/** Shortest signed angular difference from a to b, in [-PI, PI]. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % TAU;
  if (d < -Math.PI) d += TAU;
  if (d > Math.PI) d -= TAU;
  return d;
};

export const rotateTowards = (a: number, b: number, maxStep: number): number => {
  const d = angleDelta(a, b);
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
};

export const smoothstep = (t: number): number => t * t * (3 - 2 * t);

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const easeInCubic = (t: number): number => t * t * t;

export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export const approach = (v: number, target: number, step: number): number => {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
};
