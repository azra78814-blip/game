import { angleTo, damp, dist, TAU } from "../core/math";
import { fx } from "../core/rng";
import { brushStroke, inkBlob, slashArc } from "../render/brush";
import { Palette } from "../render/palette";
import type { GameContext, HitInfo } from "../game/types";

// A spectral ink-clone summoned by the Spirit Ink talisman. It drifts near the
// player and periodically slashes the nearest foe — a translucent echo of the
// wielder that reinforces the "living ink" fantasy.

let cloneHitId = 900000;

export class InkClone {
  x: number;
  y: number;
  private life: number;
  private maxLife: number;
  private attackCd = 0.3;
  private facing = 0;
  private swingT = -1; // >=0 while a slash is animating
  private seed = fx.range(0, 1000);
  private orbit = fx.angle();
  dead = false;

  constructor(x: number, y: number, duration: number) {
    this.x = x;
    this.y = y;
    this.life = this.maxLife = duration;
  }

  update(ctx: GameContext) {
    const dt = ctx.dt;
    this.life -= dt;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }
    this.orbit += dt * 1.2;
    const p = ctx.player;
    // Hover at an orbiting offset around the player.
    const tx = p.x + Math.cos(this.orbit) * 70;
    const ty = p.y + Math.sin(this.orbit) * 55;
    this.x = damp(this.x, tx, 6, dt);
    this.y = damp(this.y, ty, 6, dt);

    this.attackCd -= dt;
    if (this.swingT >= 0) this.swingT += dt;
    if (this.swingT > 0.18) this.swingT = -1;

    // Find nearest enemy to strike.
    let target: { x: number; y: number } | null = null;
    let best = 260 * 260;
    for (const e of ctx.actors) {
      if (e.team !== "enemy" || e.dead) continue;
      const d = (e.x - this.x) ** 2 + (e.y - this.y) ** 2;
      if (d < best) {
        best = d;
        target = e;
      }
    }
    if (target) this.facing = angleTo(this.x, this.y, target.x, target.y);

    if (this.attackCd <= 0 && target) {
      this.attackCd = 0.5;
      this.swingT = 0;
      const dmg = 12 * p.stats.damageMult;
      const hit: HitInfo = {
        x: this.x + Math.cos(this.facing) * 40,
        y: this.y + Math.sin(this.facing) * 40,
        radius: 66,
        angle: this.facing,
        arc: 1.2,
        damage: dmg,
        knockback: 180,
        team: "player",
        id: cloneHitId++,
        hitSet: new Set(),
      };
      ctx.hits.push(hit);
      ctx.audio.swing(0.6);
      ctx.particles.splatter(hit.x, hit.y, this.facing, 0.8, 0.7);
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    const fade = Math.min(1, this.life / 0.6);
    ctx.save();
    ctx.globalAlpha = 0.4 * fade;
    ctx.translate(this.x, this.y);
    // Ghostly indigo-tinted body.
    brushStroke(ctx, 0, -14, 0, 16, 22, 0.6, 0.15, this.seed);
    inkBlob(ctx, 0, -18, 6, 0.6, 0.2, 12, this.seed);
    ctx.fillStyle = Palette.indigo;
    ctx.globalAlpha = 0.5 * fade;
    ctx.beginPath();
    ctx.arc(-3, -18, 1.4, 0, TAU);
    ctx.arc(3, -18, 1.4, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Slash arc.
    if (this.swingT >= 0) {
      const a = Math.min(1, this.swingT / 0.18);
      ctx.globalAlpha = (1 - a) * 0.6 * fade;
      slashArc(ctx, this.x, this.y, 46, this.facing - 0.6, 1.2, 9, 0.7, 1);
      ctx.globalAlpha = 1;
    }
  }
}
