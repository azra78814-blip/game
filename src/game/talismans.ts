import { clamp, TAU } from "../core/math";
import { fx } from "../core/rng";
import { Palette } from "../render/palette";
import type { Actor, GameContext } from "./types";
import type { Player } from "../entities/player";

// The Talisman System. Talismans are drafted between rooms. Passives mutate the
// player's stat block and hook into combat events; actives replace/augment the
// player's ability (bound to E / Q). Stacking copies deepens a build.

export type Rarity = "common" | "rare" | "mythic";

export interface Talisman {
  id: string;
  name: string;
  kanji: string; // decorative seal glyph
  desc: string;
  rarity: Rarity;
  kind: "passive" | "active";
  stackable: boolean;
  // Hooks (all optional):
  applyPassive?: (p: Player) => void;
  onHit?: (p: Player, target: Actor, dmg: number, ctx: GameContext) => void;
  onParry?: (p: Player, ctx: GameContext) => void;
  onDodge?: (p: Player, ctx: GameContext) => void;
  onKill?: (p: Player, x: number, y: number, ctx: GameContext) => void;
  onTick?: (p: Player, dt: number, ctx: GameContext) => void;
  onRoomClear?: (p: Player, ctx: GameContext) => void;
  // Active ability:
  activeCooldown?: number;
  inkCost?: number;
  activate?: (p: Player, ctx: GameContext) => void;
}

export const TALISMANS: Talisman[] = [
  // ---- Passives ----
  {
    id: "crane-grace",
    name: "Crane's Grace",
    kanji: "鶴",
    desc: "+18% movement speed and +0.08s dodge invulnerability.",
    rarity: "common",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.stats.moveMult *= 1.18;
      p.stats.dodgeIframeBonus += 0.08;
    },
  },
  {
    id: "tiger-fang",
    name: "Tiger Fang",
    kanji: "虎",
    desc: "+25% attack damage.",
    rarity: "common",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.stats.damageMult *= 1.25;
    },
  },
  {
    id: "swift-brush",
    name: "Swift Brush",
    kanji: "疾",
    desc: "+22% attack speed.",
    rarity: "common",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.stats.attackSpeed *= 1.22;
    },
  },
  {
    id: "crimson-draught",
    name: "Crimson Draught",
    kanji: "紅",
    desc: "Heal for 8% of damage dealt.",
    rarity: "rare",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.stats.lifestealPct += 0.08;
    },
  },
  {
    id: "keen-edge",
    name: "Keen Edge",
    kanji: "鋭",
    desc: "+15% crit chance, +0.4x crit damage.",
    rarity: "rare",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.stats.critChance += 0.15;
      p.stats.critMult += 0.4;
    },
  },
  {
    id: "iron-hide",
    name: "Lacquer Hide",
    kanji: "鎧",
    desc: "+35 maximum health, healed on pickup.",
    rarity: "common",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.maxHp += 35;
      p.heal(35);
    },
  },
  {
    id: "thorn-seal",
    name: "Thornwood Seal",
    kanji: "棘",
    desc: "Reflect 40% of damage taken back at attackers.",
    rarity: "rare",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.stats.thorns += 0.4;
    },
  },
  {
    id: "mirror-parry",
    name: "Mirror Water",
    kanji: "鏡",
    desc: "Parry counters deal +120% damage.",
    rarity: "rare",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.stats.parryReflect += 1.2;
    },
  },
  {
    id: "ember-trail",
    name: "Ember Trail",
    kanji: "焔",
    desc: "Dodging leaves a burst of ink that damages nearby foes.",
    rarity: "rare",
    kind: "passive",
    stackable: true,
    onDodge: (p, ctx) => {
      const dmg = 14 * p.stats.damageMult;
      for (const a of ctx.actors) {
        if (a.team !== "enemy" || a.dead) continue;
        const dx = a.x - p.x;
        const dy = a.y - p.y;
        if (dx * dx + dy * dy < 70 * 70) a.hurt(dmg, p.x, p.y, 200, ctx);
      }
      ctx.particles.ring(p.x, p.y, 0.85, 90, Palette.vermilion);
      ctx.particles.splatter(p.x, p.y, fx.angle(), 1.4, 0.85);
    },
  },
  {
    id: "chain-splatter",
    name: "Scattering Ink",
    kanji: "散",
    desc: "Hits splash 30% damage to other nearby enemies.",
    rarity: "mythic",
    kind: "passive",
    stackable: true,
    onHit: (p, target, dmg, ctx) => {
      const splash = dmg * 0.3;
      for (const a of ctx.actors) {
        if (a === target || a.team !== "enemy" || a.dead) continue;
        const dx = a.x - target.x;
        const dy = a.y - target.y;
        if (dx * dx + dy * dy < 90 * 90) a.hurt(splash, target.x, target.y, 80, ctx);
      }
    },
  },
  {
    id: "vengeful-bloom",
    name: "Vengeful Bloom",
    kanji: "咲",
    desc: "Killing a foe releases homing ink petals.",
    rarity: "mythic",
    kind: "passive",
    stackable: true,
    onKill: (p, x, y, ctx) => {
      for (let i = 0; i < 3; i++) {
        const a = fx.angle();
        ctx.spawnEnemyProjectile; // placeholder to satisfy tree-shake; real spawn below
      }
      // Spawn player-side homing bolts via the projectile hook exposed on ctx.
      (ctx as any).spawnPlayerHoming?.(x, y, 3, 20 * p.stats.damageMult);
    },
  },
  {
    id: "momentum",
    name: "Rising Momentum",
    kanji: "勢",
    desc: "Your combo count grants up to +40% attack speed while it holds.",
    rarity: "rare",
    kind: "passive",
    stackable: false,
    onTick: (p) => {
      // Scale attack speed with the live combo counter, capped.
      const bonus = Math.min(0.4, p.comboCount * 0.04);
      p.dynAtkSpeed *= 1 + bonus;
    },
  },
  {
    id: "severing-brush",
    name: "Severing Brush",
    kanji: "斬",
    desc: "Hits inflict bleed, dealing extra damage over 3s.",
    rarity: "rare",
    kind: "passive",
    stackable: true,
    onHit: (p, target, dmg, _ctx) => {
      target.applyBleed?.(6 + dmg * 0.15, 3);
    },
  },
  {
    id: "inkwell-heart",
    name: "Inkwell Heart",
    kanji: "泉",
    desc: "+40 max ink and doubled ink regeneration.",
    rarity: "common",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.maxInk += 40;
      p.ink = p.maxInk;
    },
    onTick: (p, dt) => {
      p.ink = Math.min(p.maxInk, p.ink + 6 * dt);
    },
  },
  {
    id: "ink-bulwark",
    name: "Ink Bulwark",
    kanji: "盾",
    desc: "Gain 1 shield charge that blocks a hit. Refills each room.",
    rarity: "rare",
    kind: "passive",
    stackable: true,
    applyPassive: (p) => {
      p.maxShield += 1;
      p.shield = p.maxShield;
    },
    onRoomClear: (p) => {
      p.shield = p.maxShield;
    },
  },
  {
    id: "berserkers-ink",
    name: "Berserker's Ink",
    kanji: "狂",
    desc: "Deal up to +45% more damage the lower your health.",
    rarity: "mythic",
    kind: "passive",
    stackable: false,
    onTick: (p) => {
      const missing = 1 - p.hp / p.maxHp;
      p.dynDamage *= 1 + missing * 0.45;
    },
  },
  {
    id: "flowing-form",
    name: "Flowing Form",
    kanji: "流",
    desc: "Dodging grants +30% attack speed for 2s.",
    rarity: "rare",
    kind: "passive",
    stackable: false,
    onDodge: (p) => {
      p.flowingTimer = 2;
    },
    onTick: (p) => {
      if (p.flowingTimer > 0) p.dynAtkSpeed *= 1.3;
    },
  },

  // ---- Actives ----
  {
    id: "ink-nova",
    name: "Ink Nova",
    kanji: "爆",
    desc: "ACTIVE: Detonate a radial ink blast around you.",
    rarity: "rare",
    kind: "active",
    stackable: false,
    activeCooldown: 4,
    inkCost: 40,
    activate: (p, ctx) => {
      const dmg = 42 * p.stats.damageMult;
      for (const a of ctx.actors) {
        if (a.team !== "enemy" || a.dead) continue;
        const dx = a.x - p.x;
        const dy = a.y - p.y;
        if (dx * dx + dy * dy < 150 * 150) a.hurt(dmg, p.x, p.y, 460, ctx);
      }
      ctx.particles.ring(p.x, p.y, 0.9, 320, Palette.vermilion);
      for (let i = 0; i < 20; i++) ctx.particles.splatter(p.x, p.y, (i / 20) * TAU, 2, 0.9);
      ctx.audio.inkBurst();
      ctx.addScreenShake(0.5);
      ctx.hitstop(60);
    },
  },
  {
    id: "phantom-step",
    name: "Phantom Step",
    kanji: "幻",
    desc: "ACTIVE: Blink toward the cursor, becoming ink; slash on arrival.",
    rarity: "rare",
    kind: "active",
    stackable: false,
    activeCooldown: 3,
    inkCost: 30,
    activate: (p, ctx) => {
      const w = ctx.camera.screenToWorld(ctx.input.mouse.x, ctx.input.mouse.y);
      const a = Math.atan2(w.y - p.y, w.x - p.x);
      const dist = Math.min(260, Math.hypot(w.x - p.x, w.y - p.y));
      const fromX = p.x;
      const fromY = p.y;
      p.x += Math.cos(a) * dist;
      p.y += Math.sin(a) * dist;
      p.iframes = Math.max(p.iframes, 0.25);
      // Trail of ink between the two points.
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        ctx.particles.bloom(fromX + (p.x - fromX) * t, fromY + (p.y - fromY) * t, 8, 0.7);
      }
      // Arrival slash.
      const dmg = 34 * p.stats.damageMult;
      for (const e of ctx.actors) {
        if (e.team !== "enemy" || e.dead) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        if (dx * dx + dy * dy < 90 * 90) e.hurt(dmg, p.x, p.y, 300, ctx);
      }
      ctx.particles.ring(p.x, p.y, 0.9, 120);
      ctx.audio.dodge();
      ctx.audio.swing(1.2);
    },
  },
  {
    id: "brush-storm",
    name: "Brushstorm",
    kanji: "嵐",
    desc: "ACTIVE: Loose a fan of five ink slashes toward the cursor.",
    rarity: "mythic",
    kind: "active",
    stackable: false,
    activeCooldown: 5,
    inkCost: 45,
    activate: (p, ctx) => {
      const w = ctx.camera.screenToWorld(ctx.input.mouse.x, ctx.input.mouse.y);
      const base = Math.atan2(w.y - p.y, w.x - p.x);
      for (let i = -2; i <= 2; i++) {
        (ctx as any).spawnPlayerBolt?.(
          p.x,
          p.y,
          base + i * 0.16,
          560,
          22 * p.stats.damageMult
        );
      }
      ctx.audio.inkBurst();
      ctx.particles.sparks(p.x, p.y, 12, Palette.ink);
      ctx.addScreenShake(0.25);
    },
  },
  {
    id: "still-mind",
    name: "Still Mind",
    kanji: "静",
    desc: "ACTIVE: Slow time for a few seconds; you move at full speed.",
    rarity: "mythic",
    kind: "active",
    stackable: false,
    activeCooldown: 12,
    inkCost: 60,
    activate: (p, ctx) => {
      ctx.slowmo(0.35, 2600);
      p.stats.moveMult *= 1; // player already unaffected by world slow via camera dt on input
      ctx.particles.ring(p.x, p.y, 0.9, 260, Palette.indigo);
      ctx.audio.pickup();
      (ctx as any).grantHaste?.(2.6);
    },
  },
  {
    id: "crescent-rush",
    name: "Crescent Rush",
    kanji: "翔",
    desc: "ACTIVE: Dash through foes toward the cursor, cleaving all in the path.",
    rarity: "rare",
    kind: "active",
    stackable: false,
    activeCooldown: 3.5,
    inkCost: 25,
    activate: (p, ctx) => {
      const w = ctx.camera.screenToWorld(ctx.input.mouse.x, ctx.input.mouse.y);
      const a = Math.atan2(w.y - p.y, w.x - p.x);
      const fromX = p.x;
      const fromY = p.y;
      const distance = Math.min(300, Math.max(160, Math.hypot(w.x - p.x, w.y - p.y)));
      p.x += Math.cos(a) * distance;
      p.y += Math.sin(a) * distance;
      p.iframes = Math.max(p.iframes, 0.3);
      const dmg = 30 * p.stats.damageMult;
      // Cleave everything near the dash line.
      for (const e of ctx.actors) {
        if (e.team !== "enemy" || e.dead) continue;
        const t = clampProj(fromX, fromY, p.x, p.y, e.x, e.y);
        const cx = fromX + (p.x - fromX) * t;
        const cy = fromY + (p.y - fromY) * t;
        if ((e.x - cx) ** 2 + (e.y - cy) ** 2 < 60 * 60) {
          e.hurt(dmg, fromX, fromY, 340, ctx);
          e.applyBleed?.(8, 2.5);
        }
      }
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        ctx.particles.bloom(fromX + (p.x - fromX) * t, fromY + (p.y - fromY) * t, 7, 0.75);
      }
      ctx.particles.ring(p.x, p.y, 0.85, 110, Palette.ink);
      ctx.audio.dodge();
      ctx.audio.swing(1.3);
      ctx.addScreenShake(0.2);
    },
  },
  {
    id: "spirit-ink",
    name: "Spirit Ink",
    kanji: "霊",
    desc: "ACTIVE: Summon a spectral ink-clone that mirrors your slashes.",
    rarity: "mythic",
    kind: "active",
    stackable: false,
    activeCooldown: 10,
    inkCost: 50,
    activate: (p, ctx) => {
      (ctx as any).spawnInkClone?.(6);
      ctx.particles.ring(p.x, p.y, 0.9, 160, Palette.indigo);
      for (let i = 0; i < 12; i++) ctx.particles.splatter(p.x, p.y, (i / 12) * TAU, 1.4, 0.8);
      ctx.audio.inkBurst();
    },
  },
];

// Project point onto segment, clamped to [0,1]; used by Crescent Rush cleave.
function clampProj(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  return clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
}

// Runtime container the player owns.
export class TalismanState {
  owned: Talisman[] = [];
  private counts = new Map<string, number>();
  active: Talisman | null = null;

  add(t: Talisman) {
    this.owned.push(t);
    this.counts.set(t.id, (this.counts.get(t.id) ?? 0) + 1);
    if (t.kind === "active") this.active = t;
  }

  count(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  has(id: string): boolean {
    return this.counts.has(id);
  }

  applyPassives(p: Player) {
    for (const t of this.owned) t.applyPassive?.(p);
  }

  onHit(p: Player, target: Actor, dmg: number, ctx: GameContext) {
    for (const t of this.owned) t.onHit?.(p, target, dmg, ctx);
  }
  onParry(p: Player, ctx: GameContext) {
    for (const t of this.owned) t.onParry?.(p, ctx);
  }
  onDodge(p: Player, ctx: GameContext) {
    for (const t of this.owned) t.onDodge?.(p, ctx);
  }
  onKill(p: Player, x: number, y: number, ctx: GameContext) {
    for (const t of this.owned) t.onKill?.(p, x, y, ctx);
  }
  onTick(p: Player, dt: number, ctx: GameContext) {
    for (const t of this.owned) t.onTick?.(p, dt, ctx);
  }
  onRoomClear(p: Player, ctx: GameContext) {
    for (const t of this.owned) t.onRoomClear?.(p, ctx);
  }

  useActive(p: Player, ctx: GameContext) {
    const t = this.active;
    if (!t || !t.activate) {
      ctx.notify("no talisman", p.x, p.y - 30, Palette.ink50);
      return;
    }
    if (p.abilityCooldown > 0) return;
    if ((t.inkCost ?? 0) > p.ink) {
      ctx.notify("low ink", p.x, p.y - 30, Palette.indigo);
      return;
    }
    p.ink = clamp(p.ink - (t.inkCost ?? 0), 0, p.maxInk);
    p.abilityCooldown = t.activeCooldown ?? 3;
    t.activate(p, ctx);
  }
}

/** Draft options: bias toward rarer talismans deeper into the run. */
export function draftTalismans(rng: typeof fx, depth: number, owned: TalismanState): Talisman[] {
  const rareBias = clamp(0.15 + depth * 0.05, 0, 0.6);
  const mythicBias = clamp(depth * 0.02, 0, 0.25);
  const pool = TALISMANS.filter((t) => {
    if (t.stackable) return true;
    return !owned.has(t.id);
  });
  const pick: Talisman[] = [];
  const used = new Set<string>();
  let guard = 0;
  while (pick.length < 3 && guard++ < 100) {
    const r = rng.next();
    let rarity: Rarity = "common";
    if (r < mythicBias) rarity = "mythic";
    else if (r < mythicBias + rareBias) rarity = "rare";
    const tier = pool.filter((t) => t.rarity === rarity && !used.has(t.id));
    const src = tier.length ? tier : pool.filter((t) => !used.has(t.id));
    if (!src.length) break;
    const chosen = rng.pick(src);
    used.add(chosen.id);
    pick.push(chosen);
  }
  return pick;
}
