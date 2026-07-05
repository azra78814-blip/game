import type { Camera } from "../core/camera";
import type { Input } from "../core/input";
import type { Particles } from "../render/particles";
import type { AudioEngine } from "../audio/audio";
import type { RNG } from "../core/rng";

// A hurtable actor in the world (player, enemy, boss share this shape so
// combat code can be generic).
export interface Actor {
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  team: "player" | "enemy";
  /** Apply damage. Returns true if the hit landed (not blocked/i-framed). */
  hurt(amount: number, fromX: number, fromY: number, knockback: number, ctx: GameContext): boolean;
  /** Apply a stacking bleed damage-over-time (optional; enemies/boss only). */
  applyBleed?(dps: number, duration: number): void;
}

// A hit request emitted by attacks; resolved against actors each frame.
export interface HitInfo {
  x: number;
  y: number;
  radius: number;
  angle: number; // direction the attack faces
  arc: number; // half-angle of the cone (radians); >= PI = full circle
  damage: number;
  knockback: number;
  team: "player" | "enemy";
  id: number; // unique per swing so an actor is hit once per swing
  hitSet: Set<Actor>;
  crit?: boolean;
  onHit?: (actor: Actor, ctx: GameContext) => void;
}

// Shared services passed to update/draw so entities don't reach for globals.
export interface GameContext {
  dt: number;
  time: number;
  input: Input;
  camera: Camera;
  particles: Particles;
  audio: AudioEngine;
  rng: RNG;
  hits: HitInfo[];
  actors: Actor[];
  player: import("../entities/player").Player;
  addScreenShake: (amt: number) => void;
  hitstop: (ms: number) => void;
  slowmo: (scale: number, ms: number) => void;
  spawnEnemyProjectile: (x: number, y: number, angle: number, speed: number, dmg: number) => void;
  onEnemyKilled: (x: number, y: number) => void;
  notify: (text: string, x: number, y: number, color?: string) => void;
}
