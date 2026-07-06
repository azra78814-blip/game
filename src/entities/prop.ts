import { TAU } from "../core/math";
import { RNG, fx } from "../core/rng";
import { inkBlob, inkComma } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { GameContext } from "../game/types";
import type { RoomPlan } from "../game/world";

// Small interactive props that make each chamber feel inhabited: ink jars the
// player can smash for a spray of ink (and a little essence), hanging wind
// bells (fūrin) that swing and chime when brushed past or struck, and clusters
// of ink butterflies that scatter when the player draws near. None of them
// block movement — they exist purely to react and add life.

export type PropKind = "urn" | "bell" | "flutter";

interface Flit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hx: number; // home offset
  hy: number;
  phase: number;
}

export class Interactable {
  x: number;
  y: number;
  readonly kind: PropKind;
  readonly seed: number;
  readonly scale: number;
  readonly radius: number;

  broken = false;
  /** Swing ids that already struck this prop, so one swing hits it only once. */
  readonly hitIds = new Set<number>();
  private hp: number;

  private t = 0;
  private wobble = 0; // urn hit reaction, decays to 0
  private swing = 0; // bell angle (radians)
  private swingVel = 0;
  private ringCd = 0; // chime cooldown
  private agitation = 0; // flutter scatter energy 0..1
  private nearPrev = false;
  private flits: Flit[] = [];

  constructor(kind: PropKind, x: number, y: number, seed: number, scale = 1) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.seed = seed;
    this.scale = scale;
    this.radius = kind === "urn" ? 20 * scale : kind === "bell" ? 15 * scale : 34 * scale;
    this.hp = kind === "urn" ? 2 : Infinity;

    if (kind === "flutter") {
      const rng = new RNG(seed + 7);
      const n = rng.int(3, 5);
      for (let i = 0; i < n; i++) {
        const a = rng.range(0, TAU);
        const r = rng.range(6, 20) * scale;
        const hx = Math.cos(a) * r;
        const hy = Math.sin(a) * r * 0.7 - rng.range(4, 20);
        this.flits.push({ x: hx, y: hy, vx: 0, vy: 0, hx, hy, phase: rng.range(0, TAU) });
      }
    }
  }

  /** True while the prop should still be updated / drawn. */
  get alive(): boolean {
    return !this.broken;
  }

  update(ctx: GameContext) {
    const dt = ctx.dt;
    this.t += dt;
    if (this.wobble > 0) this.wobble = Math.max(0, this.wobble - dt * 4);
    if (this.ringCd > 0) this.ringCd -= dt;

    const px = ctx.player.x;
    const py = ctx.player.y;
    const d = Math.hypot(px - this.x, py - this.y);
    const nearR = this.radius + (this.kind === "flutter" ? 32 : 40);
    const near = d < nearR;

    if (this.kind === "bell") {
      // Damped pendulum with a faint idle breeze.
      this.swingVel += (-30 * this.swing - 3 * this.swingVel) * dt;
      this.swingVel += Math.sin(this.t * 0.8 + this.seed) * 0.9 * dt;
      // Brushing past nudges it and rings once (edge-triggered, with cooldown).
      if (near && !this.nearPrev && this.ringCd <= 0) {
        this.swingVel += (px < this.x ? 1 : -1) * 2.6;
        ctx.audio.chime(0.9 + (this.seed % 5) * 0.04);
        ctx.particles.ring(this.x, this.y - 22 * this.scale, 0.5, 20 * this.scale);
        this.ringCd = 0.55;
      }
      this.swing += this.swingVel * dt;
    } else if (this.kind === "flutter") {
      if (near) this.agitation = Math.min(1, this.agitation + dt * 4);
      else this.agitation = Math.max(0, this.agitation - dt * 1.4);
      if (near && !this.nearPrev) this.scatter(0.7);

      for (const f of this.flits) {
        f.phase += dt * 6;
        // Spring back toward a gently-hovering home point.
        const tx = f.hx + Math.cos(f.phase) * 2.2;
        const ty = f.hy + Math.sin(f.phase * 1.3) * 2.2;
        f.vx += (tx - f.x) * dt * 8;
        f.vy += (ty - f.y) * dt * 8;
        if (this.agitation > 0.02) {
          const a = Math.atan2(f.y - f.hy * 0.2, f.x) + ctx.rng.range(-0.6, 0.6);
          const kick = this.agitation * 90 * dt;
          f.vx += Math.cos(a) * kick;
          f.vy += Math.sin(a) * kick - kick * 0.3;
        }
        f.vx *= 0.9;
        f.vy *= 0.9;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
      }
    }

    this.nearPrev = near;
  }

  /** Called by the game when a player attack overlaps this prop. */
  strike(ctx: GameContext, fromX: number, fromY: number) {
    if (this.broken) return;
    if (this.kind === "urn") {
      this.hp -= 1;
      this.wobble = 1;
      if (this.hp <= 0) this.shatter(ctx, fromX, fromY);
      else ctx.audio.hit(0.35, 1.5);
    } else if (this.kind === "bell") {
      this.swingVel += (this.x >= fromX ? 1 : -1) * 5;
      if (this.ringCd <= 0) {
        ctx.audio.chime(1.15);
        ctx.particles.ring(this.x, this.y - 22 * this.scale, 0.6, 26 * this.scale);
        this.ringCd = 0.25;
      }
    } else {
      this.scatter(1.4);
    }
  }

  private shatter(ctx: GameContext, fromX: number, fromY: number) {
    this.broken = true;
    const dir = Math.atan2(this.y - fromY, this.x - fromX);
    ctx.particles.splatter(this.x, this.y - 12, dir, 1.5, 0.8);
    ctx.particles.splatter(this.x, this.y - 12, dir + 2.4, 1.0, 0.65);
    ctx.particles.ring(this.x, this.y - 8, 0.7, 58);
    ctx.particles.bloom(this.x, this.y + 6, 24 * this.scale, 0.55);
    ctx.audio.shatter(1);
    ctx.addScreenShake(0.12);
  }

  private scatter(power: number) {
    this.agitation = Math.min(1, this.agitation + 0.6 * power);
    for (const f of this.flits) {
      const a = Math.atan2(f.y, f.x) || fx.angle();
      f.vx += Math.cos(a) * 130 * power;
      f.vy += Math.sin(a) * 130 * power - 40;
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    switch (this.kind) {
      case "urn":
        this.drawUrn(ctx);
        break;
      case "bell":
        this.drawBell(ctx);
        break;
      case "flutter":
        this.drawFlutter(ctx);
        break;
    }
  }

  private drawUrn(ctx: CanvasRenderingContext2D) {
    if (this.broken) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(Math.sin(this.t * 28) * this.wobble * 0.1);
    ctx.scale(this.scale, this.scale);

    // Ground shadow.
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = Palette.ink;
    ctx.beginPath();
    ctx.ellipse(0, 4, 18, 6, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Body — a painterly ink blob, tapering to a narrow foot and neck.
    inkBlob(ctx, 0, -14, 17, 0.72, 0.32, 14, this.seed);
    ctx.fillStyle = inkTone(0.62, 1);
    ctx.beginPath();
    ctx.ellipse(0, -30, 9, 4, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = inkTone(0.85, 1);
    ctx.beginPath();
    ctx.ellipse(0, -31, 7, 2.6, 0, 0, TAU);
    ctx.fill();

    // Vermilion accent band + seal glyph.
    ctx.strokeStyle = Palette.vermilionSoft;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, -13, 14, 9, 0, 0.2, Math.PI - 0.2);
    ctx.stroke();
    ctx.fillStyle = Palette.seal;
    ctx.globalAlpha = 0.85;
    ctx.font = "700 10px 'Noto Serif JP', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("墨", 0, -12);
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawBell(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(this.scale, this.scale);
    const topY = -70; // fixed hanging anchor above the bell

    // Hanging cord from the anchor down to the (swinging) bell.
    const bx = Math.sin(this.swing) * 30;
    const by = topY + Math.cos(this.swing) * 42;
    ctx.strokeStyle = inkTone(0.8, 0.8);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, topY);
    ctx.quadraticCurveTo(bx * 0.5, topY + 20, bx, by - 8);
    ctx.stroke();

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(this.swing);
    // Bell dome.
    ctx.fillStyle = inkTone(0.7, 1);
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.quadraticCurveTo(-9, -13, 0, -14);
    ctx.quadraticCurveTo(9, -13, 9, 0);
    ctx.quadraticCurveTo(0, 4, -9, 0);
    ctx.closePath();
    ctx.fill();
    // Vermilion rim.
    ctx.strokeStyle = Palette.vermilion;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.quadraticCurveTo(0, 4, 9, 0);
    ctx.stroke();
    // Clapper + paper strip (tanzaku) that trails the swing.
    ctx.fillStyle = inkTone(0.5, 1);
    ctx.beginPath();
    ctx.arc(0, 5, 2.2, 0, TAU);
    ctx.fill();
    const strip = this.swing * 1.6;
    ctx.strokeStyle = Palette.vermilionSoft;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.quadraticCurveTo(strip * 6, 16, strip * 10, 26);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  private drawFlutter(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.translate(this.x, this.y);
    for (const f of this.flits) {
      const flap = Math.sin(f.phase * 3) * 0.5 + 0.6; // wing openness
      const tilt = Math.atan2(f.vy, f.vx || 0.001);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(tilt * 0.2);
      // Two ink-comma wings mirrored, with a small vermilion body.
      const wing = 4 + flap * 2;
      ctx.globalAlpha = 0.85;
      inkComma(ctx, -1, 0, wing, -1.4 - flap, 0.55);
      inkComma(ctx, 1, 0, wing, 1.4 + flap, 0.55);
      ctx.globalAlpha = 1;
      ctx.fillStyle = Palette.seal;
      ctx.beginPath();
      ctx.ellipse(0, 0, 1.1, 2.4, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
}

/** Seeded population of interactive props for a room, kept off the entrance. */
export function spawnProps(plan: RoomPlan): Interactable[] {
  const rng = new RNG(plan.seed + 4242);
  const props: Interactable[] = [];
  const hw = plan.width / 2;
  const hh = plan.height / 2;

  // Ink urns clustered toward the interior/far side (never at the west
  // entrance where the player spawns).
  const urnCount = plan.type === "boss" ? rng.int(2, 3) : rng.int(3, 5);
  for (let i = 0; i < urnCount; i++) {
    const x = rng.range(-hw * 0.35, hw * 0.85);
    const y = rng.range(-hh * 0.7, hh * 0.85);
    props.push(new Interactable("urn", x, y, rng.int(0, 1000), rng.range(0.8, 1.25)));
  }

  // A wind bell or two, hung toward the upper corners like eave ornaments.
  const bellCount = plan.type === "rest" || plan.type === "reward" ? 2 : rng.int(1, 2);
  for (let i = 0; i < bellCount; i++) {
    const side = rng.bool() ? -1 : 1;
    props.push(
      new Interactable(
        "bell",
        side * rng.range(hw * 0.45, hw * 0.85),
        -hh + rng.range(70, 120),
        rng.int(0, 1000),
        rng.range(0.9, 1.3)
      )
    );
  }

  // A butterfly cluster hovering over the floor in most rooms.
  if (plan.type !== "boss" && rng.bool(0.8)) {
    props.push(
      new Interactable(
        "flutter",
        rng.range(-hw * 0.5, hw * 0.5),
        rng.range(-hh * 0.2, hh * 0.6),
        rng.int(0, 1000),
        rng.range(0.9, 1.3)
      )
    );
  }

  return props;
}
