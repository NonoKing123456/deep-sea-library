// Procedural sound design for 《深海图书馆》: every sound is synthesized here from noise / oscillators,
// placed on the same timeline the picture uses (common.js), then mixed to a 48 kHz stereo WAV.
// Usage: node src/audio.js <out.wav> [cues.txt]
const fs = require('fs');
const { clamp, lerp, smooth, lin, rng, DUR, EV, BUB, bubbleRand, pageTime, orbTime, lampOffTime } = require('./common');

const SR = 48000, N = Math.ceil(DUR * SR), TAU = Math.PI * 2;
const L = new Float32Array(N), R = new Float32Array(N);     // dry bus
const WL = new Float32Array(N), WR = new Float32Array(N);   // reverb send
const cues = [];
const cue = (t, name) => cues.push([t, name]);

// ---------------- DSP helpers ----------------
class BQ { // RBJ biquad
  constructor(type, f, q = 0.707) { this.type = type; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, q); }
  set(f, q = this.q) {
    this.q = q; const w = TAU * clamp(f, 10, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    let b0, b1, b2; const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    if (this.type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (this.type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; } // band-pass (0 dB peak)
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  p(x) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
}
const white = (seed) => { const r = rng(seed); return () => r() * 2 - 1; };
function brown(seed) { const w = white(seed); let v = 0; return () => { v = (v + 0.02 * w()) * 0.998; return v * 3.5; }; }

// place a mono signal: fn(i, tLocal) -> sample, for `dur` seconds at time t0
function place(t0, dur, fn, { pan = 0, gain = 1, send = 0.2, muffle = 0 } = {}) {
  const s0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  const gl = Math.cos((pan + 1) * Math.PI / 4) * gain, gr = Math.sin((pan + 1) * Math.PI / 4) * gain;
  const lp = muffle > 0 ? new BQ('lp', lerp(12000, 700, muffle), 0.6) : null;
  for (let i = 0; i < n; i++) {
    const j = s0 + i; if (j < 0) continue; if (j >= N) break;
    let x = fn(i, i / SR); if (lp) x = lp.p(x);
    L[j] += x * gl; R[j] += x * gr; WL[j] += x * gl * send; WR[j] += x * gr * send;
  }
}
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));

// ---------------- underwater / surface state ----------------
const underwater = (t) => (t > EV.splash && t < EV.breach) ? 1 : 0;
const inMemory = (t) => smooth(EV.iris + 1.1, EV.iris + 2.0, t) * (1 - smooth(EV.irisOut, EV.irisOut + 1.0, t));
const lampsOn = (t) => { let k = 0; for (let i = 0; i < EV.lampN; i++) if (t < lampOffTime(i) + 0.1) k++; return k / EV.lampN; };

// ---------------- beds (continuous layers) ----------------
function beds() {
  const wA = white(11), wB = white(12), br1 = brown(13), br2 = brown(14), wC = white(15), wD = white(16);
  const waveLP_L = new BQ('lp', 900, 0.5), waveLP_R = new BQ('lp', 900, 0.5), washL = new BQ('hp', 2500), washR = new BQ('hp', 2500);
  const uwL = new BQ('lp', 260, 0.6), uwR = new BQ('lp', 260, 0.6);
  const roomL = new BQ('lp', 520, 0.5), roomR = new BQ('lp', 520, 0.5);
  const rushL = new BQ('lp', 200, 0.8), rushR = new BQ('lp', 200, 0.8);
  const muffleL = new BQ('lp', 500, 0.6), muffleR = new BQ('lp', 500, 0.6);
  for (let j = 0; j < N; j++) {
    const t = j / SR;
    // --- surface sea (sunset + dawn + the beach inside the memory) ---
    const swell = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(t * TAU / 6.3) * Math.sin(t * TAU / 9.1 + 1), 1.5);
    const surf = (t < EV.splash ? 1 - smooth(5.0, 5.7, t) * 0.0 : 0) + smooth(EV.breach - 0.1, EV.breach + 0.6, t);
    const mem = inMemory(t);
    let sL = waveLP_L.p(wA()) * 1.6 + washL.p(wC()) * 0.25 * swell, sR = waveLP_R.p(wB()) * 1.6 + washR.p(wD()) * 0.25 * swell;
    const surfGain = (surf * 0.32 + mem * 0.22) * swell * (j / SR < 0.8 ? t / 0.8 : 1);
    // heard muffled from below right after the splash / just before breaching
    const below = (smooth(EV.splash, EV.splash + 0.2, t) * (1 - smooth(EV.splash + 1, EV.splash + 3.5, t)) + smooth(85.0, EV.breach, t) * (t < EV.breach ? 1 : 0)) * 0.6;
    L[j] += sL * surfGain + muffleL.p(sL) * below * 0.5;
    R[j] += sR * surfGain + muffleR.p(sR) * below * 0.5;
    // --- underwater rumble, deeper (louder, darker) with depth ---
    const depth = t < 9 ? lin(EV.splash, 9, t) * 0.4 : t < 19 ? lerp(0.4, 1, lin(9, 19, t)) : t < 82 ? 1 : lerp(1, 0.4, lin(82, EV.breach, t));
    const uw = underwater(t) * (0.5 + 0.6 * depth) * (1 - 0.65 * mem) * (0.85 + 0.15 * Math.sin(t * 0.7));
    uwL.set(lerp(420, 180, depth)); uwR.set(lerp(420, 180, depth));
    const u1 = br1(), u2 = br2();
    L[j] += uwL.p(u1) * uw * 0.045; R[j] += uwR.p(u2) * uw * 0.045; // brown() has std ≈ 1.1
    // pressure drone (very low, two detuned sines)
    const dr = underwater(t) * depth * 0.035 * (1 - mem) * (t > 79 && t < 82 ? 1 + 0.8 * smooth(79, 81.5, t) : 1);
    const d = (Math.sin(TAU * 55 * t) + Math.sin(TAU * 55.7 * t + 1)) * dr;
    L[j] += d; R[j] += d;
    // --- hall room tone + warm lamp hum (fades as lamps die) ---
    const hall = smooth(29, 29.8, t) * (1 - smooth(81.5, 82.0, t)) * (1 - mem);
    if (hall > 0) {
      const on = lampsOn(t);
      const room = hall * (0.35 + 0.3 * on);
      L[j] += roomL.p(u2) * room * 0.03; R[j] += roomR.p(u1) * room * 0.03;
      const hum = hall * on * 0.012 * (1 + 0.3 * Math.sin(t * 3.1));
      const h = Math.sin(TAU * 100 * t) * hum + Math.sin(TAU * 200 * t + 0.4) * hum * 0.5 + Math.sin(TAU * 300.5 * t) * hum * 0.2;
      L[j] += h; R[j] += h * 0.9;
    }
    // --- ascent: rushing water rising in pitch ---
    const asc = smooth(82.3, 84, t) * (1 - smooth(EV.breach - 0.1, EV.breach + 0.1, t));
    if (asc > 0) {
      rushL.set(lerp(200, 1800, lin(82.3, EV.breach, t)), 0.8); rushR.set(lerp(200, 1800, lin(82.3, EV.breach, t)), 0.8);
      L[j] += rushL.p(wA()) * asc * 0.5; R[j] += rushR.p(wB()) * asc * 0.5;
    }
  }
}

// ---------------- events ----------------
function gull(t0, pan, gain, muffle = 0) {
  cue(t0, 'gull');
  const r = rng(Math.round(t0 * 100));
  let tt = t0;
  for (let k = 0; k < 2 + Math.floor(r() * 2); k++) {
    const dur = 0.32 + r() * 0.15, f0 = 1500 + r() * 400;
    const bp = new BQ('bp', 2200, 1.2);
    let ph = 0;
    place(tt, dur, (i, x) => {
      const u = x / dur, f = f0 * (1 + 0.35 * Math.sin(Math.min(1, u * 1.4) * Math.PI)) * (1 + 0.02 * Math.sin(x * TAU * 28));
      ph += TAU * f / SR;
      const s = Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph + 1);
      return bp.p(s) * Math.sin(u * Math.PI) ** 0.7;
    }, { pan, gain, send: 0.35, muffle });
    tt += dur + 0.08 + r() * 0.12;
  }
}
function splash(t0, gain, pan = 0) {
  cue(t0, 'splash');
  const w = white(Math.round(t0 * 77)), lp = new BQ('lp', 8000, 0.7), hp = new BQ('hp', 150);
  place(t0, 1.4, (i, x) => { lp.set(lerp(9000, 900, Math.min(1, x / 0.9))); return hp.p(lp.p(w())) * env(x, 0.006, 0.28) * 1.3; }, { pan, gain, send: 0.3 });
  let ph = 0; place(t0, 0.6, (i, x) => { ph += TAU * lerp(110, 38, Math.min(1, x / 0.3)) / SR; return Math.sin(ph) * env(x, 0.004, 0.12); }, { pan, gain: gain * 0.9, send: 0.1 });
  const r = rng(Math.round(t0 * 31)); // droplets falling back
  for (let k = 0; k < 26; k++) dropBlip(t0 + 0.25 + r() * 1.3, pan + (r() - 0.5) * 0.8, gain * (0.1 + r() * 0.15), 900 + r() * 1800, 0);
}
function dropBlip(t0, pan, gain, f0, muffle) {
  let ph = 0;
  place(t0, 0.08, (i, x) => { ph += TAU * f0 * (1 + 2.5 * x / 0.08) / SR; return Math.sin(ph) * env(x, 0.002, 0.018); }, { pan, gain, send: 0.15, muffle });
}
function bubbleBlip(t0, size, pan, gain, muffle = 0.35) {
  const f0 = lerp(1100, 280, size); let ph = 0;
  place(t0, 0.12, (i, x) => { ph += TAU * f0 * (1 + 1.4 * Math.min(1, x / 0.05)) / SR; return Math.sin(ph) * env(x, 0.003, 0.035); }, { pan, gain, send: 0.25, muffle });
}
function inhale(t0, dur, gain, pan) {
  const w = white(Math.round(t0 * 997)), bp = new BQ('bp', 1300, 0.9), bp2 = new BQ('bp', 2600, 2);
  place(t0, dur, (i, x) => { const u = x / dur; return (bp.p(w()) + 0.3 * bp2.p(w())) * Math.sin(u * Math.PI) ** 1.5; }, { pan, gain, send: 0.12 });
}
function helmetBreath(sched, gain, pan, label) {
  const o = BUB[sched];
  for (let k = Math.ceil(o.t0 / o.period); k * o.period <= o.on[1]; k++) {
    const te = k * o.period;
    if (te < o.on[0] - 0.4 || (o.until != null && te > o.until)) continue;
    // a slow breath every third exhaust (breathing every burst sounded like panting)
    if (sched !== 's1splash' && te - 1.1 > o.on[0] && k % 3 === 0) inhale(te - 1.1, 0.9, gain * 0.4, pan);
    for (let i = 0; i < o.n; i++) {
      const R = bubbleRand(o, k, i), tb = te + R[0] * 0.45;
      if (tb < o.on[0] || tb > o.on[1]) continue;
      bubbleBlip(tb, R[1], pan + (R[6] - 0.5) * 0.3, gain * (0.5 + 0.5 * R[2]));
    }
  }
  cue(o.on[0], `bubbles+breath (${label})`);
}
function click(t0, gain, pan = 0, f = 3200) {
  const w = white(Math.round(t0 * 1000)); let ph = 0;
  place(t0, 0.05, (i, x) => { ph += TAU * f / SR; return w() * env(x, 0.0005, 0.002) * 0.8 + Math.sin(ph) * env(x, 0.0005, 0.012) * 0.6; }, { pan, gain, send: 0.2 });
}
function thud(t0, gain, pan = 0, f0 = 70, muffle = 0.5) {
  let ph = 0; const w = white(Math.round(t0 * 55)), lp = new BQ('lp', 400);
  place(t0, 0.7, (i, x) => { ph += TAU * lerp(f0, f0 * 0.6, Math.min(1, x / 0.3)) / SR; return Math.sin(ph) * env(x, 0.004, 0.11) + lp.p(w()) * env(x, 0.003, 0.05) * 0.6; }, { pan, gain, send: 0.25, muffle });
}
function sandHiss(t0, gain, pan = 0, dur = 1.2) {
  const w = white(Math.round(t0 * 71)), bp = new BQ('bp', 2800, 0.7);
  place(t0, dur, (i, x) => bp.p(w()) * env(x, 0.02, dur * 0.3), { pan, gain, send: 0.2, muffle: 0.3 });
}
function whoosh(t0, dur, gain, panFrom, panTo, f0, f1, muffle = 0) {
  const w = white(Math.round(t0 * 313)), bp = new BQ('bp', f0, 1.1);
  const s0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  for (let i = 0; i < n; i++) {
    const j = s0 + i; if (j < 0 || j >= N) continue;
    const u = i / n; bp.set(lerp(f0, f1, u), 1.1);
    const x = bp.p(w()) * Math.sin(u * Math.PI) ** 2 * gain * (muffle ? 0.8 : 1);
    const pan = lerp(panFrom, panTo, u), gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    L[j] += x * gl; R[j] += x * gr; WL[j] += x * gl * 0.3; WR[j] += x * gr * 0.3;
  }
}
function pageFlip(t0, gain, pan, muffle = 0.15) {
  const w = white(Math.round(t0 * 4441)), bp = new BQ('bp', 2500, 0.8), hp = new BQ('hp', 900);
  const r = rng(Math.round(t0 * 17)); const dur = 0.28 + r() * 0.12;
  place(t0, dur, (i, x) => {
    const u = x / dur; bp.set(lerp(1800, 5200, u), 0.8);
    const flutter = 0.6 + 0.4 * Math.sin(x * TAU * (22 + r() * 0.0));
    return (bp.p(w()) * 1.2 + hp.p(w()) * 0.25) * Math.pow(Math.sin(u * Math.PI), 0.6) * flutter * (u < 0.85 ? 1 : 1 + 2 * (u - 0.85));
  }, { pan, gain, send: 0.3, muffle });
  // the page settling: tiny soft tap
  place(t0 + dur * 0.9, 0.06, (i, x) => w() * env(x, 0.001, 0.008), { pan, gain: gain * 0.5, send: 0.2, muffle: 0.6 });
}
function chime(t0, f, gain, pan, dur = 3) {
  cue(t0, `chime ${Math.round(f)}Hz`);
  place(t0, dur, (i, x) => {
    const e = env(x, 0.004, dur * 0.28);
    return (Math.sin(TAU * f * x) + 0.4 * Math.sin(TAU * f * 2.01 * x) * env(x, 0.003, 0.4) + 0.2 * Math.sin(TAU * f * 3.02 * x) * env(x, 0.002, 0.2)) * e;
  }, { pan, gain, send: 0.6 });
}
function bell(t0, f, gain, dur = 5) { // inharmonic, gong-like
  const parts = [[1, 1, 1], [2.76, 0.5, 0.6], [5.4, 0.3, 0.35], [8.93, 0.15, 0.2], [0.5, 0.6, 1.4]];
  place(t0, dur, (i, x) => { let s = 0; for (const [m, a, d] of parts) s += Math.sin(TAU * f * m * x + m) * a * env(x, 0.01, dur * 0.22 * d); return s; }, { gain, send: 0.8, muffle: 0.35 });
}
function pad(t0, dur, freqs, gain, attack = 1.5) {
  place(t0, dur, (i, x) => {
    const e = Math.min(1, x / attack) * (1 - smooth(dur - 1.5, dur, x));
    let s = 0; freqs.forEach((f, k) => { s += Math.sin(TAU * f * x + k) * (1 + 0.3 * Math.sin(x * 0.9 + k)) + 0.3 * Math.sin(TAU * f * 1.003 * x); });
    return s / freqs.length * e;
  }, { gain, send: 0.7, muffle: 0.2 });
}
function scrape(t0, dur, gain, pan) {
  const w = white(Math.round(t0 * 991)), bp = new BQ('bp', 1100, 1.5), r = rng(5);
  let stick = 1;
  place(t0, dur, (i, x) => { if (i % 480 === 0) stick = 0.4 + r() * 0.8; return bp.p(w()) * stick * Math.sin(x / dur * Math.PI) ** 0.5; }, { pan, gain, send: 0.3, muffle: 0.3 });
}
function sparks(t0, gain, pan) {
  const r = rng(Math.round(t0 * 123));
  for (let k = 0; k < 12; k++) click(t0 + r() * 0.7, gain * (0.2 + r() * 0.4), pan + (r() - 0.5) * 0.3, 4000 + r() * 3000);
}
function shimmer(t0, dur, gain, base = 880) {
  const fr = [1, 1.5, 2, 2.52, 3];
  place(t0, dur, (i, x) => {
    const e = smooth(0, dur * 0.3, x) * (1 - smooth(dur * 0.75, dur, x));
    let s = 0; fr.forEach((m, k) => { s += Math.sin(TAU * base * m * x + k) * (0.5 + 0.5 * Math.sin(x * (3 + k * 1.7) + k)) / (1 + k * 0.6); });
    return s * e * 0.4;
  }, { gain, send: 0.7 });
}
function flutter(t0, dur, gain, pan, rate) {
  const w = white(Math.round(t0 * 77)), bp = new BQ('bp', 3200, 1.2);
  place(t0, dur, (i, x) => bp.p(w()) * (0.5 + 0.5 * Math.sin(x * TAU * rate)) ** 3 * Math.sin(x / dur * Math.PI), { pan, gain, send: 0.25, muffle: 0.25 });
}

// ---------------- reverb (Schroeder) on the send bus ----------------
function reverb(inL, inR, wet, damp = 0.45) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => Math.round(d * SR / 44100));
  const aps = [225, 556, 441].map((d) => Math.round(d * SR / 44100));
  const run = (x, spread) => {
    const out = new Float32Array(N);
    for (const d0 of combs) {
      const d = d0 + spread, buf = new Float32Array(d); let idx = 0, lp = 0;
      for (let j = 0; j < N; j++) { const y = buf[idx]; lp = y * (1 - damp) + lp * damp; buf[idx] = x[j] + lp * 0.84; idx = (idx + 1) % d; out[j] += y; }
    }
    for (const d0 of aps) {
      const d = d0 + spread, buf = new Float32Array(d); let idx = 0;
      for (let j = 0; j < N; j++) { const b = buf[idx], y = -out[j] + b; buf[idx] = out[j] + b * 0.5; idx = (idx + 1) % d; out[j] = y; }
    }
    return out;
  };
  const oL = run(inL, 0), oR = run(inR, 23);
  for (let j = 0; j < N; j++) { L[j] += oL[j] * wet / combs.length; R[j] += oR[j] * wet / combs.length; }
}

// ================= SCORE (the cue list) =================
beds();
// shot 1 — sunset sea
gull(1.4, -0.6, 0.06); gull(3.7, 0.5, 0.045); gull(7.2, 0.2, 0.02, 0.8);
click(2.6, 0.05, -0.3, 1800); click(3.4, 0.04, -0.3, 1500); // helmet clasp being adjusted
cue(2.6, 'helmet adjust clicks');
thud(4.25, 0.12, -0.3, 160, 0.1); cue(4.25, 'hands grip the gunwale');
whoosh(5.0, 0.6, 0.18, -0.2, -0.3, 600, 1800); // falling backwards
splash(EV.splash, 0.55, -0.3);
whoosh(EV.splash + 0.05, 1.2, 0.25, -0.3, -0.2, 900, 250, 1); // plunge
helmetBreath('s1splash', 0.12, -0.3, 'splash burst');
helmetBreath('s1', 0.1, -0.2, 'shot 1');
// shot 2 — sinking
helmetBreath('s2', 0.11, 0, 'shot 2');
whoosh(10.6, 5.0, 0.07, 0.9, -0.9, 500, 800, 1); cue(10.6, 'fish school swish');
for (const [dt, a] of [[0, 1], [0.06, 0.6], [0.12, 0.8], [0.16, 0.5], [0.25, 0.9]]) click(EV.lampOn + dt, 0.13 * a, 0.05, 2600);
cue(EV.lampOn, 'helmet lamp click + flicker');
// shot 3 — seabed
helmetBreath('s3', 0.07, -0.45, 'shot 3 (far)');
thud(EV.land, 0.35, -0.5, 60, 0.6); sandHiss(EV.land + 0.02, 0.1, -0.5, 1.4); cue(EV.land, 'landing thud + sand');
for (const ts of [22.9, 24.0, 27.3, 28.4]) { thud(ts, 0.12, -0.45, 80, 0.7); sandHiss(ts, 0.035, -0.45, 0.6); }
cue(22.9, 'footsteps');
bell(EV.libWake, 98, 0.12, 6); pad(EV.libWake - 0.2, 3.4, [110, 164.8, 220, 246.9, 329.6], 0.07); cue(EV.libWake, 'library wakes: distant metallic bell + warm pad');
// shot 4 — hall
helmetBreath('s4', 0.1, 0.1, 'shot 4');
for (let k = 0; k < 4; k++) whoosh(29.6 + k * 1.21, 0.9, 0.05, -0.2, 0.3, 300, 700, 1); // swim strokes
scrape(EV.pull - 0.3, 0.55, 0.22, 0.5); thud(EV.pull + 0.25, 0.1, 0.5, 220, 0.4); cue(EV.pull - 0.3, 'book slides out of the shelf');
// shot 5 — pages to fish
helmetBreath('s5', 0.12, -0.25, 'shot 5 (close)');
thud(40.45, 0.12, 0.2, 180, 0.3); pageFlip(40.5, 0.2, 0.2); cue(40.45, 'book opens');
for (let i = 0; i < EV.pageN; i++) {
  const r = rng(300 + i); r(); const dirS = r() < 0.5 ? 1 : -1;
  pageFlip(pageTime(i), 0.34, 0.25 + (i % 3 - 1) * 0.1);
  flutter(pageTime(i) + 0.8, 4.2, 0.05, dirS * 0.4, 2.2);
}
cue(EV.pageT0, `12 page flips (every ${EV.pageGap}s) + paper-fish flutter`);
whoosh(49.45, 1.05, 0.4, 0.95, -0.95, 400, 2200, 0); cue(49.45, 'big paper fish whoosh past the lens');
// shot 6 — teal book + first memory
pageFlip(EV.open2 + 0.1, 0.25, 0); thud(EV.open2 + 0.95, 0.1, -0.2, 150, 0.3); cue(EV.open2, 'cover opens');
shimmer(EV.open2 + 0.6, 4.4, 0.08, 880); cue(EV.open2 + 0.6, 'light shimmer from the pages');
whoosh(EV.iris - 0.5, 2.0, 0.3, 0, 0, 300, 5000, 0); chime(EV.iris + 1.1, 587.3, 0.05, 0, 3); cue(EV.iris - 0.5, 'push into the light');
gull(EV.iris + 2.1, 0.5, 0.05); gull(EV.iris + 4.3, -0.4, 0.04); flutter(EV.iris + 1.4, 4.2, 0.03, 0.4, 3.4); cue(EV.iris + 1.4, 'memory: beach waves, gulls, kite');
whoosh(EV.irisOut, 1.2, 0.2, 0, 0, 4000, 300, 0); cue(EV.irisOut, 'memory closes');
// shot 7 — memory orbs (each book opens + a pentatonic chime)
helmetBreath('s78', 0.09, 0, 'shots 7–8');
const PENTA = [587.3, 659.3, 740.0, 880.0, 987.8, 1174.7, 1318.5, 1480.0];
for (let i = 0; i < EV.orbN; i++) { const side = i % 2 ? 0.6 : -0.6; pageFlip(orbTime(i), 0.1, side); chime(orbTime(i) + 0.25, PENTA[[0, 2, 4, 1, 3, 5, 7, 6][i]], 0.045, side * 0.7, 3.2); }
shimmer(68.4, 2.6, 0.05, 1320); cue(68.4, 'reaching for an orb: shimmer');
// shot 8 — the lamps go out, far to near (quiet far, louder near)
for (let k = 0; k < EV.lampN; k++) {
  const tt = lampOffTime(k), g = lerp(0.05, 0.22, k / (EV.lampN - 1));
  click(tt, g, 0, 1800); thud(tt + 0.01, g * 0.6, 0, 120, 0.3); sparks(tt + 0.03, g * 0.35, 0);
}
cue(EV.lampOffT0, `10 lamp-off ticks (every ${EV.lampOffGap}s) + sparks`);
// shot 9 — ascent and breach
helmetBreath('s9', 0.12, 0, 'shot 9 ascent');
splash(EV.breach, 0.45, 0); cue(EV.breach, 'breach');
gull(88.0, -0.5, 0.06); gull(89.0, 0.6, 0.05);
chime(EV.endTitle, 587.3, 0.04, -0.2, 3); chime(EV.endTitle + 0.35, 740.0, 0.035, 0.2, 3); chime(EV.endTitle + 0.7, 880.0, 0.035, 0, 3);
cue(EV.endTitle, 'title chimes');

// ---------------- mix down ----------------
reverb(WL, WR, 0.55);
// fade in/out + master
let peak = 0;
for (let j = 0; j < N; j++) {
  const t = j / SR, f = Math.min(1, t / 0.3) * (1 - smooth(89.2, 90, t));
  L[j] *= f; R[j] *= f; peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j]));
}
const gain = 0.89 / peak * 2.0; // +3.5 dB; the few splash peaks go into the tanh soft-clipper below
const out = Buffer.alloc(44 + N * 4);
out.write('RIFF', 0); out.writeUInt32LE(36 + N * 4, 4); out.write('WAVE', 8); out.write('fmt ', 12);
out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28);
out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(N * 4, 40);
for (let j = 0; j < N; j++) {
  out.writeInt16LE(Math.round(clamp(Math.tanh(L[j] * gain * 1.1) * 0.92, -1, 1) * 32767), 44 + j * 4);
  out.writeInt16LE(Math.round(clamp(Math.tanh(R[j] * gain * 1.1) * 0.92, -1, 1) * 32767), 46 + j * 4);
}
fs.writeFileSync(process.argv[2] || 'audio.wav', out);
cues.sort((a, b) => a[0] - b[0]);
const lines = cues.filter((c, i) => i === 0 || c[1] !== cues[i - 1][1] || c[0] - cues[i - 1][0] > 0.5).map(([t, n]) => `${t.toFixed(2).padStart(6)}s  ${n}`);
if (process.argv[3]) fs.writeFileSync(process.argv[3], lines.join('\n') + '\n');
console.log(`peak ${peak.toFixed(3)} -> gain ${gain.toFixed(2)}; ${cues.length} cues`);
