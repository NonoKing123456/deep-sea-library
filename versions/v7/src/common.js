// Shared timeline + math helpers (used by both picture and sound so they stay in sync).
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const lin = (a, b, x) => clamp((x - a) / (b - a));
const bump = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3);
const easeIn = (u) => Math.pow(clamp(u), 3);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Keyed tracks: keys = [[t, [v...]], ...] ; eased (smoothstep) between keys.
function track(keys, t, ease = true) {
  if (t <= keys[0][0]) return keys[0][1].slice();
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) {
      const u = t1 === t0 ? 1 : (ease ? smooth(t0, t1, t) : lin(t0, t1, t));
      return v0.map((x, j) => lerp(x, v1[j], u));
    }
  }
  return keys[keys.length - 1][1].slice();
}

// ---------------- Timeline ----------------
const SHOTS = [
  { id: 1, t0: 0, t1: 9, name: '黄昏海面 · 入水' },
  { id: 2, t0: 9, t1: 19, name: '下潜' },
  { id: 3, t0: 19, t1: 29, name: '海底发现图书馆' },
  { id: 4, t0: 29, t1: 40, name: '大厅 · 抽书' },
  { id: 5, t0: 40, t1: 50, name: '书页变鱼群' },
  { id: 6, t0: 50, t1: 61, name: '第一段回忆' },
  { id: 7, t0: 61, t1: 72, name: '回忆泡泡' },
  { id: 8, t0: 72, t1: 82, name: '灯一盏盏熄灭' },
  { id: 9, t0: 82, t1: 90, name: '浮出海面' },
];
const DUR = 90;

const EV = {
  tipBack: 5.0,        // diver starts falling backwards off the boat
  splash: 5.6,         // hits the water
  lampOn: 15.0,        // helmet lamp clicks on
  land: 21.0,          // touches the sand
  sweep0: 22.0, sweep1: 26.0, // lamp sweeps across library
  libWake: 25.6,       // library windows glow
  pull: 36.0,          // pulls the red book
  pageT0: 41.6, pageGap: 0.55, pageN: 12, // pages -> fish
  open2: 51.0,         // teal book opens
  iris: 54.0,          // push into memory
  irisOut: 59.8,       // memory closes back
  orbT0: 62.0, orbGap: 0.85, orbN: 8,     // shelf books open, memory orbs rise
  lampOffT0: 73.0, lampOffGap: 0.8, lampN: 10, // hall lamps go out far->near
  breach: 87.0,        // breaks the surface
  endTitle: 88.0,
};

// Helmet-exhaust bubble schedules, shared by the picture (fx.bubbles) and the sound (bubble blips).
// A burst leaves the valve every `period` s from t0; each of the n bubbles has its own small delay.
const BUB = {
  s1splash: { t0: 5.6, period: 0.18, n: 7, seed: 2, until: 6.5, life: 2.2, speed: 260, on: [5.6, 9] },
  s1: { t0: 6.8, period: 1.0, n: 6, seed: 3, life: 3.0, speed: 150, on: [6.8, 9] },
  s2: { t0: 8.6, period: 1.15, n: 6, seed: 9, life: 3.4, speed: 150, on: [9, 19] },
  s3: { t0: 18.6, period: 1.2, n: 6, seed: 13, life: 3.2, speed: 140, on: [19, 29] },
  s4: { t0: 29.0, period: 1.1, n: 6, seed: 17, life: 3.0, speed: 120, on: [29, 40] },
  s5: { t0: 39.0, period: 1.25, n: 6, seed: 19, life: 3.2, speed: 150, on: [40, 50] },
  s78: { t0: 60.5, period: 1.3, n: 6, seed: 23, life: 3.2, speed: 130, on: [61, 82] },
  s9: { t0: 81.6, period: 0.5, n: 5, seed: 29, until: 86.7, life: 2.6, speed: 160, on: [82, 87] },
};
// per-bubble random numbers (same order used by picture and sound): [delay, size, speed, wobF, wobPh, wobAmp, drift]
function bubbleRand(o, k, i) {
  const r = rng((o.seed || 1) * 7919 + k * 131);
  let out; for (let j = 0; j <= i; j++) out = [r(), r(), r(), r(), r(), r(), r()];
  return out;
}

const shotAt = (t) => SHOTS.find((s) => t >= s.t0 && t < s.t1) || SHOTS[SHOTS.length - 1];
const pageTime = (i) => EV.pageT0 + i * EV.pageGap;
const orbTime = (i) => EV.orbT0 + i * EV.orbGap;
const lampOffTime = (i) => EV.lampOffT0 + i * EV.lampOffGap; // i=0 is the farthest lamp

module.exports = { clamp, lerp, smooth, lin, bump, easeInOut, easeOut, easeIn, rng, track,
  SHOTS, DUR, EV, BUB, bubbleRand, shotAt, pageTime, orbTime, lampOffTime };
