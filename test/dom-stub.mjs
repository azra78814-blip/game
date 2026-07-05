// Minimal browser environment so the canvas game can run under Node for a
// headless smoke test. Every 2D-context method is a no-op; gradients/measure
// return plausible stubs.
const noop = () => {};

function makeCtx2D() {
  const grad = { addColorStop: noop };
  return new Proxy(
    {
      canvas: { width: 1280, height: 720 },
      measureText: () => ({ width: 12 }),
      createRadialGradient: () => grad,
      createLinearGradient: () => grad,
      createPattern: () => ({}),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      setLineDash: noop,
      save: noop,
      restore: noop,
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Any other accessed member is a callable no-op (fillRect, arc, etc.)
        // or a writable scratch property (fillStyle, globalAlpha, ...).
        return typeof prop === "string" && /^[a-z]/.test(prop) ? noop : undefined;
      },
      set() {
        return true;
      },
    }
  );
}

function makeCanvas() {
  return {
    width: 1280,
    height: 720,
    style: {},
    getContext: () => makeCtx2D(),
    addEventListener: noop,
    removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  };
}

const listeners = {};
globalThis.window = globalThis;
globalThis.__now = 0;
globalThis.performance = { now: () => globalThis.__now };
globalThis.requestAnimationFrame = (fn) => fn(globalThis.__now);
globalThis.cancelAnimationFrame = noop;
globalThis.setTimeout = (fn) => 0; // don't let schedulers run
globalThis.clearTimeout = noop;
globalThis.addEventListener = (t, fn) => {
  (listeners[t] ||= []).push(fn);
};
globalThis.removeEventListener = noop;

const canvasEl = makeCanvas();
globalThis.document = {
  getElementById: () => canvasEl,
  createElement: () => makeCanvas(),
  addEventListener: noop,
  fonts: { ready: Promise.resolve(), load: () => Promise.resolve() },
};

globalThis.localStorage = {
  _d: {},
  getItem(k) {
    return this._d[k] ?? null;
  },
  setItem(k, v) {
    this._d[k] = String(v);
  },
  removeItem(k) {
    delete this._d[k];
  },
};

class FakeAudioParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  cancelScheduledValues() {}
}
function fakeNode() {
  return new Proxy(
    {
      connect: () => fakeNode(),
      disconnect: noop,
      start: noop,
      stop: noop,
      gain: new FakeAudioParam(),
      frequency: new FakeAudioParam(),
      Q: new FakeAudioParam(),
      type: "sine",
      buffer: null,
    },
    { get: (t, p) => (p in t ? t[p] : () => fakeNode()), set: () => true }
  );
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  destination = fakeNode();
  state = "running";
  createGain = () => fakeNode();
  createOscillator = () => fakeNode();
  createBiquadFilter = () => fakeNode();
  createConvolver = () => fakeNode();
  createBufferSource = () => fakeNode();
  createBuffer = (ch, len) => ({
    getChannelData: () => new Float32Array(len),
    length: len,
  });
  resume = () => Promise.resolve();
}
globalThis.AudioContext = FakeAudioContext;
globalThis.webkitAudioContext = FakeAudioContext;
