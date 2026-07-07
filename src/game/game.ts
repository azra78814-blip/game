import { Camera } from "../core/camera";
import { Input } from "../core/input";
import { clamp, dist, TAU } from "../core/math";
import { RNG, fx } from "../core/rng";
import { PaperTexture } from "../render/paper";
import { Particles } from "../render/particles";
import { brushStroke, inkBlob, inkWash } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import { audio } from "../audio/audio";
import { Player } from "../entities/player";
import { Enemy, EnemyKind } from "../entities/enemy";
import { Boss } from "../entities/boss";
import { Projectile } from "../entities/projectile";
import { InkClone } from "../entities/inkclone";
import type { Actor, GameContext, HitInfo } from "./types";
import { TalismanState, draftTalismans, Talisman } from "./talismans";
import { Meta } from "./meta";
import { RunPlan, RoomPlan, decorateRoom, drawDecoration, Decoration } from "./world";
import { Interactable, spawnProps } from "../entities/prop";
import { drawHUD } from "../ui/hud";
import { drawTouchControls } from "../ui/touch";
import {
  Button,
  drawDraft,
  drawEnd,
  drawHelp,
  drawPause,
  drawShrine,
  drawTitle,
  hit,
} from "../ui/screens";

type GameState =
  | "title"
  | "help"
  | "shrine"
  | "playing"
  | "draft"
  | "paused"
  | "gameover"
  | "victory";

const ROOM_NAMES = [
  "Misted Threshold",
  "Bamboo Hollow",
  "Vermilion Bridge",
  "Sunken Garden",
  "Ashen Terrace",
  "Lantern Causeway",
  "Weeping Pavilion",
  "Moonlit Reliquary",
  "The Long Scroll",
  "Cinder Atrium",
  "Hollow Shrine",
  "Inkfall Sanctum",
];

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 1280;
  private h = 720;
  private camera: Camera;
  private input: Input;
  private particles = new Particles();
  private paper: PaperTexture;
  private meta = new Meta();

  private state: GameState = "title";
  private lastTime = 0;
  private time = 0;

  // Run state
  private run!: RunPlan;
  private player!: Player;
  private roomIndex = 0;
  private roomPlan!: RoomPlan;
  private decorations: Decoration[] = [];
  private props: Interactable[] = [];
  private actors: Actor[] = [];
  private enemies: Enemy[] = [];
  private boss: Boss | null = null;
  private projectiles: Projectile[] = [];
  private clones: InkClone[] = [];
  private floorStains: { x: number; y: number; r: number; tone: number }[] = [];

  private waveQueue: EnemyKind[][] = [];
  private waveDelay = 0;
  private roomCleared = false;
  private roomDrafted = false;
  private gate: { x: number; y: number; active: boolean } | null = null;
  private draftOptions: Talisman[] = [];
  // Brief lockout after a draft opens so a click left over from combat can't
  // instantly pick a random card.
  private draftLockout = 0;
  private rng = new RNG(1);
  private runSeed = 1;
  private runEssence = 0;
  private reviveAvailable = false;
  private hasteTimer = 0;
  private hits: HitInfo[] = [];

  // Cached click handling
  private clickConsumed = false;
  private mouseClicked = false;
  private prevMouseDown = false;

  private hitFlash = 0;
  private roomBanner = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.resize();
    this.camera = new Camera(this.w, this.h);
    this.input = new Input(canvas);
    this.paper = new PaperTexture(this.w, this.h);
    window.addEventListener("resize", this.resize);
    window.addEventListener("orientationchange", this.resize);
    // Mobile browsers change the visible area as toolbars show/hide.
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", this.resize);
    }

    // Any click/key/touch resumes audio (autoplay policy).
    const unlock = () => audio.resume();
    window.addEventListener("pointerdown", unlock, { once: false });
    window.addEventListener("keydown", unlock, { once: false });
    window.addEventListener("touchstart", unlock, { once: false });
  }

  private resize = () => {
    // Prefer the visual viewport (accounts for mobile browser chrome).
    const vv = window.visualViewport;
    const maxW = Math.max(1, vv ? vv.width : window.innerWidth);
    const maxH = Math.max(1, vv ? vv.height : window.innerHeight);

    // Fill the entire viewport — no letterbox bars. Internal render height is
    // fixed for a consistent gameplay scale; the width follows the viewport's
    // aspect ratio, so the canvas covers the whole screen without stretching
    // (wider screens simply reveal more of the world around the player).
    const BASE_H = 720;
    this.h = BASE_H;
    this.w = Math.max(1, Math.round(BASE_H * (maxW / maxH)));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.canvas.style.width = `${Math.round(maxW)}px`;
    this.canvas.style.height = `${Math.round(maxH)}px`;

    // Keep the camera and paper texture in sync with the new render size.
    // (Both are undefined on the very first call from the constructor; they are
    // then created with the freshly computed w/h.)
    this.camera?.resize(this.w, this.h);
    this.paper?.resize(this.w, this.h);

    // Portrait rotate hint (touch devices only).
    const hint = document.getElementById("rotate-hint");
    if (hint) {
      const portrait = maxH > maxW * 1.05;
      const touch = this.input?.usingTouch || "ontouchstart" in window;
      hint.style.display = portrait && touch ? "grid" : "none";
    }
  };

  start() {
    requestAnimationFrame(this.loop);
  }

  // ---- Main loop ---------------------------------------------------------
  private loop = (now: number) => {
    if (!this.lastTime) this.lastTime = now;
    let rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    rawDt = Math.min(rawDt, 1 / 30); // clamp huge frame gaps
    this.time += rawDt;

    this.input.tick(now);

    // Gameplay touch controls (joystick/buttons) are only live while playing;
    // elsewhere touches act as menu taps.
    this.input.touchControlsEnabled = this.input.usingTouch && this.state === "playing";

    // Detect click edge (mouse press this frame) or a menu tap.
    this.mouseClicked =
      (this.input.mouse.down && !this.prevMouseDown) || this.input.consumeTap();
    this.prevMouseDown = this.input.mouse.down;
    this.clickConsumed = false;

    const worldDt = this.camera.update(rawDt);

    switch (this.state) {
      case "playing":
        this.updatePlaying(worldDt, rawDt);
        break;
      case "draft":
        this.draftLockout = Math.max(0, this.draftLockout - rawDt);
        this.particles.update(rawDt);
        this.updateAmbient(rawDt);
        break;
      case "paused":
      case "gameover":
      case "victory":
      case "title":
      case "help":
      case "shrine":
        // Keep ambient particles alive for menu backdrops.
        this.particles.update(rawDt);
        this.updateAmbient(rawDt);
        break;
    }

    this.render();

    this.input.endFrame();
    requestAnimationFrame(this.loop);
  };

  private mkContext(dt: number): GameContext {
    const self = this;
    return {
      dt,
      time: this.time,
      input: this.input,
      camera: this.camera,
      particles: this.particles,
      audio,
      rng: this.rng,
      hits: this.hits,
      actors: this.actors,
      player: this.player,
      addScreenShake: (a) => this.camera.addTrauma(a),
      hitstop: (ms) => this.camera.addHitstop(ms),
      slowmo: (s, ms) => this.camera.slowmo(s, ms),
      spawnEnemyProjectile: (x, y, angle, speed, dmg) => {
        this.projectiles.push(new Projectile(x, y, angle, speed, dmg, "enemy"));
      },
      onEnemyKilled: (x, y) => this.onEnemyKilled(x, y),
      notify: (text, x, y, color) => this.particles.floatText(x, y, text, color),
      // Extra hooks used by some talismans (typed loosely on the interface).
      ...( {
        spawnPlayerHoming: (x: number, y: number, n: number, dmg: number) => {
          for (let i = 0; i < n; i++) {
            const a = fx.angle();
            const p = new Projectile(x, y, a, 300, dmg, "player", 3);
            this.projectiles.push(p);
          }
        },
        spawnPlayerBolt: (x: number, y: number, a: number, speed: number, dmg: number) => {
          this.projectiles.push(new Projectile(x, y, a, speed, dmg, "player"));
        },
        grantHaste: (t: number) => {
          this.hasteTimer = Math.max(this.hasteTimer, t);
        },
        spawnInkClone: (duration: number) => {
          const a = fx.angle();
          this.clones.push(
            new InkClone(this.player.x + Math.cos(a) * 60, this.player.y + Math.sin(a) * 60, duration)
          );
        },
      } as any),
    };
  }

  // ---- Playing update ----------------------------------------------------
  private updatePlaying(dt: number, rawDt: number) {
    // Pause toggle.
    if (this.input.pressed("pause")) {
      this.state = "paused";
      audio.setIntensity(0.1);
      return;
    }

    this.hits.length = 0;
    const ctx = this.mkContext(dt);

    // Haste (still mind): player world runs at closer to real time.
    const pdt = this.hasteTimer > 0 ? rawDt * 0.85 : dt;
    if (this.hasteTimer > 0) this.hasteTimer -= rawDt;

    // On touch there is no cursor: auto-aim toward the nearest foe (falling
    // back to movement direction) by driving the same "mouse" point the rest
    // of the aiming code already reads.
    if (this.input.usingTouch) this.updateTouchAim();

    // Update player with (possibly hastened) dt.
    const pctx = this.mkContext(pdt);
    this.player.update(pctx);

    // Update enemies / boss / projectiles with world dt.
    for (const e of this.enemies) e.update(ctx);
    if (this.boss) this.boss.update(ctx);
    for (const p of this.projectiles) p.update(ctx);
    for (const c of this.clones) c.update(ctx);
    this.clones = this.clones.filter((c) => !c.dead);

    // Resolve hits (attacks -> actors).
    this.resolveHits(ctx);

    // Thorns reflect: if player has thorns and was hit this frame, handled in hurt indirectly.

    // Cleanup dead.
    this.cleanup();

    // Camera follow player + slight aim lookahead.
    const w = this.camera.screenToWorld(this.input.mouse.x, this.input.mouse.y);
    const lookX = clamp((w.x - this.player.x) * 0.15, -80, 80);
    const lookY = clamp((w.y - this.player.y) * 0.15, -60, 60);
    this.camera.follow(this.player.x, this.player.y, lookX, lookY);

    // Room bounds: keep player inside.
    this.clampToRoom();

    // Particles + ambient.
    this.particles.update(dt);
    this.updateAmbient(rawDt);
    this.updateProps(ctx);
    this.roomBanner = Math.max(0, this.roomBanner - rawDt);

    // Wave / clear logic.
    this.updateWaves(dt);

    // Gate progression.
    if (this.gate && this.gate.active && dist(this.player.x, this.player.y, this.gate.x, this.gate.y) < 40) {
      this.advanceRoom();
    }

    // Music intensity by threat.
    const threat = this.boss ? 1 : clamp(this.enemies.length / 5, 0, 0.9);
    audio.setIntensity(this.roomCleared ? 0.15 : 0.3 + threat * 0.7);

    // Death.
    if (this.player.dead) {
      if (this.reviveAvailable) {
        this.reviveAvailable = false;
        this.player.dead = false;
        this.player.hp = this.player.maxHp * 0.4;
        this.player.iframes = 1.2;
        this.particles.ring(this.player.x, this.player.y, 0.9, 260, Palette.vermilion);
        for (let i = 0; i < 24; i++)
          this.particles.splatter(this.player.x, this.player.y, (i / 24) * TAU, 2, 0.9);
        audio.bossRoar();
        this.camera.slowmo(0.3, 700);
        this.particles.floatText(this.player.x, this.player.y - 40, "SECOND WIND", Palette.vermilion);
      } else {
        this.endRun(false);
      }
    }
  }

  private resolveHits(ctx: GameContext) {
    for (const hitInfo of this.hits) {
      const targets: Actor[] = hitInfo.team === "player" ? this.actors : [this.player];
      for (const a of targets) {
        if (a.dead || a.team === hitInfo.team) continue;
        if (hitInfo.hitSet.has(a)) continue;
        const d = dist(hitInfo.x, hitInfo.y, a.x, a.y);
        if (d > hitInfo.radius + a.radius) continue;
        // Cone check (unless full-circle).
        if (hitInfo.arc < Math.PI) {
          const ang = Math.atan2(a.y - hitInfo.y, a.x - hitInfo.x);
          let diff = Math.abs(((ang - hitInfo.angle + Math.PI * 3) % TAU) - Math.PI);
          if (diff > hitInfo.arc) continue;
        }
        hitInfo.hitSet.add(a);
        const landed = a.hurt(hitInfo.damage, hitInfo.x, hitInfo.y, hitInfo.knockback, ctx);
        if (landed) {
          // Damage number.
          const col = hitInfo.crit ? Palette.vermilion : Palette.ink;
          this.particles.floatText(a.x, a.y - a.radius - 6, `${Math.round(hitInfo.damage)}`, col);
          if (hitInfo.crit) this.particles.sparks(a.x, a.y, 6, Palette.vermilion);
          hitInfo.onHit?.(a, ctx);

          // Thorns: enemy attacks reflect onto attacker.
          if (
            hitInfo.team === "enemy" &&
            a === this.player &&
            this.player.stats.thorns > 0
          ) {
            // find nearest enemy as the "attacker" proxy
            const src = this.nearestEnemy(hitInfo.x, hitInfo.y);
            if (src)
              src.hurt(
                hitInfo.damage * this.player.stats.thorns,
                this.player.x,
                this.player.y,
                120,
                ctx
              );
          }
        }
      }
    }
  }

  private updateTouchAim() {
    const p = this.player;
    // Nearest target among all foes (enemies + boss).
    let tx = 0;
    let ty = 0;
    let found = false;
    let bd = Infinity;
    for (const a of this.actors) {
      if (a.team !== "enemy" || a.dead) continue;
      const d = dist(p.x, p.y, a.x, a.y);
      if (d < bd) {
        bd = d;
        tx = a.x;
        ty = a.y;
        found = true;
      }
    }
    if (!found) {
      // No target: aim where the player is moving, else keep current facing.
      const mv = this.input.moveVector();
      if (mv.x !== 0 || mv.y !== 0) {
        tx = p.x + mv.x * 120;
        ty = p.y + mv.y * 120;
      } else {
        tx = p.x + Math.cos(p.facing) * 120;
        ty = p.y + Math.sin(p.facing) * 120;
      }
    }
    const s = this.camera.worldToScreen(tx, ty);
    this.input.mouse.x = s.x;
    this.input.mouse.y = s.y;
  }

  private nearestEnemy(x: number, y: number): Enemy | null {
    let best: Enemy | null = null;
    let bd = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist(x, y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private onEnemyKilled(x: number, y: number) {
    this.runEssence += 3;
    this.floorStains.push({ x, y, r: fx.range(18, 30), tone: 0.6 });
    if (this.floorStains.length > 60) this.floorStains.shift();
    const ctx = this.mkContext(0);
    this.player.talismans.onKill(this.player, x, y, ctx);
  }

  private updateWaves(dt: number) {
    if (this.boss) {
      if (this.boss.dead) {
        this.waveDelay -= dt;
        if (this.waveDelay <= 0) {
          if (this.roomPlan.type === "miniboss") {
            // A miniboss clears the room (draft + gate), not the run.
            this.boss = null;
            this.onRoomCleared();
          } else {
            this.endRun(true); // final boss → victory
          }
        }
      }
      return;
    }

    if (this.roomCleared) return;

    const aliveEnemies = this.enemies.filter((e) => !e.dead).length;
    if (aliveEnemies === 0) {
      if (this.waveQueue.length > 0) {
        this.waveDelay -= dt;
        if (this.waveDelay <= 0) {
          this.spawnWave(this.waveQueue.shift()!);
          this.waveDelay = 1.2;
        }
      } else {
        this.onRoomCleared();
      }
    }
  }

  private onRoomCleared() {
    this.roomCleared = true;
    // Refill shields / trigger any room-clear talisman effects.
    this.player.talismans.onRoomClear(this.player, this.mkContext(0));
    // Combat/elite rooms grant a draft; then a gate opens.
    if (!this.roomDrafted && this.roomPlan.type !== "boss") {
      this.openDraft();
    } else {
      this.openGate();
    }
  }

  private openDraft() {
    this.roomDrafted = true;
    const depth = this.roomIndex + this.meta.startBonuses().fortune;
    this.draftOptions = draftTalismans(this.rng as any, depth, this.player.talismans);
    if (this.draftOptions.length === 0) {
      this.openGate();
      return;
    }
    this.state = "draft";
    this.draftLockout = 1; // ~1s before a card can be picked
    audio.setIntensity(0.15);
  }

  private openGate() {
    // Place gate near the far side of the room from player.
    const hw = this.roomPlan.width / 2 - 80;
    const gx = this.player.x < 0 ? hw : -hw;
    this.gate = { x: gx, y: 0, active: true };
    this.particles.ring(gx, 0, 0.9, 120, Palette.jade);
  }

  private advanceRoom() {
    this.gate = null;
    this.roomIndex++;
    if (this.roomIndex >= this.run.rooms.length) {
      this.endRun(true);
      return;
    }
    this.loadRoom(this.roomIndex);
  }

  private clampToRoom() {
    const hw = this.roomPlan.width / 2 - 20;
    const hh = this.roomPlan.height / 2 - 20;
    this.player.x = clamp(this.player.x, -hw, hw);
    this.player.y = clamp(this.player.y, -hh, hh);
    // Cull off-arena projectiles.
    for (const p of this.projectiles) {
      if (Math.abs(p.x) > hw + 60 || Math.abs(p.y) > hh + 60) p.dead = true;
    }
  }

  private cleanup() {
    this.enemies = this.enemies.filter((e) => !e.dead);
    this.projectiles = this.projectiles.filter((p) => !p.dead);
    this.rebuildActors();
  }

  private rebuildActors() {
    this.actors.length = 0;
    for (const e of this.enemies) this.actors.push(e);
    if (this.boss && !this.boss.dead) this.actors.push(this.boss);
  }

  private updateAmbient(rawDt: number) {
    // Occasional drifting ink motes and petals for atmosphere. In menus there's
    // no camera transform, so spawn directly in screen space.
    if (fx.bool(rawDt * 4)) {
      const inWorld = this.state === "playing" || this.state === "draft" || this.state === "paused";
      const x = inWorld ? this.camera.x + fx.range(-this.w / 2, this.w / 2) : fx.range(0, this.w);
      const y = inWorld ? this.camera.y + fx.range(-this.h / 2, this.h / 2) : fx.range(0, this.h);
      this.particles.ambient(x, y, fx.bool(0.3));
    }
  }

  /** Advance interactive props and let player attacks strike them. */
  private updateProps(ctx: GameContext) {
    let anyBroken = false;
    for (const p of this.props) {
      if (!p.alive) {
        anyBroken = true;
        continue;
      }
      p.update(ctx);
      // A player swing overlapping the prop strikes it (once per swing id).
      for (const h of this.hits) {
        if (h.team !== "player" || p.hitIds.has(h.id)) continue;
        if (dist(h.x, h.y, p.x, p.y) > h.radius + p.radius) continue;
        if (h.arc < Math.PI) {
          const ang = Math.atan2(p.y - h.y, p.x - h.x);
          const diff = Math.abs(((ang - h.angle + Math.PI * 3) % TAU) - Math.PI);
          if (diff > h.arc) continue;
        }
        p.hitIds.add(h.id);
        const wasBroken = p.broken;
        p.strike(ctx, h.x, h.y);
        if (!wasBroken && p.broken) this.rewardUrn(p);
      }
    }
    if (anyBroken) this.props = this.props.filter((p) => p.alive);
  }

  /** A smashed urn yields a little essence and, now and then, a sip of health. */
  private rewardUrn(p: Interactable) {
    const gained = 2;
    this.runEssence += gained;
    this.particles.floatText(p.x, p.y - 26, `+${gained}`, Palette.gold);
    audio.pickup();
    if (this.player && !this.player.dead && fx.bool(0.22)) {
      const heal = Math.min(this.player.maxHp - this.player.hp, 6);
      if (heal > 0) {
        this.player.hp += heal;
        this.particles.floatText(p.x, p.y - 42, `+${Math.round(heal)}`, Palette.jade);
      }
    }
  }

  // ---- Room / run setup --------------------------------------------------
  private beginRun() {
    this.runSeed = (Math.random() * 1e9) >>> 0;
    this.rng = new RNG(this.runSeed);
    this.run = new RunPlan(this.runSeed, 12);
    const bonuses = this.meta.startBonuses();

    const talismans = new TalismanState();
    this.player = new Player(0, 0, talismans);
    this.player.maxHp += bonuses.bonusHp;
    this.player.hp = this.player.maxHp;
    this.player.maxInk += bonuses.bonusInk;
    this.player.ink = this.player.maxInk;
    this.player.recomputeStats();
    // Apply meta damage bonus after recompute (recompute resets multipliers).
    this.player.stats.damageMult *= 1 + bonuses.bonusDamage;
    this.reviveAvailable = bonuses.revive;

    this.runEssence = 0;
    this.roomIndex = 0;
    this.floorStains = [];
    this.loadRoom(0);
    this.state = "playing";
    audio.resume();
  }

  private loadRoom(index: number) {
    this.roomPlan = this.run.rooms[index];
    this.decorations = decorateRoom(this.roomPlan);
    this.props = spawnProps(this.roomPlan);
    this.enemies = [];
    this.projectiles = [];
    this.clones = [];
    this.boss = null;
    this.hits.length = 0;
    this.roomCleared = false;
    this.roomDrafted = false;
    this.gate = null;
    this.waveQueue = this.roomPlan.waves.slice();
    this.waveDelay = 0.6;
    this.roomBanner = 2.4;
    this.floorStains = [];

    // Reposition player at entrance (opposite side from any gate).
    this.player.x = -this.roomPlan.width / 2 + 90;
    this.player.y = 0;
    this.camera.snapTo(this.player.x, this.player.y);

    const hpScale = 1 + index * 0.14;
    const dmgScale = 1 + index * 0.08;

    if (this.roomPlan.type === "boss" || this.roomPlan.type === "miniboss") {
      const isFinal = this.roomPlan.type === "boss";
      // Final fight is the new Oni; the mid-run miniboss is the Calligrapher at
      // reduced health so it reads as a wall, not the climax.
      const bossHp = (1 + index * 0.05) * (isFinal ? 1 : 0.5);
      const b = new Boss(
        this.roomPlan.width / 2 - 200,
        0,
        bossHp,
        dmgScale,
        isFinal ? "oni" : "calligrapher"
      );
      b.onSummon = (x, y) => this.spawnEnemy("wisp", x, y, hpScale, dmgScale);
      this.boss = b;
      audio.setIntensity(1);
      // Beat before victory (final) or before the clear/draft (miniboss).
      this.waveDelay = isFinal ? 2.6 : 1.4;
    } else if (this.roomPlan.type === "reward") {
      // Safe room: immediate draft.
      this.roomCleared = true;
      this.waveQueue = [];
      // Slight delay so banner shows, then draft.
      this.rewardPending = true;
    } else {
      // combat / elite: waves spawn via updateWaves.
    }

    this.rebuildActors();
  }
  private rewardPending = false;

  /** Display name for the current room (special-cased for boss/miniboss). */
  private roomLabel(): string {
    if (this.roomPlan.type === "boss") return "Inkfall Sanctum";
    if (this.roomPlan.type === "miniboss") return "The Sealed Hall";
    return ROOM_NAMES[this.roomIndex % ROOM_NAMES.length];
  }

  private spawnWave(kinds: EnemyKind[]) {
    const hpScale = 1 + this.roomIndex * 0.14;
    const dmgScale = 1 + this.roomIndex * 0.08;
    const hw = this.roomPlan.width / 2 - 90;
    const hh = this.roomPlan.height / 2 - 90;
    for (const k of kinds) {
      // Spawn on the far half of the room, away from the player.
      let x = fx.range(0, hw);
      let y = fx.range(-hh, hh);
      if (this.player.x > 0) x = -x;
      this.spawnEnemy(k, x, y, hpScale, dmgScale);
      // Spawn-in ink burst.
      this.particles.ring(x, y, 0.7, 80);
    }
    this.rebuildActors();
  }

  private spawnEnemy(kind: EnemyKind, x: number, y: number, hpScale: number, dmgScale: number) {
    const e = new Enemy(kind, x, y, hpScale, dmgScale);
    this.enemies.push(e);
    this.rebuildActors();
  }

  private endRun(victory: boolean) {
    const total = this.runEssence + (victory ? 120 : 0) + this.roomIndex * 8;
    this.meta.addEssence(total);
    this.meta.recordRun(this.roomIndex, victory);
    this.lastRunEssence = total;
    this.state = victory ? "victory" : "gameover";
    audio.setIntensity(victory ? 0.4 : 0.05);
  }
  private lastRunEssence = 0;

  // ---- Rendering ---------------------------------------------------------
  private render() {
    const ctx = this.ctx;
    // Handle reward-room deferred draft.
    if (this.state === "playing" && this.rewardPending && this.roomBanner < 1.4) {
      this.rewardPending = false;
      this.openDraft();
    }

    // Paper background (screen space).
    this.paper.draw(ctx);

    if (this.state === "playing" || this.state === "draft" || this.state === "paused") {
      ctx.save();
      this.camera.apply(ctx);
      this.renderWorld(ctx);
      ctx.restore();
      // HUD in screen space.
      if (this.player)
        drawHUD(
          ctx,
          this.w,
          this.h,
          this.player,
          this.roomIndex,
          this.roomLabel(),
          this.enemies.filter((e) => !e.dead).length + (this.boss && !this.boss.dead ? 1 : 0),
          this.time
        );
      this.renderRoomBanner(ctx);
      if (this.boss) this.renderBossBar(ctx);
      // On-screen touch controls sit above the HUD during play.
      if (this.input.usingTouch && this.state === "playing")
        drawTouchControls(ctx, this.input);
    }

    // Overlays / menus.
    this.renderOverlays(ctx);
  }

  private renderWorld(ctx: CanvasRenderingContext2D) {
    // Arena floor: a soft washed rectangle with brushed border.
    const hw = this.roomPlan.width / 2;
    const hh = this.roomPlan.height / 2;
    ctx.save();
    inkWash(ctx, 0, 0, Math.max(hw, hh) * 1.4, 0.28, 0.14);
    this.renderFloor(ctx, hw, hh);
    // Brushed border frame.
    ctx.globalAlpha = 0.5;
    brushStroke(ctx, -hw, -hh, hw, -hh, 8, 0.5, 0.3, 101);
    brushStroke(ctx, -hw, hh, hw, hh, 8, 0.5, 0.3, 102);
    brushStroke(ctx, -hw, -hh, -hw, hh, 8, 0.5, 0.3, 103);
    brushStroke(ctx, hw, -hh, hw, hh, 8, 0.5, 0.3, 104);
    // Corner seal marks.
    ctx.globalAlpha = 0.6;
    for (const [sx, sy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]] as const) {
      ctx.fillStyle = Palette.seal;
      ctx.fillRect(sx - 5, sy - 5, 10, 10);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Floor stains (behind entities).
    for (const s of this.floorStains) {
      ctx.globalAlpha = 0.4;
      inkBlob(ctx, s.x, s.y, s.r, s.tone, 0.4, 12, s.x + s.y);
    }
    ctx.globalAlpha = 1;

    // Distant backdrop decorations (peaks behind, with gentle parallax).
    const isBackdrop = (k: Decoration["kind"]) => k === "mountain" || k === "ashpeak";
    ctx.save();
    ctx.translate(this.camera.x * 0.12, this.camera.y * 0.12);
    for (const d of this.decorations)
      if (isBackdrop(d.kind)) drawDecoration(ctx, d, this.time);
    ctx.restore();

    // Gate.
    if (this.gate && this.gate.active) this.renderGate(ctx);

    // Ground decorations.
    for (const d of this.decorations)
      if (!isBackdrop(d.kind)) drawDecoration(ctx, d, this.time);

    // Entities sorted by y for depth.
    const ctxGame = this.mkContext(0);
    const drawList: { y: number; fn: () => void }[] = [];
    for (const e of this.enemies) drawList.push({ y: e.y, fn: () => e.draw(ctx, ctxGame) });
    if (this.boss && !this.boss.dead) drawList.push({ y: this.boss.y, fn: () => this.boss!.draw(ctx, ctxGame) });
    if (this.player && !this.player.dead)
      drawList.push({ y: this.player.y, fn: () => this.player.draw(ctx, ctxGame) });
    // Ground-standing props (urns, bells) depth-sort with the entities so the
    // player can pass in front of and behind them.
    for (const p of this.props)
      if (p.kind !== "flutter") drawList.push({ y: p.y, fn: () => p.draw(ctx) });
    drawList.sort((a, b) => a.y - b.y);
    for (const d of drawList) d.fn();

    // Butterfly clusters drift above the scene.
    for (const p of this.props) if (p.kind === "flutter") p.draw(ctx);

    // Ink clones drift with the entities.
    for (const c of this.clones) c.draw(ctx);

    // Projectiles above entities.
    for (const p of this.projectiles) p.draw(ctx);

    // Particles on top.
    this.particles.draw(ctx);
  }

  private renderFloor(ctx: CanvasRenderingContext2D, hw: number, hh: number) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-hw, -hh, hw * 2, hh * 2);
    ctx.clip();
    const type = this.roomPlan.type;
    const ember = this.roomPlan.biome === "ember";

    // Base tint sets each chamber's mood.
    let tint = "rgba(0,0,0,0)";
    if (ember) tint = type === "boss" ? "rgba(96, 28, 14, 0.3)" : "rgba(74, 26, 14, 0.22)";
    else if (type === "boss") tint = "rgba(60, 20, 14, 0.15)";
    else if (type === "elite") tint = "rgba(70, 40, 30, 0.10)";
    else if (type === "reward") tint = "rgba(150, 120, 50, 0.09)";
    if (tint !== "rgba(0,0,0,0)") {
      ctx.fillStyle = tint;
      ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
    }

    if (ember) {
      // Scorched ground: dark char patches veined with molten cracks.
      const rng = new RNG(this.roomPlan.seed + 777);
      ctx.fillStyle = "rgba(18, 10, 6, 0.05)";
      for (let i = 0; i < 24; i++) {
        inkWash(ctx, rng.range(-hw, hw), rng.range(-hh, hh), rng.range(30, 80), 0.9, 0.06);
      }
      // Glowing fissures snaking across the floor.
      ctx.strokeStyle = "rgba(200, 78, 28, 0.14)";
      for (let i = 0; i < 7; i++) {
        let x = rng.range(-hw, hw);
        let y = rng.range(-hh, hh);
        ctx.lineWidth = rng.range(1.5, 3.5);
        ctx.beginPath();
        ctx.moveTo(x, y);
        const segs = rng.int(3, 6);
        for (let s = 0; s < segs; s++) {
          x += rng.range(-80, 80);
          y += rng.range(-60, 60);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } else if (type === "reward" || type === "boss") {
      // Zen raked-sand: concentric arcs radiating from a focal point.
      ctx.strokeStyle = "rgba(40, 32, 20, 0.06)";
      ctx.lineWidth = 2;
      const fy = hh * 0.25;
      const maxR = Math.max(hw, hh) * 1.4;
      for (let r = 38; r < maxR; r += 24) {
        ctx.beginPath();
        ctx.arc(0, fy, r, Math.PI * 1.02, Math.PI * 1.98);
        ctx.stroke();
      }
    } else {
      // Faint flagstone washes — deterministic from the room seed (no shimmer).
      const rng = new RNG(this.roomPlan.seed + 555);
      ctx.fillStyle = "rgba(40, 32, 20, 0.035)";
      for (let i = 0; i < 26; i++) {
        const x = rng.range(-hw, hw);
        const y = rng.range(-hh, hh);
        const r = rng.range(26, 70);
        inkWash(ctx, x, y, r, 0.4, 0.05);
      }
    }
    ctx.restore();
  }

  private renderGate(ctx: CanvasRenderingContext2D) {
    const g = this.gate!;
    const pulse = 1 + Math.sin(this.time * 3) * 0.1;
    inkWash(ctx, g.x, g.y, 60 * pulse, 0.3, 0.4);
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.strokeStyle = Palette.jade;
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.6 - i * 0.15;
      ctx.beginPath();
      ctx.arc(0, 0, 24 + i * 10 + Math.sin(this.time * 2 + i) * 4, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Torii-like glyph.
    ctx.fillStyle = Palette.jade;
    ctx.font = "900 30px 'Noto Serif JP', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("門", 0, 1);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
    // Prompt.
    ctx.fillStyle = Palette.ink70;
    ctx.font = "600 13px 'Noto Serif JP', serif";
    ctx.textAlign = "center";
    ctx.fillText("enter the gate", g.x, g.y + 54);
  }

  private renderRoomBanner(ctx: CanvasRenderingContext2D) {
    if (this.roomBanner <= 0) return;
    const a = clamp(this.roomBanner > 2 ? (2.4 - this.roomBanner) * 3 : this.roomBanner, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = "center";
    ctx.fillStyle = Palette.ink;
    ctx.font = "900 40px 'Noto Serif JP', serif";
    ctx.fillText(this.roomLabel(), this.w / 2, 150);
    ctx.fillStyle = Palette.seal;
    ctx.font = "500 15px 'Cinzel', serif";
    const label =
      this.roomPlan.type === "boss"
        ? "— final trial —"
        : this.roomPlan.type === "miniboss"
        ? "— the sealed one stirs —"
        : this.roomPlan.type === "elite"
        ? "— elite —"
        : this.roomPlan.type === "reward"
        ? "— offering —"
        : `— chamber ${this.roomIndex + 1} —`;
    ctx.fillText(label, this.w / 2, 176);
    ctx.restore();
  }

  private renderBossBar(ctx: CanvasRenderingContext2D) {
    const b = this.boss!;
    if (b.dead) return;
    const bw = 620;
    const x = this.w / 2 - bw / 2;
    const y = this.h - 54;
    ctx.save();
    ctx.textAlign = "center";
    // Name.
    ctx.globalAlpha = clamp(b.nameAlpha + 0.4, 0.4, 1);
    ctx.fillStyle = Palette.ink;
    ctx.font = "700 20px 'Noto Serif JP', serif";
    ctx.fillText(`${b.title.kanji} — ${b.title.name}`, this.w / 2, y - 12);
    ctx.globalAlpha = 1;
    // Bar backing.
    ctx.fillStyle = "rgba(30,26,18,0.15)";
    ctx.fillRect(x, y, bw, 12);
    // Phase segments.
    const frac = clamp(b.hp / b.maxHp, 0, 1);
    ctx.fillStyle = Palette.vermilion;
    ctx.fillRect(x, y, bw * frac, 12);
    // Phase dividers at 33% and 66%.
    ctx.strokeStyle = Palette.paper;
    ctx.lineWidth = 2;
    for (const p of [0.33, 0.66]) {
      ctx.beginPath();
      ctx.moveTo(x + bw * p, y);
      ctx.lineTo(x + bw * p, y + 12);
      ctx.stroke();
    }
    ctx.strokeStyle = Palette.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, bw, 12);
    ctx.fillStyle = Palette.ink70;
    ctx.font = "600 12px 'Cinzel', serif";
    ctx.fillText(`Phase ${b.phase} / 3`, this.w / 2, y + 30);
    ctx.restore();
  }

  // ---- Overlays / input dispatch ----------------------------------------
  private renderOverlays(ctx: CanvasRenderingContext2D) {
    const mx = this.input.mouse.x;
    const my = this.input.mouse.y;
    let buttons: Button[] = [];

    switch (this.state) {
      case "title":
        this.renderMenuBackdrop(ctx);
        buttons = drawTitle(ctx, this.w, this.h, this.meta, mx, my, this.time);
        break;
      case "help":
        this.renderMenuBackdrop(ctx);
        buttons = drawHelp(ctx, this.w, this.h, mx, my);
        break;
      case "shrine":
        this.renderMenuBackdrop(ctx);
        buttons = drawShrine(ctx, this.w, this.h, this.meta, mx, my);
        break;
      case "draft":
        buttons = drawDraft(ctx, this.w, this.h, this.draftOptions, mx, my, false, this.draftLockout);
        break;
      case "paused":
        buttons = drawPause(ctx, this.w, this.h, mx, my, audio.muted);
        break;
      case "gameover":
        buttons = drawEnd(ctx, this.w, this.h, false, this.roomIndex, this.lastRunEssence, mx, my);
        break;
      case "victory":
        buttons = drawEnd(ctx, this.w, this.h, true, this.roomIndex, this.lastRunEssence, mx, my);
        break;
    }

    // Cursor (brush tip) in menus and game.
    this.renderCursor(ctx, mx, my);

    // Ignore clicks during the draft's brief selection lockout so a leftover
    // click from combat can't accidentally pick a card.
    const locked = this.state === "draft" && this.draftLockout > 0;
    if (this.mouseClicked && !this.clickConsumed && !locked) {
      for (const b of buttons) {
        if (hit(b, mx, my)) {
          this.onButton(b);
          audio.uiSelect();
          break;
        }
      }
    }

    // Keyboard shortcuts on menus.
    if (this.state === "paused" && this.input.pressed("pause")) {
      this.state = "playing";
    }
  }

  private renderMenuBackdrop(ctx: CanvasRenderingContext2D) {
    // A single large ink smear + particles behind menus for life.
    this.particles.draw(ctx);
  }

  private renderCursor(ctx: CanvasRenderingContext2D, mx: number, my: number) {
    // No crosshair on touch — aim is automatic and there is no pointer.
    if (this.input.usingTouch) return;
    ctx.save();
    ctx.translate(mx, my);
    ctx.fillStyle = Palette.seal;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, TAU);
    ctx.strokeStyle = Palette.seal;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private onButton(b: Button) {
    this.clickConsumed = true;
    switch (b.id) {
      case "start":
        this.beginRun();
        break;
      case "shrine":
        this.state = "shrine";
        break;
      case "help":
        this.state = "help";
        break;
      case "back":
        this.state = "title";
        break;
      case "pick": {
        const t = b.data as Talisman;
        this.player.talismans.add(t);
        this.player.recomputeStats();
        // reapply meta damage bonus lost on recompute
        this.player.stats.damageMult *= 1 + this.meta.startBonuses().bonusDamage;
        audio.pickup();
        this.particles.floatText(this.player.x, this.player.y - 30, t.name, Palette.seal);
        this.state = "playing";
        this.openGate();
        break;
      }
      case "buy": {
        const u = b.data as import("./meta").MetaUpgrade;
        this.meta.buy(u);
        break;
      }
      case "resume":
        this.state = "playing";
        break;
      case "mute":
        audio.setMuted(!audio.muted);
        break;
      case "quit":
        this.endRun(false);
        break;
      case "again":
        this.beginRun();
        break;
      case "menu":
        this.state = "title";
        break;
    }
  }
}
