import { clamp, TAU } from "../core/math";
import { brushStroke, inkBlob } from "../render/brush";
import { inkTone, Palette } from "../render/palette";
import type { Player } from "../entities/player";
import type { Talisman } from "../game/talismans";

// In-world HUD drawn in screen space: an ink-brush health bar, ink meter,
// combo counter, ability icon, and run depth. Styled as calligraphy on paper.

const RARITY_COLOR: Record<string, string> = {
  common: Palette.ink,
  rare: Palette.indigo,
  mythic: Palette.vermilion,
};

export function drawHUD(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  player: Player,
  depth: number,
  roomLabel: string,
  enemiesLeft: number,
  time: number
) {
  ctx.save();

  // ---- Health bar (top-left) as a loaded brush stroke ----
  const barX = 34;
  const barY = 36;
  const barW = 300;
  drawBrushBar(ctx, barX, barY, barW, 18, player.hp / player.maxHp, Palette.vermilion, 0.9);
  ctx.fillStyle = Palette.ink;
  ctx.font = "600 13px 'Noto Serif JP', serif";
  ctx.textAlign = "left";
  ctx.fillText(`${Math.ceil(player.hp)} / ${player.maxHp}`, barX + 4, barY + 34);

  // Shield charges (Ink Bulwark) as indigo pips beside the health readout.
  if (player.maxShield > 0) {
    for (let i = 0; i < player.maxShield; i++) {
      ctx.fillStyle = i < player.shield ? Palette.indigo : Palette.ink15;
      ctx.beginPath();
      ctx.arc(barX + 90 + i * 16, barY + 30, 5, 0, TAU);
      ctx.fill();
    }
  }

  // ---- Ink meter below ----
  const inkY = barY + 44;
  drawBrushBar(ctx, barX, inkY, barW * 0.72, 12, player.ink / player.maxInk, Palette.indigo, 0.8);

  // ---- Ability icon (bottom-left) + owned-ability tray ----
  const t = player.talismans.active;
  if (t) {
    drawAbilityIcon(ctx, 42, h - 78, t, player.abilityCooldown, t.activeCooldown ?? 1, player.ink >= (t.inkCost ?? 0));
    if (player.talismans.actives.length > 1) drawAbilityTray(ctx, 42, h - 118, player);
  }

  // ---- Owned talismans list (right side) ----
  drawTalismanColumn(ctx, w - 30, 44, player);

  // ---- Combo counter (center-ish, floating) ----
  if (player.comboCount >= 2) {
    const scale = 1 + clamp((player.comboTimer - 2.6) * 2, 0, 0.4);
    ctx.save();
    ctx.translate(w / 2, 70);
    ctx.scale(scale, scale);
    ctx.textAlign = "center";
    ctx.font = "900 30px 'Noto Serif JP', serif";
    ctx.fillStyle = player.comboCount >= 8 ? Palette.vermilion : Palette.ink;
    ctx.globalAlpha = clamp(player.comboTimer, 0, 1);
    ctx.fillText(`${player.comboCount}`, 0, 0);
    ctx.font = "600 12px 'Cinzel', serif";
    ctx.fillText("COMBO", 0, 16);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ---- Depth / room label (top-right) ----
  ctx.textAlign = "right";
  ctx.fillStyle = Palette.ink;
  ctx.font = "700 15px 'Cinzel', serif";
  ctx.fillText(roomLabel, w - 34, 40);
  ctx.font = "500 12px 'Noto Serif JP', serif";
  ctx.fillStyle = Palette.ink70;
  ctx.fillText(`Depth ${depth + 1}`, w - 34, 58);
  if (enemiesLeft > 0) {
    ctx.fillStyle = Palette.vermilion;
    ctx.fillText(`${enemiesLeft} remain`, w - 34, 76);
  } else {
    ctx.fillStyle = Palette.jade;
    ctx.fillText("cleared — seek the gate", w - 34, 76);
  }

  ctx.restore();
}

function drawBrushBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  color: string,
  tone: number
) {
  frac = clamp(frac, 0, 1);
  // Track (pale ink wash).
  ctx.globalAlpha = 0.25;
  brushStroke(ctx, x, y + h / 2, x + w, y + h / 2, h, 0.4, 0.1);
  ctx.globalAlpha = 1;
  // Fill (colored brush).
  if (frac > 0.001) {
    const fw = w * frac;
    ctx.save();
    ctx.beginPath();
    // clip to a slightly organic capsule
    ctx.rect(x - h, y - h, fw + h * 1.5, h * 3);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    brushStroke(ctx, x, y + h / 2, x + w, y + h / 2, h, 0.85, 0.12);
    // recolor overlay
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = color;
    ctx.fillRect(x - h, y - h, w + h * 2, h * 3);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawAbilityIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: Talisman,
  cooldown: number,
  maxCd: number,
  hasInk: boolean
) {
  const r = 26;
  ctx.save();
  ctx.translate(x + r, y + r);
  // Seal-style rounded square.
  ctx.fillStyle = hasInk && cooldown <= 0 ? Palette.seal : Palette.washLight;
  roundRect(ctx, -r, -r, r * 2, r * 2, 8);
  ctx.fill();
  // Kanji glyph.
  ctx.fillStyle = Palette.paper;
  ctx.font = "900 30px 'Noto Serif JP', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(t.kanji, 0, 2);
  // Cooldown sweep.
  if (cooldown > 0) {
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = Palette.ink;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const frac = cooldown / maxCd;
    ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.textBaseline = "alphabetic";
  // Key hint.
  ctx.fillStyle = Palette.ink70;
  ctx.font = "600 11px 'Cinzel', serif";
  ctx.fillText("E", 0, r + 14);
  ctx.restore();
}

/** Row of chips for every owned active ability; the equipped one is highlighted
 *  and each shows its own cooldown. A hint reminds the player how to swap. */
function drawAbilityTray(ctx: CanvasRenderingContext2D, x: number, y: number, player: Player) {
  const actives = player.talismans.actives;
  const size = 24;
  const gap = 6;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < actives.length; i++) {
    const a = actives[i];
    const cx = x + i * (size + gap);
    const selected = i === player.talismans.activeIndex;
    ctx.fillStyle = selected ? Palette.seal : Palette.ink15;
    roundRect(ctx, cx, y, size, size, 6);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = Palette.vermilion;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = selected ? Palette.paper : Palette.ink70;
    ctx.font = "900 15px 'Noto Serif JP', serif";
    ctx.fillText(a.kanji, cx + size / 2, y + size / 2 + 1);
    // Per-ability cooldown shade.
    const cd = player.talismans.remainingCooldown(a.id);
    if (cd > 0) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = Palette.ink;
      const frac = clamp(cd / (a.activeCooldown ?? 1), 0, 1);
      roundRect(ctx, cx, y + size * (1 - frac), size, size * frac, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = Palette.ink50;
  ctx.font = "600 10px 'Cinzel', serif";
  ctx.textAlign = "left";
  ctx.fillText("Q / 換  swap", x, y - 6);
  ctx.restore();
}

function drawTalismanColumn(ctx: CanvasRenderingContext2D, x: number, y: number, player: Player) {
  const owned = player.talismans.owned;
  // Group by id with counts.
  const seen = new Map<string, { t: Talisman; n: number }>();
  for (const t of owned) {
    const e = seen.get(t.id);
    if (e) e.n++;
    else seen.set(t.id, { t, n: 1 });
  }
  let yy = y + 90;
  ctx.textAlign = "right";
  for (const { t, n } of seen.values()) {
    ctx.fillStyle = RARITY_COLOR[t.rarity] ?? Palette.ink;
    ctx.font = "600 12px 'Noto Serif JP', serif";
    const label = n > 1 ? `${t.name} ×${n}` : t.name;
    ctx.globalAlpha = 0.85;
    ctx.fillText(`${t.kanji}  ${label}`, x, yy);
    ctx.globalAlpha = 1;
    yy += 20;
  }
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
