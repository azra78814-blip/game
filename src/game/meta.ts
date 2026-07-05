// Persistent meta-progression saved to localStorage. Between runs the player
// spends "ink essence" on permanent unlocks that make future runs stronger —
// the roguelite hook that rewards repeated play.

export interface MetaUpgrade {
  id: string;
  name: string;
  desc: string;
  maxLevel: number;
  cost: (level: number) => number;
}

export const META_UPGRADES: MetaUpgrade[] = [
  {
    id: "vitality",
    name: "Enduring Body",
    desc: "+15 starting max health per level.",
    maxLevel: 5,
    cost: (l) => 40 + l * 40,
  },
  {
    id: "power",
    name: "Honed Brush",
    desc: "+8% starting damage per level.",
    maxLevel: 5,
    cost: (l) => 50 + l * 50,
  },
  {
    id: "reservoir",
    name: "Deep Inkwell",
    desc: "+15 starting max ink per level.",
    maxLevel: 4,
    cost: (l) => 40 + l * 35,
  },
  {
    id: "fortune",
    name: "Fortune's Favor",
    desc: "Improves talisman rarity odds per level.",
    maxLevel: 3,
    cost: (l) => 80 + l * 80,
  },
  {
    id: "second-wind",
    name: "Second Wind",
    desc: "Revive once per run at 40% health (level 1 unlocks).",
    maxLevel: 1,
    cost: () => 250,
  },
];

interface SaveData {
  essence: number;
  upgrades: Record<string, number>;
  bestDepth: number;
  bossKills: number;
  runs: number;
}

const KEY = "sumi-requiem-save-v1";

export class Meta {
  data: SaveData;

  constructor() {
    this.data = this.load();
  }

  private load(): SaveData {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SaveData;
        return {
          essence: parsed.essence ?? 0,
          upgrades: parsed.upgrades ?? {},
          bestDepth: parsed.bestDepth ?? 0,
          bossKills: parsed.bossKills ?? 0,
          runs: parsed.runs ?? 0,
        };
      }
    } catch {
      /* ignore corrupt save */
    }
    return { essence: 0, upgrades: {}, bestDepth: 0, bossKills: 0, runs: 0 };
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable */
    }
  }

  level(id: string): number {
    return this.data.upgrades[id] ?? 0;
  }

  upgradeCost(u: MetaUpgrade): number | null {
    const lvl = this.level(u.id);
    if (lvl >= u.maxLevel) return null;
    return u.cost(lvl);
  }

  buy(u: MetaUpgrade): boolean {
    const cost = this.upgradeCost(u);
    if (cost === null || this.data.essence < cost) return false;
    this.data.essence -= cost;
    this.data.upgrades[u.id] = this.level(u.id) + 1;
    this.save();
    return true;
  }

  addEssence(n: number) {
    this.data.essence += n;
    this.save();
  }

  recordRun(depth: number, killedBoss: boolean) {
    this.data.runs += 1;
    this.data.bestDepth = Math.max(this.data.bestDepth, depth);
    if (killedBoss) this.data.bossKills += 1;
    this.save();
  }

  /** Starting bonuses derived from purchased upgrades. */
  startBonuses() {
    return {
      bonusHp: this.level("vitality") * 15,
      bonusDamage: this.level("power") * 0.08,
      bonusInk: this.level("reservoir") * 15,
      fortune: this.level("fortune"),
      revive: this.level("second-wind") > 0,
    };
  }
}
