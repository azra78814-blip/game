import { RNG } from "../core/rng";
import { TAU } from "../core/math";
import { brushStroke, inkBlob, inkComma, inkWash } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { EnemyKind } from "../entities/enemy";
import { enemyScore } from "../entities/enemy";

// A run is a sequence of rooms. Rooms are one of a few types; combat rooms are
// gated (doors seal until cleared). Layout, enemy composition and decoration
// are all seeded so a given run seed reproduces exactly.

export type RoomType = "combat" | "elite" | "reward" | "rest" | "miniboss" | "boss";

// The run descends from a misty garden into a burning oni realm. The biome
// drives the floor, palette and decoration set so the deep rooms read as a
// wholly different place.
export type Biome = "garden" | "ember";

export interface RoomPlan {
  index: number;
  type: RoomType;
  seed: number;
  waves: EnemyKind[][];
  width: number;
  height: number;
  biome: Biome;
}

export interface Decoration {
  x: number;
  y: number;
  kind:
    // Garden set.
    | "bamboo"
    | "rock"
    | "grass"
    | "mountain"
    | "blossom"
    | "lantern"
    | "torii"
    | "tree"
    | "pond"
    | "pagoda"
    | "stones"
    // Ember set.
    | "ashpeak"
    | "deadtree"
    | "spikerock"
    | "spiderlily"
    | "brazier"
    | "emberpool";
  scale: number;
  seed: number;
}

/** Deep rooms (from the 8th onward) descend into the ember realm. */
export function biomeForDepth(depth: number): Biome {
  return depth >= 8 ? "ember" : "garden";
}

const COMBAT_POOL: EnemyKind[] = ["wisp", "archer", "charger", "brute"];
// New foes are introduced a little deeper so early rooms stay a gentle warm-up.
const COMBAT_POOL_DEEP: EnemyKind[] = [
  "wisp",
  "archer",
  "charger",
  "brute",
  "lancer",
  "bomber",
  "shade",
];

export class RunPlan {
  rooms: RoomPlan[] = [];
  readonly seed: number;
  private rng: RNG;

  constructor(seed: number, length = 12) {
    this.seed = seed;
    this.rng = new RNG(seed);
    this.generate(length);
  }

  private generate(length: number) {
    // A single mid-run miniboss sits at the halfway mark.
    const minibossIndex = Math.floor(length / 2);
    for (let i = 0; i < length; i++) {
      let type: RoomType;
      if (i === length - 1) type = "boss";
      else if (i === 0) type = "combat";
      else if (i === minibossIndex) type = "miniboss";
      else if (i % 3 === 2) type = "reward";
      else if (this.rng.bool(0.22)) type = "elite";
      else type = "combat";

      const roomSeed = this.rng.int(1, 1e9);
      const combat = type !== "boss" && type !== "reward" && type !== "miniboss";
      this.rooms.push({
        index: i,
        type,
        seed: roomSeed,
        waves: combat ? this.buildWaves(i, type) : [],
        width: type === "boss" ? 1100 : type === "miniboss" ? 960 : 820,
        height: type === "boss" ? 760 : type === "miniboss" ? 680 : 620,
        biome: biomeForDepth(i),
      });
    }
  }

  private buildWaves(depth: number, type: RoomType): EnemyKind[][] {
    const rng = new RNG(this.seed + depth * 977);
    const budget = (type === "elite" ? 8 : 5) + depth * 2.2;
    const waveCount = type === "elite" ? 2 : depth < 2 ? 1 : rng.int(1, 2);
    const waves: EnemyKind[][] = [];
    let remaining = budget;
    for (let w = 0; w < waveCount; w++) {
      const wave: EnemyKind[] = [];
      let waveBudget = remaining / (waveCount - w);
      // Early rooms skew to easy enemies; the new archetypes only appear after
      // the 8th room (depth index >= 8).
      const pool =
        depth < 1 ? (["wisp", "archer"] as EnemyKind[]) : depth >= 8 ? COMBAT_POOL_DEEP : COMBAT_POOL;
      let guard = 0;
      while (waveBudget > 0 && guard++ < 40) {
        const kind = rng.pick(pool);
        const cost = enemyScore(kind);
        if (cost > waveBudget + 1) continue;
        wave.push(kind);
        waveBudget -= cost;
      }
      if (type === "elite" && w === waveCount - 1) wave.push("brute");
      if (wave.length === 0) wave.push("wisp");
      waves.push(wave);
    }
    return waves;
  }
}

/** Generate scenic decorations arranged around the room edges. */
export function decorateRoom(plan: RoomPlan): Decoration[] {
  if (plan.biome === "ember") return decorateEmber(plan);
  const rng = new RNG(plan.seed + 13);
  const decos: Decoration[] = [];
  const hw = plan.width / 2;
  const hh = plan.height / 2;

  // Distant mountains along the top (parallax handled at draw).
  const mountainCount = rng.int(2, 4);
  for (let i = 0; i < mountainCount; i++) {
    decos.push({
      x: -hw + (plan.width * (i + 0.5)) / mountainCount + rng.range(-60, 60),
      y: -hh - 40,
      kind: "mountain",
      scale: rng.range(1.2, 2.4),
      seed: rng.int(0, 1000),
    });
  }

  // Bamboo clusters and rocks around the perimeter.
  const edgeCount = rng.int(10, 16);
  for (let i = 0; i < edgeCount; i++) {
    const onX = rng.bool();
    let x: number;
    let y: number;
    if (onX) {
      x = rng.range(-hw + 30, hw - 30);
      y = rng.bool() ? -hh + rng.range(10, 50) : hh - rng.range(10, 50);
    } else {
      x = rng.bool() ? -hw + rng.range(10, 50) : hw - rng.range(10, 50);
      y = rng.range(-hh + 30, hh - 30);
    }
    const kind = rng.weighted(
      ["bamboo", "rock", "grass", "blossom"] as Decoration["kind"][],
      [3, 2, 3, 1]
    );
    decos.push({ x, y, kind, scale: rng.range(0.7, 1.4), seed: rng.int(0, 1000) });
  }

  // Interior grass tufts.
  for (let i = 0; i < rng.int(8, 14); i++) {
    decos.push({
      x: rng.range(-hw + 60, hw - 60),
      y: rng.range(-hh + 60, hh - 60),
      kind: "grass",
      scale: rng.range(0.5, 1),
      seed: rng.int(0, 1000),
    });
  }

  // A distant back-wall centerpiece establishes each chamber's character.
  const backY = -hh + 30;
  if (plan.type === "boss") {
    decos.push({ x: 0, y: backY - 30, kind: "pagoda", scale: 2.1, seed: 9 });
    decos.push({ x: -hw + 90, y: -hh + 90, kind: "lantern", scale: 1.3, seed: 1 });
    decos.push({ x: hw - 90, y: -hh + 90, kind: "lantern", scale: 1.3, seed: 2 });
  } else if (plan.type === "reward") {
    decos.push({ x: 0, y: backY - 10, kind: "torii", scale: 1.9, seed: 4 });
    decos.push({ x: -hw + 80, y: -hh + 80, kind: "lantern", scale: 1.1, seed: 1 });
    decos.push({ x: hw - 80, y: -hh + 80, kind: "lantern", scale: 1.1, seed: 2 });
  } else {
    const centerpiece = rng.weighted(
      ["tree", "pagoda", "torii"] as Decoration["kind"][],
      [3, 1.4, 1.2]
    );
    decos.push({
      x: rng.range(-hw * 0.4, hw * 0.4),
      y: backY,
      kind: centerpiece,
      scale: rng.range(1.5, 2.1),
      seed: rng.int(0, 1000),
    });
  }

  // An ornamental koi pond off to one side in some rooms.
  if (plan.type !== "boss" && rng.bool(0.55)) {
    decos.push({
      x: rng.bool() ? -hw * 0.55 : hw * 0.55,
      y: rng.range(hh * 0.2, hh * 0.5),
      kind: "pond",
      scale: rng.range(0.9, 1.4),
      seed: rng.int(0, 1000),
    });
  }

  // Stepping-stone path meandering across the floor.
  const stoneCount = rng.int(4, 7);
  const sx0 = rng.range(-hw * 0.6, -hw * 0.2);
  const sy0 = rng.range(-hh * 0.3, hh * 0.3);
  for (let i = 0; i < stoneCount; i++) {
    decos.push({
      x: sx0 + i * rng.range(60, 90),
      y: sy0 + Math.sin(i * 0.9 + rng.range(0, 3)) * 40,
      kind: "stones",
      scale: rng.range(0.7, 1.1),
      seed: rng.int(0, 1000),
    });
  }

  return decos;
}

/** Ember-realm decorations: charred trees, jagged rock, braziers and lilies. */
function decorateEmber(plan: RoomPlan): Decoration[] {
  const rng = new RNG(plan.seed + 71);
  const decos: Decoration[] = [];
  const hw = plan.width / 2;
  const hh = plan.height / 2;

  // Jagged volcanic ridge across the far horizon (parallax at draw).
  const peaks = rng.int(2, 4);
  for (let i = 0; i < peaks; i++) {
    decos.push({
      x: -hw + (plan.width * (i + 0.5)) / peaks + rng.range(-60, 60),
      y: -hh - 40,
      kind: "ashpeak",
      scale: rng.range(1.3, 2.5),
      seed: rng.int(0, 1000),
    });
  }

  // Jagged rock spurs and spider lilies around the perimeter.
  const edgeCount = rng.int(10, 16);
  for (let i = 0; i < edgeCount; i++) {
    const onX = rng.bool();
    let x: number;
    let y: number;
    if (onX) {
      x = rng.range(-hw + 30, hw - 30);
      y = rng.bool() ? -hh + rng.range(10, 50) : hh - rng.range(10, 50);
    } else {
      x = rng.bool() ? -hw + rng.range(10, 50) : hw - rng.range(10, 50);
      y = rng.range(-hh + 30, hh - 30);
    }
    const kind = rng.weighted(
      ["spikerock", "spiderlily", "deadtree"] as Decoration["kind"][],
      [3, 2.5, 1.4]
    );
    decos.push({ x, y, kind, scale: rng.range(0.7, 1.4), seed: rng.int(0, 1000) });
  }

  // Scattered spider lilies dotting the interior.
  for (let i = 0; i < rng.int(6, 12); i++) {
    decos.push({
      x: rng.range(-hw + 60, hw - 60),
      y: rng.range(-hh + 60, hh - 60),
      kind: "spiderlily",
      scale: rng.range(0.5, 1),
      seed: rng.int(0, 1000),
    });
  }

  // A great charred tree (or burnt torii) as the back-wall centerpiece, flanked
  // by braziers that light the chamber.
  const backY = -hh + 30;
  const centerpiece = rng.weighted(
    ["deadtree", "torii", "pagoda"] as Decoration["kind"][],
    [3, 1.2, 1.2]
  );
  decos.push({
    x: rng.range(-hw * 0.4, hw * 0.4),
    y: backY,
    kind: centerpiece,
    scale: rng.range(1.6, 2.2),
    seed: rng.int(0, 1000),
  });
  decos.push({ x: -hw + 90, y: -hh + 90, kind: "brazier", scale: 1.2, seed: 1 });
  decos.push({ x: hw - 90, y: -hh + 90, kind: "brazier", scale: 1.2, seed: 2 });

  // A pool of molten ink off to one side in some rooms.
  if (rng.bool(0.55)) {
    decos.push({
      x: rng.bool() ? -hw * 0.55 : hw * 0.55,
      y: rng.range(hh * 0.2, hh * 0.5),
      kind: "emberpool",
      scale: rng.range(0.9, 1.4),
      seed: rng.int(0, 1000),
    });
  }

  // Charred stepping stones across the floor.
  const stoneCount = rng.int(4, 7);
  const sx0 = rng.range(-hw * 0.6, -hw * 0.2);
  const sy0 = rng.range(-hh * 0.3, hh * 0.3);
  for (let i = 0; i < stoneCount; i++) {
    decos.push({
      x: sx0 + i * rng.range(60, 90),
      y: sy0 + Math.sin(i * 0.9 + rng.range(0, 3)) * 40,
      kind: "spikerock",
      scale: rng.range(0.5, 0.8),
      seed: rng.int(0, 1000),
    });
  }

  return decos;
}

// ---- Decoration drawing ---------------------------------------------------
export function drawDecoration(ctx: CanvasRenderingContext2D, d: Decoration, time: number) {
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.scale(d.scale, d.scale);
  switch (d.kind) {
    case "mountain":
      drawMountain(ctx, d.seed);
      break;
    case "bamboo":
      drawBamboo(ctx, d.seed, time);
      break;
    case "rock":
      drawRock(ctx, d.seed);
      break;
    case "grass":
      drawGrass(ctx, d.seed, time);
      break;
    case "blossom":
      drawBlossom(ctx, d.seed);
      break;
    case "lantern":
      drawLantern(ctx, time);
      break;
    case "torii":
      drawTorii(ctx);
      break;
    case "tree":
      drawTree(ctx, d.seed, time);
      break;
    case "pond":
      drawPond(ctx, d.seed, time);
      break;
    case "pagoda":
      drawPagoda(ctx, d.seed);
      break;
    case "stones":
      drawSteppingStone(ctx, d.seed);
      break;
    case "ashpeak":
      drawAshPeak(ctx, d.seed);
      break;
    case "deadtree":
      drawDeadTree(ctx, d.seed, time);
      break;
    case "spikerock":
      drawSpikeRock(ctx, d.seed);
      break;
    case "spiderlily":
      drawSpiderLily(ctx, d.seed, time);
      break;
    case "brazier":
      drawBrazier(ctx, time);
      break;
    case "emberpool":
      drawEmberPool(ctx, d.seed, time);
      break;
  }
  ctx.restore();
}

function drawTorii(ctx: CanvasRenderingContext2D) {
  // Vermilion shrine gate silhouette, softly faded like a distant landmark.
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = Palette.seal;
  const w = 70;
  const h = 96;
  // Pillars.
  ctx.fillRect(-w, -h, 9, h);
  ctx.fillRect(w - 9, -h, 9, h);
  // Top lintel (kasagi) with upturned ends.
  ctx.beginPath();
  ctx.moveTo(-w - 16, -h);
  ctx.quadraticCurveTo(0, -h - 14, w + 16, -h);
  ctx.lineTo(w + 12, -h + 12);
  ctx.quadraticCurveTo(0, -h + 2, -w - 12, -h + 12);
  ctx.closePath();
  ctx.fill();
  // Second beam (nuki).
  ctx.fillRect(-w - 2, -h + 26, (w + 2) * 2, 10);
  ctx.globalAlpha = 1;
}

function drawTree(ctx: CanvasRenderingContext2D, seed: number, time: number) {
  const sway = Math.sin(time * 0.8 + seed) * 3;
  // Trunk.
  ctx.strokeStyle = inkTone(0.85, 1);
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.quadraticCurveTo(sway * 0.4, -50, sway, -96);
  ctx.stroke();
  // Boughs.
  ctx.lineWidth = 4;
  const boughs = 4 + (seed % 3);
  for (let i = 0; i < boughs; i++) {
    const by = -50 - i * 14;
    const dir = i % 2 === 0 ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(sway * ((96 + by) / 96), by);
    ctx.quadraticCurveTo(dir * 26, by - 12, dir * (44 + (seed % 20)), by - 26 + sway);
    ctx.stroke();
  }
  // Blossom canopy — clusters of vermilion dabs.
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * TAU + seed;
    const rad = 40 + ((seed + i * 7) % 26);
    const bx = sway + Math.cos(a) * rad * 0.9;
    const by = -96 + Math.sin(a) * rad * 0.7 + 4;
    ctx.globalAlpha = 0.5 + ((i * 13) % 40) / 100;
    ctx.fillStyle = i % 4 === 0 ? Palette.vermilion : Palette.vermilionSoft;
    ctx.beginPath();
    ctx.ellipse(bx, by, 4, 3, a, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPond(ctx: CanvasRenderingContext2D, seed: number, time: number) {
  // Elliptical water pool with ripples and a couple of koi commas.
  ctx.save();
  ctx.scale(1, 0.55);
  const r = 48;
  const g = ctx.createRadialGradient(0, 0, 4, 0, 0, r);
  g.addColorStop(0, "rgba(63, 77, 99, 0.4)");
  g.addColorStop(1, "rgba(63, 77, 99, 0.08)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  // Ripples.
  ctx.strokeStyle = "rgba(40, 32, 20, 0.15)";
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    const rr = ((time * 14 + i * 20 + seed) % r);
    ctx.globalAlpha = 1 - rr / r;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  // Koi.
  const kx = Math.sin(time * 0.6 + seed) * 20;
  const ky = Math.cos(time * 0.5 + seed) * 8;
  inkComma(ctx, kx, ky, 6, time * 0.6 + seed, 0.6);
  ctx.fillStyle = Palette.vermilion;
  ctx.globalAlpha = 0.7;
  inkComma(ctx, -kx * 0.6, ky + 6, 5, -time * 0.5, 0.9);
  ctx.globalAlpha = 1;
}

function drawPagoda(ctx: CanvasRenderingContext2D, seed: number) {
  // Tiered pagoda silhouette, faded into the distance.
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = inkTone(0.7, 1);
  const tiers = 4;
  let w = 74;
  let y = 0;
  // Base.
  ctx.fillRect(-14, -6, 28, 8);
  for (let i = 0; i < tiers; i++) {
    // Roof: wide flared trapezoid.
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.quadraticCurveTo(-w * 0.5, y - 4, -w * 0.35, y - 16);
    ctx.lineTo(w * 0.35, y - 16);
    ctx.quadraticCurveTo(w * 0.5, y - 4, w, y);
    ctx.closePath();
    ctx.fill();
    // Body block.
    const bw = w * 0.4;
    ctx.fillRect(-bw, y - 34, bw * 2, 18);
    y -= 34;
    w *= 0.8;
  }
  // Finial.
  ctx.fillRect(-2, y - 14, 4, 14);
  ctx.globalAlpha = 1;
}

function drawSteppingStone(ctx: CanvasRenderingContext2D, seed: number) {
  ctx.globalAlpha = 0.4;
  inkBlob(ctx, 0, 0, 16, 0.42, 0.3, 12, seed);
  ctx.globalAlpha = 0.18;
  inkBlob(ctx, -3, -2, 10, 0.3, 0.3, 10, seed + 3);
  ctx.globalAlpha = 1;
}

function drawMountain(ctx: CanvasRenderingContext2D, seed: number) {
  // Faded, wet-on-wet distant peak.
  ctx.globalAlpha = 0.18;
  const w = 200;
  ctx.beginPath();
  ctx.moveTo(-w, 60);
  const peaks = 3;
  for (let i = 0; i <= peaks; i++) {
    const t = i / peaks;
    const px = -w + t * w * 2;
    const py = 60 - Math.sin(t * Math.PI) * (80 + ((seed + i) % 40));
    ctx.lineTo(px, py + Math.sin(seed + i) * 12);
  }
  ctx.lineTo(w, 60);
  ctx.closePath();
  ctx.fillStyle = inkTone(0.4, 1);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawBamboo(ctx: CanvasRenderingContext2D, seed: number, time: number) {
  const sway = Math.sin(time * 1.2 + seed) * 4;
  const stalks = 2 + (seed % 3);
  for (let s = 0; s < stalks; s++) {
    const ox = (s - stalks / 2) * 10;
    const h = 90 + (seed % 30) + s * 8;
    ctx.save();
    ctx.translate(ox, 0);
    // Segmented stalk.
    ctx.strokeStyle = inkTone(0.75, 1);
    ctx.lineWidth = 4;
    for (let seg = 0; seg < 5; seg++) {
      const y0 = -seg * (h / 5);
      const y1 = -(seg + 1) * (h / 5);
      const bend = (sway * (seg + 1)) / 5;
      ctx.beginPath();
      ctx.moveTo(bend * 0.6, y0);
      ctx.lineTo(bend, y1);
      ctx.stroke();
    }
    // Leaves near top.
    for (let l = 0; l < 4; l++) {
      const ly = -h + l * 10;
      const dir = l % 2 === 0 ? 1 : -1;
      inkComma(ctx, sway, ly, 10, dir * 1.3 + sway * 0.02, 0.7);
    }
    ctx.restore();
  }
}

function drawRock(ctx: CanvasRenderingContext2D, seed: number) {
  inkWash(ctx, 0, 6, 30, 0.5, 0.2);
  inkBlob(ctx, 0, 0, 20, 0.7, 0.4, 12, seed);
  ctx.globalAlpha = 0.3;
  brushStroke(ctx, -12, -6, 10, -10, 3, 0.85, 0.2);
  ctx.globalAlpha = 1;
}

function drawGrass(ctx: CanvasRenderingContext2D, seed: number, time: number) {
  const blades = 4 + (seed % 4);
  const sway = Math.sin(time * 2 + seed) * 4;
  for (let i = 0; i < blades; i++) {
    const ox = (i - blades / 2) * 6;
    ctx.strokeStyle = inkTone(0.6, 0.8);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox, 0);
    ctx.quadraticCurveTo(ox + sway * 0.5, -14, ox + sway, -26 - (seed % 8));
    ctx.stroke();
  }
}

function drawBlossom(ctx: CanvasRenderingContext2D, seed: number) {
  // Small plum-blossom branch accent.
  ctx.strokeStyle = inkTone(0.8, 1);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 20);
  ctx.quadraticCurveTo(6, 0, -4, -22);
  ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const bx = (i % 2 === 0 ? 1 : -1) * (4 + i);
    const by = 10 - i * 9;
    ctx.fillStyle = Palette.vermilion;
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * TAU;
      ctx.beginPath();
      ctx.ellipse(bx + Math.cos(a) * 3, by + Math.sin(a) * 3, 2, 1.4, a, 0, TAU);
      ctx.fill();
    }
  }
}

function drawLantern(ctx: CanvasRenderingContext2D, time: number) {
  const glow = 0.7 + Math.sin(time * 2) * 0.15;
  ctx.strokeStyle = inkTone(0.8, 1);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, -80);
  ctx.lineTo(0, -46);
  ctx.stroke();
  inkWash(ctx, 0, -34, 30, 0.2, glow * 0.4);
  ctx.fillStyle = Palette.vermilion;
  ctx.globalAlpha = glow;
  ctx.beginPath();
  ctx.ellipse(0, -34, 12, 15, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = Palette.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-12, -40, 24, 12);
}

// ---- Ember-realm decorations ----------------------------------------------

function drawAshPeak(ctx: CanvasRenderingContext2D, seed: number) {
  // Dark volcanic ridge with a faint molten crown.
  const w = 200;
  ctx.globalAlpha = 0.24;
  ctx.beginPath();
  ctx.moveTo(-w, 60);
  const peaks = 3;
  const crown: [number, number][] = [];
  for (let i = 0; i <= peaks; i++) {
    const t = i / peaks;
    const px = -w + t * w * 2;
    const py = 60 - Math.sin(t * Math.PI) * (90 + ((seed + i) % 46));
    ctx.lineTo(px, py + Math.sin(seed + i) * 12);
    crown.push([px, py]);
  }
  ctx.lineTo(w, 60);
  ctx.closePath();
  ctx.fillStyle = inkTone(0.85, 1);
  ctx.fill();
  // Molten glow along the ridgeline.
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = "rgba(200, 70, 30, 0.6)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  crown.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawDeadTree(ctx: CanvasRenderingContext2D, seed: number, time: number) {
  const sway = Math.sin(time * 0.7 + seed) * 2;
  // Charred trunk.
  ctx.strokeStyle = inkTone(0.95, 1);
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.quadraticCurveTo(sway * 0.4, -50, sway, -96);
  ctx.stroke();
  // Bare, clawing branches.
  ctx.lineWidth = 3.5;
  const boughs = 5 + (seed % 3);
  for (let i = 0; i < boughs; i++) {
    const by = -46 - i * 12;
    const dir = i % 2 === 0 ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(sway * ((96 + by) / 96), by);
    ctx.quadraticCurveTo(dir * 24, by - 16, dir * (40 + (seed % 18)), by - 34 + sway);
    ctx.stroke();
  }
  // A few drifting embers rising from the crown.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + seed;
    const rise = ((time * 20 + i * 30 + seed) % 60);
    ctx.globalAlpha = 0.6 * (1 - rise / 60);
    ctx.fillStyle = i % 2 === 0 ? Palette.vermilion : "rgba(210, 120, 40, 0.9)";
    ctx.beginPath();
    ctx.arc(sway + Math.cos(a) * 26, -96 - rise + Math.sin(a) * 10, 2, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSpikeRock(ctx: CanvasRenderingContext2D, seed: number) {
  // Angular shards of blackened stone.
  inkWash(ctx, 0, 6, 28, 0.6, 0.25);
  ctx.fillStyle = inkTone(0.9, 1);
  const shards = 3 + (seed % 3);
  for (let i = 0; i < shards; i++) {
    const ox = (i - shards / 2) * 12 + ((seed + i * 7) % 6);
    const h = 20 + ((seed + i * 13) % 22);
    ctx.beginPath();
    ctx.moveTo(ox - 8, 6);
    ctx.lineTo(ox + (i % 2 ? 5 : -5), -h);
    ctx.lineTo(ox + 9, 6);
    ctx.closePath();
    ctx.fill();
  }
  // Molten seam.
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = "rgba(200, 80, 30, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-10, 2);
  ctx.lineTo(6, -6);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawSpiderLily(ctx: CanvasRenderingContext2D, seed: number, time: number) {
  // Higanbana — a crimson spider lily; long stem, spidery recurved petals.
  const sway = Math.sin(time * 1.6 + seed) * 3;
  ctx.strokeStyle = inkTone(0.6, 0.9);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(sway * 0.5, -18, sway, -34);
  ctx.stroke();
  ctx.save();
  ctx.translate(sway, -34);
  ctx.strokeStyle = Palette.vermilion;
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + seed;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(Math.cos(a) * 8, Math.sin(a) * 8 - 4, Math.cos(a) * 13, Math.sin(a) * 13 - 8);
    ctx.stroke();
    // Curled stamen tip.
    ctx.fillStyle = Palette.seal;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 13, Math.sin(a) * 13 - 8, 1.4, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawBrazier(ctx: CanvasRenderingContext2D, time: number) {
  const flick = 0.7 + Math.sin(time * 6) * 0.2 + Math.sin(time * 11 + 1) * 0.1;
  // Legs + bowl.
  ctx.strokeStyle = inkTone(0.9, 1);
  ctx.lineWidth = 3;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(dir * 12, -20);
    ctx.lineTo(dir * 8, 0);
    ctx.stroke();
  }
  ctx.fillStyle = inkTone(0.85, 1);
  ctx.beginPath();
  ctx.ellipse(0, -22, 16, 6, 0, 0, TAU);
  ctx.fill();
  // Fire glow + flames.
  inkWash(ctx, 0, -30, 34, 0.2, flick * 0.5);
  ctx.globalAlpha = flick;
  for (let i = -1; i <= 1; i++) {
    ctx.fillStyle = i === 0 ? "rgba(230, 150, 40, 0.9)" : Palette.vermilion;
    const h = 22 + Math.sin(time * 8 + i) * 6;
    ctx.beginPath();
    ctx.moveTo(i * 6 - 5, -24);
    ctx.quadraticCurveTo(i * 6, -24 - h, i * 6 + 3, -24);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawEmberPool(ctx: CanvasRenderingContext2D, seed: number, time: number) {
  // A pool of molten ink: glowing red with slow ripples.
  ctx.save();
  ctx.scale(1, 0.55);
  const r = 48;
  const g = ctx.createRadialGradient(0, 0, 4, 0, 0, r);
  g.addColorStop(0, "rgba(210, 90, 30, 0.5)");
  g.addColorStop(0.6, "rgba(150, 40, 20, 0.3)");
  g.addColorStop(1, "rgba(60, 20, 14, 0.1)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(240, 160, 60, 0.3)";
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 3; i++) {
    const rr = (time * 12 + i * 20 + seed) % r;
    ctx.globalAlpha = 1 - rr / r;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  // Rising ember flecks.
  for (let i = 0; i < 4; i++) {
    const rise = (time * 26 + i * 22 + seed) % 44;
    ctx.globalAlpha = 0.7 * (1 - rise / 44);
    ctx.fillStyle = "rgba(240, 150, 50, 0.9)";
    ctx.beginPath();
    ctx.arc(Math.sin(time + i * 2 + seed) * 20, -rise, 1.6, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
