import { damp, clamp } from "./math";
import { fx } from "./rng";

// Camera that follows a target with lookahead, plus juice: trauma-based screen
// shake, hitstop (global freeze frames) and time-dilation (slow-mo) for parries.

export class Camera {
  x = 0;
  y = 0;
  private targetX = 0;
  private targetY = 0;
  zoom = 1;
  private zoomTarget = 1;

  // Screen shake via "trauma" that decays; shake = trauma^2 for a punchy curve.
  private trauma = 0;
  private shakeSeed = fx.range(0, 1000);

  // Hitstop: freeze everything for a few ms on heavy impacts.
  private hitstop = 0;

  // Time dilation: multiplies dt (used for parry slow-mo). 1 = normal.
  private timeScaleTarget = 1;
  private timeScaleCur = 1;
  private timeScaleHold = 0;

  viewW: number;
  viewH: number;

  offsetX = 0;
  offsetY = 0;

  constructor(viewW: number, viewH: number) {
    this.viewW = viewW;
    this.viewH = viewH;
  }

  /** Update the viewport dimensions when the render resolution changes. */
  resize(viewW: number, viewH: number) {
    this.viewW = viewW;
    this.viewH = viewH;
  }

  snapTo(x: number, y: number) {
    this.x = this.targetX = x;
    this.y = this.targetY = y;
  }

  follow(x: number, y: number, lookX = 0, lookY = 0) {
    this.targetX = x + lookX;
    this.targetY = y + lookY;
  }

  addTrauma(amount: number) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  addHitstop(ms: number) {
    this.hitstop = Math.max(this.hitstop, ms);
  }

  /** Enter slow-motion at `scale` for `holdMs`, then ease back to normal. */
  slowmo(scale: number, holdMs: number) {
    this.timeScaleTarget = scale;
    this.timeScaleHold = holdMs;
  }

  setZoom(z: number) {
    this.zoomTarget = z;
  }

  /**
   * Advance camera. Returns the *scaled* dt the world should use this frame
   * (0 during hitstop, reduced during slow-mo). `rawDt` is real seconds.
   */
  update(rawDt: number): number {
    // Hitstop consumes real time but freezes the world.
    if (this.hitstop > 0) {
      this.hitstop -= rawDt * 1000;
      // still let the camera settle a touch so shake reads during freeze
      this.updateShake(rawDt);
      return 0;
    }

    // Time dilation bookkeeping.
    if (this.timeScaleHold > 0) {
      this.timeScaleHold -= rawDt * 1000;
      if (this.timeScaleHold <= 0) this.timeScaleTarget = 1;
    }
    this.timeScaleCur = damp(this.timeScaleCur, this.timeScaleTarget, 12, rawDt);

    const dt = rawDt * this.timeScaleCur;

    // Smooth follow (use rawDt so camera feel is unaffected by slow-mo).
    this.x = damp(this.x, this.targetX, 8, rawDt);
    this.y = damp(this.y, this.targetY, 8, rawDt);
    this.zoom = damp(this.zoom, this.zoomTarget, 6, rawDt);

    this.updateShake(rawDt);
    return dt;
  }

  private updateShake(rawDt: number) {
    this.trauma = clamp(this.trauma - rawDt * 1.8, 0, 1);
    const shake = this.trauma * this.trauma;
    const t = performance.now() * 0.001;
    const mag = shake * 26;
    // Smooth pseudo-noise from summed sines.
    this.offsetX =
      mag *
      (Math.sin((t + this.shakeSeed) * 47.3) * 0.6 +
        Math.sin((t + this.shakeSeed) * 91.7) * 0.4);
    this.offsetY =
      mag *
      (Math.cos((t + this.shakeSeed) * 53.1) * 0.6 +
        Math.cos((t + this.shakeSeed) * 83.9) * 0.4);
  }

  get timeScale(): number {
    return this.timeScaleCur;
  }

  get frozen(): boolean {
    return this.hitstop > 0;
  }

  /** Apply camera transform to a context. Caller must save/restore. */
  apply(ctx: CanvasRenderingContext2D) {
    ctx.translate(this.viewW / 2, this.viewH / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(
      -this.x + this.offsetX / this.zoom,
      -this.y + this.offsetY / this.zoom
    );
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewW / 2) / this.zoom + this.x - this.offsetX / this.zoom,
      y: (sy - this.viewH / 2) / this.zoom + this.y - this.offsetY / this.zoom,
    };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + this.offsetX + this.viewW / 2,
      y: (wy - this.y) * this.zoom + this.offsetY + this.viewH / 2,
    };
  }
}
