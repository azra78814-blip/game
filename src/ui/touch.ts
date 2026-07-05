import { TAU } from "../core/math";
import { Input, TOUCH_BUTTONS } from "../core/input";
import { Palette } from "../render/palette";

// Draws the on-screen touch controls in the ink aesthetic: a floating brush
// joystick where the thumb rests, and a thumb-cluster of calligraphic action
// buttons. Rendered in screen space (1280x720 internal), so it lines up with
// the hit-testing in Input.

export function drawTouchControls(ctx: CanvasRenderingContext2D, input: Input) {
  ctx.save();

  // Action buttons (bottom-right).
  for (const b of TOUCH_BUTTONS) {
    const held = input.isButtonHeld(b.action);
    ctx.globalAlpha = held ? 0.95 : 0.5;
    // Ink disc.
    ctx.fillStyle = held ? Palette.seal : "rgba(30,26,18,0.16)";
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = held ? 3 : 2;
    ctx.strokeStyle = held ? Palette.seal : Palette.ink50;
    ctx.stroke();
    // Kanji glyph.
    ctx.globalAlpha = held ? 1 : 0.72;
    ctx.fillStyle = held ? Palette.paper : Palette.ink;
    ctx.font = `900 ${Math.round(b.r * 0.9)}px 'Noto Serif JP', serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(b.kanji, b.x, b.y + 1);
  }
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha = 1;

  // Floating joystick.
  const joy = input.joystick();
  if (joy.active) {
    ctx.globalAlpha = 0.5;
    // Base ring.
    ctx.strokeStyle = Palette.ink50;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(joy.baseX, joy.baseY, 92, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = "rgba(30,26,18,0.08)";
    ctx.beginPath();
    ctx.arc(joy.baseX, joy.baseY, 92, 0, TAU);
    ctx.fill();
    // Knob (ink blob).
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = Palette.seal;
    ctx.beginPath();
    ctx.arc(joy.knobX, joy.knobY, 36, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
