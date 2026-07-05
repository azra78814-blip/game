import { TAU, dist } from "../core/math";
import { fx } from "../core/rng";
import { inkBlob } from "../render/brush";
import { Palette } from "../render/palette";
import type { GameContext } from "../game/types";

// An ink-bolt fired by ranged enemies / the boss. Parryable: if the player's
// parry window is active when it connects, it is deflected instead of hitting.

export class Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  radius = 7;
  dead = false;
  life = 4;
  team: "enemy" | "player";
  deflected = false;
  private trail: { x: number; y: number }[] = [];
  private spin = fx.range(0, TAU);
  homing: number;

  constructor(
    x: number,
    y: number,
    angle: number,
    speed: number,
    damage: number,
    team: "enemy" | "player" = "enemy",
    homing = 0
  ) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.damage = damage;
    this.team = team;
    this.homing = homing;
  }

  update(ctx: GameContext) {
    const dt = ctx.dt;
    if (this.dead) return;
    this.life -= dt;
    this.spin += dt * 8;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }

    // Light homing toward player for special bolts.
    if (this.homing > 0 && this.team === "enemy") {
      const p = ctx.player;
      const a = Math.atan2(p.y - this.y, p.x - this.x);
      const ca = Math.atan2(this.vy, this.vx);
      const speed = Math.hypot(this.vx, this.vy);
      let na = ca + Math.max(-this.homing * dt, Math.min(this.homing * dt, ((a - ca + Math.PI * 3) % TAU) - Math.PI));
      this.vx = Math.cos(na) * speed;
      this.vy = Math.sin(na) * speed;
    }

    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 6) this.trail.shift();

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const p = ctx.player;
    if (this.team === "enemy") {
      // Deflect on active parry.
      if (p.parryWindow > 0 && dist(this.x, this.y, p.x, p.y) < 44) {
        this.deflect(ctx);
        return;
      }
      if (dist(this.x, this.y, p.x, p.y) < this.radius + p.radius) {
        if (p.hurt(this.damage, this.x, this.y, 200, ctx)) {
          this.dead = true;
        } else if (p.parryWindow > 0) {
          this.deflect(ctx);
        } else {
          // i-framed through; fizzle
          this.dead = true;
        }
        return;
      }
    } else {
      // Player-deflected bolt hits enemies.
      for (const a of ctx.actors) {
        if (a.team !== "enemy" || a.dead) continue;
        if (dist(this.x, this.y, a.x, a.y) < this.radius + a.radius) {
          a.hurt(this.damage, this.x, this.y, 260, ctx);
          ctx.particles.splatter(this.x, this.y, Math.atan2(this.vy, this.vx), 1.2, 0.8);
          this.dead = true;
          return;
        }
      }
    }

    // Off-world cull handled by room bounds in game loop.
  }

  private deflect(ctx: GameContext) {
    this.team = "player";
    this.deflected = true;
    // Fire back where the player is aiming, faster.
    const p = ctx.player;
    const w = ctx.camera.screenToWorld(ctx.input.mouse.x, ctx.input.mouse.y);
    const a = Math.atan2(w.y - p.y, w.x - p.x);
    const speed = 620;
    this.vx = Math.cos(a) * speed;
    this.vy = Math.sin(a) * speed;
    this.damage *= 2.2;
    this.life = 3;
    // Parry feedback is triggered by the player's own parry handler when a
    // melee lands; for a projectile deflect give a little spark here.
    ctx.particles.sparks(this.x, this.y, 10, Palette.vermilion);
    ctx.audio.parry();
    ctx.slowmo(0.3, 200);
  }

  draw(ctx: CanvasRenderingContext2D) {
    // Trail.
    for (let i = 0; i < this.trail.length; i++) {
      const t = i / this.trail.length;
      ctx.globalAlpha = t * 0.4;
      inkBlob(ctx, this.trail[i].x, this.trail[i].y, this.radius * t, 0.7, 0.3, 8, i);
    }
    ctx.globalAlpha = 1;
    const col = this.deflected ? Palette.vermilion : undefined;
    if (col) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, TAU);
      ctx.fill();
    } else {
      inkBlob(ctx, this.x, this.y, this.radius, 0.9, 0.35, 10, this.spin);
    }
    // Vermilion core.
    ctx.fillStyle = this.deflected ? Palette.paper : Palette.vermilionSoft;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius * 0.4, 0, TAU);
    ctx.fill();
  }
}
