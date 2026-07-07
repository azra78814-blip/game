import { Camera } from "../core/camera";
import {
  angleTo,
  clamp,
  damp,
  easeOutCubic,
  lerp,
  TAU,
} from "../core/math";
import { fx } from "../core/rng";
import { brushStroke, inkBlob, inkWash, slashArc } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { Actor, GameContext, HitInfo } from "../game/types";
import type { TalismanState } from "../game/talismans";

type State = "idle" | "attack" | "dodge" | "parry" | "hurt";

// Combo definitions: each light attack in the chain has its own reach, arc,
// damage multiplier and timing. Chaining within the window advances the combo.
interface ComboStep {
  windup: number;
  active: number;
  recover: number;
  reach: number;
  arc: number;
  dmg: number;
  knockback: number;
  sweep: number; // visual sweep direction of the crescent
}

const LIGHT_COMBO: ComboStep[] = [
  { windup: 0.06, active: 0.08, recover: 0.11, reach: 62, arc: 1.1, dmg: 10, knockback: 130, sweep: 1 },
  { windup: 0.06, active: 0.08, recover: 0.11, reach: 66, arc: 1.2, dmg: 11, knockback: 140, sweep: -1 },
  { windup: 0.09, active: 0.1, recover: 0.24, reach: 78, arc: 1.6, dmg: 18, knockback: 300, sweep: 1 },
];

const HEAVY: ComboStep = {
  windup: 0.22,
  active: 0.12,
  recover: 0.3,
  reach: 92,
  arc: 1.5,
  dmg: 32,
  knockback: 420,
  sweep: 1,
};

let hitIdCounter = 1;

export class Player implements Actor {
  x: number;
  y: number;
  radius = 15;
  hp: number;
  maxHp: number;
  dead = false;
  team = "player" as const;

  facing = 0; // radians, toward aim
  private vx = 0;
  private vy = 0;
  private moveSpeed = 300;

  state: State = "idle";
  private stateTime = 0;
  private comboIndex = 0;
  private comboWindow = 0; // time left to continue combo
  private curStep: ComboStep | null = null;
  private curHeavy = false;
  private activeHit: HitInfo | null = null;
  private hitEmitted = false;
  // Blade-tip motion trail: a fading ribbon that gives swings a fluid smear.
  private slashTrail: { x: number; y: number; life: number }[] = [];

  // Dodge
  private dodgeDir = 0;
  private dodgeCooldown = 0;
  iframes = 0;
  dashTrail: { x: number; y: number; a: number }[] = [];

  // Parry
  private parryCooldown = 0;
  parryWindow = 0; // >0 means actively parrying
  private parrySuccessFlash = 0;
  private parryHaste = 0; // brief attack-speed burst after a clean parry

  // Whether the current swing rolled a crit (drives impact-frame emphasis).
  private curCrit = false;

  // Ink resource (spent by ability / heavy)
  ink = 100;
  maxInk = 100;

  // Ability (talisman-driven active)
  abilityCooldown = 0;

  // Ink Bulwark shield charges (block one hit each; refilled on room clear).
  shield = 0;
  maxShield = 0;

  // Per-frame dynamic modifiers (reset each tick, set by talisman onTick hooks).
  dynAtkSpeed = 1;
  dynDamage = 1;
  flowingTimer = 0; // Flowing Form haste window

  // Feedback
  private hurtCooldown = 0;
  private flash = 0;
  private squash = 0; // animation squash/stretch
  private walkCycle = 0;
  comboCount = 0;
  comboTimer = 0;

  talismans: TalismanState;

  // Stats derived from talismans (recomputed on pickup).
  stats = {
    damageMult: 1,
    attackSpeed: 1,
    moveMult: 1,
    lifestealPct: 0,
    dodgeIframeBonus: 0,
    critChance: 0.05,
    critMult: 1.8,
    thorns: 0,
    parryReflect: 1,
  };

  constructor(x: number, y: number, talismans: TalismanState) {
    this.x = x;
    this.y = y;
    this.maxHp = 100;
    this.hp = 100;
    this.talismans = talismans;
  }

  get alive() {
    return !this.dead;
  }

  recomputeStats() {
    // Reset to base then let talismans mutate.
    this.stats = {
      damageMult: 1,
      attackSpeed: 1,
      moveMult: 1,
      lifestealPct: 0,
      dodgeIframeBonus: 0,
      critChance: 0.05,
      critMult: 1.8,
      thorns: 0,
      parryReflect: 1,
    };
    this.maxInk = 100;
    this.talismans.applyPassives(this);
  }

  hurt(amount: number, fromX: number, fromY: number, knockback: number, ctx: GameContext): boolean {
    if (this.dead || this.iframes > 0 || this.hurtCooldown > 0) return false;

    // Active parry: negate and counter.
    if (this.parryWindow > 0) {
      this.triggerParry(fromX, fromY, ctx);
      return false;
    }

    // Ink Bulwark: consume a shield charge to fully block the hit.
    if (this.shield > 0) {
      this.shield--;
      this.iframes = 0.25;
      ctx.audio.parry();
      ctx.particles.ring(this.x, this.y, 0.85, 80, Palette.indigo);
      ctx.particles.sparks(this.x, this.y, 8, Palette.indigo);
      ctx.notify("BLOCK", this.x, this.y - 26, Palette.indigo);
      return false;
    }

    this.hp -= amount;
    this.flash = 1;
    this.hurtCooldown = 0.4;
    this.iframes = 0.35;
    this.comboCount = 0;
    const a = angleTo(fromX, fromY, this.x, this.y);
    this.vx += Math.cos(a) * knockback;
    this.vy += Math.sin(a) * knockback;
    ctx.audio.hurt();
    ctx.particles.splatter(this.x, this.y, a, 1.2, 0.7);
    ctx.addScreenShake(0.4);
    ctx.hitstop(70);
    ctx.notify(`-${Math.round(amount)}`, this.x, this.y - 20, Palette.vermilion);

    // Thorns reflect.
    if (this.stats.thorns > 0) {
      // handled by attacker check elsewhere; here just a flash
    }

    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
    }
    return true;
  }

  private triggerParry(fromX: number, fromY: number, ctx: GameContext) {
    this.parryWindow = 0;
    this.parrySuccessFlash = 1;
    this.iframes = Math.max(this.iframes, 0.25);
    ctx.audio.parry();
    ctx.slowmo(0.25, 320);
    ctx.hitstop(90);
    ctx.addScreenShake(0.5);
    const a = angleTo(this.x, this.y, fromX, fromY);
    ctx.particles.sparks(
      this.x + Math.cos(a) * 24,
      this.y + Math.sin(a) * 24,
      18,
      Palette.vermilion
    );
    ctx.particles.ring(this.x, this.y, 0.9, 70, Palette.vermilion);
    ctx.notify("PARRY", this.x, this.y - 34, Palette.vermilion);
    // Restore ink and a bit of health on a clean parry, and grant a short
    // attack-speed burst so a good read flows straight into aggression.
    this.ink = clamp(this.ink + 25, 0, this.maxInk);
    this.hp = clamp(this.hp + 4, 0, this.maxHp);
    this.parryHaste = 1.2;
    this.comboCount += 1;
    this.comboTimer = 3;

    // Riposte: emit a strong counter hit around the player.
    const hit: HitInfo = {
      x: this.x,
      y: this.y,
      radius: 90,
      angle: a,
      arc: Math.PI,
      damage: 24 * this.stats.damageMult * this.stats.parryReflect,
      knockback: 380,
      team: "player",
      id: hitIdCounter++,
      hitSet: new Set(),
      crit: true,
    };
    ctx.hits.push(hit);
    this.talismans.onParry(this, ctx);
  }

  private startAttack(step: ComboStep, heavy: boolean, ctx: GameContext) {
    this.state = "attack";
    this.stateTime = 0;
    this.curStep = step;
    this.curHeavy = heavy;
    this.hitEmitted = false;
    this.activeHit = null;
    this.squash = heavy ? 0.35 : 0.2;
    // Aim toward mouse.
    const w = ctx.camera.screenToWorld(ctx.input.mouse.x, ctx.input.mouse.y);
    this.facing = angleTo(this.x, this.y, w.x, w.y);
    ctx.audio.swing(heavy ? 1.4 : 1);
    // Lunge slightly forward into the swing.
    const lunge = heavy ? 150 : 90;
    this.vx += Math.cos(this.facing) * lunge;
    this.vy += Math.sin(this.facing) * lunge;
  }

  private emitHit(ctx: GameContext) {
    const step = this.curStep!;
    const crit = fx.next() < this.stats.critChance;
    this.curCrit = crit;
    const dmg =
      step.dmg * this.stats.damageMult * this.dynDamage * (crit ? this.stats.critMult : 1);
    const hit: HitInfo = {
      x: this.x + Math.cos(this.facing) * step.reach * 0.5,
      y: this.y + Math.sin(this.facing) * step.reach * 0.5,
      radius: step.reach,
      angle: this.facing,
      arc: step.arc,
      damage: dmg,
      knockback: step.knockback,
      team: "player",
      id: hitIdCounter++,
      hitSet: new Set(),
      crit,
      onHit: (actor, c) => this.onDealtHit(actor, dmg, c),
    };
    // Stored, not pushed here — the active-window loop pushes it each frame so
    // the hitbox stays live for the whole swing (shared hitSet dedupes).
    this.activeHit = hit;
    this.hitEmitted = true;
  }

  private onDealtHit(actor: Actor, dmg: number, ctx: GameContext) {
    // Lifesteal.
    if (this.stats.lifestealPct > 0) {
      this.hp = clamp(this.hp + dmg * this.stats.lifestealPct, 0, this.maxHp);
    }
    this.comboCount += 1;
    this.comboTimer = 3;
    this.ink = clamp(this.ink + 4, 0, this.maxInk);

    // Impact frame: weighty hits (finisher / heavy) bite harder, and crits pop
    // a brief slow-mo. This layers on top of the enemy's own hurt feedback.
    const finisher = this.curHeavy || this.comboIndex === LIGHT_COMBO.length - 1;
    if (finisher) {
      ctx.hitstop(this.curHeavy ? 95 : 70);
      ctx.addScreenShake(this.curHeavy ? 0.5 : 0.34);
      ctx.particles.ring(actor.x, actor.y, 0.9, this.curHeavy ? 110 : 84, Palette.ink);
      ctx.particles.sparks(actor.x, actor.y, 6, Palette.vermilion);
      if (this.curHeavy) {
        // Recoil back off the blow for weight.
        this.vx -= Math.cos(this.facing) * 90;
        this.vy -= Math.sin(this.facing) * 90;
      }
    }
    if (this.curCrit) ctx.slowmo(0.6, 70);

    this.talismans.onHit(this, actor, dmg, ctx);
  }

  private startDodge(ctx: GameContext) {
    const mv = ctx.input.moveVector();
    let dir: number;
    if (mv.x !== 0 || mv.y !== 0) dir = Math.atan2(mv.y, mv.x);
    else dir = this.facing;
    this.dodgeDir = dir;
    this.state = "dodge";
    this.stateTime = 0;
    this.iframes = 0.32 + this.stats.dodgeIframeBonus;
    this.dodgeCooldown = 0.28;
    this.comboWindow = 0;
    ctx.audio.dodge();
    ctx.particles.ring(this.x, this.y, 0.7, 44);
    this.dashTrail.length = 0;
    this.talismans.onDodge(this, ctx);
  }

  private startParry(ctx: GameContext) {
    this.state = "parry";
    this.stateTime = 0;
    this.parryWindow = 0.2;
    this.parryCooldown = 0.5;
    ctx.audio.swing(0.6);
    const w = ctx.camera.screenToWorld(ctx.input.mouse.x, ctx.input.mouse.y);
    this.facing = angleTo(this.x, this.y, w.x, w.y);
  }

  update(ctx: GameContext) {
    const dt = ctx.dt;
    if (this.dead) return;

    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.parryCooldown = Math.max(0, this.parryCooldown - dt);
    // Abilities each keep their own cooldown in the talisman state; mirror the
    // equipped one into abilityCooldown for the HUD sweep and legacy reads.
    this.talismans.tickCooldowns(dt);
    this.abilityCooldown = this.talismans.remainingCooldown(this.talismans.active?.id ?? "");
    // Swap the equipped active ability (kept, never discarded).
    if (ctx.input.pressed("swapAbility") && this.talismans.actives.length > 1) {
      const t = this.talismans.cycleActive();
      if (t) {
        ctx.notify(`${t.kanji} ${t.name}`, this.x, this.y - 42, Palette.indigo);
        ctx.audio.uiSelect();
      }
    }
    this.hurtCooldown = Math.max(0, this.hurtCooldown - dt);
    this.iframes = Math.max(0, this.iframes - dt);
    this.parryWindow = Math.max(0, this.parryWindow - dt);
    this.flash = Math.max(0, this.flash - dt * 4);
    this.parrySuccessFlash = Math.max(0, this.parrySuccessFlash - dt * 2.5);
    this.squash = damp(this.squash, 0, 12, dt);
    this.comboTimer = Math.max(0, this.comboTimer - dt);
    if (this.comboTimer <= 0) this.comboCount = 0;

    // Age the blade trail so it lingers briefly after the swing then fades.
    if (this.slashTrail.length) {
      for (const s of this.slashTrail) s.life -= dt * 4.5;
      this.slashTrail = this.slashTrail.filter((s) => s.life > 0);
    }

    // Reset per-frame dynamic modifiers, then let talismans set them.
    this.dynAtkSpeed = 1;
    this.dynDamage = 1;
    this.flowingTimer = Math.max(0, this.flowingTimer - dt);
    this.talismans.onTick(this, dt, ctx);

    // Aggression reward: a sustained combo sharpens the blade; a clean parry
    // grants a short haste burst. (Movement momentum is applied in integrate.)
    const momentum = Math.min(this.comboCount, 12) / 12;
    this.dynAtkSpeed *= 1 + momentum * 0.12;
    this.parryHaste = Math.max(0, this.parryHaste - dt);
    if (this.parryHaste > 0) this.dynAtkSpeed *= 1.25;

    // Passive ink regen.
    this.ink = clamp(this.ink + 6 * dt, 0, this.maxInk);

    // Aim always tracks the mouse when idle-ish.
    if (this.state === "idle" || this.state === "attack") {
      const w = ctx.camera.screenToWorld(ctx.input.mouse.x, ctx.input.mouse.y);
      const aim = angleTo(this.x, this.y, w.x, w.y);
      if (this.state === "idle") this.facing = aim;
    }

    // ---- State machine ----
    // A buffered dodge/parry cancels whatever we're doing (dodge-canceling).
    if (!this.tryCancels(ctx)) {
      switch (this.state) {
        case "idle":
          this.handleIdle(ctx);
          break;
        case "attack":
          this.updateAttack(ctx);
          break;
        case "dodge":
          this.updateDodge(ctx);
          break;
        case "parry":
          this.updateParry(ctx);
          break;
      }
    }

    // Combo window countdown.
    if (this.comboWindow > 0) {
      this.comboWindow -= dt;
      if (this.comboWindow <= 0) this.comboIndex = 0;
    }

    // Movement integration (movement allowed in idle & tail of attack).
    this.integrate(ctx);

    // Ambient ink drip under the brush when moving fast.
    if (Math.hypot(this.vx, this.vy) > 120 && fx.bool(0.3)) {
      ctx.particles.bloom(this.x + fx.range(-6, 6), this.y + 14, fx.range(3, 6), 0.35);
    }
  }

  /**
   * Buffered dodge/parry can interrupt ANY action (except while hurt/dead or
   * already dodging) — this is the core of the responsive, cancel-heavy feel.
   * Returns true if a cancel fired, so the caller skips the normal state update.
   */
  private tryCancels(ctx: GameContext): boolean {
    if (this.state === "hurt" || this.state === "dodge") return false;
    // Dodge takes priority (the reflexive "get out"), then parry.
    if (this.dodgeCooldown <= 0 && ctx.input.consumeBuffered("dodge", 160)) {
      this.startDodge(ctx);
      return true;
    }
    if (this.parryCooldown <= 0 && ctx.input.consumeBuffered("parry", 160)) {
      this.startParry(ctx);
      return true;
    }
    return false;
  }

  private handleIdle(ctx: GameContext) {
    // Dodge/parry are handled globally by tryCancels; idle starts offense.
    if (ctx.input.consumeBuffered("heavy", 160) && this.ink >= 20) {
      this.ink -= 20;
      this.startAttack(HEAVY, true, ctx);
      return;
    }
    if (ctx.input.consumeBuffered("light", 160)) {
      this.comboIndex = 0;
      this.startAttack(LIGHT_COMBO[0], false, ctx);
      return;
    }
    if (ctx.input.consumeBuffered("ability", 160)) {
      this.talismans.useActive(this, ctx);
      return;
    }
  }

  private updateAttack(ctx: GameContext) {
    const step = this.curStep!;
    const spd = this.stats.attackSpeed * this.dynAtkSpeed;
    const windup = step.windup / spd;
    const active = step.active / spd;
    const recover = step.recover / spd;
    this.stateTime += ctx.dt;
    const t = this.stateTime;

    // Emit hit at the start of the active window.
    if (t >= windup && !this.hitEmitted) {
      this.emitHit(ctx);
    }
    // Keep the hitbox live for the whole active window: re-add it to the
    // frame's hit list each tick, following the blade, sharing one hitSet.
    if (this.activeHit && t >= windup && t < windup + active) {
      this.activeHit.x = this.x + Math.cos(this.facing) * step.reach * 0.5;
      this.activeHit.y = this.y + Math.sin(this.facing) * step.reach * 0.5;
      this.activeHit.angle = this.facing;
      ctx.hits.push(this.activeHit);
    }

    // Record the blade tip through the swing to build the motion-trail ribbon.
    const total = windup + active;
    if (t >= windup * 0.3 && t <= total + 0.02) {
      const ang = this.bladeAngle(step, clamp(t / total, 0, 1));
      this.slashTrail.push({
        x: this.x + Math.cos(ang) * step.reach * 0.98,
        y: this.y + Math.sin(ang) * step.reach * 0.98,
        life: 1,
      });
      if (this.slashTrail.length > 16) this.slashTrail.shift();
    }

    // Chain the next attack early — as soon as the blade is most of the way
    // through its active window — so combos flow without a stall. (Dodge/parry
    // cancels are handled globally by tryCancels, so a swing can be broken at
    // any time, not just here.)
    if (t >= windup + active * 0.6) {
      if (!this.curHeavy && ctx.input.consumeBuffered("light", 200)) {
        const next = (this.comboIndex + 1) % LIGHT_COMBO.length;
        this.comboIndex = next;
        this.startAttack(LIGHT_COMBO[next], false, ctx);
        return;
      }
      if (ctx.input.consumeBuffered("heavy", 200) && this.ink >= 20) {
        this.ink -= 20;
        this.startAttack(HEAVY, true, ctx);
        return;
      }
    }

    if (t >= windup + active + recover) {
      this.state = "idle";
      this.comboWindow = 0.3; // brief window shown in HUD
    }
  }

  private updateDodge(ctx: GameContext) {
    this.stateTime += ctx.dt;
    const dur = 0.24;
    const t = this.stateTime / dur;
    const speed = lerp(600, 130, easeOutCubic(clamp(t, 0, 1))) * this.stats.moveMult;
    this.vx = Math.cos(this.dodgeDir) * speed;
    this.vy = Math.sin(this.dodgeDir) * speed;

    // Afterimage trail.
    if (fx.bool(0.9)) {
      this.dashTrail.push({ x: this.x, y: this.y, a: 0.5 });
    }

    // Dash-attack: cancel out of the dash into a lunging swing (dash → slash →
    // dash flow). Available once past the initial burst so the dash still reads.
    if (this.stateTime > 0.1) {
      if (ctx.input.consumeBuffered("heavy", 200) && this.ink >= 20) {
        this.ink -= 20;
        this.startAttack(HEAVY, true, ctx);
        return;
      }
      if (ctx.input.consumeBuffered("light", 200)) {
        this.comboIndex = 0;
        this.startAttack(LIGHT_COMBO[0], false, ctx);
        return;
      }
    }

    if (this.stateTime >= dur) {
      this.state = "idle";
      // Carry a little dash momentum out so movement flows into the next action
      // instead of stopping dead.
      this.vx = Math.cos(this.dodgeDir) * 150 * this.stats.moveMult;
      this.vy = Math.sin(this.dodgeDir) * 150 * this.stats.moveMult;
    }
  }

  private updateParry(ctx: GameContext) {
    this.stateTime += ctx.dt;
    // Slow to a stop while bracing.
    this.vx *= 0.8;
    this.vy *= 0.8;
    // Cancel the brace into an attack once the active window has passed, so a
    // successful read flows straight into a punish. (Dodge is handled globally.)
    if (this.parryWindow <= 0 && this.stateTime > 0.12) {
      if (ctx.input.consumeBuffered("heavy", 200) && this.ink >= 20) {
        this.ink -= 20;
        this.startAttack(HEAVY, true, ctx);
        return;
      }
      if (ctx.input.consumeBuffered("light", 200)) {
        this.comboIndex = 0;
        this.startAttack(LIGHT_COMBO[0], false, ctx);
        return;
      }
    }
    if (this.stateTime >= 0.32) {
      this.state = "idle";
    }
  }

  private integrate(ctx: GameContext) {
    const dt = ctx.dt;
    // You are never fully rooted: you can drift through the whole attack swing
    // (touch a touch quicker, since the joystick is a separate thumb). This is
    // what makes offense feel mobile and aggressive rather than committal.
    const touch = ctx.input.usingTouch;
    if (this.state === "idle" || this.state === "attack") {
      const mv = ctx.input.moveVector();
      // A live combo adds a little extra glide (movement momentum).
      const moMove = 1 + (Math.min(this.comboCount, 12) / 12) * 0.06;
      const target = this.state === "attack" ? (touch ? 0.6 : 0.42) : 1;
      const spd = this.moveSpeed * this.stats.moveMult * moMove * target;
      this.vx = damp(this.vx, mv.x * spd, 14, dt);
      this.vy = damp(this.vy, mv.y * spd, 14, dt);
      if (mv.x !== 0 || mv.y !== 0) this.walkCycle += dt * 12;
    } else if (this.state !== "dodge") {
      this.vx = damp(this.vx, 0, 8, dt);
      this.vy = damp(this.vy, 0, 8, dt);
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Fade dash trail.
    for (const d of this.dashTrail) d.a -= dt * 2;
    this.dashTrail = this.dashTrail.filter((d) => d.a > 0);
  }

  heal(amount: number) {
    this.hp = clamp(this.hp + amount, 0, this.maxHp);
  }

  // ---- Rendering ---------------------------------------------------------
  draw(ctx: CanvasRenderingContext2D, g: GameContext) {
    // Ground shadow / ink pool.
    inkWash(ctx, this.x, this.y + 12, this.radius * 1.7, 0.5, 0.32);

    // Dash afterimages.
    for (const d of this.dashTrail) {
      ctx.globalAlpha = d.a * 0.5;
      inkBlob(ctx, d.x, d.y, this.radius * 0.9, 0.6, 0.3, 12, d.x);
    }
    ctx.globalAlpha = 1;

    // Body: a robed brush figure. Squash/stretch on attacks.
    const sq = 1 + this.squash;
    const st = 1 - this.squash * 0.5;
    ctx.save();
    ctx.translate(this.x, this.y);

    // Parry brace glow.
    if (this.parryWindow > 0) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = Palette.vermilion;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius + 12, this.facing - 0.9, this.facing + 0.9);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Bob while walking.
    const bob = Math.sin(this.walkCycle) * 2;
    ctx.translate(0, bob);

    // Robe (tapered brush body).
    const tone = this.flash > 0 ? 0.4 : 0.9;
    ctx.save();
    ctx.scale(st, sq);
    // Lower robe as a fat downward stroke.
    brushStroke(ctx, 0, -this.radius, 0, this.radius + 6, this.radius * 1.7, tone, 0.15, 11);
    // Shoulders.
    brushStroke(
      ctx,
      -this.radius * 0.8,
      -this.radius * 0.3,
      this.radius * 0.8,
      -this.radius * 0.3,
      10,
      tone,
      0.2,
      23
    );
    ctx.restore();

    // Head.
    inkBlob(ctx, 0, -this.radius - 4, 7, tone, 0.2, 12, 3);

    // Vermilion sash / seal accent.
    ctx.strokeStyle = this.parrySuccessFlash > 0 ? Palette.vermilion : Palette.seal;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-8, -2);
    ctx.lineTo(6, 6);
    ctx.stroke();

    ctx.restore();

    // Flowing motion-trail ribbon, then the crescent on top.
    this.drawSlashTrail(ctx);
    this.drawWeapon(ctx);

    // Flash overlay on hurt.
    if (this.flash > 0) {
      ctx.globalAlpha = this.flash * 0.5;
      ctx.fillStyle = Palette.vermilion;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius + 4, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /** Blade angle at normalized swing progress t (0..1), eased. */
  private bladeAngle(step: ComboStep, t: number): number {
    const arcHalf = step.arc;
    const start = this.facing - arcHalf * step.sweep;
    const sweep = arcHalf * 2 * step.sweep;
    return start + sweep * easeOutCubic(t);
  }

  private drawWeapon(ctx: CanvasRenderingContext2D) {
    if (this.state !== "attack" || !this.curStep) return;
    const step = this.curStep;
    const spd = this.stats.attackSpeed * this.dynAtkSpeed;
    const windup = step.windup / spd;
    const active = step.active / spd;
    const total = windup + active;
    const t = clamp(this.stateTime / total, 0, 1);
    let curAngle = this.bladeAngle(step, t);
    // Anticipation: pull the blade back during the wind-up, release into swing.
    if (this.stateTime < windup) {
      const wp = this.stateTime / windup;
      curAngle -= step.sweep * 0.55 * (1 - easeOutCubic(wp));
    }
    const alpha =
      this.stateTime < windup
        ? 0.22 + 0.18 * (this.stateTime / windup)
        : clamp(1 - (this.stateTime - windup) / (active + 0.1), 0, 1);
    const tone = this.curHeavy ? 0.95 : 0.85;
    slashArc(
      ctx,
      this.x,
      this.y,
      step.reach * 0.7,
      curAngle - 0.5 * step.sweep,
      1.0 * step.sweep,
      this.curHeavy ? 16 : 11,
      tone,
      alpha
    );
  }

  private drawSlashTrail(ctx: CanvasRenderingContext2D) {
    const tr = this.slashTrail;
    if (tr.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const heavy = this.curHeavy;
    for (let i = 1; i < tr.length; i++) {
      const head = i / tr.length; // 0 tail .. 1 head
      const life = tr[i].life;
      ctx.globalAlpha = life * 0.5 * head;
      ctx.strokeStyle = inkTone(heavy ? 0.9 : 0.78, 1);
      ctx.lineWidth = (heavy ? 15 : 10) * head * (0.55 + life * 0.45);
      ctx.beginPath();
      ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
      ctx.lineTo(tr[i].x, tr[i].y);
      ctx.stroke();
    }
    // Bright leading spark at the blade tip.
    const tip = tr[tr.length - 1];
    ctx.globalAlpha = tip.life * 0.6;
    ctx.fillStyle = Palette.paper;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, (heavy ? 4.5 : 3) * tip.life, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
