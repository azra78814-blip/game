// Headless smoke test: drive the real Game through title -> combat -> boss,
// stepping the frame loop by hand, to surface runtime errors the type checker
// can't (the `as any` hooks, bad property access, etc.).
import { Game } from "../src/game/game";

declare const globalThis: any;

const canvas = document.getElementById("game") as HTMLCanvasElement;
void canvas;

const game = new Game(canvas as HTMLCanvasElement);

// Capture the rAF callback the game registers each frame.
let cb: ((t: number) => void) | null = null;
globalThis.requestAnimationFrame = (fn: (t: number) => void) => {
  cb = fn;
  return 1;
};

game.start();

let t = 0;
const step = (frames: number, dtMs = 16.7) => {
  for (let i = 0; i < frames; i++) {
    t += dtMs;
    globalThis.__now = t;
    if (cb) cb(t);
  }
};

// 1) Title screen frames (menus, particles, cursor).
step(60);
console.log("[smoke] title ok");

// 2) Force a run and play through several rooms of real combat.
(game as any).beginRun();
step(90);
console.log("[smoke] combat room ok, enemies:", (game as any).enemies.length);

// Grant the player every talisman to exercise all hooks (onTick, actives,
// bleed, shields, clones) under the real update loop.
import { TALISMANS } from "../src/game/talismans";
for (const t of TALISMANS) {
  (game as any).player.talismans.add(t);
}
(game as any).player.recomputeStats();
// Fire each active ability a few times.
for (let i = 0; i < TALISMANS.length; i++) {
  (game as any).player.talismans.active &&
    (game as any).player.talismans.useActive((game as any).player, (game as any).mkContext(0.016));
  (game as any).player.ink = 100;
  (game as any).player.abilityCooldown = 0;
  step(6);
}
console.log("[smoke] all talismans + actives ok, clones:", (game as any).clones.length);

// 2b) Touch controls: drive the Input touch handlers directly (joystick +
// action button + auto-aim) to catch runtime errors in the mobile path.
{
  const input = (game as any).input;
  input.usingTouch = true;
  input.touchControlsEnabled = true;
  const ev = (touches: any[]) => ({ changedTouches: touches, preventDefault() {} });
  input.onTouchStart(ev([{ identifier: 1, clientX: 200, clientY: 500 }])); // joystick
  input.onTouchStart(ev([{ identifier: 2, clientX: 1158, clientY: 600 }])); // attack
  input.onTouchMove(ev([{ identifier: 1, clientX: 270, clientY: 450 }]));
  step(24);
  const mv = input.moveVector();
  const joy = input.joystick();
  console.log(
    `[smoke] touch: move=(${mv.x.toFixed(2)},${mv.y.toFixed(2)}) joyActive=${joy.active} attackHeld=${input.isButtonHeld("light")}`
  );
  input.onTouchEnd(ev([{ identifier: 1 }, { identifier: 2 }]));
  step(6);
  console.log("[smoke] touch controls ok, joyActive after release:", input.joystick().active);
}

// Simulate clearing rooms and drafting by directly advancing.
for (let r = 0; r < 6; r++) {
  // Kill any enemies to force clear.
  for (const e of (game as any).enemies) e.dead = true;
  step(40);
  // If a draft opened, auto-pick the first option.
  if ((game as any).state === "draft") {
    const opt = (game as any).draftOptions[0];
    (game as any).onButton({ id: "pick", data: opt, x: 0, y: 0, w: 0, h: 0 });
  }
  // If a gate opened, teleport player into it.
  const gate = (game as any).gate;
  if (gate) {
    (game as any).player.x = gate.x;
    (game as any).player.y = gate.y;
  }
  step(30);
  console.log(`[smoke] progressed, roomIndex=${(game as any).roomIndex}, state=${(game as any).state}`);
}

// 2c) Swap between stacked active abilities (regression: actives must persist).
{
  const ta = (game as any).player.talismans;
  const before = ta.actives.length;
  ta.cycleActive();
  ta.cycleActive();
  console.log(`[smoke] ability swap ok, actives kept=${before}, index=${ta.activeIndex}`);
}

// 2d) Mid-run miniboss (the Calligrapher) — exercise the demoted-boss path.
const minibossIdx = (game as any).run.rooms.findIndex((r: any) => r.type === "miniboss");
if (minibossIdx >= 0) {
  (game as any).roomIndex = minibossIdx;
  (game as any).loadRoom(minibossIdx);
  (game as any).state = "playing";
  step(200);
  console.log(`[smoke] miniboss room ok, variant=${(game as any).boss?.variant}`);
}

// 2e) Deep ember room — new biome floor/decor + new enemy archetypes (lancer,
// bomber, shade) spawning and acting under the real loop.
{
  const deep = (game as any).run.rooms.findIndex(
    (r: any) => r.biome === "ember" && (r.type === "combat" || r.type === "elite")
  );
  if (deep >= 0) {
    (game as any).roomIndex = deep;
    (game as any).loadRoom(deep);
    (game as any).state = "playing";
    step(300);
    console.log(`[smoke] ember room ok, biome=${(game as any).roomPlan.biome}, enemies=${(game as any).enemies.length}`);
  }
}

// 3) Jump to the final boss room and exercise all of the Oni's moves.
const bossIdx = (game as any).run.rooms.length - 1;
(game as any).roomIndex = bossIdx;
(game as any).loadRoom(bossIdx);
(game as any).state = "playing";
step(500);
const boss = (game as any).boss;
console.log("[smoke] boss room ok, variant:", boss?.variant, "hp:", boss ? Math.round(boss.hp) : "none");

// 4) Force boss through phases and death.
if (boss) {
  const ctx = (game as any).mkContext(0.016);
  boss.hurt(700, 0, 0, 0, ctx); // trigger phase transitions
  step(120);
  boss.hurt(1000, 0, 0, 0, (game as any).mkContext(0.016));
  step(200);
}
console.log("[smoke] final state:", (game as any).state);

console.log("[smoke] PASS — no runtime errors");
