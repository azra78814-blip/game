import { angleTo, clamp, damp, dist, lerp, rotateTowards, TAU } from "../core/math";
import { fx } from "../core/rng";
import { brushStroke, inkBlob, inkComma, inkWash, slashArc } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { Actor, GameContext, HitInfo } from "../game/types";

export type EnemyKind = "wisp" | "archer" | "charger" | "brute";

let hitIdCounter = 100000;

// Telegraphed attacks are the core of the "test skill not stats" design: every
// attack has a clearly readable wind-up (colour + growing arc) before it hits,
// giving the player a fair window to dodge or parry.

interface Archetype {
  hp: number;
  radius: number;
  speed: number;
  contactDamage: number;
  attackRange: number;
  attackWindup: number;
  attackDamage: number;
  attackCooldown: number;
  color: number;
  score: number;
}

const ARCHETYPES: Record<EnemyKind, Archetype> = {
  wisp: {
    hp: 30,
    radius: 14,
    speed: 118,
    contactDamage: 0,
    attackRange: 52,
    attackWindup: 0.5,
    attackDamage: 10,
    attackCooldown: 1.4,
    color: 0.75,
    score: 1,
  },
  archer: {
    hp: 22,
    radius: 13,
    speed: 78,
    contactDamage: 0,
    attackRange: 320,
    attackWindup: 0.85,
    attackDamage: 9,
    attackCooldown: 1.9,
    color: 0.6,
    score: 1,
  },
  charger: {
    hp: 46,
    radius: 17,
    speed: 96,
    contactDamage: 8,
    attackRange: 240,
    attackWindup: 0.7,
    attackDamage: 16,
    attackCooldown: 2.4,
    color: 0.85,
    score: 2,
  },
  brute: {
    hp: 90,
    radius: 24,
    speed: 66,
    contactDamage: 0,
    attackRange: 74,
    attackWindup: 0.75,
    attackDamage: 20,
    attackCooldown: 2.0,
    color: 0.95,
    score: 3,
  },
};

type AIState = "spawn" | "approach" | "windup" | "attack" | "recover" | "charge" | "stagger";

export class Enemy implements Actor {
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  dead = false;
  team = "enemy" as const;
  kind: EnemyKind;
  arch: Archetype;

  private vx = 0;
  private vy = 0;
  facing = 0;
  private ai: AIState = "spawn";
  private stateTime = 0;
  private cooldown = 0;
  private spawnAnim = 0;
  private flash = 0;
  private staggerTime = 0;
  private wobble = fx.range(0, TAU);
  private bodySeed = fx.range(0, 1000);
  private chargeDir = 0;
  private hitEmitted = false;
  private windupAngle = 0;
  private hpScale: number;
  private activeHit: HitInfo | null = null;
  private bleedDps = 0;
  private bleedTime = 0;
  private bleedTick = 0;

  applyBleed(dps: number, duration: number) {
    // Refresh duration, stack intensity (with a sane cap).
    this.bleedDps = Math.min(this.bleedDps + dps, dps * 5 + 40);
    this.bleedTime = Math.max(this.bleedTime, duration);
  }

  constructor(kind: EnemyKind, x: number, y: number, hpScale = 1, dmgScale = 1) {
    this.kind = kind;
    this.arch = ARCHETYPES[kind];
    this.x = x;
    this.y = y;
    this.radius = this.arch.radius;
    this.hpScale = hpScale;
    this.maxHp = this.arch.hp * hpScale;
    this.hp = this.maxHp;
    this.spawnAnim = 1;
    this.dmgScale = dmgScale;
  }
  private dmgScale: number;

  hurt(amount: number, fromX: number, fromY: number, knockback: number, ctx: GameContext): boolean {
    if (this.dead) return false;
    this.hp -= amount;
    this.flash = 1;
    const a = angleTo(fromX, fromY, this.x, this.y);
    this.vx += Math.cos(a) * knockback;
    this.vy += Math.sin(a) * knockback;
    ctx.audio.hit(clamp(amount / 20, 0.5, 1.6), lerp(1.3, 0.7, this.radius / 24));
    ctx.particles.splatter(this.x, this.y, a, clamp(amount / 14, 0.6, 2), this.arch.color);
    ctx.hitstop(amount > 25 ? 60 : 34);
    ctx.addScreenShake(clamp(amount / 60, 0.08, 0.3));

    // Interrupt wind-ups on solid hits (stagger).
    if ((this.ai === "windup" || this.ai === "approach") && amount > 14) {
      this.ai = "stagger";
      this.staggerTime = 0.32;
    }

    if (this.hp <= 0) {
      this.die(ctx);
    }
    return true;
  }

  private die(ctx: GameContext) {
    this.dead = true;
    // Big ink burst + lingering stain.
    ctx.particles.splatter(this.x, this.y, fx.angle(), 2.2, this.arch.color);
    ctx.particles.bloom(this.x, this.y, this.radius * 1.6, 0.7);
    ctx.particles.ring(this.x, this.y, 0.8, this.radius * 3);
    ctx.audio.hit(1.4, 0.6);
    ctx.addScreenShake(0.25);
    ctx.onEnemyKilled(this.x, this.y);
  }

  update(ctx: GameContext) {
    const dt = ctx.dt;
    if (this.dead) return;
    const p = ctx.player;
    this.flash = Math.max(0, this.flash - dt * 4);
    this.spawnAnim = Math.max(0, this.spawnAnim - dt * 2);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.wobble += dt * 3;

    // Bleed damage-over-time: drips ink and chips HP without knockback/flash.
    if (this.bleedTime > 0) {
      this.bleedTime -= dt;
      this.bleedTick -= dt;
      this.hp -= this.bleedDps * dt;
      if (this.bleedTick <= 0) {
        this.bleedTick = 0.2;
        ctx.particles.bloom(this.x + fx.range(-6, 6), this.y + fx.range(0, 8), fx.range(2, 4), 0.75);
      }
      if (this.bleedTime <= 0) this.bleedDps = 0;
      if (this.hp <= 0 && !this.dead) this.die(ctx);
    }

    const d = dist(this.x, this.y, p.x, p.y);
    const toPlayer = angleTo(this.x, this.y, p.x, p.y);

    if (this.ai !== "charge" && this.ai !== "attack") {
      this.facing = rotateTowards(this.facing, toPlayer, dt * 6);
    }

    switch (this.ai) {
      case "spawn":
        this.stateTime += dt;
        if (this.stateTime > 0.35) {
          this.ai = "approach";
          this.stateTime = 0;
        }
        break;

      case "approach":
        this.approach(ctx, d, toPlayer, p);
        break;

      case "windup":
        this.stateTime += dt;
        // Brace: slow, telegraph grows.
        this.vx = damp(this.vx, 0, 10, dt);
        this.vy = damp(this.vy, 0, 10, dt);
        if (this.kind !== "archer" && this.kind !== "charger") {
          this.windupAngle = toPlayer; // melee tracks a bit
          this.facing = rotateTowards(this.facing, toPlayer, dt * 2.2);
        }
        if (this.stateTime >= this.arch.attackWindup) {
          this.doAttack(ctx, p);
        }
        break;

      case "attack":
        this.updateAttack(ctx, p);
        break;

      case "charge":
        this.updateCharge(ctx, p);
        break;

      case "recover":
        this.stateTime += dt;
        this.vx = damp(this.vx, 0, 8, dt);
        this.vy = damp(this.vy, 0, 8, dt);
        if (this.stateTime > 0.35) {
          this.ai = "approach";
          this.stateTime = 0;
          this.cooldown = this.arch.attackCooldown * fx.range(0.8, 1.2);
        }
        break;

      case "stagger":
        this.staggerTime -= dt;
        this.vx = damp(this.vx, 0, 6, dt);
        this.vy = damp(this.vy, 0, 6, dt);
        if (this.staggerTime <= 0) {
          this.ai = "approach";
          this.stateTime = 0;
        }
        break;
    }

    // Contact damage for chargers/brutes.
    if (this.arch.contactDamage > 0 && d < this.radius + p.radius && this.ai === "charge") {
      p.hurt(this.arch.contactDamage * this.dmgScale, this.x, this.y, 260, ctx);
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= 0.9;
    this.vy *= 0.9;
  }

  private approach(ctx: GameContext, d: number, toPlayer: number, p: Actor) {
    const dt = ctx.dt;
    // Separation: gentle avoidance so they don't stack perfectly.
    let sx = 0;
    let sy = 0;
    for (const a of ctx.actors) {
      if (a === this || a.team !== "enemy" || a.dead) continue;
      const dd = dist(this.x, this.y, a.x, a.y);
      if (dd < this.radius * 2.2 && dd > 0.01) {
        sx += (this.x - a.x) / dd;
        sy += (this.y - a.y) / dd;
      }
    }

    const desiredRange =
      this.kind === "archer" ? this.arch.attackRange * 0.7 : this.arch.attackRange * 0.6;

    let moveAngle = toPlayer;
    let speed = this.arch.speed;
    if (this.kind === "archer") {
      // Kite: keep distance, strafe.
      if (d < desiredRange * 0.8) moveAngle = toPlayer + Math.PI; // back off
      else if (d > this.arch.attackRange) moveAngle = toPlayer;
      else moveAngle = toPlayer + Math.PI / 2 * Math.sin(this.wobble * 0.5); // strafe
    } else {
      // Slight weave so melee approach isn't a straight line.
      moveAngle = toPlayer + Math.sin(this.wobble) * 0.3;
    }

    const tvx = Math.cos(moveAngle) * speed + sx * 60;
    const tvy = Math.sin(moveAngle) * speed + sy * 60;
    this.vx = damp(this.vx, tvx, 8, dt);
    this.vy = damp(this.vy, tvy, 8, dt);

    // Decide to attack.
    if (this.cooldown <= 0) {
      if (this.kind === "charger" && d < this.arch.attackRange && d > 60) {
        this.startCharge(toPlayer);
      } else if (d <= this.arch.attackRange * (this.kind === "archer" ? 1 : 0.85)) {
        this.ai = "windup";
        this.stateTime = 0;
        this.windupAngle = toPlayer;
        this.hitEmitted = false;
      }
    }
  }

  private startCharge(toPlayer: number) {
    this.ai = "windup";
    this.stateTime = 0;
    this.windupAngle = toPlayer;
    this.chargeDir = toPlayer;
    this.hitEmitted = false;
    // charger's windup then transitions to charge in doAttack.
  }

  private doAttack(ctx: GameContext, p: Actor) {
    this.ai = this.kind === "charger" ? "charge" : "attack";
    this.stateTime = 0;
    this.hitEmitted = false;
    if (this.kind === "archer") {
      // Fire a projectile toward the telegraphed angle.
      ctx.spawnEnemyProjectile(
        this.x,
        this.y,
        this.windupAngle,
        360,
        this.arch.attackDamage * this.dmgScale
      );
      ctx.audio.swing(0.7);
      this.ai = "recover";
    } else if (this.kind === "charger") {
      this.chargeDir = this.windupAngle;
      ctx.audio.swing(1.1);
    } else {
      ctx.audio.swing(1);
    }
  }

  private updateAttack(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.stateTime += dt;
    // Melee slash: spin up a cone hit and keep it live through the swing.
    if (!this.hitEmitted && this.stateTime > 0.04) {
      this.activeHit = {
        x: this.x + Math.cos(this.windupAngle) * this.arch.attackRange * 0.5,
        y: this.y + Math.sin(this.windupAngle) * this.arch.attackRange * 0.5,
        radius: this.arch.attackRange,
        angle: this.windupAngle,
        arc: 0.9,
        damage: this.arch.attackDamage * this.dmgScale,
        knockback: 240,
        team: "enemy",
        id: hitIdCounter++,
        hitSet: new Set(),
      };
      this.hitEmitted = true;
      // Lunge into the strike.
      this.vx += Math.cos(this.windupAngle) * 180;
      this.vy += Math.sin(this.windupAngle) * 180;
    }
    if (this.activeHit && this.stateTime > 0.04 && this.stateTime < 0.18) {
      this.activeHit.x = this.x + Math.cos(this.windupAngle) * this.arch.attackRange * 0.5;
      this.activeHit.y = this.y + Math.sin(this.windupAngle) * this.arch.attackRange * 0.5;
      ctx.hits.push(this.activeHit);
    }
    if (this.stateTime > 0.22) {
      this.ai = "recover";
      this.stateTime = 0;
      this.activeHit = null;
    }
  }

  private updateCharge(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.stateTime += dt;
    const speed = 620;
    this.vx = Math.cos(this.chargeDir) * speed;
    this.vy = Math.sin(this.chargeDir) * speed;
    // trail
    if (fx.bool(0.7)) ctx.particles.bloom(this.x, this.y, this.radius * 0.8, 0.5);
    if (this.stateTime > 0.42) {
      this.ai = "recover";
      this.stateTime = 0;
    }
  }

  /** Telegraph strength 0..1 for rendering. */
  private telegraph(): number {
    if (this.ai === "windup") return clamp(this.stateTime / this.arch.attackWindup, 0, 1);
    return 0;
  }

  draw(ctx: CanvasRenderingContext2D, g: GameContext) {
    const tele = this.telegraph();
    // Shadow.
    inkWash(ctx, this.x, this.y + this.radius * 0.7, this.radius * 1.5, 0.5, 0.3);

    // Telegraph arc — grows and reddens as attack nears.
    if (tele > 0) {
      const col = lerp(0.6, 1, tele);
      ctx.globalAlpha = 0.25 + tele * 0.5;
      if (this.kind === "archer") {
        // Aim line.
        ctx.strokeStyle = Palette.vermilionSoft;
        ctx.lineWidth = 1 + tele * 2;
        ctx.setLineDash([6, 8]);
        ctx.beginPath();
        ctx.moveTo(this.x, this.y);
        ctx.lineTo(
          this.x + Math.cos(this.windupAngle) * this.arch.attackRange,
          this.y + Math.sin(this.windupAngle) * this.arch.attackRange
        );
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (this.kind === "charger") {
        // Charge lane.
        ctx.fillStyle = Palette.vermilionSoft;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.windupAngle);
        ctx.fillRect(0, -this.radius * tele, this.arch.attackRange, this.radius * 2 * tele);
        ctx.restore();
      } else {
        // Melee cone.
        slashArc(
          ctx,
          this.x,
          this.y,
          this.arch.attackRange * 0.7,
          this.windupAngle - 0.9,
          1.8,
          6 + tele * 10,
          col,
          0.5
        );
      }
      ctx.globalAlpha = 1;
    }

    // Body — an ink silhouette per kind.
    ctx.save();
    ctx.translate(this.x, this.y);
    const spawnScale = 1 - this.spawnAnim * 0.6;
    ctx.scale(spawnScale, spawnScale);
    const tone = this.flash > 0 ? 0.35 : this.arch.color;

    switch (this.kind) {
      case "wisp":
        this.drawWisp(ctx, tone);
        break;
      case "archer":
        this.drawArcher(ctx, tone);
        break;
      case "charger":
        this.drawCharger(ctx, tone);
        break;
      case "brute":
        this.drawBrute(ctx, tone);
        break;
    }
    ctx.restore();

    // Active melee slash visual.
    if (this.ai === "attack" && this.stateTime < 0.2 && this.kind !== "archer") {
      slashArc(
        ctx,
        this.x,
        this.y,
        this.arch.attackRange * 0.6,
        this.windupAngle - 0.8,
        1.6,
        10,
        0.9,
        clamp(1 - this.stateTime / 0.2, 0, 1)
      );
    }

    // HP pip (thin ink bar) when damaged.
    if (this.hp < this.maxHp && !this.dead) {
      const w = this.radius * 2;
      const frac = clamp(this.hp / this.maxHp, 0, 1);
      ctx.fillStyle = Palette.ink30;
      ctx.fillRect(this.x - w / 2, this.y - this.radius - 12, w, 3);
      ctx.fillStyle = Palette.vermilion;
      ctx.fillRect(this.x - w / 2, this.y - this.radius - 12, w * frac, 3);
    }

    // Flash halo on hurt.
    if (this.flash > 0.4) {
      ctx.globalAlpha = (this.flash - 0.4) * 0.6;
      inkBlob(ctx, this.x, this.y, this.radius + 3, 0.2, 0.2, 12, this.wobble);
      ctx.globalAlpha = 1;
    }
  }

  private drawWisp(ctx: CanvasRenderingContext2D, tone: number) {
    // Floating spectre — a wavering vertical stroke with two ember eyes.
    const sway = Math.sin(this.wobble) * 3;
    brushStroke(ctx, sway, -this.radius, -sway, this.radius, this.radius * 1.5, tone, 0.4, this.bodySeed);
    inkBlob(ctx, 0, -this.radius * 0.6, this.radius * 0.7, tone, 0.35, 12, this.wobble);
    // wispy tail
    for (let i = 0; i < 3; i++) {
      const t = i / 3;
      inkBlob(ctx, Math.sin(this.wobble + i) * 4, this.radius * 0.4 + i * 5, (1 - t) * 5, tone * 0.8, 0.4, 8, i + this.wobble);
    }
    // eyes
    ctx.fillStyle = Palette.vermilion;
    ctx.beginPath();
    ctx.arc(-3, -this.radius * 0.6, 1.6, 0, TAU);
    ctx.arc(3, -this.radius * 0.6, 1.6, 0, TAU);
    ctx.fill();
  }

  private drawArcher(ctx: CanvasRenderingContext2D, tone: number) {
    // Lean archer figure with a drawn bow (comma stroke).
    brushStroke(ctx, 0, -this.radius, 0, this.radius, this.radius * 1.1, tone, 0.2, this.bodySeed);
    inkBlob(ctx, 0, -this.radius - 2, 5, tone, 0.2, 10, 2);
    ctx.save();
    ctx.rotate(this.facing);
    ctx.strokeStyle = inkTone(tone, 1);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(6, 0, this.radius * 0.9, -1.1, 1.1);
    ctx.stroke();
    ctx.restore();
  }

  private drawCharger(ctx: CanvasRenderingContext2D, tone: number) {
    // Hunched, forward-leaning brute-let with horns.
    ctx.save();
    ctx.rotate(this.facing * 0.15);
    inkBlob(ctx, 0, 0, this.radius, tone, 0.3, 14, this.bodySeed);
    brushStroke(ctx, -this.radius * 0.6, -this.radius * 0.5, this.radius * 0.9, -this.radius, 6, tone, 0.3, this.bodySeed);
    inkComma(ctx, -this.radius * 0.5, -this.radius * 0.7, 6, -0.6, tone);
    inkComma(ctx, this.radius * 0.5, -this.radius * 0.7, 6, 0.6 + Math.PI, tone);
    ctx.restore();
    ctx.fillStyle = Palette.vermilion;
    ctx.beginPath();
    ctx.arc(0, -2, 2, 0, TAU);
    ctx.fill();
  }

  private drawBrute(ctx: CanvasRenderingContext2D, tone: number) {
    inkBlob(ctx, 0, 0, this.radius, tone, 0.25, 16, this.bodySeed);
    inkBlob(ctx, 0, -this.radius * 0.9, this.radius * 0.55, tone, 0.3, 12, this.bodySeed + 2);
    // heavy arms
    brushStroke(ctx, -this.radius, -4, -this.radius * 1.5, this.radius * 0.6, 9, tone, 0.3, this.bodySeed);
    brushStroke(ctx, this.radius, -4, this.radius * 1.5, this.radius * 0.6, 9, tone, 0.3, this.bodySeed + 5);
    ctx.fillStyle = Palette.vermilion;
    ctx.beginPath();
    ctx.arc(-5, -this.radius * 0.9, 2, 0, TAU);
    ctx.arc(5, -this.radius * 0.9, 2, 0, TAU);
    ctx.fill();
  }
}

export function enemyScore(kind: EnemyKind): number {
  return ARCHETYPES[kind].score;
}
