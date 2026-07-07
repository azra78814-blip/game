// Keyboard + mouse input with buffered "just pressed" edges and an input buffer
// window that makes combat feel responsive (queues an action briefly).

export type Action =
  | "up"
  | "down"
  | "left"
  | "right"
  | "light"
  | "heavy"
  | "dodge"
  | "parry"
  | "ability"
  | "swapAbility"
  | "pause"
  | "confirm";

const KEY_MAP: Record<string, Action> = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  Space: "dodge",
  ShiftLeft: "dodge",
  ShiftRight: "dodge",
  KeyJ: "light",
  KeyK: "heavy",
  KeyL: "parry",
  KeyF: "parry",
  KeyE: "ability",
  KeyQ: "swapAbility",
  Tab: "swapAbility",
  Escape: "pause",
  Enter: "confirm",
};

interface Buffered {
  time: number;
}

// On-screen action buttons for touch. The internal render size is no longer a
// fixed 1280x720 — its width tracks the viewport aspect — so the thumb cluster
// is laid out relative to the live canvas size (w,h) instead of hard-coded
// coordinates. Both hit-testing and rendering call layoutTouchButtons() so they
// always agree.
export interface TouchButtonDef {
  action: Action;
  x: number;
  y: number;
  r: number;
  kanji: string;
  label: string;
}

export function layoutTouchButtons(w: number, h: number): TouchButtonDef[] {
  // Main attack anchored to the bottom-right corner; the rest fan up and to the
  // left in a generously spaced arc (the extra width is free real estate now).
  return [
    { action: "light", x: w - 120, y: h - 120, r: 58, kanji: "斬", label: "Attack" },
    { action: "dodge", x: w - 120, y: h - 268, r: 46, kanji: "避", label: "Dodge" },
    { action: "heavy", x: w - 262, y: h - 150, r: 44, kanji: "重", label: "Heavy" },
    { action: "parry", x: w - 266, y: h - 300, r: 40, kanji: "受", label: "Parry" },
    { action: "ability", x: w - 400, y: h - 120, r: 38, kanji: "術", label: "Skill" },
    { action: "swapAbility", x: w - 400, y: h - 235, r: 32, kanji: "換", label: "Swap" },
    { action: "pause", x: w * 0.5, y: 46, r: 26, kanji: "休", label: "Pause" },
  ];
}

type TouchRec =
  | { kind: "joy" }
  | { kind: "button"; action: Action }
  | { kind: "tap" };

export interface JoystickState {
  active: boolean;
  baseX: number;
  baseY: number;
  knobX: number;
  knobY: number;
}

const JOY_MAX = 92;

export class Input {
  private down = new Set<Action>();
  private pressedEdge = new Set<Action>();
  private buffer = new Map<Action, Buffered>();
  readonly mouse = { x: 0, y: 0, worldX: 0, worldY: 0, down: false, rightDown: false };
  private now = 0;
  private canvas: HTMLCanvasElement;

  // ---- Touch state ----
  usingTouch = false;
  /** When true, gameplay touch controls (joystick/buttons) are active; when
   *  false, touches behave as menu taps. Set by the game per frame. */
  touchControlsEnabled = false;
  private touches = new Map<number, TouchRec>();
  private joyId: number | null = null;
  private joyBaseX = 0;
  private joyBaseY = 0;
  private joyX = 0;
  private joyY = 0;
  private tapLatched = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("touchstart", this.onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", this.onTouchMove, { passive: false });
    window.addEventListener("touchend", this.onTouchEnd, { passive: false });
    window.addEventListener("touchcancel", this.onTouchEnd, { passive: false });
  }

  private mapPoint(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * this.canvas.width,
      y: ((clientY - r.top) / r.height) * this.canvas.height,
    };
  }

  private pressAction(a: Action) {
    if (!this.down.has(a)) this.pressedEdge.add(a);
    this.down.add(a);
    this.buffer.set(a, { time: this.now });
  }

  private onTouchStart = (e: TouchEvent) => {
    this.usingTouch = true;
    for (const t of Array.from(e.changedTouches)) {
      const p = this.mapPoint(t.clientX, t.clientY);
      if (!this.touchControlsEnabled) {
        // Menu / overlay: treat as a tap-click at that point.
        this.mouse.x = p.x;
        this.mouse.y = p.y;
        this.mouse.down = true;
        this.tapLatched = true;
        this.touches.set(t.identifier, { kind: "tap" });
        continue;
      }
      // Gameplay: buttons first, then joystick on the left, else attack.
      let hitAction: Action | null = null;
      for (const b of layoutTouchButtons(this.canvas.width, this.canvas.height)) {
        const dx = p.x - b.x;
        const dy = p.y - b.y;
        if (dx * dx + dy * dy <= b.r * b.r) {
          hitAction = b.action;
          break;
        }
      }
      if (hitAction) {
        this.pressAction(hitAction);
        this.touches.set(t.identifier, { kind: "button", action: hitAction });
      } else if (p.x < this.canvas.width * 0.5 && this.joyId === null) {
        this.joyId = t.identifier;
        this.joyBaseX = this.joyX = p.x;
        this.joyBaseY = this.joyY = p.y;
        this.touches.set(t.identifier, { kind: "joy" });
      } else {
        // Empty right-side tap acts as a light attack.
        this.pressAction("light");
        this.touches.set(t.identifier, { kind: "button", action: "light" });
      }
    }
    e.preventDefault();
  };

  private onTouchMove = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      const rec = this.touches.get(t.identifier);
      if (!rec) continue;
      const p = this.mapPoint(t.clientX, t.clientY);
      if (rec.kind === "joy") {
        this.joyX = p.x;
        this.joyY = p.y;
      } else if (rec.kind === "tap") {
        this.mouse.x = p.x;
        this.mouse.y = p.y;
      }
    }
    e.preventDefault();
  };

  private onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      const rec = this.touches.get(t.identifier);
      if (!rec) continue;
      this.touches.delete(t.identifier);
      if (rec.kind === "joy") {
        if (this.joyId === t.identifier) this.joyId = null;
      } else if (rec.kind === "button") {
        // Release the held action only if no other touch still holds it.
        let stillHeld = false;
        for (const r of this.touches.values())
          if (r.kind === "button" && r.action === rec.action) stillHeld = true;
        if (!stillHeld) this.down.delete(rec.action);
      } else if (rec.kind === "tap") {
        this.mouse.down = false;
      }
    }
    e.preventDefault();
  };

  /** One-shot tap flag for menu clicks (robust against same-frame down/up). */
  consumeTap(): boolean {
    if (this.tapLatched) {
      this.tapLatched = false;
      return true;
    }
    return false;
  }

  joystick(): JoystickState {
    if (this.joyId === null)
      return { active: false, baseX: 0, baseY: 0, knobX: 0, knobY: 0 };
    let dx = this.joyX - this.joyBaseX;
    let dy = this.joyY - this.joyBaseY;
    const len = Math.hypot(dx, dy);
    if (len > JOY_MAX) {
      dx = (dx / len) * JOY_MAX;
      dy = (dy / len) * JOY_MAX;
    }
    return {
      active: true,
      baseX: this.joyBaseX,
      baseY: this.joyBaseY,
      knobX: this.joyBaseX + dx,
      knobY: this.joyBaseY + dy,
    };
  }

  isButtonHeld(a: Action): boolean {
    for (const r of this.touches.values())
      if (r.kind === "button" && r.action === a) return true;
    return false;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const a = KEY_MAP[e.code];
    if (!a) return;
    if (["Space", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code))
      e.preventDefault();
    if (!this.down.has(a)) {
      this.pressedEdge.add(a);
      this.buffer.set(a, { time: this.now });
    }
    this.down.add(a);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const a = KEY_MAP[e.code];
    if (a) this.down.delete(a);
  };

  private onMouseMove = (e: MouseEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - r.left) / r.width) * this.canvas.width;
    this.mouse.y = ((e.clientY - r.top) / r.height) * this.canvas.height;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      this.mouse.down = true;
      this.pressedEdge.add("light");
      this.buffer.set("light", { time: this.now });
    } else if (e.button === 2) {
      this.mouse.rightDown = true;
      this.pressedEdge.add("heavy");
      this.buffer.set("heavy", { time: this.now });
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouse.down = false;
    if (e.button === 2) this.mouse.rightDown = false;
  };

  /** Advance internal clock; call once per frame before reading edges. */
  tick(now: number) {
    this.now = now;
  }

  /** Clear per-frame edges; call at end of frame. */
  endFrame() {
    this.pressedEdge.clear();
  }

  held(a: Action): boolean {
    return this.down.has(a);
  }

  pressed(a: Action): boolean {
    return this.pressedEdge.has(a);
  }

  /** Was the action pressed within `window` ms? Consumes the buffer if so. */
  consumeBuffered(a: Action, window = 140): boolean {
    const b = this.buffer.get(a);
    if (b && this.now - b.time <= window) {
      this.buffer.delete(a);
      return true;
    }
    return false;
  }

  /** Movement vector from the touch joystick (analog) or held direction keys. */
  moveVector(): { x: number; y: number } {
    if (this.joyId !== null) {
      const dx = this.joyX - this.joyBaseX;
      const dy = this.joyY - this.joyBaseY;
      const len = Math.hypot(dx, dy);
      if (len < JOY_MAX * 0.18) return { x: 0, y: 0 }; // deadzone
      const m = Math.min(len, JOY_MAX);
      return { x: (dx / len) * (m / JOY_MAX), y: (dy / len) * (m / JOY_MAX) };
    }
    let x = 0;
    let y = 0;
    if (this.down.has("left")) x -= 1;
    if (this.down.has("right")) x += 1;
    if (this.down.has("up")) y -= 1;
    if (this.down.has("down")) y += 1;
    if (x !== 0 && y !== 0) {
      const inv = 1 / Math.sqrt(2);
      x *= inv;
      y *= inv;
    }
    return { x, y };
  }
}
