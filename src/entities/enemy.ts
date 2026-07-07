import { angleTo, clamp, damp, dist, lerp, rotateTowards, TAU } from "../core/math";
import { fx } from "../core/rng";
import { brushStroke, inkBlob, inkComma, inkWash, slashArc } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { Actor, GameContext, HitInfo } from "../game/types";

export type EnemyKind = "wisp" | "archer" | "charger" | "brute" | "lancer" | "bomber" | "shade";

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
    attackWindup: 0.47,
    attackDamage: 10,
    attackCooldown: 1.26,
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
    attackWindup: 0.66,
    attackDamage: 16,
    attackCooldown: 2.16,
    color: 0.85,
    score: 2,
  },
  brute: {
    hp: 90,
    radius: 24,
    speed: 66,
    contactDamage: 0,
    attackRange: 74,
    attackWindup: 0.7,
    attackDamage: 20,
    attackCooldown: 1.8,
    color: 0.95,
    score: 3,
  },
  // Polearm skirmisher: hangs at range then stabs a long, narrow line — punish
  // by sidestepping rather than backing straight up.
  lancer: {
    hp: 44,
    radius: 16,
    speed: 92,
    contactDamage: 0,
    attackRange: 172,
    attackWindup: 0.52,
    attackDamage: 16,
    attackCooldown: 1.8,
    color: 0.8,
    score: 2,
  },
  // Drifting lantern-bomb: rushes in and self-detonates in a radial blast.
  bomber: {
    hp: 26,
    radius: 15,
    speed: 108,
    contactDamage: 0,
    attackRange: 72,
    attackWindup: 0.62,
    attackDamage: 26,
    attackCooldown: 999,
    color: 0.7,
    score: 2,
  },
  // Blink assassin: teleports to a flank then delivers a quick short slash.
  shade: {
    hp: 30,
    radius: 13,
    speed: 122,
    contactDamage: 0,
    attackRange: 60,
    attackWindup: 0.26,
    attackDamage: 12,
    attackCooldown: 1.44,
    color: 0.5,
    score: 2,
  },
};

type AIState =
  | "spawn"
  | "approach"
  | "windup"
  | "attack"
  | "recover"
  | "charge"
  | "stagger"
  | "explode"
  | "blink";

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
  private blinkX = 0;
  private blinkY = 0;
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

    // Shades often blink away when struck (then re-engage from a new angle).
    if (this.kind === "shade" && this.hp > 0 && this.ai !== "blink" && fx.bool(0.55)) {
      this.startBlink(ctx.player);
    }

    if (this.hp <= 0) {
      this.die(ctx);
    }
    return true;
  }

  private startBlink(p: Actor) {
    this.ai = "blink";
    this.stateTime = 0;
    this.hitEmitted = false; // reused as "teleported yet?" flag during the blink
    const ang = fx.range(0, TAU);
    const r = fx.range(80, 130);
    this.blinkX = clamp(p.x + Math.cos(ang) * r, -380, 380);
    this.blinkY = clamp(p.y + Math.sin(ang) * r, -280, 280);
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

      case "explode":
        this.updateExplode(ctx);
        break;

      case "blink":
        this.updateBlink(ctx, p);
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
      } else if (this.kind === "shade" && d < 320) {
        this.startBlink(p);
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
      this.ai = "charge";
      this.chargeDir = this.windupAngle;
      ctx.audio.swing(1.1);
    } else if (this.kind === "bomber") {
      this.ai = "explode";
      ctx.audio.swing(0.9);
    } else {
      // Melee: wisp, brute, lancer, shade.
      this.ai = "attack";
      ctx.audio.swing(this.kind === "lancer" ? 1.2 : 1);
    }
  }

  private updateAttack(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.stateTime += dt;
    // Per-kind shape: the lancer stabs a long narrow line; the shade darts a
    // quick short slash; wisp/brute swing a wider cone.
    const lancer = this.kind === "lancer";
    const shade = this.kind === "shade";
    const arc = lancer ? 0.34 : shade ? 0.7 : 0.9;
    const reach = this.arch.attackRange;
    const lunge = lancer ? 360 : shade ? 150 : 180;
    const activeEnd = shade ? 0.14 : 0.18;
    if (!this.hitEmitted && this.stateTime > 0.04) {
      this.activeHit = {
        x: this.x + Math.cos(this.windupAngle) * reach * 0.5,
        y: this.y + Math.sin(this.windupAngle) * reach * 0.5,
        radius: reach,
        angle: this.windupAngle,
        arc,
        damage: this.arch.attackDamage * this.dmgScale,
        knockback: 240,
        team: "enemy",
        id: hitIdCounter++,
        hitSet: new Set(),
      };
      this.hitEmitted = true;
      // Lunge into the strike.
      this.vx += Math.cos(this.windupAngle) * lunge;
      this.vy += Math.sin(this.windupAngle) * lunge;
    }
    if (this.activeHit && this.stateTime > 0.04 && this.stateTime < activeEnd) {
      this.activeHit.x = this.x + Math.cos(this.windupAngle) * reach * 0.5;
      this.activeHit.y = this.y + Math.sin(this.windupAngle) * reach * 0.5;
      ctx.hits.push(this.activeHit);
    }
    if (this.stateTime > activeEnd + 0.04) {
      this.ai = "recover";
      this.stateTime = 0;
      this.activeHit = null;
    }
  }

  private updateExplode(ctx: GameContext) {
    const dt = ctx.dt;
    this.stateTime += dt;
    this.vx = damp(this.vx, 0, 12, dt);
    this.vy = damp(this.vy, 0, 12, dt);
    if (!this.hitEmitted && this.stateTime > 0.02) {
      this.hitEmitted = true;
      const blast: HitInfo = {
        x: this.x,
        y: this.y,
        radius: 98,
        angle: 0,
        arc: Math.PI, // full circle
        damage: this.arch.attackDamage * this.dmgScale,
        knockback: 440,
        team: "enemy",
        id: hitIdCounter++,
        hitSet: new Set(),
      };
      ctx.hits.push(blast);
      ctx.particles.ring(this.x, this.y, 0.9, 210, Palette.vermilion);
      for (let i = 0; i < 18; i++)
        ctx.particles.splatter(this.x, this.y, (i / 18) * TAU, 1.9, 0.85);
      ctx.audio.inkBurst();
      ctx.addScreenShake(0.35);
      // The lantern is consumed by its own blast.
      this.die(ctx);
    }
  }

  private updateBlink(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.stateTime += dt;
    this.vx = damp(this.vx, 0, 14, dt);
    this.vy = damp(this.vy, 0, 14, dt);
    // Vanish, reappear at the flank at the midpoint of the blink.
    if (!this.hitEmitted && this.stateTime >= 0.09) {
      this.hitEmitted = true;
      ctx.particles.ring(this.x, this.y, 0.5, 70, Palette.indigo);
      this.x = this.blinkX;
      this.y = this.blinkY;
      ctx.particles.ring(this.x, this.y, 0.6, 70, Palette.indigo);
      for (let i = 0; i < 8; i++)
        ctx.particles.splatter(this.x, this.y, (i / 8) * TAU, 0.9, 0.5);
      this.spawnAnim = 0.5;
    }
    if (this.stateTime >= 0.2) {
      // Emerge into a quick slash toward the player's new bearing.
      this.ai = "windup";
      this.stateTime = 0;
      this.windupAngle = angleTo(this.x, this.y, p.x, p.y);
      this.facing = this.windupAngle;
      this.hitEmitted = false;
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
      } else if (this.kind === "lancer") {
        // Thin thrust line — telegraphs the narrow stab lane.
        ctx.fillStyle = Palette.vermilionSoft;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.windupAngle);
        const th = 3 + tele * 7;
        ctx.fillRect(this.radius, -th / 2, this.arch.attackRange, th);
        ctx.restore();
      } else if (this.kind === "bomber") {
        // Swelling blast circle warns of the detonation radius.
        ctx.fillStyle = Palette.vermilionSoft;
        ctx.beginPath();
        ctx.arc(this.x, this.y, 12 + tele * 96, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = Palette.vermilion;
        ctx.lineWidth = 2;
        ctx.stroke();
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
      case "lancer":
        this.drawLancer(ctx, tone);
        break;
      case "bomber":
        this.drawBomber(ctx, tone);
        break;
      case "shade":
        this.drawShade(ctx, tone);
        break;
    }
    ctx.restore();

    // Active melee slash visual.
    if (this.ai === "attack" && this.stateTime < 0.2 && this.kind !== "archer") {
      const fade = clamp(1 - this.stateTime / 0.2, 0, 1);
      if (this.kind === "lancer") {
        // A thin driven line for the thrust.
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.windupAngle);
        ctx.globalAlpha = fade;
        ctx.fillStyle = inkTone(0.9, 1);
        ctx.fillRect(this.radius, -3, this.arch.attackRange, 6);
        ctx.globalAlpha = 1;
        ctx.restore();
      } else {
        slashArc(
          ctx,
          this.x,
          this.y,
          this.arch.attackRange * (this.kind === "shade" ? 0.5 : 0.6),
          this.windupAngle - 0.8,
          this.kind === "shade" ? 1.1 : 1.6,
          10,
          0.9,
          fade
        );
      }
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

  private drawLancer(ctx: CanvasRenderingContext2D, tone: number) {
    // Lean figure shouldering a long polearm aimed along its facing.
    brushStroke(ctx, 0, -this.radius, 0, this.radius, this.radius, tone, 0.2, this.bodySeed);
    inkBlob(ctx, 0, -this.radius - 2, 5, tone, 0.2, 10, 3);
    ctx.save();
    ctx.rotate(this.facing);
    ctx.strokeStyle = inkTone(tone, 1);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-this.radius * 0.6, 0);
    ctx.lineTo(this.arch.attackRange * 0.44, 0);
    ctx.stroke();
    inkComma(ctx, this.arch.attackRange * 0.44, 0, 8, 0.2, tone);
    ctx.restore();
    ctx.fillStyle = Palette.vermilion;
    ctx.beginPath();
    ctx.arc(0, -this.radius * 0.4, 1.8, 0, TAU);
    ctx.fill();
  }

  private drawBomber(ctx: CanvasRenderingContext2D, tone: number) {
    // Paper lantern with a hot, pulsing core; the glow swells as it winds up.
    const pulse =
      this.ai === "windup" ? this.telegraph() : 0.4 + Math.sin(this.wobble * 3) * 0.2;
    inkWash(ctx, 0, 0, this.radius * 1.9, 0.3, 0.25 + pulse * 0.45);
    inkBlob(ctx, 0, 0, this.radius, tone, 0.18, 14, this.bodySeed);
    ctx.strokeStyle = inkTone(0.9, 0.5);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(0, 0, this.radius * 0.5, this.radius, 0, 0, TAU);
    ctx.stroke();
    // Top cap + fuse.
    ctx.strokeStyle = inkTone(tone, 1);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -this.radius);
    ctx.quadraticCurveTo(4, -this.radius - 8, 8, -this.radius - 6);
    ctx.stroke();
    // Glowing core.
    ctx.globalAlpha = 0.5 + pulse * 0.5;
    ctx.fillStyle = Palette.vermilion;
    ctx.beginPath();
    ctx.arc(0, 0, 3 + pulse * 4, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawShade(ctx: CanvasRenderingContext2D, tone: number) {
    // Tall, wispy silhouette that fades out and back during a blink.
    let alpha = 0.85;
    if (this.ai === "blink") {
      const t = this.stateTime;
      alpha =
        t < 0.09
          ? lerp(0.85, 0.1, t / 0.09)
          : lerp(0.1, 0.85, clamp((t - 0.09) / 0.11, 0, 1));
    }
    ctx.globalAlpha = alpha;
    const sway = Math.sin(this.wobble * 1.5) * 3;
    brushStroke(ctx, sway * 0.5, -this.radius * 1.2, -sway * 0.5, this.radius, this.radius * 0.9, tone, 0.35, this.bodySeed);
    inkBlob(ctx, 0, -this.radius * 0.9, this.radius * 0.5, tone, 0.3, 12, this.wobble);
    for (let i = 0; i < 3; i++)
      inkBlob(ctx, Math.sin(this.wobble + i) * 5, this.radius * 0.3 + i * 4, (3 - i) * 2, tone * 0.9, 0.4, 8, i + this.wobble);
    ctx.fillStyle = Palette.indigo;
    ctx.beginPath();
    ctx.arc(-3, -this.radius * 0.9, 1.6, 0, TAU);
    ctx.arc(3, -this.radius * 0.9, 1.6, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export function enemyScore(kind: EnemyKind): number {
  return ARCHETYPES[kind].score;
}
