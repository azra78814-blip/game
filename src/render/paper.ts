import { fx } from "../core/rng";
import { Palette } from "./palette";

// Pre-render an aged rice-paper texture to an offscreen canvas once, then blit
// it. Fibres, blotches and a vignette give the "washi" feel cheaply.

export class PaperTexture {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(w: number, h: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d")!;
    this.render(w, h);
  }

  private render(w: number, h: number) {
    const ctx = this.ctx;
    // Base gradient wash.
    const g = ctx.createRadialGradient(w * 0.5, h * 0.42, h * 0.1, w * 0.5, h * 0.5, h * 0.9);
    g.addColorStop(0, "#efe8d6");
    g.addColorStop(0.65, Palette.paper);
    g.addColorStop(1, Palette.paperEdge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Faint mottled blotches (older, damper patches of paper).
    for (let i = 0; i < 90; i++) {
      const x = fx.range(0, w);
      const y = fx.range(0, h);
      const r = fx.range(40, 220);
      const bg = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = fx.range(0.015, 0.05);
      bg.addColorStop(0, `rgba(90, 78, 55, ${a})`);
      bg.addColorStop(1, "rgba(90, 78, 55, 0)");
      ctx.fillStyle = bg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Fine horizontal paper fibres.
    ctx.globalAlpha = 0.04;
    ctx.strokeStyle = "#7a6c4c";
    ctx.lineWidth = 1;
    for (let i = 0; i < 260; i++) {
      const y = fx.range(0, h);
      const x = fx.range(0, w);
      const len = fx.range(20, 120);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + fx.range(-2, 2));
      ctx.stroke();
    }

    // Speckle grain.
    ctx.globalAlpha = 1;
    for (let i = 0; i < 1400; i++) {
      const x = fx.range(0, w);
      const y = fx.range(0, h);
      ctx.fillStyle = `rgba(60, 50, 35, ${fx.range(0.02, 0.08)})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // Edge vignette to frame the scene.
    const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, h * 0.4, w * 0.5, h * 0.5, h * 0.85);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(40, 32, 20, 0.28)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.drawImage(this.canvas, 0, 0);
  }
}
