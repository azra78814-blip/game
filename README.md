# Sumi Requiem · 墨の輪廻

An action roguelike rendered entirely in a hand-built **ink & wash** (sumi-e) style — expressive brush strokes, bleeding ink splatter, aged rice-paper texture, and a single vermilion seal accent. Fast, skill-based melee combat with dodging, parries, combos, a deep talisman build system, and a three-phase boss. Runs in the browser at 60fps with **zero external assets** — every visual is drawn procedurally on a 2D canvas and every sound is synthesized live with the Web Audio API.

## Play

```bash
npm install
npm run dev      # open the printed http://localhost:5173 URL
```

Production build (single self-contained bundle, ~85 KB JS):

```bash
npm run build
npm run preview  # serves the built game on http://localhost:4173
```

## Controls

| Action | Keys |
| --- | --- |
| Move | `W A S D` / Arrow keys |
| Aim | Mouse |
| Light attack (3-hit combo) | Left click / `J` |
| Heavy attack (costs ink) | Right click / `K` |
| Dodge (i-frames) | `Space` / `Shift` |
| Parry (deflect + counter) | `F` / `L` |
| Talisman ability | `E` / `Q` |
| Pause | `Esc` |

**Parrying is the heart of the combat**: a clean parry slows time, heals you, refunds ink, and unleashes a counter. Read the red telegraph flare — it means a hit is coming.

## Design pillars

- **Game feel** — hitstop, trauma-based screen shake, parry slow-mo, knockback, squash-and-stretch, input buffering and attack-cancel windows.
- **Combat** — 3-hit light chain, ink-gated heavy, dodge i-frames, timing-based parry with riposte, projectile deflection.
- **Talismans** — 24 data-driven talismans: passives (lifesteal, thorns, crit, splash, dodge-bombs, **bleed**, **shields**, combo/low-HP scaling…) and actives (Ink Nova, Phantom Step, Brushstorm, Still Mind, **Crescent Rush**, **Spirit Ink** clone). Stack copies to deepen a build; drafted 1-of-3 between rooms.
- **Roguelike runs** — seeded procedural room sequences, gated wave combat, elites, offering rooms, and a boss finale. Enemies scale with depth.
- **Boss** — *The Drowned Calligrapher*: three telegraphed phases (sweep, thrust, ink-rain, bullet spirals, floor sigils, summons) that escalate in speed and complexity.
- **Meta progression** — earn ink essence, spend it at the Ink Shrine on permanent starting bonuses (health, damage, ink, talisman fortune, a one-time revive). Saved to `localStorage`.
- **Audio** — an original synthesized pentatonic score (guqin/koto flavour) whose intensity adapts to combat, plus fully synthesized SFX.

## Architecture

```
src/
  core/      loop timing, input + buffering, seeded RNG, math, juice camera
  render/    palette, procedural brush primitives, paper texture, particles
  audio/     Web Audio synth: adaptive music scheduler + combat SFX
  entities/  player controller, enemy AI roster, boss, projectiles
  game/      state machine + orchestrator, talismans, world/run generation, meta
  ui/        ink HUD, menus, talisman draft, shrine, end screens
test/        headless DOM/canvas/audio stubs + frame-stepping smoke test
```

### Headless smoke test

`test/` contains a Node harness that stubs the browser, then instantiates the
real `Game` and steps it through title → combat → boss death to catch runtime
errors that type-checking can't:

```bash
npx esbuild test/smoke-entry.ts --bundle --format=esm --platform=node --outfile=test/.smoke-bundle.mjs
node test/run-smoke.mjs
```

## Tech

Vanilla **TypeScript** (strict) + **HTML5 Canvas 2D**, bundled with **Vite**. No
game engine, no art/audio files — chosen for instant loading, tight control over
the 60fps game loop, and cross-browser portability.
