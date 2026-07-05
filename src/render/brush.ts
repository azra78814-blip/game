import { TAU } from "../core/math";
import { fx } from "../core/rng";
import { inkTone, Palette } from "./palette";

// Procedural brush-stroke primitives. Everything visible in the game is drawn
// with these — no bitmaps. The goal is the wet, tapered, slightly-uneven look
// of a loaded sumi brush dragged across absorbent paper.

// Cheap, stable value-noise so a stroke's edge wobble is deterministic given a
// seed. Passing a fixed per-entity seed stops bodies from shimmering frame to
// frame; omitting it falls back to random (fine for one-shot splatter marks).
function edgeNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 12.9898 + seed * 7.233) * 0.6 +
    Math.sin(t * 27.137 + seed * 3.11) * 0.4
  );
}

// Trace a point list as a smooth curve using midpoint quadratics.
function strokeOutline(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) * 0.5;
    const my = (pts[i][1] + pts[i + 1][1]) * 0.5;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

/**
 * A tapered brush stroke between two points. Thick in the middle, tapering to
 * fine points at both ends, with a little ink-bleed wobble along the spine.
 * Pass `seed` for a stable edge (no per-frame shimmer); omit for random.
 */
export function brushStroke(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  tone = 0.85,
  wobble = 0.35,
  seed?: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 0.0001;
  const nx = -dy / length;
  const ny = dx / length;

  const segs = Math.max(8, Math.floor(length / 5));
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  const stable = seed !== undefined;

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Taper profile: pointed ends, full belly. sin gives a nice leaf shape.
    const taper = Math.sin(t * Math.PI) ** 0.65;
    const jitter = (stable ? edgeNoise(t, seed!) * 0.5 : fx.next() - 0.5) * wobble * width;
    const w = width * 0.5 * taper + jitter * taper;
    const px = x1 + dx * t;
    const py = y1 + dy * t;
    top.push([px + nx * w, py + ny * w]);
    bot.push([px - nx * w, py - ny * w]);
  }

  // Smooth the outline with quadratic midpoints so edges read as flowing ink
  // rather than faceted polygons.
  ctx.beginPath();
  strokeOutline(ctx, top);
  for (let i = bot.length - 1; i >= 0; i--) {
    const p = bot[i];
    ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();
  ctx.fillStyle = inkTone(tone, 1);
  ctx.fill();

  // Dry-brush texture: a couple of pale streaks that miss the paper.
  if (width > 5) {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = Palette.paper;
    ctx.lineWidth = Math.max(1, width * 0.12);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * A filled ink blob with an irregular, organic outline (a single dab of a wet
 * brush). Cached-friendly: cheap enough to call per frame for small counts.
 */
export function inkBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  tone = 0.85,
  irregularity = 0.35,
  points = 14,
  seed = 0
) {
  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * TAU;
    // Deterministic-ish wobble using seed so blobs don't shimmer per frame.
    const n =
      Math.sin(a * 3 + seed) * 0.5 +
      Math.sin(a * 5 + seed * 1.7) * 0.3 +
      Math.sin(a * 2 + seed * 0.3) * 0.2;
    const r = radius * (1 + n * irregularity);
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = inkTone(tone, 1);
  ctx.fill();
}

/**
 * Soft ink wash halo — a radial gradient bleed, like ink diffusing into damp
 * paper. Used for shadows, glows and the "aura" under characters.
 */
export function inkWash(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  tone = 0.5,
  alpha = 0.4
) {
  const g = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
  g.addColorStop(0, inkTone(tone, alpha));
  g.addColorStop(0.6, inkTone(tone * 0.8, alpha * 0.5));
  g.addColorStop(1, inkTone(tone * 0.6, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fill();
}

/**
 * A crescent slash arc — the signature swing shape. Drawn as a filled sickle
 * that is fat at the middle and tapers at both tips.
 */
export function slashArc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  sweep: number,
  thickness: number,
  tone = 0.9,
  alpha = 1
) {
  const steps = 18;
  const outer: [number, number][] = [];
  const inner: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = startAngle + sweep * t;
    const taper = Math.sin(t * Math.PI) ** 0.7;
    const th = thickness * taper;
    outer.push([cx + Math.cos(a) * (radius + th), cy + Math.sin(a) * (radius + th)]);
    inner.push([cx + Math.cos(a) * (radius - th * 0.4), cy + Math.sin(a) * (radius - th * 0.4)]);
  }
  ctx.beginPath();
  ctx.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i++) ctx.lineTo(outer[i][0], outer[i][1]);
  for (let i = inner.length - 1; i >= 0; i--) ctx.lineTo(inner[i][0], inner[i][1]);
  ctx.closePath();
  ctx.fillStyle = inkTone(tone, alpha);
  ctx.fill();
}

/** A quick calligraphic dot/comma, good for eyes, accents, foliage. */
export function inkComma(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  angle: number,
  tone = 0.9
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.5);
  ctx.quadraticCurveTo(size * 1.2, -size * 0.2, size * 0.2, size);
  ctx.quadraticCurveTo(-size * 0.2, size * 0.2, 0, -size * 0.5);
  ctx.closePath();
  ctx.fillStyle = inkTone(tone, 1);
  ctx.fill();
  ctx.restore();
}
