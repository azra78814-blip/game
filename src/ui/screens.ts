import { clamp, TAU } from "../core/math";
import { fx } from "../core/rng";
import { brushStroke, inkBlob } from "../render/brush";
import { Palette } from "../render/palette";
import { roundRect } from "./hud";
import type { Talisman } from "../game/talismans";
import type { Meta } from "../game/meta";
import { META_UPGRADES } from "../game/meta";

// Immediate-mode UI for menus. Each screen returns clickable regions; the game
// loop feeds mouse position + click and dispatches actions. Everything is drawn
// on the same canvas in the ink aesthetic for a seamless look.

export interface Button {
  x: number;
  y: number;
  w: number;
  h: number;
  id: string;
  data?: unknown;
}

export function hit(b: Button, mx: number, my: number): boolean {
  return mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h;
}

function title(ctx: CanvasRenderingContext2D, w: number, text: string, sub: string, y: number) {
  ctx.textAlign = "center";
  ctx.fillStyle = Palette.ink;
  ctx.font = "900 54px 'Noto Serif JP', serif";
  ctx.fillText(text, w / 2, y);
  ctx.fillStyle = Palette.seal;
  ctx.font = "500 16px 'Cinzel', serif";
  ctx.fillText(sub, w / 2, y + 28);
}

// ---- Title screen ----------------------------------------------------------
export function drawTitle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  meta: Meta,
  mx: number,
  my: number,
  time: number
): Button[] {
  // Big brushed title.
  ctx.save();
  ctx.textAlign = "center";

  // Decorative giant kanji behind title.
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = Palette.ink;
  ctx.font = "900 340px 'Noto Serif JP', serif";
  ctx.fillText("墨", w / 2, h / 2 + 110);
  ctx.globalAlpha = 1;

  ctx.fillStyle = Palette.ink;
  ctx.font = "900 76px 'Noto Serif JP', serif";
  ctx.fillText("Sumi Requiem", w / 2, h / 2 - 90);
  ctx.fillStyle = Palette.seal;
  ctx.font = "600 22px 'Noto Serif JP', serif";
  ctx.fillText("墨 の 輪 廻  —  an ink & wash roguelike", w / 2, h / 2 - 52);

  // Seal stamp.
  ctx.save();
  ctx.translate(w / 2 + 235, h / 2 - 120);
  ctx.rotate(-0.06);
  ctx.fillStyle = Palette.seal;
  roundRect(ctx, -26, -26, 52, 52, 6);
  ctx.fill();
  ctx.fillStyle = Palette.paper;
  ctx.font = "900 30px 'Noto Serif JP', serif";
  ctx.fillText("命", 0, 11);
  ctx.restore();

  const buttons: Button[] = [];
  const btn = (id: string, label: string, cy: number, wBtn = 260) => {
    const b: Button = { x: w / 2 - wBtn / 2, y: cy, w: wBtn, h: 52, id };
    drawButton(ctx, b, label, hit(b, mx, my));
    buttons.push(b);
  };
  btn("start", "Begin the Descent", h / 2 + 10);
  btn("shrine", "Ink Shrine  (upgrades)", h / 2 + 76);
  btn("help", "How to Play", h / 2 + 142);

  // Stats footer.
  ctx.fillStyle = Palette.ink70;
  ctx.font = "500 13px 'Cinzel', serif";
  ctx.fillText(
    `Essence ${meta.data.essence}   ·   Best Depth ${meta.data.bestDepth}   ·   Bosses Felled ${meta.data.bossKills}`,
    w / 2,
    h - 40
  );

  ctx.restore();
  return buttons;
}

export function drawButton(
  ctx: CanvasRenderingContext2D,
  b: Button,
  label: string,
  hovered: boolean,
  enabled = true
) {
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  ctx.fillStyle = hovered && enabled ? Palette.ink : "rgba(30,26,18,0.08)";
  roundRect(ctx, b.x, b.y, b.w, b.h, 8);
  ctx.fill();
  ctx.strokeStyle = Palette.ink;
  ctx.lineWidth = hovered ? 2.5 : 1.5;
  ctx.stroke();
  ctx.fillStyle = hovered && enabled ? Palette.paper : Palette.ink;
  ctx.font = "600 18px 'Noto Serif JP', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2 + 1);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

// ---- Talisman draft --------------------------------------------------------
const RARITY_LABEL: Record<string, string> = {
  common: "Common",
  rare: "Rare",
  mythic: "Mythic",
};
const RARITY_COLOR: Record<string, string> = {
  common: Palette.ink,
  rare: Palette.indigo,
  mythic: Palette.vermilion,
};

export function drawDraft(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  options: Talisman[],
  mx: number,
  my: number,
  canReroll: boolean
): Button[] {
  // Dim backdrop.
  ctx.fillStyle = "rgba(20,16,10,0.35)";
  ctx.fillRect(0, 0, w, h);

  title(ctx, w, "Choose a Talisman", "an offering rises from the ink", 108);

  const buttons: Button[] = [];
  const cardW = 240;
  const cardH = 320;
  const gap = 34;
  const totalW = options.length * cardW + (options.length - 1) * gap;
  let x = w / 2 - totalW / 2;
  const y = h / 2 - cardH / 2 + 20;

  for (const t of options) {
    const b: Button = { x, y, w: cardW, h: cardH, id: "pick", data: t };
    drawTalismanCard(ctx, b, t, hit(b, mx, my));
    buttons.push(b);
    x += cardW + gap;
  }

  if (canReroll) {
    const rb: Button = { x: w / 2 - 90, y: y + cardH + 26, w: 180, h: 44, id: "reroll" };
    drawButton(ctx, rb, "Reroll  (spend combo)", hit(rb, mx, my));
    buttons.push(rb);
  }

  return buttons;
}

function drawTalismanCard(
  ctx: CanvasRenderingContext2D,
  b: Button,
  t: Talisman,
  hovered: boolean
) {
  ctx.save();
  const lift = hovered ? -8 : 0;
  ctx.translate(0, lift);
  // Paper card.
  ctx.fillStyle = Palette.paper;
  ctx.shadowColor = "rgba(20,16,10,0.35)";
  ctx.shadowBlur = hovered ? 26 : 12;
  ctx.shadowOffsetY = hovered ? 14 : 8;
  roundRect(ctx, b.x, b.y, b.w, b.h, 10);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  const rc = RARITY_COLOR[t.rarity];
  ctx.strokeStyle = rc;
  ctx.lineWidth = hovered ? 3 : 2;
  roundRect(ctx, b.x, b.y, b.w, b.h, 10);
  ctx.stroke();

  const cx = b.x + b.w / 2;

  // Big seal glyph.
  ctx.save();
  ctx.translate(cx, b.y + 86);
  ctx.fillStyle = rc;
  roundRect(ctx, -42, -42, 84, 84, 10);
  ctx.fill();
  ctx.fillStyle = Palette.paper;
  ctx.font = "900 52px 'Noto Serif JP', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(t.kanji, 0, 3);
  ctx.textBaseline = "alphabetic";
  ctx.restore();

  // Kind tag.
  ctx.textAlign = "center";
  ctx.fillStyle = rc;
  ctx.font = "600 12px 'Cinzel', serif";
  ctx.fillText(
    `${RARITY_LABEL[t.rarity]}  ·  ${t.kind === "active" ? "ACTIVE" : "PASSIVE"}`,
    cx,
    b.y + 152
  );

  // Name.
  ctx.fillStyle = Palette.ink;
  ctx.font = "700 20px 'Noto Serif JP', serif";
  ctx.fillText(t.name, cx, b.y + 180);

  // Description (wrapped).
  ctx.fillStyle = Palette.ink70;
  ctx.font = "400 14px 'Noto Serif JP', serif";
  wrapText(ctx, t.desc, cx, b.y + 208, b.w - 36, 19);

  ctx.restore();
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxW: number,
  lh: number
) {
  const words = text.split(" ");
  let line = "";
  let yy = y;
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, cx, yy);
      line = word;
      yy += lh;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, cx, yy);
}

// ---- Shrine (meta upgrades) ------------------------------------------------
export function drawShrine(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  meta: Meta,
  mx: number,
  my: number
): Button[] {
  ctx.fillStyle = "rgba(20,16,10,0.15)";
  ctx.fillRect(0, 0, w, h);
  title(ctx, w, "Ink Shrine", `Essence  ${meta.data.essence}`, 90);

  const buttons: Button[] = [];
  const rowH = 74;
  const listW = 620;
  const x = w / 2 - listW / 2;
  let y = 150;
  for (const u of META_UPGRADES) {
    const lvl = meta.level(u.id);
    const cost = meta.upgradeCost(u);
    const b: Button = { x, y, w: listW, h: rowH - 12, id: "buy", data: u };
    const hovered = hit(b, mx, my);
    const affordable = cost !== null && meta.data.essence >= cost;

    ctx.fillStyle = hovered && affordable ? "rgba(30,26,18,0.1)" : "rgba(30,26,18,0.04)";
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fill();
    ctx.strokeStyle = affordable ? Palette.seal : Palette.ink30;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = Palette.ink;
    ctx.font = "700 18px 'Noto Serif JP', serif";
    ctx.fillText(u.name, x + 18, y + 26);
    ctx.fillStyle = Palette.ink70;
    ctx.font = "400 13px 'Noto Serif JP', serif";
    ctx.fillText(u.desc, x + 18, y + 46);

    // Level pips.
    ctx.textAlign = "right";
    for (let i = 0; i < u.maxLevel; i++) {
      ctx.fillStyle = i < lvl ? Palette.seal : Palette.ink15;
      ctx.beginPath();
      ctx.arc(x + listW - 130 + i * 16, y + 20, 5, 0, TAU);
      ctx.fill();
    }
    // Cost.
    ctx.fillStyle = cost === null ? Palette.jade : affordable ? Palette.seal : Palette.ink50;
    ctx.font = "700 15px 'Cinzel', serif";
    ctx.fillText(cost === null ? "MAX" : `${cost}`, x + listW - 20, y + 46);

    buttons.push(b);
    y += rowH;
  }

  const back: Button = { x: w / 2 - 90, y: y + 14, w: 180, h: 46, id: "back" };
  drawButton(ctx, back, "Return", hit(back, mx, my));
  buttons.push(back);
  return buttons;
}

// ---- Game over / victory ---------------------------------------------------
export function drawEnd(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  victory: boolean,
  depth: number,
  essence: number,
  mx: number,
  my: number
): Button[] {
  ctx.fillStyle = victory ? "rgba(20,16,10,0.4)" : "rgba(30,10,6,0.5)";
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = "center";
  ctx.fillStyle = victory ? Palette.ink : Palette.vermilion;
  ctx.font = "900 64px 'Noto Serif JP', serif";
  ctx.fillText(victory ? "終 — The Ink Settles" : "散 — Undone", w / 2, h / 2 - 60);

  ctx.fillStyle = Palette.ink70;
  ctx.font = "500 18px 'Noto Serif JP', serif";
  ctx.fillText(
    victory
      ? "The Drowned Calligrapher is stilled. The scroll is complete."
      : `You fell at depth ${depth + 1}. The brush passes on.`,
    w / 2,
    h / 2 - 18
  );
  ctx.fillStyle = Palette.seal;
  ctx.font = "600 16px 'Cinzel', serif";
  ctx.fillText(`+${essence} ink essence gathered`, w / 2, h / 2 + 12);

  const buttons: Button[] = [];
  const b1: Button = { x: w / 2 - 140, y: h / 2 + 50, w: 130, h: 50, id: "again" };
  drawButton(ctx, b1, "Descend Again", hit(b1, mx, my));
  const b2: Button = { x: w / 2 + 10, y: h / 2 + 50, w: 130, h: 50, id: "menu" };
  drawButton(ctx, b2, "Main Menu", hit(b2, mx, my));
  buttons.push(b1, b2);
  return buttons;
}

// ---- Pause / help ----------------------------------------------------------
export function drawPause(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mx: number,
  my: number,
  muted: boolean
): Button[] {
  ctx.fillStyle = "rgba(20,16,10,0.45)";
  ctx.fillRect(0, 0, w, h);
  title(ctx, w, "Paused", "the brush rests", h / 2 - 150);

  const buttons: Button[] = [];
  const resume: Button = { x: w / 2 - 130, y: h / 2 - 60, w: 260, h: 50, id: "resume" };
  drawButton(ctx, resume, "Resume", hit(resume, mx, my));
  const mute: Button = { x: w / 2 - 130, y: h / 2, w: 260, h: 50, id: "mute" };
  drawButton(ctx, mute, muted ? "Unmute Audio" : "Mute Audio", hit(mute, mx, my));
  const quit: Button = { x: w / 2 - 130, y: h / 2 + 60, w: 260, h: 50, id: "quit" };
  drawButton(ctx, quit, "Abandon Run", hit(quit, mx, my));
  buttons.push(resume, mute, quit);
  return buttons;
}

export function drawHelp(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mx: number,
  my: number
): Button[] {
  ctx.fillStyle = "rgba(20,16,10,0.2)";
  ctx.fillRect(0, 0, w, h);
  title(ctx, w, "How to Play", "master the brush", 90);

  const lines: [string, string][] = [
    ["Move", "W A S D  /  Arrow Keys"],
    ["Aim", "Mouse"],
    ["Light Attack", "Left Click  /  J   — chain for a 3-hit combo"],
    ["Heavy Attack", "Right Click  /  K   — costs ink, breaks poise"],
    ["Dodge", "Space  /  Shift   — brief invulnerability"],
    ["Parry", "F  /  L   — time it to deflect & counter (slows time)"],
    ["Talisman Ability", "E  /  Q   — spends ink"],
    ["Pause", "Esc"],
  ];
  ctx.textAlign = "left";
  const x = w / 2 - 260;
  let y = 170;
  for (const [k, v] of lines) {
    ctx.fillStyle = Palette.seal;
    ctx.font = "700 17px 'Noto Serif JP', serif";
    ctx.fillText(k, x, y);
    ctx.fillStyle = Palette.ink;
    ctx.font = "400 16px 'Noto Serif JP', serif";
    ctx.fillText(v, x + 170, y);
    y += 34;
  }

  ctx.textAlign = "center";
  ctx.fillStyle = Palette.ink70;
  ctx.font = "400 15px 'Noto Serif JP', serif";
  y += 6;
  wrapText(
    ctx,
    "Parrying is your strongest tool: a clean parry heals you, restores ink, and unleashes a counter. Read enemy telegraphs — the red flare means a hit is coming.",
    w / 2,
    y,
    560,
    22
  );

  const back: Button = { x: w / 2 - 90, y: y + 80, w: 180, h: 46, id: "back" };
  drawButton(ctx, back, "Return", hit(back, mx, my));
  return [back];
}
