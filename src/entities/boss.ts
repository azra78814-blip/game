import { angleTo, clamp, damp, dist, lerp, rotateTowards, TAU } from "../core/math";
import { fx } from "../core/rng";
import { brushStroke, inkBlob, inkWash, slashArc } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { Actor, GameContext, HitInfo } from "../game/types";

// "The Drowned Calligrapher" — a three-phase boss. Each phase adds a mechanic
// and speeds up. Every attack is telegraphed; the fight rewards reading tells,
// spacing, and punishing recovery windows rather than trading stats.

type Phase = 1 | 2 | 3;
export type BossVariant = "calligrapher" | "oni";
type Move =
  | "idle"
  | "sweep" // wide brush slash, dodge through or around
  | "thrust" // fast lunge stab, sidestep
  | "rain" // ink bolts from above, keep moving
  | "spiral" // rotating bullet spiral, weave outward
  | "callig" // draws a damaging sigil on the floor, telegraph then detonate
  | "summon" // spawns wisps (phase 2+)
  | "shockwave" // oni: slam emits expanding rings to outrun/dash through
  | "orbitals" // oni: orbs circle then launch at the player
  | "geyser" // oni: line of erupting pillars stepping toward the player
  | "transition";

let hitId = 500000;

interface Sigil {
  x: number;
  y: number;
  r: number;
  t: number; // charge 0..1
  detonated: boolean;
  pillar?: boolean; // draw as an erupting vertical geyser instead of a ring
}

interface Wave {
  r: number; // current radius
  t: number; // lifetime accumulator
  hitSet: Set<unknown>; // players already hit (only ever the one player)
}

interface Orbital {
  angle: number;
  launched: boolean;
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
  readonly variant: BossVariant;
  private waves: Wave[] = [];
  private orbitals: Orbital[] = [];
  private orbitAngle = 0;

  applyBleed(dps: number, duration: number) {
    this.bleedDps = Math.min(this.bleedDps + dps, dps * 6 + 60);
    this.bleedTime = Math.max(this.bleedTime, duration);
  }

  // Name plate reveal.
  nameAlpha = 0;

  constructor(x: number, y: number, hpScale = 1, dmgScale = 1, variant: BossVariant = "calligrapher") {
    this.x = x;
    this.y = y;
    this.variant = variant;
    this.maxHp = 900 * hpScale;
    this.hp = this.maxHp;
    this.dmgScale = dmgScale;
  }

  /** Display name + seal glyph for the boss bar, per variant. */
  get title(): { name: string; kanji: string } {
    return this.variant === "oni"
      ? { name: "The Vermilion Oni", kanji: "鬼" }
      : { name: "The Drowned Calligrapher", kanji: "墨" };
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
    this.waves = [];
    this.orbitals = [];
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
      case "shockwave":
        this.updateShockwave(ctx);
        break;
      case "orbitals":
        this.updateOrbitals(ctx, p);
        break;
      case "geyser":
        this.updateGeyser(ctx, p);
        break;
    }

    // Expanding shockwave rings live independently of the current move.
    this.updateWaves(ctx);

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
    const moves: Move[] = [];
    const weights: number[] = [];
    if (this.variant === "oni") {
      // Oni fights with concussive, space-controlling attacks.
      moves.push("thrust", "shockwave", "orbitals", "geyser");
      weights.push(d < 260 ? 2.4 : 0.7, d < 320 ? 2.2 : 1.4, 1.8, 1.6);
      if (this.phase >= 2) {
        moves.push("summon", "rain");
        weights.push(1.0, 1.2);
      }
      if (this.phase >= 3) {
        weights[1] += 1.2; // more shockwaves
        weights[3] += 1.0; // more geysers
      }
    } else {
      // Calligrapher: the original brush-and-sigil moveset.
      moves.push("sweep", "thrust", "rain", "callig");
      weights.push(d < 160 ? 3 : 1, d < 260 ? 2.5 : 0.6, 1.5, 1.2);
      if (this.phase >= 2) {
        moves.push("spiral", "summon");
        weights.push(1.6, 1.0);
      }
      if (this.phase >= 3) {
        weights[2] += 1;
        weights[weights.length - 2] += 1.2;
      }
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

  // ---- Oni moves ---------------------------------------------------------
  private updateShockwave(ctx: GameContext) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.55 * this.speedScale();
    this.telegraph = clamp(this.moveTime / windup, 0, 1);
    this.vx = damp(this.vx, 0, 10, dt);
    this.vy = damp(this.vy, 0, 10, dt);
    if (this.moveTime >= windup && !this.hitEmitted) {
      this.hitEmitted = true;
      const rings = this.phase === 3 ? 3 : this.phase === 2 ? 2 : 1;
      for (let i = 0; i < rings; i++) {
        this.waves.push({ r: 20 + i * 46, t: -i * 0.22, hitSet: new Set() });
      }
      ctx.audio.bossRoar();
      ctx.addScreenShake(0.6);
      ctx.hitstop(50);
      ctx.particles.ring(this.x, this.y, 0.9, 160, Palette.vermilion);
    }
    if (this.moveTime > windup + 0.5) this.endMove();
  }

  private updateWaves(ctx: GameContext) {
    const dt = ctx.dt;
    const p = ctx.player;
    const speed = 300 + this.phase * 40;
    const band = 34; // ring thickness for the damage check
    for (const w of this.waves) {
      w.t += dt;
      if (w.t < 0) continue; // stagger before this ring starts expanding
      w.r += speed * dt;
      const d = dist(this.x, this.y, p.x, p.y);
      if (!w.hitSet.has(p) && Math.abs(d - w.r) < band) {
        w.hitSet.add(p);
        p.hurt(16 * this.dmgScale, this.x, this.y, 420, ctx);
      }
    }
    this.waves = this.waves.filter((w) => w.r < 760);
  }

  private updateOrbitals(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.6 * this.speedScale();
    this.telegraph = clamp(this.moveTime / windup, 0, 1);
    this.orbitAngle += dt * 2.4;
    if (this.moveTime < windup) {
      // Spin up the orbs during the telegraph.
      if (this.orbitals.length === 0) {
        const n = this.phase === 3 ? 6 : this.phase === 2 ? 5 : 4;
        for (let i = 0; i < n; i++)
          this.orbitals.push({ angle: (i / n) * TAU, launched: false });
      }
    } else if (!this.hitEmitted) {
      // Launch every orb toward the player, fanned slightly.
      this.hitEmitted = true;
      const aim = angleTo(this.x, this.y, p.x, p.y);
      for (let i = 0; i < this.orbitals.length; i++) {
        const spread = (i - (this.orbitals.length - 1) / 2) * 0.12;
        ctx.spawnEnemyProjectile(
          this.x + Math.cos(this.orbitals[i].angle + this.orbitAngle) * 70,
          this.y + Math.sin(this.orbitals[i].angle + this.orbitAngle) * 70,
          aim + spread,
          360 + this.phase * 30,
          9 * this.dmgScale
        );
      }
      ctx.audio.inkBurst();
      ctx.addScreenShake(0.3);
      this.orbitals = [];
    }
    if (this.moveTime > windup + 0.4) {
      this.orbitals = [];
      this.endMove();
    }
  }

  private updateGeyser(ctx: GameContext, p: Actor) {
    const dt = ctx.dt;
    this.moveTime += dt;
    const windup = 0.3;
    if (this.moveTime < windup) {
      this.telegraph = this.moveTime / windup;
    } else if (!this.hitEmitted) {
      this.hitEmitted = true;
      // A line of erupting pillars marching from the boss toward the player.
      const n = this.phase === 3 ? 6 : this.phase === 2 ? 5 : 4;
      const a = angleTo(this.x, this.y, p.x, p.y);
      const step = 96;
      for (let i = 0; i < n; i++) {
        this.sigils.push({
          x: this.x + Math.cos(a) * (80 + i * step),
          y: this.y + Math.sin(a) * (80 + i * step),
          r: 46,
          t: -i * 0.14, // ripple outward in sequence
          detonated: false,
          pillar: true,
        });
      }
      ctx.audio.swing(1.2);
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
    // Expanding shockwave rings.
    for (const w of this.waves) this.drawWave(ctx, w);

    // Shadow.
    inkWash(ctx, this.x, this.y + this.radius * 0.7, this.radius * 2.2, 0.55, 0.4);

    // Telegraph visuals per move.
    this.drawTelegraph(ctx);

    // Orbiting orbs (drawn around the boss during the orbitals wind-up).
    for (const o of this.orbitals) {
      const ox = this.x + Math.cos(o.angle + this.orbitAngle) * 70;
      const oy = this.y + Math.sin(o.angle + this.orbitAngle) * 70;
      inkWash(ctx, ox, oy, 16, 0.4, 0.5);
      ctx.fillStyle = Palette.vermilion;
      ctx.beginPath();
      ctx.arc(ox, oy, 6, 0, TAU);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    const breathe = 1 + Math.sin(this.wobble * 1.5) * 0.03;
    ctx.scale(breathe, breathe);
    const tone = this.flash > 0 ? 0.4 : 0.95;

    if (this.variant === "oni") this.drawOni(ctx, tone);
    else this.drawCalligrapher(ctx, tone);

    ctx.restore();

    if (this.flash > 0.4) {
      ctx.globalAlpha = (this.flash - 0.4) * 0.5;
      inkBlob(ctx, this.x, this.y, this.radius + 5, 0.2, 0.2, 14, this.wobble);
      ctx.globalAlpha = 1;
    }
  }

  private drawCalligrapher(ctx: CanvasRenderingContext2D, tone: number) {
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
    brushStroke(ctx, -this.radius * 1.2, -this.radius * 0.4, this.radius * 1.2, -this.radius * 0.4, this.radius * 0.7, tone, 0.2, 71);
    inkBlob(ctx, 0, -this.radius * 1.1, this.radius * 0.5, tone, 0.25, 14, this.wobble);
    // Long brush-weapon held to the side, angled toward facing.
    ctx.save();
    ctx.rotate(this.facing);
    brushStroke(ctx, 10, 0, 90, 0, 8, 0.9, 0.15);
    inkBlob(ctx, 92, 0, 7, 0.95, 0.4, 10, this.wobble);
    ctx.restore();
    this.drawEyes(ctx, -6, 6, -this.radius * 1.1);
  }

  private drawOni(ctx: CanvasRenderingContext2D, tone: number) {
    // Squat, heavy-shouldered demon: broad torso, two horns, a war club.
    const sway = Math.sin(this.wobble) * 4;
    // Bulky torso.
    inkBlob(ctx, sway * 0.3, 0, this.radius * 1.1, tone, 0.28, 16, 40);
    // Massive shoulders.
    brushStroke(ctx, -this.radius * 1.35, -this.radius * 0.5, this.radius * 1.35, -this.radius * 0.5, this.radius * 0.85, tone, 0.24, 71);
    // Head.
    inkBlob(ctx, sway * 0.4, -this.radius * 1.15, this.radius * 0.6, tone, 0.24, 14, this.wobble);
    // Two curved horns.
    ctx.strokeStyle = inkTone(tone, 1);
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(dir * this.radius * 0.36, -this.radius * 1.5);
      ctx.quadraticCurveTo(dir * this.radius * 0.95, -this.radius * 2.1, dir * this.radius * 0.55, -this.radius * 2.3);
      ctx.stroke();
    }
    // Iron-studded club (kanabo) swung to the facing side.
    ctx.save();
    ctx.rotate(this.facing);
    brushStroke(ctx, 12, 0, 84, 0, 12, 0.85, 0.16);
    inkBlob(ctx, 92, 0, 16, 0.9, 0.35, 12, this.wobble);
    ctx.fillStyle = Palette.vermilion;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + this.wobble;
      ctx.beginPath();
      ctx.arc(92 + Math.cos(a) * 9, Math.sin(a) * 9, 1.6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // Glowing eyes + a fanged grin.
    this.drawEyes(ctx, -7, 7, -this.radius * 1.2);
    ctx.strokeStyle = Palette.vermilion;
    ctx.globalAlpha = 0.5 + 0.14 * this.phase;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-7, -this.radius * 0.95);
    ctx.lineTo(7, -this.radius * 0.95);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawEyes(ctx: CanvasRenderingContext2D, lx: number, rx: number, y: number) {
    ctx.fillStyle = Palette.vermilion;
    const eyeGlow = 2 + this.phase;
    ctx.globalAlpha = 0.6 + 0.13 * this.phase;
    ctx.beginPath();
    ctx.arc(lx, y, eyeGlow, 0, TAU);
    ctx.arc(rx, y, eyeGlow, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawWave(ctx: CanvasRenderingContext2D, w: Wave) {
    if (w.t < 0) return;
    const fade = clamp(1 - w.r / 760, 0, 1);
    ctx.globalAlpha = 0.5 * fade;
    ctx.strokeStyle = Palette.vermilion;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(this.x, this.y, w.r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.2 * fade;
    ctx.lineWidth = 22;
    ctx.stroke();
    ctx.globalAlpha = 1;
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
    } else if (this.move === "shockwave") {
      // Pulsing charge ring hints at the slam about to erupt.
      ctx.strokeStyle = Palette.vermilion;
      ctx.lineWidth = 3 + t * 8;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius + 14 + t * 40, 0, TAU);
      ctx.stroke();
    } else if (
      this.move === "rain" ||
      this.move === "spiral" ||
      this.move === "summon" ||
      this.move === "orbitals"
    ) {
      ctx.strokeStyle = Palette.vermilionSoft;
      ctx.lineWidth = 2 + t * 3;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius + 10 + t * 20, 0, TAU);
      ctx.stroke();
    } else if (this.move === "geyser") {
      // Dotted lane toward the player where the pillars will erupt.
      ctx.strokeStyle = Palette.vermilionSoft;
      ctx.lineWidth = 2 + t * 4;
      ctx.setLineDash([10, 12]);
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + Math.cos(this.aimAngle) * 560, this.y + Math.sin(this.aimAngle) * 560);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  private drawSigil(ctx: CanvasRenderingContext2D, s: Sigil) {
    const t = clamp(s.t, 0, 1);
    ctx.save();
    ctx.translate(s.x, s.y);
    if (s.pillar) {
      // Geyser: a marked spot that spits an ink column as it charges.
      ctx.globalAlpha = 0.3 + t * 0.5;
      ctx.strokeStyle = Palette.vermilion;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, s.r * 0.7, s.r * 0.32, 0, 0, TAU);
      ctx.stroke();
      const h = t * s.r * 1.9;
      ctx.globalAlpha = 0.2 + t * 0.55;
      ctx.fillStyle = Palette.vermilionSoft;
      ctx.beginPath();
      ctx.moveTo(-s.r * 0.45, 0);
      ctx.quadraticCurveTo(-s.r * 0.2, -h, 0, -h);
      ctx.quadraticCurveTo(s.r * 0.2, -h, s.r * 0.45, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }
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
