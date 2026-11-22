// Atmosphere: god rays, caustics, bubbles, marine snow, water wobble, film grain, vignette.
// All effects are deterministic functions of t (seeded RNG), so any frame can be rendered alone.
const { clamp, lerp, smooth, rng } = require('./common');
const { M } = require('./diver');
const TAU = Math.PI * 2;

let mk = null;
const cache = {};
function setFactory(f) { mk = f; }
function buf(name, W, H, clear = true) {
  const k = `${name}_${W}x${H}`;
  if (!cache[k]) cache[k] = mk(W, H);
  const c = cache[k], g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  if (clear) g.clearRect(0, 0, W, H);
  return [c, g];
}

// ---- where bubbles leave the helmet (exhaust valve at the back of the helmet) ----
function exhaust(p) {
  const s = p.s || 1, f = p.f || 1;
  const base = M.mul(M.mul(M.tr(p.x, p.y), M.rot(p.rot || 0)), M.sc(s * f, s));
  const head = M.mul(M.mul(base, M.tr(0, -84)), M.rot(p.head || 0));
  return M.ap(head, -24, -48);
}

// ---- bubbles ----
// emit(te) -> [x, y, scale] world position of the exhaust at emission time te (or null = not emitting)
function bubbles(ctx, t, o) {
  const period = o.period || 1.1, life = o.life || 3.2, n = o.n || 6, t0 = o.t0 || 0, sp = o.speed || 170;
  const first = Math.max(t0, Math.floor((t - life) / period) * period);
  for (let k = Math.ceil(first / period); k * period <= t; k++) {
    const te = k * period;
    if (te < t0 || (o.until != null && te > o.until)) continue;
    const src = o.emit(te);
    if (!src) continue;
    const r = rng((o.seed || 1) * 7919 + k * 131);
    for (let i = 0; i < n; i++) {
      // draw all 7 numbers up front so a skipped bubble never shifts the next one's randoms (see common.bubbleRand)
      const R = [r(), r(), r(), r(), r(), r(), r()];
      const delay = R[0] * 0.45, age = t - te - delay;
      if (age < 0 || age > life) continue;
      const sc = src[2] || 1;
      const rad = (2.5 + R[1] * 6.5) * sc * (1 + age * 0.12);
      const rise = (sp * (0.7 + R[2] * 0.6) + (o.vRel || 0)) * age + 40 * age * age;
      const wob = Math.sin(age * (5 + R[3] * 4) + R[4] * TAU) * (4 + 6 * R[5]) * sc + (R[6] - 0.5) * 30 * sc * age;
      const x = src[0] + wob + (o.drift || 0) * age, y = src[1] - rise * sc;
      if (o.ceil != null && y < o.ceil) continue;
      const a = (1 - smooth(life * 0.75, life, age)) * (o.alpha || 1);
      drawBubble(ctx, x, y, rad, a, o.lit);
    }
  }
}
function drawBubble(ctx, x, y, r, a, lit) {
  if (a <= 0.01) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.fillStyle = lit ? 'rgba(255,236,190,0.22)' : 'rgba(200,240,250,0.18)';
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.strokeStyle = lit ? 'rgba(255,240,205,0.9)' : 'rgba(220,250,255,0.85)'; ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.22, 0, TAU); ctx.fill();
  ctx.restore();
}

// ---- marine snow / plankton (screen space with parallax) ----
// o: { n, seed, scrollX, scrollY (camera motion in px), vy (px/s drift), size, alpha, color, lightFn(x,y)->0..1 }
function marineSnow(ctx, t, o) {
  const r = rng(o.seed || 3), n = o.n || 120, VW = 1920, VH = 1080, pad = 40;
  for (let i = 0; i < n; i++) {
    const depth = 0.3 + r() * 0.9; // parallax factor
    const x0 = r() * (VW + pad * 2), y0 = r() * (VH + pad * 2), ph = r() * TAU, sz = (o.size || 2.2) * (0.5 + r()) * depth;
    let x = x0 - (o.scrollX || 0) * depth + Math.sin(t * 0.3 + ph) * 14 + (o.vx || 0) * t * depth;
    let y = y0 - (o.scrollY || 0) * depth + (o.vy == null ? -8 : o.vy) * t * depth + Math.cos(t * 0.25 + ph) * 8;
    x = ((x % (VW + pad * 2)) + VW + pad * 2) % (VW + pad * 2) - pad;
    y = ((y % (VH + pad * 2)) + VH + pad * 2) % (VH + pad * 2) - pad;
    let a = (o.alpha || 0.5) * (0.4 + 0.6 * depth) * (0.75 + 0.25 * Math.sin(t * 2 + ph));
    let col = o.color || '200,230,230';
    if (o.lightFn) { const L = o.lightFn(x, y); a = a * (o.darkMul == null ? 0.25 : o.darkMul) + L * 0.9; if (L > 0.1) col = '255,236,190'; }
    if (a <= 0.02) continue;
    ctx.fillStyle = `rgba(${col},${Math.min(1, a)})`;
    ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill();
  }
}

// ---- god rays from the surface (screen space) ----
function godRays(ctx, t, o) {
  const a = o.alpha || 0.3; if (a <= 0.005) return;
  const r = rng(o.seed || 11), n = o.n || 7, col = o.color || '200,240,235', tilt = o.tilt == null ? 0.22 : o.tilt;
  const top = o.top == null ? -60 : o.top, len = o.len || 1300;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const x = (o.x0 == null ? -200 : o.x0) + r() * (o.span || 2300) + Math.sin(t * 0.15 + i) * 40;
    const w0 = 40 + r() * 110, w1 = w0 * (2.2 + r() * 1.5);
    const k = a * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (0.4 + r() * 0.5) + r() * TAU)));
    const g = ctx.createLinearGradient(0, top, 0, top + len);
    g.addColorStop(0, `rgba(${col},${k})`); g.addColorStop(0.6, `rgba(${col},${k * 0.35})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    const dx = Math.tan(tilt) * len;
    ctx.beginPath(); ctx.moveTo(x - w0 / 2, top); ctx.lineTo(x + w0 / 2, top); ctx.lineTo(x + dx + w1 / 2, top + len); ctx.lineTo(x + dx - w1 / 2, top + len); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// ---- caustic net (bright wobbling cells) inside a band ----
function caustics(ctx, t, o) {
  const a = o.alpha || 0.15; if (a <= 0.005) return;
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(${o.color || '210,250,240'},${a})`; ctx.lineWidth = o.lw || 3; ctx.lineCap = 'round';
  const x0 = o.x0 == null ? -100 : o.x0, x1 = o.x1 == null ? 2020 : o.x1, y0 = o.y0, y1 = o.y1, cell = o.cell || 90;
  for (let y = y0; y < y1; y += cell * 0.6) {
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 18) {
      const yy = y + Math.sin(x * 0.021 + t * 1.3 + y * 0.05) * cell * 0.22 + Math.sin(x * 0.047 - t * 1.9) * cell * 0.12;
      if (x === x0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  for (let x = x0; x < x1; x += cell) {
    ctx.beginPath();
    for (let y = y0; y <= y1; y += 18) {
      const xx = x + Math.sin(y * 0.03 + t * 1.1 + x * 0.04) * cell * 0.25 + Math.sin(y * 0.07 + t * 2.1) * cell * 0.08;
      if (y === y0) ctx.moveTo(xx, y); else ctx.lineTo(xx, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ---- underwater refraction wobble: re-draw the frame in horizontal strips with sine offsets ----
function waterWobble(ctx, t, amp, yMinV = 0) {
  if (amp <= 0.05) return;
  const src = ctx.canvas, W = src.width, H = src.height;
  // Shifts whole pixel rows in place (integer offsets). Per-strip drawImage was ~0.5 s/frame; this is ~15 ms.
  const k = W / 1920;
  const y0 = Math.max(0, Math.floor(yMinV * k));
  if (y0 >= H) return;
  const img = ctx.getImageData(0, y0, W, H - y0);
  const px = new Uint32Array(img.data.buffer, img.data.byteOffset, W * (H - y0));
  for (let y = 0; y < H - y0; y++) {
    const yy = (y + y0) / k;
    const dx = Math.round((Math.sin(yy * 0.018 + t * 1.7) + 0.5 * Math.sin(yy * 0.047 - t * 2.3)) * amp * k);
    if (!dx) continue;
    const row = px.subarray(y * W, (y + 1) * W);
    if (dx > 0) row.copyWithin(dx, 0, W - dx); else row.copyWithin(0, -dx, W);
  }
  ctx.putImageData(img, 0, y0);
}

// ---- film grain + paper fibres + vignette + black lift (retro print look) ----
function noiseTile(size, seed) {
  const [c, g] = buf(`noise${seed}`, size, size, false);
  if (c._done) return c;
  const img = g.createImageData(size, size), r = rng(seed);
  for (let i = 0; i < size * size; i++) { const v = Math.floor(128 + (r() - 0.5) * 255); img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0); c._done = true; return c;
}
function paperTex(W, H) {
  const [c, g] = buf('paper', W, H, false);
  if (c._done) return c;
  g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, W, H);
  const r = rng(808), k = W / 1920;
  for (let i = 0; i < 900; i++) { // soft blotches
    const x = r() * W, y = r() * H, rad = (30 + r() * 140) * k, v = r() < 0.5 ? 0 : 255;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, `rgba(${v},${v},${v},0.05)`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.lineWidth = Math.max(1, k); // fibres
  for (let i = 0; i < 1400; i++) {
    const x = r() * W, y = r() * H, l = (8 + r() * 30) * k, a = r() * TAU, v = r() < 0.5 ? 60 : 200;
    g.strokeStyle = `rgba(${v},${v},${v},0.12)`; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a + 0.5) * l * 0.6, y + Math.sin(a + 0.5) * l * 0.6, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  c._done = true; return c;
}
function filmPost(ctx, W, H, t, o = {}) {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  // black lift (printed ink never reaches pure black)
  ctx.globalCompositeOperation = 'lighten'; ctx.fillStyle = o.lift || 'rgb(16,13,22)'; ctx.fillRect(0, 0, W, H);
  // paper texture (static, like printed paper)
  ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = o.paper == null ? 0.55 : o.paper; ctx.drawImage(paperTex(W, H), 0, 0);
  // grain (changes every frame, 12 "film" updates per second for a hand-made feel)
  const tile = noiseTile(256, 1), fr = Math.floor(t * 12), r = rng(fr + 17);
  ctx.globalAlpha = o.grain == null ? 0.07 : o.grain;
  const ox = -Math.floor(r() * 256), oy = -Math.floor(r() * 256), sc = Math.max(1, Math.round(W / 1280));
  ctx.save(); ctx.scale(sc, sc);
  for (let y = oy; y < H / sc; y += 256) for (let x = ox; x < W / sc; x += 256) ctx.drawImage(tile, x, y);
  ctx.restore();
  // vignette
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const v = o.vignette == null ? 0.5 : o.vignette;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  g.addColorStop(0, 'rgba(10,6,14,0)'); g.addColorStop(1, `rgba(10,6,14,${v})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

module.exports = { setFactory, buf, exhaust, bubbles, drawBubble, marineSnow, godRays, caustics, waterWobble, filmPost };
