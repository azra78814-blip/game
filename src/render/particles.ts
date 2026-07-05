import { TAU } from "../core/math";
import { fx } from "../core/rng";
import { inkTone, Palette } from "./palette";

// A single pooled particle system for all ink effects: splatter droplets,
// bleeding stains, drifting motes, petal-like flecks and vermilion sparks.

type PKind = "droplet" | "stain" | "mote" | "spark" | "petal" | "ring" | "text";

interface Particle {
  active: boolean;
  kind: PKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  vr: number;
  tone: number;
  drag: number;
  gravity: number;
  color: string;
  text?: string;
  seed: number;
}

const MAX = 1400;

export class Particles {
  private pool: Particle[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < MAX; i++) {
      this.pool.push({
        active: false,
        kind: "droplet",
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 1,
        rot: 0,
        vr: 0,
        tone: 0.8,
        drag: 0.9,
        gravity: 0,
        color: "",
        seed: 0,
      });
    }
  }

  private obtain(): Particle {
    // Ring buffer; overwrite oldest if we wrap.
    for (let i = 0; i < MAX; i++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % MAX;
      if (!p.active) return p;
    }
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX;
    return p;
  }

  /** Directional ink splatter — the money shot on every hit. */
  splatter(x: number, y: number, dir: number, power = 1, tone = 0.85) {
    const count = Math.floor(6 + power * 10);
    for (let i = 0; i < count; i++) {
      const p = this.obtain();
      const spread = fx.range(-0.9, 0.9);
      const a = dir + spread;
      const speed = fx.range(80, 420) * power * (1 - Math.abs(spread) * 0.4);
      p.active = true;
      p.kind = fx.bool(0.75) ? "droplet" : "stain";
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.life = p.maxLife = fx.range(0.35, 0.85);
      p.size = fx.range(1.5, 5.5) * (p.kind === "stain" ? 1.8 : 1);
      p.tone = tone + fx.range(-0.1, 0.1);
      p.drag = 0.86;
      p.gravity = 0;
      p.rot = fx.angle();
      p.vr = fx.range(-6, 6);
      p.seed = fx.range(0, 100);
      p.color = "";
    }
    // A few fat "cast off" droplets that arc and land as stains.
    for (let i = 0; i < 3 + power * 2; i++) {
      const p = this.obtain();
      const a = dir + fx.range(-0.5, 0.5);
      const speed = fx.range(120, 340) * power;
      p.active = true;
      p.kind = "droplet";
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed - fx.range(20, 120);
      p.life = p.maxLife = fx.range(0.5, 1.1);
      p.size = fx.range(3, 7);
      p.tone = tone;
      p.drag = 0.98;
      p.gravity = 480;
      p.rot = 0;
      p.vr = 0;
      p.seed = fx.range(0, 100);
    }
  }

  /** Soft persistent stain that blooms then holds (floor decals). */
  bloom(x: number, y: number, size: number, tone = 0.6) {
    const p = this.obtain();
    p.active = true;
    p.kind = "stain";
    p.x = x + fx.range(-4, 4);
    p.y = y + fx.range(-4, 4);
    p.vx = 0;
    p.vy = 0;
    p.life = p.maxLife = fx.range(1.6, 2.6);
    p.size = size;
    p.tone = tone;
    p.drag = 1;
    p.gravity = 0;
    p.rot = fx.angle();
    p.vr = 0;
    p.seed = fx.range(0, 100);
  }

  /** An expanding ink ring — dodge, parry, shockwaves. */
  ring(x: number, y: number, tone = 0.8, size = 40, color: string = "") {
    const p = this.obtain();
    p.active = true;
    p.kind = "ring";
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    p.life = p.maxLife = 0.4;
    p.size = size;
    p.tone = tone;
    p.color = color;
    p.seed = fx.range(0, 100);
  }

  /** Vermilion sparks for parries and crits. */
  sparks(x: number, y: number, count = 10, color: string = Palette.vermilion) {
    for (let i = 0; i < count; i++) {
      const p = this.obtain();
      const a = fx.angle();
      const speed = fx.range(120, 460);
      p.active = true;
      p.kind = "spark";
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.life = p.maxLife = fx.range(0.25, 0.55);
      p.size = fx.range(1.5, 3.5);
      p.drag = 0.9;
      p.gravity = 0;
      p.color = color;
    }
  }

  /** Ambient drifting ink motes / petals for atmosphere. */
  ambient(x: number, y: number, petal = false) {
    const p = this.obtain();
    p.active = true;
    p.kind = petal ? "petal" : "mote";
    p.x = x;
    p.y = y;
    p.vx = fx.range(-12, 12);
    p.vy = fx.range(-6, 18);
    p.life = p.maxLife = fx.range(4, 9);
    p.size = petal ? fx.range(3, 7) : fx.range(1, 2.4);
    p.tone = petal ? 0.75 : fx.range(0.3, 0.6);
    p.drag = 1;
    p.gravity = petal ? 6 : 0;
    p.rot = fx.angle();
    p.vr = fx.range(-1, 1);
    p.color = petal ? Palette.vermilionSoft : "";
    p.seed = fx.range(0, 100);
  }

  /** Floating combat text (damage numbers, PARRY!, etc). */
  floatText(x: number, y: number, text: string, color: string = Palette.ink) {
    const p = this.obtain();
    p.active = true;
    p.kind = "text";
    p.x = x;
    p.y = y;
    p.vx = fx.range(-14, 14);
    p.vy = -70;
    p.life = p.maxLife = 0.9;
    p.size = 1;
    p.text = text;
    p.color = color;
    p.drag = 0.92;
    p.gravity = 40;
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.rot += p.vr * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const t = p.life / p.maxLife;
      const age = 1 - t; // 0 at spawn -> 1 at death
      switch (p.kind) {
        case "droplet": {
          // Ease the fade so droplets settle softly instead of popping out.
          ctx.globalAlpha = Math.min(1, (t * t) * 1.8);
          ctx.fillStyle = inkTone(p.tone, 1);
          ctx.beginPath();
          // Elongate along velocity for a "flick" look.
          const sp = Math.hypot(p.vx, p.vy);
          if (sp > 60) {
            const a = Math.atan2(p.vy, p.vx);
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(a);
            ctx.scale(1 + sp / 400, 1);
            ctx.arc(0, 0, p.size, 0, TAU);
            ctx.restore();
          } else {
            ctx.arc(p.x, p.y, p.size, 0, TAU);
          }
          ctx.fill();
          break;
        }
        case "stain": {
          // Bloom in fast (ink spreading into paper), hold, then fade out.
          const grow = Math.min(1, age * 6);
          const fade = t < 0.35 ? t / 0.35 : 1;
          ctx.globalAlpha = 0.62 * fade;
          ctx.fillStyle = inkTone(p.tone, 1);
          ctx.beginPath();
          const pts = 14;
          const rr = p.size * (0.4 + grow * 0.6);
          for (let i = 0; i <= pts; i++) {
            const a = (i / pts) * TAU;
            const n =
              Math.sin(a * 3 + p.seed) * 0.4 + Math.sin(a * 5 + p.seed * 2) * 0.22;
            const r = rr * (1 + n * 0.35);
            const px = p.x + Math.cos(a) * r;
            const py = p.y + Math.sin(a) * r;
            // Smooth the blob outline with midpoint curves.
            if (i === 0) ctx.moveTo(px, py);
            else {
              const pa = ((i - 0.5) / pts) * TAU;
              const pn = Math.sin(pa * 3 + p.seed) * 0.4 + Math.sin(pa * 5 + p.seed * 2) * 0.22;
              const pr = rr * (1 + pn * 0.35);
              ctx.quadraticCurveTo(
                p.x + Math.cos(pa) * pr,
                p.y + Math.sin(pa) * pr,
                px,
                py
              );
            }
          }
          ctx.closePath();
          ctx.fill();
          break;
        }
        case "mote": {
          ctx.globalAlpha = Math.min(0.5, t * 0.7) * 0.6;
          ctx.fillStyle = inkTone(p.tone, 1);
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, TAU);
          ctx.fill();
          break;
        }
        case "petal": {
          ctx.globalAlpha = Math.min(0.85, t * 1.2);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color || Palette.vermilionSoft;
          ctx.beginPath();
          ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, TAU);
          ctx.fill();
          ctx.restore();
          break;
        }
        case "spark": {
          ctx.globalAlpha = t;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
          ctx.stroke();
          break;
        }
        case "ring": {
          const rr = p.size * (1 - t) + 6;
          ctx.globalAlpha = t * 0.8;
          ctx.strokeStyle = p.color || inkTone(p.tone, 1);
          ctx.lineWidth = 3 * t + 0.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, TAU);
          ctx.stroke();
          break;
        }
        case "text": {
          ctx.globalAlpha = Math.min(1, t * 1.5);
          const scale = 1.3 - t * 0.3;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.scale(scale, scale);
          ctx.font = "700 20px 'Noto Serif JP', serif";
          ctx.textAlign = "center";
          ctx.lineWidth = 4;
          ctx.strokeStyle = Palette.paper;
          ctx.strokeText(p.text!, 0, 0);
          ctx.fillStyle = p.color;
          ctx.fillText(p.text!, 0, 0);
          ctx.restore();
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  clear() {
    for (const p of this.pool) p.active = false;
  }
}
