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
  KeyQ: "ability",
  Escape: "pause",
  Enter: "confirm",
};

interface Buffered {
  time: number;
}

export class Input {
  private down = new Set<Action>();
  private pressedEdge = new Set<Action>();
  private buffer = new Map<Action, Buffered>();
  readonly mouse = { x: 0, y: 0, worldX: 0, worldY: 0, down: false, rightDown: false };
  private now = 0;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const a = KEY_MAP[e.code];
    if (!a) return;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code))
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

  /** Normalized movement vector from held direction keys. */
  moveVector(): { x: number; y: number } {
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
