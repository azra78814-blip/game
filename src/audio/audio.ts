import { fx } from "../core/rng";

// Fully synthesized audio — zero asset files. The music is a slow, breathing
// pentatonic drift (guqin/koto flavour) with a soft percussion pulse; the SFX
// are all shaped noise/oscillator bursts. An "intensity" value crossfades the
// score between contemplative exploration and driving combat.

// Chinese/Japanese pentatonic scale (relative to a root), in semitones.
const PENTA = [0, 2, 4, 7, 9];

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;
  private reverb!: ConvolverNode;
  private started = false;

  private intensity = 0; // 0 explore .. 1 combat
  private intensityTarget = 0;
  private nextNoteTime = 0;
  private step = 0;
  private root = 57; // A3
  private schedulerTimer = 0;
  muted = false;

  init() {
    if (this.ctx) return;
    const AC =
      window.AudioContext || (window as unknown as any).webkitAudioContext;
    this.ctx = new AC();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.0;
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 0.9;

    // Simple algorithmic reverb (noise impulse response).
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.4, 2.6);
    const reverbGain = ctx.createGain();
    reverbGain.gain.value = 0.32;
    this.reverb.connect(reverbGain);
    reverbGain.connect(this.master);

    this.musicGain.connect(this.master);
    this.musicGain.connect(this.reverb);
    this.sfxGain.connect(this.master);
    this.sfxGain.connect(this.reverb);
  }

  private makeImpulse(duration: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** Must be called from a user gesture to satisfy autoplay policies. */
  async resume() {
    this.init();
    if (this.ctx!.state === "suspended") await this.ctx!.resume();
    if (!this.started) {
      this.started = true;
      this.nextNoteTime = this.ctx!.currentTime + 0.1;
      this.scheduler();
      this.fadeMusic(0.55, 3);
    }
  }

  private fadeMusic(to: number, time: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(this.muted ? 0 : to, now + time);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.value = m ? 0 : 0.85;
  }

  setIntensity(v: number) {
    this.intensityTarget = Math.max(0, Math.min(1, v));
  }

  // ---- Music scheduler ---------------------------------------------------
  private scheduler = () => {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.intensity += (this.intensityTarget - this.intensity) * 0.05;

    // Tempo speeds up with intensity.
    const bpm = 60 + this.intensity * 46;
    const stepDur = 60 / bpm / 2; // eighth notes

    while (this.nextNoteTime < ctx.currentTime + 0.2) {
      this.scheduleStep(this.step, this.nextNoteTime, stepDur);
      this.nextNoteTime += stepDur;
      this.step++;
    }
    this.schedulerTimer = window.setTimeout(this.scheduler, 40);
  };

  private scheduleStep(step: number, time: number, dur: number) {
    const beat = step % 16;
    const intensity = this.intensity;

    // Drone / pad every 8 steps.
    if (beat % 8 === 0) {
      this.playPad(this.root - 12, time, dur * 8, 0.12 + intensity * 0.05);
    }

    // Plucked melody — sparse when calm, busier when intense.
    const density = 0.25 + intensity * 0.5;
    if (fx.next() < density) {
      const octave = fx.pick([0, 12, 12, 24]);
      const deg = fx.pick(PENTA);
      const note = this.root + deg + octave;
      this.playPluck(note, time, 0.35 + intensity * 0.25, dur);
    }

    // Percussion pulse — a soft taiko-ish thump on strong beats when in combat.
    if (intensity > 0.25 && beat % 4 === 0) {
      this.playDrum(time, 0.3 + intensity * 0.5);
    }
    // Woodblock ticks in intense sections.
    if (intensity > 0.55 && beat % 2 === 1 && fx.bool(0.6)) {
      this.playTick(time, 0.15 * intensity);
    }
  }

  private playPluck(midi: number, time: number, gain: number, dur: number) {
    const ctx = this.ctx!;
    const freq = midiToFreq(midi);
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc.type = "triangle";
    osc2.type = "sine";
    osc.frequency.value = freq;
    osc2.frequency.value = freq * 2.01;
    const g = ctx.createGain();
    const decay = 0.9 + dur * 2;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(gain, time + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    osc.connect(g);
    osc2.connect(g2);
    g2.connect(g);
    g.connect(this.musicGain);
    osc.start(time);
    osc2.start(time);
    osc.stop(time + decay);
    osc2.stop(time + decay);
  }

  private playPad(midi: number, time: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const freq = midiToFreq(midi);
    [1, 1.5].forEach((mult, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(gain * (i === 0 ? 1 : 0.5), time + dur * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, time + dur);
      osc.connect(g);
      g.connect(this.musicGain);
      osc.start(time);
      osc.stop(time + dur);
    });
  }

  private playDrum(time: number, gain: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, time);
    osc.frequency.exponentialRampToValueAtTime(52, time + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.34);
    osc.connect(g);
    g.connect(this.musicGain);
    osc.start(time);
    osc.stop(time + 0.36);
  }

  private playTick(time: number, gain: number) {
    const ctx = this.ctx!;
    const buf = this.noiseBurst(0.05);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.musicGain);
    src.start(time);
  }

  private noiseBurst(dur: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ---- SFX ---------------------------------------------------------------
  private env(node: AudioNode, time: number, attack: number, gain: number, decay: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(gain, time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
    node.connect(g);
    g.connect(this.sfxGain);
    return g;
  }

  private t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  swing(power = 1) {
    if (!this.ctx) return;
    const time = this.t();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBurst(0.25);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900 + power * 400, time);
    bp.frequency.exponentialRampToValueAtTime(2600, time + 0.12);
    bp.Q.value = 0.8;
    src.connect(bp);
    this.env(bp, time, 0.005, 0.28 * power, 0.16);
    src.start(time);
  }

  hit(power = 1, pitch = 1) {
    if (!this.ctx) return;
    const time = this.t();
    // Body thump.
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180 * pitch, time);
    osc.frequency.exponentialRampToValueAtTime(60 * pitch, time + 0.1);
    this.env(osc, time, 0.002, 0.5 * power, 0.16);
    osc.start(time);
    osc.stop(time + 0.2);
    // Wet splat noise.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBurst(0.12);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    src.connect(lp);
    this.env(lp, time, 0.002, 0.32 * power, 0.12);
    src.start(time);
  }

  parry() {
    if (!this.ctx) return;
    const time = this.t();
    // Bright metallic ring — two detuned high oscillators.
    [1, 1.5, 2.02].forEach((m, i) => {
      const osc = this.ctx!.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1200 * m, time);
      osc.frequency.exponentialRampToValueAtTime(900 * m, time + 0.3);
      this.env(osc, time, 0.001, 0.22 / (i + 1), 0.5);
      osc.start(time);
      osc.stop(time + 0.6);
    });
    // Impact spark noise.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBurst(0.1);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    src.connect(hp);
    this.env(hp, time, 0.001, 0.3, 0.1);
    src.start(time);
  }

  dodge() {
    if (!this.ctx) return;
    const time = this.t();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBurst(0.3);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(400, time);
    bp.frequency.exponentialRampToValueAtTime(1800, time + 0.2);
    src.connect(bp);
    this.env(bp, time, 0.005, 0.18, 0.22);
    src.start(time);
  }

  inkBurst() {
    if (!this.ctx) return;
    const time = this.t();
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, time);
    osc.frequency.exponentialRampToValueAtTime(80, time + 0.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1800, time);
    lp.frequency.exponentialRampToValueAtTime(300, time + 0.3);
    osc.connect(lp);
    this.env(lp, time, 0.005, 0.32, 0.35);
    osc.start(time);
    osc.stop(time + 0.4);
  }

  hurt() {
    if (!this.ctx) return;
    const time = this.t();
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, time);
    osc.frequency.exponentialRampToValueAtTime(110, time + 0.25);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    osc.connect(lp);
    this.env(lp, time, 0.002, 0.35, 0.3);
    osc.start(time);
    osc.stop(time + 0.35);
  }

  pickup() {
    if (!this.ctx) return;
    const time = this.t();
    [0, 4, 7].forEach((deg, i) => {
      const osc = this.ctx!.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = midiToFreq(72 + deg);
      this.env(osc, time + i * 0.05, 0.005, 0.2, 0.25);
      osc.start(time + i * 0.05);
      osc.stop(time + i * 0.05 + 0.3);
    });
  }

  bossRoar() {
    if (!this.ctx) return;
    const time = this.t();
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(70, time);
    osc.frequency.linearRampToValueAtTime(45, time + 1.4);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(600, time);
    lp.frequency.linearRampToValueAtTime(180, time + 1.4);
    const osc2 = this.ctx.createOscillator();
    osc2.type = "square";
    osc2.frequency.setValueAtTime(35, time);
    osc.connect(lp);
    osc2.connect(lp);
    this.env(lp, time, 0.05, 0.5, 1.5);
    osc.start(time);
    osc2.start(time);
    osc.stop(time + 1.6);
    osc2.stop(time + 1.6);
  }

  uiSelect() {
    if (!this.ctx) return;
    const time = this.t();
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, time);
    osc.frequency.exponentialRampToValueAtTime(780, time + 0.08);
    this.env(osc, time, 0.005, 0.16, 0.12);
    osc.start(time);
    osc.stop(time + 0.16);
  }

  dispose() {
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
  }
}

export const audio = new AudioEngine();
