import { angleTo, clamp, damp, dist, lerp, rotateTowards, TAU } from "../core/math";
import { fx } from "../core/rng";
import { brushStroke, inkBlob, inkWash, slashArc } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { Actor, GameContext, HitInfo } from "../game/types";

// "The Drowned Calligrapher" — a three-phase boss. Each phase adds a mechanic
// and speeds up. Every attack is telegraphed; the fight rewards reading tells,
// spacing, and punishing recovery windows rather than trading stats.

type Phase = 1 | 2 | 3;
type Move =
  | "idle"
  | "sweep" // wide brush slash, dodge through or around
  | "thrust" // fast lunge stab, sidestep
  | "rain" // ink bolts from above, keep moving
  | "spiral" // rotating bullet spiral, weave outward
  | "callig" // draws a damaging sigil on the floor, telegraph then detonate
  | "summon" // spawns wisps (phase 2+)
  | "transition";

let hitId = 500000;

interface Sigil {
  x: number;
  y: number;
  r: number;
  t: number; // charge 0..1
  detonated: boolean;
}

export class Boss implements Actor {
  x: number;
  y: number;
  radius = 40;
  hp: number;
  maxHp: number;
  dead = false;
  team = "enemy" as const;

  facing = 0;
  private vx = 0;
  private vy = 0;
  phase: Phase = 1;
  private move: Move = "idle";
  private moveTime = 0;
  private nextDecision = 1.2;
  private flash = 0;
  private wobble = 0;
  private telegraph = 0;
  private hitEmitted = false;
  private aimAngle = 0;
  private sigils: Sigil[] = [];
  private introTime = 1.6;
  private enraged = false;
  onSummon?: (x: number, y: number) => void;
  private dmgScale: number;
  private spiralCount = 0;
  private lungeHit: HitInfo | null = null;
  private bleedDps = 0;
  private bleedTime = 0;

  applyBleed(dps: number, duration: number) {
    this.bleedDps = Math.min(this.bleedDps + dps, dps * 6 + 60);
    this.bleedTime = Math.max(this.bleedTime, duration);
  }

  // Name plate reveal.
  nameAlpha = 0;

  constructor(x: number, y: number, hpScale = 1, dmgScale = 1) {
    this.x = x;
    this.y = y;
    this.maxHp = 900 * hpScale;
    this.hp = this.maxHp;
    this.dmgScale = dmgScale;
  }

  get phaseThresholds() {
    return { two: this.maxHp * 0.66, three: this.maxHp * 0.33 };
  }

  hurt(amount: number, fromX: number, fromY: number, knockback: number, ctx: GameContext): boolean {
    if (this.dead || this.move === "transition" || this.introTime > 0) return false;
    this.hp -= amount;
    this.flash = 1;
    // Boss has super-armor: tiny knockback only.
    const a = angleTo(fromX, fromY, this.x, this.y);
    this.vx += Math.cos(a) * knockback * 0.06;
    this.vy += Math.sin(a) * knockback * 0.06;
    ctx.audio.hit(clamp(amount / 24, 0.6, 1.6), 0.55);
    ctx.particles.splatter(fromX, fromY, angleTo(fromX, fromY, this.x, this.y), 1.4, 0.9);
    ctx.hitstop(amount > 25 ? 55 : 30);

    // Phase transitions.
    if (this.phase === 1 && this.hp <= this.phaseThresholds.two) {
      this.enterPhase(2, ctx);
    } else if (this.phase === 2 && this.hp <= this.phaseThresholds.three) {
      this.enterPhase(3, ctx);
    }

    if (this.hp <= 0) {
      this.hp = 0;
      this.die(ctx);
    }
    return true;
  }

  private enterPhase(p: Phase, ctx: GameContext) {
    this.phase = p;
    this.move = "transition";
    this.moveTime = 0;
    this.telegraph = 0;
    this.sigils = [];
    ctx.audio.bossRoar();
    ctx.addScreenShake(0.8);
    ctx.slowmo(0.4, 500);
    ctx.particles.ring(this.x, this.y, 0.9, 200, Palette.vermilion);
    for (let i = 0; i < 24; i++) {
      ctx.particles.splatter(this.x, this.y, (i / 24) * TAU, 2, 0.9);
    }
    ctx.notify(p === 2 ? "第二幕" : "終幕", this.x, this.y - 70, Palette.vermilion);
  }

  private die(ctx: GameContext) {
    this.dead = true;
    ctx.audio.bossRoar();
    ctx.slowmo(0.15, 1400);
    ctx.addScreenShake(1);
    for (let i = 0; i < 60; i++) {
      ctx.particles.splatter(
        this.x + fx.range(-30, 30),
        this.y + fx.range(-30, 30),
        fx.angle(),
        2.5,
        0.9
      );
    }
    ctx.particles.ring(this.x, this.y, 0.9, 400, Palette.vermilion);
  }

  update(ctx: GameContext) {
    const dt = ctx.dt;
    if (this.dead) return;
    const p = ctx.player;
    this.flash = Math.max(0, this.flash - dt * 4);
    this.wobble += dt * 2;
    this.nameAlpha = damp(this.nameAlpha, this.introTime > 0 ? 1 : 0.0, 4, dt);

    // Bleed DoT (no super-armor protection against it).
    if (this.bleedTime > 0 && this.introTime <= 0) {
      this.bleedTime -= dt;
      this.hp -= this.bleedDps * dt;
      if (fx.bool(dt * 8)) ctx.particles.bloom(this.x + fx.range(-14, 14), this.y + fx.range(-6, 14), fx.range(3, 6), 0.8);
      if (this.bleedTime <= 0) this.bleedDps = 0;
      if (this.hp <= 0) { this.hp = 0; this.die(ctx); return; }
    }

    if (this.introTime > 0) {
      this.introTime -= dt;
      this.facing = angleTo(this.x, this.y, p.x, p.y);
      return;
    }

    const toPlayer = angleTo(this.x, this.y, p.x, p.y);
    const d = dist(this.x, this.y, p.x, p.y);

    // Update floor sigils regardless of move.
    this.updateSigils(ctx);

    switch (this.move) {
      case "transition":
        this.moveTime += dt;
        this.vx = damp(this.vx, 0, 8, dt);
        this.vy = damp(this.vy, 0, 8, dt);
        if (this.moveTime > 1.0) {
          this.move = "idle";
          this.moveTime = 0;
          this.nextDecision = 0.4;
        }
        break;

      case "idle":
        this.facing = rotateTowards(this.facing, toPlayer, dt * 3);
        // Drift to maintain mid-range.
        this.reposition(ctx, d, toPlayer);
        this.moveTime += dt;
        if (this.moveTime >= this.nextDecision) {
          this.decide(ctx, d);
        }
        break;

      case "sweep":
        this.updateSweep(ctx);
        break;
      case "thrust":
        this.updateThrust(ctx, toPlayer);
        break;
      case "rain":
        this.updateRain(ctx, p);
        break;
      case "spiral":
        this.updateSpiral(ctx);
        break;
      case "callig":
        this.updateCallig(ctx, p);
        break;
      case "summon":
        this.updateSummon(ctx);
        break;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= 0.9;
    this.vy *= 0.9;

    // Keep within a soft arena bound (set by room; clamp large).
    this.x = clamp(this.x, -520, 520);
    this.y = clamp(this.y, -360, 360);
  }

  private reposition(ctx: GameContext, d: number, toPlayer: number) {
    const dt = ctx.dt;
    const ideal = 220;
    let a = toPlayer;
    if (d < ideal - 40) a = toPlayer + Math.PI;
    const speed = 60 + this.phase * 18;
    this.vx = damp(this.vx, Math.cos(a) * speed + Math.cos(this.wobble) * 30, 4, dt);
    this.vy = damp(this.vy, Math.sin(a) * speed + Math.sin(this.wobble) * 30, 4, dt);
  }

  private decide(ctx: GameContext, d: number) {
    this.moveTime = 0;
    this.hitEmitted = false;
    this.telegraph = 0;
    // Weighted move choice by phase.
    const moves: Move[] = ["sweep", "thrust", "rain", "callig"];
    const weights = [d < 160 ? 3 : 1, d < 260 ? 2.5 : 0.6, 1.5, 1.2];
    if (this.phase >= 2) {
      moves.push("spiral", "summon");
      weights.push(1.6, 1.0);
    }
    if (this.phase >= 3) {
      // more spirals & rain in the final phase
      weights[2] += 1;
      weights[weights.length - 2] += 1.2;
    }
    let total = 0;
    for (const w of weights) total += w;
    let r = fx.next() * total;
    let chosen: Move = "sweep";
    for (let i = 0; i < moves.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosen = moves[i];
        break;
      }
    }
    this.move = chosen;
    this.aimAngle = angleTo(this.x, this.y, ctx.player.x, ctx.player.y);
  }

  private speedScale() {
    return this.phase === 1 ? 1 : this.phase === 2 ? 0.82 : 0.66; // windups shrink
  }

  // ---- Moves -------------------------------------------------------------
  private updateSweep(ctx: GameContext) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.7 * this.speedScale();
    this.telegraph = clamp(this.moveTime / windup, 0, 1);
    if (this.moveTime < windup) {
      // track player during windup, slowly.
      this.aimAngle = rotateTowards(this.aimAngle, angleTo(this.x, this.y, ctx.player.x, ctx.player.y), dt * 1.6);
      this.facing = this.aimAngle;
    } else {
      if (!this.hitEmitted) {
        // Big 270-degree brush sweep — live for a short active window.
        this.lungeHit = {
          x: this.x,
          y: this.y,
          radius: 170,
          angle: this.aimAngle,
          arc: 2.4,
          damage: 22 * this.dmgScale,
          knockback: 460,
          team: "enemy",
          id: hitId++,
          hitSet: new Set(),
        };
        this.hitEmitted = true;
        ctx.audio.swing(1.6);
        ctx.addScreenShake(0.4);
        this.vx += Math.cos(this.aimAngle) * 120;
        this.vy += Math.sin(this.aimAngle) * 120;
      }
      if (this.lungeHit && this.moveTime < windup + 0.16) {
        this.lungeHit.x = this.x;
        this.lungeHit.y = this.y;
        ctx.hits.push(this.lungeHit);
      }
    }
    if (this.moveTime > windup + 0.5) {
      this.lungeHit = null;
      this.endMove();
    }
  }

  private updateThrust(ctx: GameContext, toPlayer: number) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.55 * this.speedScale();
    this.telegraph = clamp(this.moveTime / windup, 0, 1);
    if (this.moveTime < windup) {
      this.aimAngle = rotateTowards(this.aimAngle, toPlayer, dt * 2.4);
      this.facing = this.aimAngle;
    } else if (this.moveTime < windup + 0.22) {
      // Lunge — the hitbox rides the boss for the whole dash, one shared hitSet.
      const speed = 900;
      this.vx = Math.cos(this.aimAngle) * speed;
      this.vy = Math.sin(this.aimAngle) * speed;
      if (!this.hitEmitted) {
        this.lungeHit = {
          x: this.x,
          y: this.y,
          radius: this.radius + 26,
          angle: this.aimAngle,
          arc: 0.7,
          damage: 20 * this.dmgScale,
          knockback: 520,
          team: "enemy",
          id: hitId++,
          hitSet: new Set(),
        };
        this.hitEmitted = true;
        ctx.audio.swing(1.3);
      }
      if (this.lungeHit) {
        this.lungeHit.x = this.x;
        this.lungeHit.y = this.y;
        ctx.hits.push(this.lungeHit);
      }
    } else {
      this.lungeHit = null;
    }
    if (this.moveTime > windup + 0.6) this.endMove();
  }

  private updateRain(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.5 * this.speedScale();
    this.telegraph = clamp(this.moveTime / windup, 0, 1);
    if (this.moveTime >= windup && !this.hitEmitted) {
      const shots = this.phase === 3 ? 20 : this.phase === 2 ? 14 : 10;
      for (let i = 0; i < shots; i++) {
        const a = (i / shots) * TAU + this.wobble;
        ctx.spawnEnemyProjectile(this.x, this.y, a, 260 + this.phase * 30, 8 * this.dmgScale);
      }
      // Aimed volley too.
      const aim = angleTo(this.x, this.y, p.x, p.y);
      for (let i = -1; i <= 1; i++) {
        ctx.spawnEnemyProjectile(this.x, this.y, aim + i * 0.18, 380, 9 * this.dmgScale);
      }
      ctx.audio.inkBurst();
      ctx.addScreenShake(0.3);
      this.hitEmitted = true;
    }
    if (this.moveTime > windup + 0.6) this.endMove();
  }

  private updateSpiral(ctx: GameContext) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.4 * this.speedScale();
    this.telegraph = clamp(this.moveTime / windup, 0, 1);
    if (this.moveTime >= windup) {
      // Continuous rotating emitter.
      const emitEvery = 0.06;
      this.spiralCount += dt;
      if (this.spiralCount >= emitEvery) {
        this.spiralCount = 0;
        const base = this.moveTime * (this.phase === 3 ? 5.2 : 3.6);
        const arms = this.phase === 3 ? 3 : 2;
        for (let i = 0; i < arms; i++) {
          const a = base + (i / arms) * TAU;
          ctx.spawnEnemyProjectile(this.x, this.y, a, 240, 7 * this.dmgScale);
        }
      }
    }
    if (this.moveTime > windup + (this.phase === 3 ? 2.6 : 2.0)) this.endMove();
  }

  private updateCallig(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.3;
    if (this.moveTime < windup) {
      this.telegraph = this.moveTime / windup;
    } else if (!this.hitEmitted) {
      // Paint N sigils: one under the player, others scattered.
      const n = this.phase === 3 ? 5 : this.phase === 2 ? 4 : 3;
      this.sigils.push({ x: p.x, y: p.y, r: 70, t: 0, detonated: false });
      for (let i = 1; i < n; i++) {
        this.sigils.push({
          x: p.x + fx.range(-220, 220),
          y: p.y + fx.range(-180, 180),
          r: fx.range(55, 90),
          t: 0,
          detonated: false,
        });
      }
      ctx.audio.swing(0.8);
      this.hitEmitted = true;
    }
    if (this.moveTime > windup + 0.4) this.endMove();
  }

  private updateSummon(ctx: GameContext) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.6;
    this.telegraph = clamp(this.moveTime / windup, 0, 1);
    if (this.moveTime >= windup && !this.hitEmitted) {
      const count = this.phase === 3 ? 3 : 2;
      for (let i = 0; i < count; i++) {
        const a = fx.angle();
        this.onSummon?.(this.x + Math.cos(a) * 120, this.y + Math.sin(a) * 120);
      }
      ctx.audio.inkBurst();
      ctx.particles.ring(this.x, this.y, 0.8, 140);
      this.hitEmitted = true;
    }
    if (this.moveTime > windup + 0.5) this.endMove();
  }

  private updateSigils(ctx: GameContext) {
    const dt = ctx.dt;
    const chargeSpeed = this.phase === 3 ? 1.1 : 0.8;
    for (const s of this.sigils) {
      if (s.detonated) continue;
      s.t += dt * chargeSpeed;
      if (s.t >= 1) {
        s.detonated = true;
        // Detonate: damage if player inside.
        const p = ctx.player;
        if (dist(s.x, s.y, p.x, p.y) < s.r) {
          p.hurt(18 * this.dmgScale, s.x, s.y, 300, ctx);
        }
        ctx.particles.ring(s.x, s.y, 0.9, s.r * 2, Palette.vermilion);
        for (let i = 0; i < 10; i++)
          ctx.particles.splatter(s.x, s.y, (i / 10) * TAU, 1.4, 0.9);
        ctx.audio.inkBurst();
        ctx.addScreenShake(0.2);
      }
    }
    this.sigils = this.sigils.filter((s) => !s.detonated || s.t < 1.15);
  }

  private endMove() {
    this.move = "idle";
    this.moveTime = 0;
    this.telegraph = 0;
    this.nextDecision = lerp(0.7, 0.25, (this.phase - 1) / 2) * fx.range(0.8, 1.3);
  }

  // ---- Draw --------------------------------------------------------------
  draw(ctx: CanvasRenderingContext2D, g: GameContext) {
    // Floor sigils.
    for (const s of this.sigils) this.drawSigil(ctx, s);

    // Shadow.
    inkWash(ctx, this.x, this.y + this.radius * 0.7, this.radius * 2.2, 0.55, 0.4);

    // Telegraph visuals per move.
    this.drawTelegraph(ctx);

    ctx.save();
    ctx.translate(this.x, this.y);
    const breathe = 1 + Math.sin(this.wobble * 1.5) * 0.03;
    ctx.scale(breathe, breathe);
    const tone = this.flash > 0 ? 0.4 : 0.95;

    // Flowing robe — several overlapping downward strokes.
    const sway = Math.sin(this.wobble) * 6;
    for (let i = -2; i <= 2; i++) {
      const off = i * this.radius * 0.5;
      brushStroke(
        ctx,
        off + sway * 0.3,
        -this.radius,
        off * 1.4 + sway,
        this.radius * 1.5,
        this.radius * 0.7,
        tone,
        0.2,
        i * 17 + 40
      );
    }
    // Broad shoulders / mantle.
    brushStroke(ctx, -this.radius * 1.2, -this.radius * 0.4, this.radius * 1.2, -this.radius * 0.4, this.radius * 0.7, tone, 0.2, 71);

    // Head — hooded.
    inkBlob(ctx, 0, -this.radius * 1.1, this.radius * 0.5, tone, 0.25, 14, this.wobble);

    // Long brush-weapon held to the side, angled toward facing.
    ctx.save();
    ctx.rotate(this.facing);
    brushStroke(ctx, 10, 0, 90, 0, 8, 0.9, 0.15);
    inkBlob(ctx, 92, 0, 7, 0.95, 0.4, 10, this.wobble);
    ctx.restore();

    // Phase eyes — burn brighter each phase.
    ctx.fillStyle = Palette.vermilion;
    const eyeGlow = 2 + this.phase;
    ctx.globalAlpha = 0.6 + 0.13 * this.phase;
    ctx.beginPath();
    ctx.arc(-6, -this.radius * 1.1, eyeGlow, 0, TAU);
    ctx.arc(6, -this.radius * 1.1, eyeGlow, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.restore();

    if (this.flash > 0.4) {
      ctx.globalAlpha = (this.flash - 0.4) * 0.5;
      inkBlob(ctx, this.x, this.y, this.radius + 5, 0.2, 0.2, 14, this.wobble);
      ctx.globalAlpha = 1;
    }
  }

  private drawTelegraph(ctx: CanvasRenderingContext2D) {
    if (this.telegraph <= 0) return;
    const t = this.telegraph;
    ctx.globalAlpha = 0.3 + t * 0.4;
    if (this.move === "sweep") {
      slashArc(ctx, this.x, this.y, 150, this.aimAngle - 1.2, 2.4, 8 + t * 20, lerp(0.6, 1, t), 0.5);
    } else if (this.move === "thrust") {
      ctx.strokeStyle = Palette.vermilionSoft;
      ctx.lineWidth = 3 + t * 6;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + Math.cos(this.aimAngle) * 300, this.y + Math.sin(this.aimAngle) * 300);
      ctx.stroke();
    } else if (this.move === "rain" || this.move === "spiral" || this.move === "summon") {
      ctx.strokeStyle = Palette.vermilionSoft;
      ctx.lineWidth = 2 + t * 3;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius + 10 + t * 20, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawSigil(ctx: CanvasRenderingContext2D, s: Sigil) {
    const t = clamp(s.t, 0, 1);
    ctx.save();
    ctx.translate(s.x, s.y);
    // Charging ring fills with vermilion.
    ctx.globalAlpha = 0.25 + t * 0.4;
    ctx.strokeStyle = Palette.vermilion;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, s.r, 0, TAU);
    ctx.stroke();
    // Inner calligraphic mark.
    ctx.globalAlpha = 0.3 + t * 0.5;
    ctx.rotate(this.wobble * 0.5);
    brushStroke(ctx, -s.r * 0.4, -s.r * 0.4, s.r * 0.4, s.r * 0.4, 5, 0.9, 0.2);
    brushStroke(ctx, s.r * 0.4, -s.r * 0.4, -s.r * 0.4, s.r * 0.4, 5, 0.9, 0.2);
    // Fill arc showing charge.
    ctx.globalAlpha = 0.15 + t * 0.35;
    ctx.fillStyle = Palette.vermilionSoft;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, s.r, -Math.PI / 2, -Math.PI / 2 + t * TAU);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
