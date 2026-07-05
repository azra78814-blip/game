// Deterministic, seedable PRNG (mulberry32) so runs can be reproduced.

export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  static fromString(s: string): RNG {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return new RNG(h >>> 0);
  }

  /** Float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fisher-Yates shuffle, returns a new array. */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Pick `count` unique items without replacement. */
  sample<T>(arr: readonly T[], count: number): T[] {
    return this.shuffle(arr).slice(0, Math.min(count, arr.length));
  }

  /** Weighted pick. `weights[i]` corresponds to `arr[i]`. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  angle(): number {
    return this.next() * Math.PI * 2;
  }
}

// A convenient global RNG for cosmetic randomness (particles, brush jitter).
export const fx = new RNG((Math.random() * 1e9) >>> 0);
