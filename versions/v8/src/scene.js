// 《深海图书馆》 scene renderer. render(ctx, t, W, H, createCanvas) is a pure function of t.
// Everything is authored in a 1920x1080 virtual frame and scaled to the output size.
const { clamp, lerp, smooth, lin, bump, easeInOut, easeOut, easeIn, rng, track,
  EV, BUB, shotAt, pageTime, orbTime, lampOffTime } = require('./common');
const { drawDiver, OUT, rrect, fillOut } = require('./diver');
const FX = require('./fx');

const VW = 1920, VH = 1080, TAU = Math.PI * 2;
let mkCanvas = null;
const layers = {};
function layer(name, W, H) {
  const k = `${name}_${W}x${H}`;
  if (!layers[k]) layers[k] = mkCanvas(W, H);
  const c = layers[k], g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(0, 0, W, H);
  return [c, g];
}

const BOOKCOL = ['#8c2f39', '#24636e', '#c48a2c', '#3d5e3a', '#5b3f6b', '#a2552c', '#2e4a6b'];
const PAPER = '#efe3c4', SEPIA = '#f5d9a0';

// ---------- generic helpers ----------
function camApply(ctx, cam) { ctx.translate(VW / 2, VH / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y); }
function camApply2(ctx, cam, W, H) { ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0); camApply(ctx, cam); }
const toScreen = (cam, pt) => [(pt[0] - cam.x) * cam.z + VW / 2, (pt[1] - cam.y) * cam.z + VH / 2];
// is screen point inside a light cone (screen-space lamp + angle)? returns 0..1 brightness
function coneLight(x, y, lx, ly, ang, half, len) {
  const dx = x - lx, dy = y - ly, d = Math.hypot(dx, dy);
  if (d > len || d < 1) return d < 1 ? 1 : 0;
  let da = Math.atan2(dy, dx) - ang; da = Math.atan2(Math.sin(da), Math.cos(da));
  const edge = 1 - smooth(half * 0.6, half, Math.abs(da));
  return edge * (1 - d / len);
}
function vgrad(ctx, y0, y1, stops) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}
function glow(ctx, x, y, r, col, a) {
  if (a <= 0.002 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(0.35, `rgba(${col},${a * 0.45})`); g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}
// 2-bone IK for the diver's arm: returns [shoulderAngle, elbowAngle] (rig convention) reaching world point.
function ikArm(p, target) {
  const s = p.s || 1, f = p.f || 1, r = p.rot || 0;
  const dx0 = target[0] - p.x, dy0 = target[1] - p.y;
  const lx = (Math.cos(-r) * dx0 - Math.sin(-r) * dy0) / (s * f), ly = (Math.sin(-r) * dx0 + Math.cos(-r) * dy0) / s;
  const dx = lx - 4, dy = ly + 64, l1 = 36, l2 = 34;
  const d = clamp(Math.hypot(dx, dy), 4, l1 + l2 - 0.5);
  const phi = Math.atan2(dx, dy);
  const B = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const Cc = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  return [phi - B, Math.PI - Cc];
}
const mixA = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
function fadeBlack(ctx, W, H, a) { if (a <= 0) return; ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fillRect(0, 0, W, H); ctx.restore(); }
function poly(ctx, pts) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); }

// Light cone path in world coords
function conePath(ctx, x, y, ang, half, len) {
  ctx.beginPath(); ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(ang - half) * len, y + Math.sin(ang - half) * len);
  ctx.arc(x, y, len, ang - half, ang + half);
  ctx.closePath();
}
function drawBeam(ctx, x, y, ang, a, len = 1500, half = 0.2) {
  if (a <= 0) return;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, len);
  g.addColorStop(0, `rgba(255,232,170,${0.42 * a})`); g.addColorStop(0.4, `rgba(255,220,150,${0.16 * a})`); g.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = g; conePath(ctx, x, y, ang, half, len); ctx.fill();
  ctx.restore();
  glow(ctx, x, y, 40, '255,240,200', 0.9 * a);
}

// Darkness overlay with holes punched by lights. lights in world coords; drawn through current transform.
function darkness(ctx, W, H, alpha, col, lights) {
  if (alpha <= 0) return;
  const [c, g] = layer('dark', W, H);
  g.fillStyle = `rgba(${col},${alpha})`; g.fillRect(0, 0, W, H);
  // NOTE: @napi-rs/canvas mis-renders gradient fills under a scale transform with destination-out
  // (only the upper half gets punched), so lights are mapped to device pixels by hand and drawn untransformed.
  const m = ctx.getTransform(), k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  g.globalCompositeOperation = 'destination-out';
  for (const L0 of lights) {
    if (L0.a <= 0) continue;
    const L = { ...L0, x: m.a * L0.x + m.c * L0.y + m.e, y: m.b * L0.x + m.d * L0.y + m.f, r: L0.r * k, len: (L0.len || 0) * k };
    if (L.cone) {
      const gr = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.len);
      gr.addColorStop(0, `rgba(0,0,0,${L.a})`); gr.addColorStop(0.55, `rgba(0,0,0,${0.75 * L.a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; conePath(g, L.x, L.y, L.ang, L.half, L.len); g.fill();
    }
    const gr = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
    gr.addColorStop(0, `rgba(0,0,0,${L.a})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(L.x, L.y, L.r, 0, TAU); g.fill();
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(c, 0, 0); ctx.restore();
}

// ---------- props ----------
function drawBookClosed(ctx, x, y, w, h, rot, col, glowA = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  if (glowA > 0) glow(ctx, 0, 0, Math.max(w, h) * 1.6, '255,214,130', glowA);
  rrect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.08); fillOut(ctx, col, Math.max(1.5, w * 0.05));
  ctx.fillStyle = PAPER; ctx.fillRect(w / 2 - w * 0.12, -h / 2 + h * 0.05, w * 0.08, h * 0.9);
  ctx.fillStyle = '#e9c46a'; ctx.fillRect(-w / 2 + w * 0.08, -h * 0.32, w * 0.05, h * 0.64);
  ctx.fillRect(-w * 0.2, -h * 0.18, w * 0.4, h * 0.05); ctx.fillRect(-w * 0.2, h * 0.13, w * 0.4, h * 0.05);
  ctx.restore();
}
function textLines(ctx, x0, y0, w, h, n, col) {
  ctx.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const yy = y0 + (i + 0.7) * h / (n + 0.4);
    const ww = w * (i === n - 1 ? 0.55 : 0.92 - 0.08 * ((i * 7) % 3));
    ctx.fillRect(x0, yy, ww, Math.max(1, h * 0.022));
  }
}
// open book, facing camera, centred at spine (0,0). w = width of ONE page.
function drawBookOpen(ctx, w, h, col, pagesRight = 1, glowA = 0) {
  // cover behind
  rrect(ctx, -w - w * 0.06, -h / 2 - h * 0.04, 2 * w + w * 0.12, h * 1.08, w * 0.05); fillOut(ctx, col, Math.max(2, w * 0.03));
  // left page (slight curve)
  for (const side of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(0, -h / 2 + h * 0.03);
    ctx.quadraticCurveTo(side * w * 0.5, -h / 2 - h * 0.04, side * w, -h / 2);
    ctx.lineTo(side * w, h / 2);
    ctx.quadraticCurveTo(side * w * 0.5, h / 2 - h * 0.04, 0, h / 2 + h * 0.02);
    ctx.closePath(); fillOut(ctx, side < 0 ? '#e6d6b0' : PAPER, Math.max(1.5, w * 0.02));
    if (side < 0 || pagesRight > 0) textLines(ctx, side < 0 ? -w * 0.88 : w * 0.12, -h * 0.4, w * 0.76, h * 0.8, 9, 'rgba(60,45,35,0.45)');
  }
  ctx.strokeStyle = 'rgba(60,40,30,0.5)'; ctx.lineWidth = Math.max(1, w * 0.015);
  ctx.beginPath(); ctx.moveTo(0, -h / 2); ctx.lineTo(0, h / 2); ctx.stroke();
  if (glowA > 0) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; glow(ctx, 0, 0, w * 2.2, '255,210,120', glowA); ctx.restore(); }
}

// page (rectangle) -> paper fish morph. m: 0 page, 1 fish. flap: tail phase
const PAGE_PTS = [[20, 0], [20, -28], [-6, -28], [-20, -28], [-20, 28], [-6, 28], [20, 28]];
const FISH_PTS = [[30, 0], [6, -13], [-14, -3], [-30, -13], [-30, 13], [-14, 3], [6, 13]];
function drawPaperFish(ctx, x, y, ang, sc, m, flap, alpha = 1, sx = 1) {
  if (alpha <= 0.01) return;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(ang); ctx.scale(sc * sx, sc);
  const pts = PAGE_PTS.map((p, i) => {
    const q = FISH_PTS[i];
    let fx = q[0], fy = q[1];
    if (i === 3 || i === 4) fy += Math.sin(flap) * 6;
    return [lerp(p[0], fx, m), lerp(p[1], fy, m)];
  });
  poly(ctx, pts); ctx.fillStyle = PAPER; ctx.fill();
  ctx.save(); ctx.clip(); textLines(ctx, -24, -26, 48, 52, 8, 'rgba(70,55,40,0.4)'); ctx.restore();
  ctx.strokeStyle = OUT; ctx.lineWidth = 2.5; poly(ctx, pts); ctx.stroke();
  if (m > 0.15 && m < 0.95) { ctx.strokeStyle = `rgba(27,22,32,${0.6 * Math.sin(m * Math.PI)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lerp(20, 30, m), 0); ctx.lineTo(lerp(-20, -14, m), 0); ctx.stroke(); }
  if (m > 0.6) { // eye + fold line
    ctx.fillStyle = OUT; ctx.beginPath(); ctx.arc(16, -2, 2.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(27,22,32,0.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(6, -12); ctx.lineTo(6, 12); ctx.stroke();
  }
  ctx.restore();
}

// ---------- memory vignettes (drawn in a unit space: [-1,1], sepia palette) ----------
function sepiaSky(ctx, top = '#f7e2b0', bot = '#e9a96a') {
  ctx.fillStyle = vgrad(ctx, -1, 1, [[0, top], [1, bot]]); ctx.fillRect(-3, -3, 6, 6);
}
const SIL = '#4a2f1d';
function stick(ctx, pts, w) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); }
function memKite(ctx, t) {
  sepiaSky(ctx, '#f9e7bd', '#eba86a');
  ctx.fillStyle = '#fff3d6'; ctx.beginPath(); ctx.arc(0.35, 0.18, 0.2, 0, TAU); ctx.fill();
  ctx.fillStyle = '#d08a55'; ctx.fillRect(-3, 0.25, 6, 0.2);
  ctx.strokeStyle = 'rgba(255,240,210,0.6)'; ctx.lineWidth = 0.008;
  for (let i = 0; i < 6; i++) { const y = 0.29 + i * 0.03; const o = ((t * 0.08 + i * 0.37) % 1) * 2 - 1; ctx.beginPath(); ctx.moveTo(o - 0.15, y); ctx.lineTo(o + 0.15, y); ctx.stroke(); }
  ctx.fillStyle = '#e8c08e'; ctx.beginPath(); ctx.moveTo(-3, 0.47); ctx.lineTo(-1.2, 0.45); ctx.quadraticCurveTo(0, 0.38, 1.2, 0.47); ctx.lineTo(3, 0.47); ctx.lineTo(3, 3); ctx.lineTo(-3, 3); ctx.fill();
  // wet sand mirror of the sun + a trail of small footprints
  ctx.fillStyle = 'rgba(255,240,210,0.35)'; ctx.beginPath(); ctx.ellipse(0.35, 0.5, 0.16, 0.025, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(120,80,50,0.25)';
  for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(-0.3 + i * 0.035 + (t * 0.02 % 0.035), 0.74 + (i % 2) * 0.02, 0.009, 0.005, 0, 0, TAU); ctx.fill(); }
  // old man: hunched coat, flat cap, cane, pointing up at the kite
  ctx.fillStyle = SIL; ctx.strokeStyle = SIL;
  const ox = -0.42, oy = 0.62, sway = Math.sin(t * 1.3) * 0.006;
  ctx.beginPath(); // trousers
  ctx.moveTo(ox - 0.045, oy - 0.07); ctx.lineTo(ox - 0.055, oy + 0.15); ctx.lineTo(ox - 0.02, oy + 0.15); ctx.lineTo(ox, oy - 0.02);
  ctx.lineTo(ox + 0.02, oy + 0.15); ctx.lineTo(ox + 0.055, oy + 0.15); ctx.lineTo(ox + 0.045, oy - 0.07); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.ellipse(ox - 0.03, oy + 0.155, 0.035, 0.012, 0, 0, TAU); ctx.ellipse(ox + 0.045, oy + 0.155, 0.035, 0.012, 0, 0, TAU); ctx.fill(); // shoes
  ctx.beginPath(); // coat, shoulders rounded forward
  ctx.moveTo(ox - 0.06 + sway, oy - 0.32); ctx.quadraticCurveTo(ox + 0.02 + sway, oy - 0.38, ox + 0.07 + sway, oy - 0.31);
  ctx.lineTo(ox + 0.085, oy - 0.03); ctx.quadraticCurveTo(ox, oy, ox - 0.085, oy - 0.03); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(ox + 0.03 + sway, oy - 0.41, 0.05, 0, TAU); ctx.fill(); // head
  ctx.beginPath(); ctx.ellipse(ox + 0.045 + sway, oy - 0.45, 0.065, 0.016, -0.12, 0, TAU); ctx.fill(); // cap peak
  ctx.beginPath(); ctx.ellipse(ox + 0.03 + sway, oy - 0.46, 0.05, 0.028, 0, Math.PI, TAU); ctx.fill();
  const pt = Math.sin(t * 1.1) * 0.015;
  stick(ctx, [[ox + 0.05 + sway, oy - 0.3], [ox + 0.12, oy - 0.36 + pt], [ox + 0.16, oy - 0.45 + pt]], 0.03); // pointing arm
  stick(ctx, [[ox - 0.04 + sway, oy - 0.29], [ox - 0.1, oy - 0.16], [ox - 0.13, oy - 0.05]], 0.03); // arm on the cane
  ctx.lineWidth = 0.014; ctx.beginPath(); ctx.moveTo(ox - 0.16, oy - 0.07); ctx.quadraticCurveTo(ox - 0.13, oy - 0.09, ox - 0.13, oy - 0.04); ctx.lineTo(ox - 0.14, oy + 0.16); ctx.stroke();
  // child running, with the same red scarf the diver wears
  const cx = 0.02 + 0.03 * Math.sin(t * 0.7), cy = 0.66, ph = t * 9, bob = Math.abs(Math.sin(ph)) * 0.012;
  const leg = (sgn) => { const a = Math.sin(ph) * sgn; stick(ctx, [[cx, cy - 0.06 - bob], [cx + a * 0.06 + 0.01, cy + 0.03 - bob], [cx + a * 0.08 - 0.02 + (a < 0 ? -0.03 : 0), cy + 0.105]], 0.026); };
  leg(1); leg(-1);
  ctx.beginPath(); ctx.moveTo(cx - 0.04, cy - 0.06 - bob); ctx.lineTo(cx + 0.045, cy - 0.06 - bob); ctx.lineTo(cx + 0.035, cy - 0.11 - bob); ctx.lineTo(cx - 0.035, cy - 0.11 - bob); ctx.fill(); // shorts
  ctx.beginPath(); ctx.moveTo(cx - 0.035, cy - 0.1 - bob); ctx.lineTo(cx + 0.04, cy - 0.1 - bob); ctx.lineTo(cx + 0.03, cy - 0.2 - bob); ctx.lineTo(cx - 0.025, cy - 0.2 - bob); ctx.fill(); // shirt
  ctx.beginPath(); ctx.arc(cx + 0.015, cy - 0.25 - bob, 0.044, 0, TAU); ctx.fill(); // head
  ctx.lineWidth = 0.013; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(cx + 0.01, cy - 0.288 - bob); ctx.quadraticCurveTo(cx - 0.005, cy - 0.325 - bob, cx - 0.04, cy - 0.312 - bob + Math.sin(t * 7) * 0.004); ctx.stroke(); // one cowlick blown back
  const hand = [cx + 0.1, cy - 0.3 - bob];
  stick(ctx, [[cx + 0.015, cy - 0.18 - bob], [cx + 0.06, cy - 0.25 - bob], hand], 0.022);
  stick(ctx, [[cx - 0.01, cy - 0.18 - bob], [cx - 0.06, cy - 0.15 - bob], [cx - 0.09, cy - 0.12 + Math.sin(ph) * 0.02 - bob]], 0.022);
  ctx.strokeStyle = '#b8452f'; ctx.lineWidth = 0.02; ctx.lineCap = 'round'; // scarf streaming back in the wind
  ctx.beginPath(); ctx.moveTo(cx, cy - 0.2 - bob); ctx.quadraticCurveTo(cx - 0.06, cy - 0.22 + Math.sin(t * 7) * 0.015, cx - 0.12, cy - 0.2 + Math.sin(t * 7 + 1) * 0.025); ctx.stroke();
  ctx.lineWidth = 0.024; ctx.beginPath(); ctx.moveTo(cx - 0.02, cy - 0.205 - bob); ctx.lineTo(cx + 0.03, cy - 0.205 - bob); ctx.stroke();
  ctx.strokeStyle = SIL;
  // kite + string
  const kx = 0.5 + 0.05 * Math.sin(t * 0.9), ky = -0.55 + 0.04 * Math.sin(t * 1.3);
  ctx.lineWidth = 0.004; ctx.strokeStyle = 'rgba(74,47,29,0.8)'; ctx.beginPath(); ctx.moveTo(hand[0], hand[1]); ctx.quadraticCurveTo(0.35, -0.05, kx, ky + 0.06); ctx.stroke();
  ctx.save(); ctx.translate(kx, ky); ctx.rotate(0.25 + 0.08 * Math.sin(t * 1.7));
  ctx.fillStyle = '#b8452f'; poly(ctx, [[0, -0.09], [0.06, 0], [0, 0.11], [-0.06, 0]]); ctx.fill();
  ctx.strokeStyle = '#f9e7bd'; ctx.lineWidth = 0.006; ctx.beginPath(); ctx.moveTo(0, -0.09); ctx.lineTo(0, 0.11); ctx.moveTo(-0.06, 0); ctx.lineTo(0.06, 0); ctx.stroke();
  ctx.strokeStyle = SIL; ctx.lineWidth = 0.005; ctx.beginPath(); ctx.moveTo(0, 0.11);
  for (let i = 1; i <= 8; i++) ctx.lineTo(Math.sin(t * 3 + i * 0.9) * 0.025 * i * 0.3, 0.11 + i * 0.035); ctx.stroke();
  for (let i = 2; i <= 8; i += 2) { ctx.fillStyle = '#b8452f'; ctx.beginPath(); ctx.arc(Math.sin(t * 3 + i * 0.9) * 0.025 * i * 0.3, 0.11 + i * 0.035, 0.009, 0, TAU); ctx.fill(); }
  ctx.restore();
  // gulls
  ctx.strokeStyle = SIL; ctx.lineWidth = 0.008;
  for (let i = 0; i < 3; i++) { const gx = -0.6 + i * 0.13 + t * 0.02, gy = -0.4 - i * 0.05, f = Math.sin(t * 4 + i) * 0.02;
    ctx.beginPath(); ctx.moveTo(gx - 0.035, gy - f); ctx.quadraticCurveTo(gx - 0.01, gy - 0.02, gx, gy); ctx.quadraticCurveTo(gx + 0.01, gy - 0.02, gx + 0.035, gy - f); ctx.stroke(); }
}
function memLighthouse(ctx, t) {
  sepiaSky(ctx, '#5a4a6a', '#e7a46c');
  ctx.fillStyle = '#7a5a4a'; ctx.fillRect(-1.2, 0.45, 2.4, 0.8);
  ctx.fillStyle = SIL; poly(ctx, [[-0.7, 0.5], [-0.3, 0.25], [0.1, 0.3], [0.4, 0.5]]); ctx.fill();
  poly(ctx, [[-0.2, 0.3], [-0.12, -0.45], [0.02, -0.45], [0.1, 0.3]]); ctx.fill();
  ctx.fillStyle = '#ffe9b0'; ctx.fillRect(-0.12, -0.58, 0.14, 0.12);
  ctx.fillStyle = SIL; poly(ctx, [[-0.15, -0.58], [-0.05, -0.68], [0.05, -0.58]]); ctx.fill();
  const a = t * 1.2; ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(255,230,170,0.35)'; ctx.beginPath(); ctx.moveTo(-0.05, -0.52);
  ctx.lineTo(-0.05 + Math.cos(a) * 1.6, -0.52 + Math.sin(a) * 0.15 - 0.1); ctx.lineTo(-0.05 + Math.cos(a) * 1.6, -0.52 + Math.sin(a) * 0.15 + 0.1); ctx.fill(); ctx.restore();
  ctx.strokeStyle = 'rgba(255,230,190,0.5)'; ctx.lineWidth = 0.01;
  for (let i = 0; i < 5; i++) { const y = 0.55 + i * 0.08; ctx.beginPath(); ctx.moveTo(-1, y + Math.sin(t + i) * 0.01); ctx.lineTo(1, y); ctx.stroke(); }
}
function memDancers(ctx, t) {
  sepiaSky(ctx, '#f3d7a3', '#b9744a');
  for (let i = 0; i < 5; i++) glow(ctx, -0.8 + i * 0.4, -0.55, 0.12, '255,240,200', 0.9);
  ctx.strokeStyle = 'rgba(74,47,29,0.6)'; ctx.lineWidth = 0.008; ctx.beginPath(); ctx.moveTo(-1, -0.6); ctx.quadraticCurveTo(0, -0.4, 1, -0.6); ctx.stroke();
  ctx.fillStyle = '#9a6040'; ctx.fillRect(-1.2, 0.5, 2.4, 0.8);
  ctx.save(); ctx.translate(0, 0.25); ctx.rotate(Math.sin(t * 1.5) * 0.12);
  ctx.fillStyle = SIL; ctx.strokeStyle = SIL;
  // man
  ctx.beginPath(); ctx.ellipse(-0.1, -0.1, 0.06, 0.17, 0, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.arc(-0.1, -0.33, 0.055, 0, TAU); ctx.fill();
  stick(ctx, [[-0.12, 0.05], [-0.13, 0.27]], 0.04); stick(ctx, [[-0.08, 0.05], [-0.06, 0.27]], 0.04);
  // woman with swirling dress
  ctx.beginPath(); ctx.arc(0.1, -0.31, 0.05, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0.1, -0.14, 0.045, 0.12, 0, 0, TAU); ctx.fill();
  const sw = Math.sin(t * 3) * 0.06;
  poly(ctx, [[0.06, -0.06], [0.14, -0.06], [0.26 + sw, 0.26], [-0.04 + sw, 0.26]]); ctx.fill();
  stick(ctx, [[-0.06, -0.2], [0.06, -0.24]], 0.025); stick(ctx, [[-0.14, -0.22], [-0.2, -0.36], [0.12, -0.42]], 0.02);
  ctx.restore();
}
function memTrain(ctx, t) {
  sepiaSky(ctx, '#2f2a44', '#8a5a5a');
  ctx.fillStyle = '#fff2cc'; ctx.beginPath(); ctx.arc(0.5, -0.5, 0.12, 0, TAU); ctx.fill();
  ctx.fillStyle = '#3a2a2a'; poly(ctx, [[-1.2, 0.3], [-0.6, 0.05], [-0.1, 0.25], [0.4, 0.0], [1.2, 0.3], [1.2, 1.2], [-1.2, 1.2]]); ctx.fill();
  const off = ((t * 0.25) % 1) * 2 - 1.5;
  ctx.fillStyle = '#1f1720';
  for (let i = 0; i < 5; i++) {
    const x = off + i * 0.42; ctx.fillRect(x, 0.32, 0.38, 0.16);
    ctx.fillStyle = '#ffd98a'; for (let j = 0; j < 4; j++) ctx.fillRect(x + 0.04 + j * 0.085, 0.35, 0.05, 0.05); ctx.fillStyle = '#1f1720';
  }
  ctx.fillRect(-1.2, 0.48, 2.4, 0.02);
  ctx.fillStyle = 'rgba(240,220,200,0.35)';
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(off + 1.95 + i * 0.12, 0.25 - i * 0.07, 0.05 + i * 0.02, 0, TAU); ctx.fill(); }
}
function memCat(ctx, t) {
  sepiaSky(ctx, '#e9cf9b', '#c9925c');
  ctx.fillStyle = '#5a3a26'; ctx.fillRect(-1.2, -1.2, 2.4, 2.4);
  ctx.fillStyle = vgrad(ctx, -0.7, 0.4, [[0, '#ffe8b8'], [1, '#e9a96a']]); ctx.fillRect(-0.6, -0.7, 1.2, 1.1);
  ctx.strokeStyle = '#5a3a26'; ctx.lineWidth = 0.05; ctx.beginPath(); ctx.moveTo(0, -0.7); ctx.lineTo(0, 0.4); ctx.moveTo(-0.6, -0.15); ctx.lineTo(0.6, -0.15); ctx.stroke();
  // rain streaks on window
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.006;
  for (let i = 0; i < 12; i++) { const x = -0.55 + ((i * 0.37) % 1.1), y = -0.7 + ((t * 0.5 + i * 0.29) % 1.1); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 0.02, y + 0.08); ctx.stroke(); }
  ctx.fillStyle = '#6b4a32'; ctx.fillRect(-0.75, 0.4, 1.5, 0.1);
  ctx.fillStyle = SIL;
  ctx.beginPath(); ctx.ellipse(0.1, 0.27, 0.16, 0.13, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(0.18, 0.08, 0.08, 0, TAU); ctx.fill();
  poly(ctx, [[0.12, 0.03], [0.13, -0.06], [0.17, 0.01]]); ctx.fill(); poly(ctx, [[0.2, 0.01], [0.24, -0.06], [0.25, 0.04]]); ctx.fill();
  ctx.strokeStyle = SIL; ctx.lineWidth = 0.035; ctx.beginPath(); ctx.moveTo(-0.04, 0.34); ctx.quadraticCurveTo(-0.25, 0.4 + Math.sin(t * 2) * 0.03, -0.2, 0.2 + Math.sin(t * 2) * 0.05); ctx.stroke();
}
const MEMS = [memLighthouse, memDancers, memTrain, memCat];

function drawMemoryDisc(ctx, x, y, r, fn, t, a) {
  if (a <= 0.01 || r < 1) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; glow(ctx, x, y, r * 2.2, '255,210,130', 0.55); ctx.restore();
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.save(); ctx.clip();
  ctx.translate(x, y); ctx.scale(r, r); fn(ctx, t);
  ctx.restore();
  ctx.lineWidth = Math.max(1.5, r * 0.06); ctx.strokeStyle = 'rgba(255,226,160,0.9)'; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  ctx.restore();
}

// ======================================================================
// SHOT 1 — sunset sea, diver tips backwards into the water (0–9)
// ======================================================================
const WL = 660; // water line (world y)
function seaSurface(ctx, t, sky) {
  // sky
  ctx.fillStyle = vgrad(ctx, -200, 520, sky.stops); ctx.fillRect(-200, -400, 2400, 930);
  const sx = sky.sun[0], sy = sky.sun[1], sr = sky.sun[2];
  // sun halo
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; glow(ctx, sx, sy, sr * 4.2, sky.halo, 0.32); ctx.restore();
  // long flat retro cloud bands drifting slowly
  for (const [cx, cy, w, h, col, sp] of sky.clouds) {
    const x = cx + t * sp;
    ctx.fillStyle = col; rrect(ctx, x - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
    rrect(ctx, x - w * 0.3, cy - h * 1.2, w * 0.45, h, h / 2); ctx.fill();
  }
  // retro striped sun
  ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.clip();
  ctx.fillStyle = sky.sunCol; ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
  ctx.fillStyle = sky.stops[sky.stops.length - 1][1];
  for (let i = 0; i < 5; i++) { const y = sy + sr * (0.15 + i * 0.19); ctx.fillRect(sx - sr, y, sr * 2, 4 + i * 3); }
  ctx.restore();
  // far sea
  ctx.fillStyle = vgrad(ctx, 520, WL, sky.sea); ctx.fillRect(-200, 520, 2400, WL - 520 + 2);
  // sun glitter
  ctx.fillStyle = sky.glit;
  for (let i = 0; i < 14; i++) {
    const y = 530 + i * 9.5, w = 120 - i * 4 + 26 * Math.sin(t * 2 + i * 1.7);
    ctx.fillRect(sx - w / 2 + 14 * Math.sin(t * 1.3 + i), y, w, 3);
  }
  // wave lines
  ctx.strokeStyle = sky.wave; ctx.lineWidth = 3; ctx.lineCap = 'round';
  const r = rng(77);
  for (let i = 0; i < 40; i++) {
    const y = 535 + r() * 120, x = r() * 2200 - 140 + Math.sin(t * 0.6 + i) * 18, w = 20 + (y - 520) * 0.4;
    ctx.beginPath(); ctx.moveTo(x - w, y); ctx.quadraticCurveTo(x, y - 5, x + w, y); ctx.stroke();
  }
}
const SUNSET = {
  stops: [[0, '#1f4b63'], [0.45, '#d77a5a'], [0.8, '#f2a65a'], [1, '#f7cf8e']],
  sun: [1400, 470, 120], sunCol: '#fbe6ad',
  sea: [[0, '#3c7f8a'], [1, '#215a6c']], glit: 'rgba(255,226,160,0.75)', wave: 'rgba(255,214,160,0.55)', halo: '255,214,150',
  clouds: [[380, 150, 420, 26, 'rgba(250,200,150,0.55)', 4], [1550, 250, 520, 22, 'rgba(255,190,140,0.5)', -3], [900, 70, 360, 20, 'rgba(240,170,140,0.45)', 2], [1250, 380, 300, 14, 'rgba(255,215,160,0.55)', -5]],
};
const DAWN = {
  stops: [[0, '#4a4f7a'], [0.5, '#c98aa6'], [0.85, '#f4b8a8'], [1, '#fbe0c4']],
  sun: [560, 505, 95], sunCol: '#fff1d6',
  sea: [[0, '#6f8fa8'], [1, '#3a6a86']], glit: 'rgba(255,236,220,0.8)', wave: 'rgba(255,226,220,0.55)', halo: '255,225,205',
  clouds: [[300, 120, 380, 22, 'rgba(255,205,215,0.5)', 5], [1500, 200, 480, 24, 'rgba(250,190,200,0.45)', 3], [1100, 330, 260, 14, 'rgba(255,225,215,0.55)', 4]],
};

function underwaterBelow(ctx, top, bottom, deep) {
  ctx.fillStyle = vgrad(ctx, top, bottom, deep); ctx.fillRect(-300, top, 2600, bottom - top);
}
function surfaceLine(ctx, t, y, col = '#bfe3e0') {
  ctx.beginPath(); ctx.moveTo(-300, y);
  for (let x = -300; x <= 2300; x += 40) ctx.lineTo(x, y + Math.sin(x * 0.012 + t * 2) * 6 + Math.sin(x * 0.031 - t * 3) * 3);
  ctx.lineTo(2300, y + 14); ctx.lineTo(-300, y + 14); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
}

function boat(ctx, t, x, y) {
  const bob = Math.sin(t * 1.4) * 5, rock = Math.sin(t * 1.1 + 0.5) * 0.025;
  ctx.save(); ctx.translate(x, y + bob); ctx.rotate(rock);
  // mast + furled sail
  ctx.fillStyle = '#5a3a26'; ctx.fillRect(28, -330, 12, 330); ctx.strokeStyle = OUT; ctx.lineWidth = 3; ctx.strokeRect(28, -330, 12, 330);
  ctx.beginPath(); ctx.moveTo(40, -310); ctx.lineTo(210, -40); ctx.lineTo(40, -40); ctx.closePath(); fillOut(ctx, '#e9dcc0', 4);
  ctx.strokeStyle = 'rgba(120,90,60,0.4)'; ctx.lineWidth = 3; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(40, -310 + i * 67); ctx.lineTo(40 + i * 42, -40); ctx.stroke(); }
  // hull
  ctx.beginPath(); ctx.moveTo(-270, -40); ctx.lineTo(290, -40); ctx.quadraticCurveTo(250, 40, 180, 50); ctx.lineTo(-200, 50); ctx.quadraticCurveTo(-250, 30, -270, -40); ctx.closePath();
  fillOut(ctx, '#8a4f30', 5);
  ctx.fillStyle = '#6e3c24'; ctx.fillRect(-255, -8, 520, 8); ctx.fillRect(-235, 18, 470, 7);
  ctx.fillStyle = '#c8a24a'; ctx.fillRect(-270, -44, 560, 9); ctx.strokeStyle = OUT; ctx.lineWidth = 3; ctx.strokeRect(-270, -44, 560, 9);
  // name plate
  ctx.fillStyle = '#e9dcc0'; ctx.font = 'bold 18px Georgia'; ctx.fillText('ESTER', 120, 12);
  // rope coil + lantern
  ctx.beginPath(); ctx.ellipse(-120, -48, 34, 10, 0, 0, TAU); fillOut(ctx, '#c49a5a', 3);
  ctx.fillStyle = '#2f2a2c'; ctx.fillRect(250, -90, 22, 32); ctx.fillStyle = '#ffd27a'; ctx.fillRect(254, -84, 14, 20);
  ctx.restore();
  return { bob, rock };
}

function diverShot1(t) {
  // sitting on the left gunwale, facing right; adjusts helmet, grips the rail, leans in, tips back.
  const bob = Math.sin(t * 1.4) * 5 + Math.sin(t * 2.1) * 1.2;
  if (t < EV.tipBack) {
    const aF = track([[0, [0.95, 0.75]], [2.3, [0.95, 0.75]], [2.8, [2.75, 1.05]], [3.5, [2.75, 1.05]], [3.95, [0.95, 0.75]], [4.25, [-0.35, 0.25]]], t);
    const aB = track([[0, [0.8, 0.85]], [3.9, [0.8, 0.85]], [4.25, [-0.4, 0.2]]], t);
    const wig = bump(t, 3.15, 0.3) * 0.07 * Math.sin(t * 16);
    const lean = 0.09 * bump(t, 4.65, 0.22); // anticipation
    return { x: 690, y: 572 + bob, s: 0.82, f: 1, rot: lean,
      lF: [1.5 + 0.06 * Math.sin(t * 1.7), -1.45 - 0.08 * Math.sin(t * 1.7 + 1)], lB: [1.4, -1.5 + 0.05 * Math.sin(t * 1.3)],
      aB, aF, head: -0.04 + 0.13 * Math.sin(t * 0.75) * (1 - bump(t, 3.1, 0.6)) + wig, t, scarfLift: 0.12, lamp: 0 };
  }
  if (t < EV.splash) {
    const u = lin(EV.tipBack, EV.splash, t), a = easeIn(u);
    return { x: lerp(690, 605, a), y: lerp(572 + bob, WL + 22, a) - Math.sin(u * Math.PI) * 26, s: 0.82, f: 1, rot: -1.95 * a,
      lF: [lerp(1.5, 2.35, a), lerp(-1.45, -0.35, a)], lB: [lerp(1.4, 2.1, a), lerp(-1.5, -0.55, a)],
      aB: [lerp(-0.4, 2.7, a), 0.3], aF: [lerp(-0.35, 2.95, a), 0.25], head: 0.2 * a, t, scarfLift: 0.2 + 0.6 * a };
  }
  // underwater: tumbles a little further, then settles into a slow backwards sink
  const v = t - EV.splash;
  const tumble = -1.95 - 0.45 * Math.sin(Math.min(v, 1.6) / 1.6 * Math.PI) * Math.exp(-v * 0.4);
  const settle = smooth(1.0, 3.4, v);
  return { x: 605 - 40 * easeOut(v / 3.4), y: WL + 22 + 260 * (1 - Math.exp(-v * 1.2)) + 60 * v, s: 0.82, f: 1,
    rot: lerp(tumble, -1.5, settle),
    lF: [lerp(2.0, 0.6, settle) + 0.15 * Math.sin(t * 2.2), lerp(-0.5, -0.55, settle)], lB: [lerp(1.8, 0.35, settle) - 0.15 * Math.sin(t * 2.2), -0.7],
    aB: [lerp(2.8, 2.3, settle) + 0.25 * Math.sin(t * 1.6 + 1), 0.45], aF: [lerp(3.0, 2.55, settle) + 0.3 * Math.sin(t * 1.6), 0.5],
    head: lerp(0.2, 0, settle), t, scarfLift: 1 };
}
function shot1cam(t) {
  const tilt = smooth(6.3, 9.0, t);
  const pull = easeInOut(lin(0, 5.4, t));
  return { x: lerp(lerp(820, 920, pull), 780, tilt), y: lerp(lerp(560, 540, pull), 1240, tilt), z: lerp(lerp(1.45, 1.04, pull), 1, smooth(5.4, 7, t)) };
}

function shot1(ctx, t, W, H) {
  const cam = shot1cam(t);
  camApply(ctx, cam);
  seaSurface(ctx, t, SUNSET);
  underwaterBelow(ctx, WL, 2400, [[0, '#2f8a96'], [0.5, '#1b5a74'], [1, '#123a55']]);
  FX.godRays(ctx, t, { top: WL, len: 1500, alpha: 0.16, x0: 0, span: 1900, seed: 4, tilt: 0.12 });
  FX.caustics(ctx, t, { y0: WL + 30, y1: WL + 420, alpha: 0.05, cell: 110 });
  // boat (hull dips below water line)
  boat(ctx, t, 960, 640);
  const p = diverShot1(t);
  const behind = t >= EV.splash;
  if (!behind) drawDiver(ctx, p);
  // water surface strip in front of the boat bottom
  ctx.save(); ctx.globalAlpha = 0.85; surfaceLine(ctx, t, WL, '#3c8f9a'); ctx.restore();
  if (behind) drawDiver(ctx, p);
  // bubbles: a big burst at the splash, then the regular helmet exhaust
  if (t > EV.splash) {
    FX.bubbles(ctx, t, { ...BUB.s1splash, ceil: WL + 8,
      emit: (te) => te < EV.splash + 0.9 ? [605 + (te - EV.splash) * -20, WL + 40 + (te - EV.splash) * 200, 1.1] : null });
    FX.bubbles(ctx, t, { ...BUB.s1, ceil: WL + 8,
      emit: (te) => { const q = diverShot1(te); const e = FX.exhaust(q); return [e[0], e[1], q.s]; } });
  }
  // marine snow, only below the water line (screen space, parallax with the camera tilt)
  const wlS = (WL - cam.y) * cam.z + VH / 2;
  if (wlS < VH) {
    ctx.save(); ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0); ctx.beginPath(); ctx.rect(0, wlS + 8, VW, VH); ctx.clip();
    FX.marineSnow(ctx, t, { n: 110, seed: 5, scrollY: cam.y - 540, alpha: 0.45 });
    ctx.restore(); camApply2(ctx, cam, W, H);
  }
  // splash
  const sp = t - EV.splash;
  if (sp > 0 && sp < 1.4) {
    const r = rng(9);
    ctx.fillStyle = '#e8f6f2';
    for (let i = 0; i < 26; i++) {
      const vx = (r() - 0.5) * 520, vy = -300 - r() * 420, tt = sp;
      const x = 600 + vx * tt, y = WL + vy * tt + 900 * tt * tt;
      if (y > WL + 6) continue;
      ctx.beginPath(); ctx.arc(x, y, 5 + r() * 7, 0, TAU); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(232,246,242,' + (1 - sp / 1.4) + ')'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.ellipse(600, WL + 2, 40 + sp * 240, 8 + sp * 20, 0, 0, TAU); ctx.stroke();
  }
  FX.waterWobble(ctx, t, 1.6, wlS + 10);
  // title (screen space, so camera moves don't crop it)
  ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
  const ta = smooth(0.8, 1.8, t) * (1 - smooth(4.0, 4.9, t));
  if (ta > 0) {
    ctx.save(); ctx.globalAlpha = ta; ctx.textAlign = 'center';
    ctx.font = '120px KaiTi'; ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(40,30,40,0.6)'; ctx.strokeText('深海图书馆', 960, 165);
    ctx.fillStyle = '#fbeed0'; ctx.fillText('深海图书馆', 960, 165);
    ctx.font = 'italic 30px Georgia'; ctx.fillStyle = 'rgba(251,238,208,0.85)'; ctx.fillText('The Library Beneath the Sea', 960, 222);
    ctx.restore();
  }
}

// ======================================================================
// SHOT 2 — sinking (9–19)
// ======================================================================
function deepGrad(d) { // d 0..1 depth
  const top = mix3([47, 138, 150], [12, 40, 66], d), bot = mix3([22, 74, 104], [5, 14, 28], d);
  return [[0, rgb(top)], [1, rgb(bot)]];
}
function mix3(a, b, u) { return a.map((x, i) => lerp(x, b[i], u)); }
function rgb(c) { return `rgb(${c.map((v) => Math.round(v)).join(',')})`; }

const FISH = (() => { const r = rng(31); return Array.from({ length: 46 }, () => ({ dx: r() * 520, dy: (r() - 0.5) * 220, ph: r() * TAU, s: 0.6 + r() * 0.5 })); })();
function fishSilhouette(ctx, x, y, s, ph, col) {
  ctx.save(); ctx.translate(x, y); ctx.scale(-s, s);
  ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 0, 18, 7, 0, 0, TAU); ctx.fill();
  const f = Math.sin(ph) * 4;
  ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(-28, -8 + f); ctx.lineTo(-28, 8 + f); ctx.closePath(); ctx.fill();
  // silver flash along the belly as the fish turns
  const fl = Math.max(0, Math.sin(ph * 0.13 + x * 0.004)) ** 4;
  if (fl > 0.05) { ctx.strokeStyle = `rgba(210,240,245,${0.75 * fl})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.ellipse(0, 1, 14, 4, 0, 0.2, Math.PI - 0.2); ctx.stroke(); }
  ctx.restore();
}

function diverShot2(t) {
  const k = t - 9;
  // rights himself: back-float -> upright with a small overshoot, arms paddling to balance
  const rot = track([[9, [-1.5]], [10.2, [-1.25]], [12.6, [0.18]], [13.6, [0.02]], [19, [0.06]]], t)[0];
  const paddle = smooth(9.6, 10.4, t) * (1 - smooth(12.8, 13.8, t));
  let aF = [lerp(2.55, 1.15, smooth(9.5, 13, t)) + paddle * 0.7 * Math.sin(t * 3.2), 0.45 + paddle * 0.3 * Math.sin(t * 3.2 + 1)];
  const aB = [lerp(2.3, 0.85, smooth(9.5, 13, t)) + paddle * 0.7 * Math.sin(t * 3.2 + 0.8) + 0.08 * Math.sin(t * 1.1), 0.5];
  // reaches up to click the helmet lamp on
  const reach = smooth(14.2, 14.7, t) * (1 - smooth(15.15, 15.7, t));
  const p = { x: 960 + 18 * Math.sin(k * 0.5), y: 600 + 10 * Math.sin(k * 0.8), s: 1.0, f: 1, rot,
    lF: [lerp(0.6, 0.22, smooth(9.5, 13, t)) + 0.22 * Math.sin(t * 2.4), -0.45 - 0.2 * Math.max(0, Math.sin(t * 2.4))],
    lB: [lerp(0.35, -0.18, smooth(9.5, 13, t)) - 0.22 * Math.sin(t * 2.4), -0.55 - 0.2 * Math.max(0, -Math.sin(t * 2.4))],
    aB, aF, head: track([[9, [0]], [14.2, [-0.05]], [15.4, [0.4]], [17.4, [0.45]], [19, [0.95]]], t)[0], t, scarfLift: 1, lamp: lampOn(t) };
  if (reach > 0) {
    const tgt = [p.x + 30 * p.s, p.y - 160 * p.s];
    const ik = ikArm(p, tgt);
    p.aF = mixA(aF, ik, reach);
  }
  return p;
}
function shot2cam(t) {
  const u = easeInOut(lin(9, 13.5, t));
  return { x: lerp(1222, 960, u) + 14 * Math.sin(t * 0.35), y: lerp(720, 560, u) + 8 * Math.sin(t * 0.5), z: lerp(0.82, 1.12, easeInOut(lin(9, 16, t))) + 0.05 * smooth(16, 19, t) };
}
function lampOn(t) {
  if (t < EV.lampOn) return 0;
  const k = t - EV.lampOn;
  return k < 0.25 ? (k < 0.06 || (k > 0.12 && k < 0.16) ? 1 : 0.15) : 1;
}

function shot2(ctx, t, W, H) {
  const d = lin(9, 19, t);
  ctx.save(); ctx.fillStyle = vgrad(ctx, 0, 1080, deepGrad(0.15 + 0.75 * d)); ctx.fillRect(0, 0, VW, VH); ctx.restore();
  // light shafts from far above, fading with depth
  FX.godRays(ctx, t, { alpha: 0.2 * (1 - d) ** 1.5, seed: 7, tilt: 0.1, len: 1200 });
  const cam = shot2cam(t);
  // distant (background) snow drifts upward: we are sinking
  FX.marineSnow(ctx, t, { n: 70, seed: 21, vy: -55, size: 1.6, alpha: 0.35 * (1 - 0.5 * d), scrollX: cam.x - 960 });
  camApply(ctx, cam);
  // fish school crossing right -> left between 10.5 and 15.5
  const fx = lerp(2300, -900, lin(10.5, 15.8, t));
  for (const f of FISH) fishSilhouette(ctx, fx + f.dx + Math.sin(t * 2 + f.ph) * 12, 300 + f.dy + Math.sin(t * 1.3 + f.ph) * 10, f.s, t * 12 + f.ph, 'rgba(10,30,45,0.75)');
  const p = diverShot2(t);
  FX.bubbles(ctx, t, { ...BUB.s2, vRel: 55,
    emit: (te) => { const q = diverShot2(Math.max(9, te)); const e = FX.exhaust(q); return [e[0], e[1], q.s]; } });
  const info = drawDiver(ctx, p);
  if (p.lamp > 0) drawBeam(ctx, info.lamp[0], info.lamp[1], info.lampAng, p.lamp, 1300, 0.2);
  // foreground snow, glittering where the lamp beam crosses it
  const ls = toScreen(cam, info.lamp);
  ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
  FX.marineSnow(ctx, t, { n: 90, seed: 22, vy: -80, size: 2.4, alpha: 0.45 * (1 - 0.4 * d), scrollX: (cam.x - 960) * 1.4,
    lightFn: p.lamp > 0 ? (x, y) => p.lamp * coneLight(x, y, ls[0], ls[1], info.lampAng, 0.2, 1300 * cam.z) : null, darkMul: 1 });
  FX.waterWobble(ctx, t, 1.4);
}

// ======================================================================
// SHOT 3 — seabed, discovering the library (19–29)
// ======================================================================
const LIB = { cx: 1250, gy: 830, tilt: -0.025 };
function seabed(ctx, t) {
  ctx.fillStyle = '#9b8763';
  ctx.beginPath(); ctx.moveTo(-200, 900);
  ctx.bezierCurveTo(200, 850, 500, 880, 800, 860); ctx.bezierCurveTo(1100, 840, 1500, 850, 2200, 830);
  ctx.lineTo(2200, 1300); ctx.lineTo(-200, 1300); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#86734f';
  const r = rng(5);
  for (let i = 0; i < 60; i++) { const x = r() * 2300 - 200, y = 880 + r() * 220; ctx.fillRect(x, y, 20 + r() * 50, 3); }
  // rocks
  for (const [x, y, w, h] of [[160, 905, 120, 60], [1780, 860, 160, 80], [620, 900, 70, 34]]) { ctx.beginPath(); ctx.ellipse(x, y, w / 2, h / 2, 0, Math.PI, TAU); fillOut(ctx, '#5d5a5e', 4); }
}
function kelp(ctx, t, x, y, h, seed, col = '#3f6a4a') {
  const r = rng(seed);
  ctx.strokeStyle = OUT; ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const ox = (r() - 0.5) * 40, hh = h * (0.6 + r() * 0.5), ph = r() * TAU;
    const pts = [];
    for (let i = 0; i <= 10; i++) { const v = i / 10; pts.push([x + ox + Math.sin(t * 1.1 + ph + v * 3) * 30 * v, y - hh * v]); }
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const q of pts) ctx.lineTo(q[0], q[1]);
    ctx.lineWidth = 16; ctx.strokeStyle = OUT; ctx.stroke(); ctx.lineWidth = 10; ctx.strokeStyle = col; ctx.stroke();
  }
}
function library(ctx, t, wake) {
  const { cx, gy } = LIB;
  ctx.save(); ctx.translate(cx, gy); ctx.rotate(LIB.tilt); ctx.translate(-cx, -gy);
  const stone = '#a8a08c', stoneLo = '#7d7666', wall = '#5c574e';
  // wall behind columns
  ctx.fillStyle = wall; ctx.fillRect(cx - 330, gy - 420, 660, 380); ctx.strokeStyle = OUT; ctx.lineWidth = 5; ctx.strokeRect(cx - 330, gy - 420, 660, 380);
  // windows & door
  const win = (x, w, h, door) => {
    const y1 = gy - 40, y0 = y1 - h;
    ctx.beginPath(); ctx.moveTo(x - w / 2, y1); ctx.lineTo(x - w / 2, y0 + w / 2); ctx.arc(x, y0 + w / 2, w / 2, Math.PI, 0); ctx.lineTo(x + w / 2, y1); ctx.closePath();
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    const a = door ? 0.25 + 0.5 * wake : wake;
    g.addColorStop(0, `rgba(${Math.round(lerp(20, 255, a))},${Math.round(lerp(26, 196, a))},${Math.round(lerp(30, 107, a))},1)`);
    g.addColorStop(1, `rgba(${Math.round(lerp(14, 200, a))},${Math.round(lerp(18, 120, a))},${Math.round(lerp(22, 60, a))},1)`);
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 4; ctx.stroke();
    if (!door) { // shelf silhouettes in the window
      ctx.fillStyle = `rgba(40,25,15,${0.5 * wake})`;
      for (let i = 1; i < 4; i++) ctx.fillRect(x - w / 2 + 4, y0 + w / 2 + i * (h - w / 2) / 4, w - 8, 4);
    }
  };
  const colX = [-300, -180, -60, 60, 180, 300].map((d) => cx + d);
  win(cx - 240, 52, 200); win(cx - 120, 52, 200); win(cx, 96, 280, true); win(cx + 120, 52, 200); win(cx + 240, 52, 200);
  // steps
  for (let i = 0; i < 3; i++) { ctx.fillStyle = i % 2 ? stone : stoneLo; ctx.fillRect(cx - 380 + i * 18, gy - 14 - i * 14, 760 - i * 36, 14); ctx.strokeStyle = OUT; ctx.lineWidth = 3; ctx.strokeRect(cx - 380 + i * 18, gy - 14 - i * 14, 760 - i * 36, 14); }
  // columns
  colX.forEach((x, i) => {
    const top = i === 5 ? gy - 260 : gy - 430;
    ctx.fillStyle = stone; ctx.fillRect(x - 24, top, 48, gy - 42 - top); ctx.strokeStyle = OUT; ctx.lineWidth = 4; ctx.strokeRect(x - 24, top, 48, gy - 42 - top);
    ctx.fillStyle = stoneLo; ctx.fillRect(x - 24, top, 10, gy - 42 - top);
    ctx.strokeStyle = 'rgba(40,30,30,0.3)'; ctx.lineWidth = 2; for (let k = -8; k <= 12; k += 10) { ctx.beginPath(); ctx.moveTo(x + k, top + 6); ctx.lineTo(x + k, gy - 48); ctx.stroke(); }
    if (i !== 5) { ctx.fillStyle = stone; ctx.fillRect(x - 34, top - 14, 68, 16); ctx.strokeStyle = OUT; ctx.lineWidth = 3; ctx.strokeRect(x - 34, top - 14, 68, 16); }
    else { ctx.fillStyle = stone; poly(ctx, [[x - 24, top], [x - 8, top - 22], [x + 6, top - 6], [x + 24, top - 18], [x + 24, top]]); ctx.fill(); }
  });
  // entablature + inscription
  ctx.fillStyle = stone; ctx.fillRect(cx - 360, gy - 500, 720, 58); ctx.strokeStyle = OUT; ctx.lineWidth = 5; ctx.strokeRect(cx - 360, gy - 500, 720, 58);
  ctx.fillStyle = '#4a443c'; ctx.font = 'bold 34px Georgia'; ctx.textAlign = 'center'; ctx.fillText('B I B L I O T H E C A', cx, gy - 458); ctx.textAlign = 'left';
  // pediment
  poly(ctx, [[cx - 380, gy - 500], [cx, gy - 650], [cx + 380, gy - 500]]); fillOut(ctx, stone, 5);
  poly(ctx, [[cx - 320, gy - 512], [cx, gy - 626], [cx + 320, gy - 512]]); ctx.fillStyle = stoneLo; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, gy - 560, 30, 0, TAU); fillOut(ctx, stone, 4); // round emblem (open book)
  ctx.fillStyle = '#4a443c'; poly(ctx, [[cx - 18, gy - 570], [cx, gy - 562], [cx + 18, gy - 570], [cx + 18, gy - 548], [cx, gy - 542], [cx - 18, gy - 548]]); ctx.fill();
  // fallen column drum + spilled books
  ctx.save(); ctx.translate(cx + 430, gy - 12); ctx.rotate(0.15); rrect(ctx, -60, -24, 120, 48, 8); fillOut(ctx, stone, 4); ctx.restore();
  drawBookClosed(ctx, cx - 140, gy - 50, 30, 20, 0.3, BOOKCOL[0]); drawBookClosed(ctx, cx + 90, gy - 8, 34, 22, -0.2, BOOKCOL[1]);
  ctx.restore();
  // sand dune burying the left corner
  ctx.fillStyle = '#9b8763'; ctx.beginPath(); ctx.moveTo(cx - 520, gy + 60); ctx.quadraticCurveTo(cx - 380, gy - 90, cx - 200, gy + 30); ctx.lineTo(cx - 200, gy + 80); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#86734f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx - 470, gy + 10); ctx.quadraticCurveTo(cx - 380, gy - 60, cx - 280, gy - 10); ctx.stroke();
}

function diverShot3(t) {
  const land = EV.land;
  const descent = lin(19, land, t);
  const y = lerp(-120, 860, 1 - Math.pow(1 - descent, 2.2));
  const squat = t < land ? 0 : Math.exp(-(t - land) * 3.2) * Math.sin(Math.min(1, (t - land) * 2.2) * Math.PI) * 1.1 + bump(t, land + 0.1, 0.12) * 0.4;
  // two slow steps forward (22.4–24.6), recoil in awe when the library wakes, then two more steps (26.8–28.6)
  const step1 = lin(22.4, 24.6, t), step2 = lin(26.8, 28.6, t);
  const walking = (step1 > 0 && step1 < 1) || (step2 > 0 && step2 < 1);
  const ph = step1 < 1 ? step1 * TAU * 1 : step2 * TAU * 1;
  const sw = walking ? Math.sin(ph) * 0.38 : 0;
  const x = 420 + 80 * easeInOut(step1) + 70 * easeInOut(step2) - 18 * bump(t, EV.libWake + 0.4, 0.4);
  const awe = smooth(EV.libWake, EV.libWake + 0.6, t) * (1 - smooth(26.6, 27.4, t));
  // head angle drives the lamp sweep
  const head = track([[19, [0.6]], [21.6, [0.75]], [EV.sweep0, [0.6]], [24.2, [-0.14]], [EV.sweep1, [-0.05]], [29, [-0.03]]], t)[0] - 0.12 * awe;
  const armsUp = 1 - smooth(land - 0.2, land + 0.6, t);
  return { x, y: y + squat * 16 - Math.abs(sw) * 4, s: 0.72, f: 1, rot: 0.04 + 0.05 * squat - 0.07 * awe,
    lF: [0.18 + sw + squat * 0.7, -0.15 - squat * 1.1 - Math.max(0, -sw) * 0.5], lB: [-0.12 - sw + squat * 0.55, -0.2 - squat * 1.1 - Math.max(0, sw) * 0.5],
    aB: [lerp(0.5, 1.6, armsUp) + 0.15 * Math.sin(ph + 0.5) * (walking ? 1 : 0), 0.5], aF: [lerp(0.55, 1.8, armsUp) - 0.15 * Math.sin(ph) * (walking ? 1 : 0) + 0.25 * awe, 0.5 + 0.3 * awe],
    head, t, scarfLift: 1 - 0.4 * smooth(land, land + 1, t), lamp: 1 };
}
function shot3cam(t) {
  const push = easeInOut(lin(25.4, 29.2, t));
  return { x: lerp(960, 1160, push), y: lerp(lerp(330, 540, easeInOut(lin(19, 21.6, t))), 600, push), z: lerp(1, 1.5, push) };
}

function sandPuff(ctx, t, x, y, t0, seed, n = 22, spread = 1) {
  const k = t - t0; if (k < 0 || k > 3.5) return;
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const dir = (r() < 0.5 ? -1 : 1), vx = dir * (60 + r() * 160) * spread, vy = -(20 + r() * 70);
    const e = 1 - Math.exp(-k * 1.6);
    const px = x + vx * e / 1.6 * 1.6, py = y + vy * e - 6 * k;
    const rad = (10 + r() * 22) * (0.6 + k * 0.5) * spread;
    ctx.fillStyle = `rgba(170,150,110,${0.38 * (1 - k / 3.5)})`;
    ctx.beginPath(); ctx.arc(px, py, rad, 0, TAU); ctx.fill();
  }
}
function shot3(ctx, t, W, H) {
  const cam = shot3cam(t);
  camApply(ctx, cam);
  ctx.fillStyle = vgrad(ctx, 0, 1080, [[0, '#0d2236'], [1, '#08131f']]); ctx.fillRect(-200, -200, 2320, 1480);
  seabed(ctx, t);
  const wake = smooth(EV.libWake, EV.libWake + 1.2, t) * (0.9 + 0.1 * Math.sin(t * 7));
  library(ctx, t, wake);
  kelp(ctx, t, 760, 880, 260, 3); kelp(ctx, t, 1700, 860, 320, 4); kelp(ctx, t, 90, 910, 200, 6);
  const p = diverShot3(t);
  FX.bubbles(ctx, t, { ...BUB.s3,
    emit: (te) => { const q = diverShot3(Math.max(19, te)); const e = FX.exhaust(q); return [e[0], e[1], q.s]; } });
  const info = drawDiver(ctx, p);
  // sand kicked up by the landing and by each step
  sandPuff(ctx, t, 420, 925, EV.land, 31, 26, 1.1);
  for (const [ts, x] of [[22.9, 455], [24.0, 495], [27.3, 525], [28.4, 560]]) sandPuff(ctx, t, x, 922, ts, Math.round(ts * 10), 8, 0.45);
  // darkness, with the lamp cone + library glow as light
  darkness(ctx, W, H, 0.9, '3,9,18', [
    { x: info.lamp[0], y: info.lamp[1], cone: true, ang: info.lampAng, half: 0.24, len: 1500, r: 160, a: 1 },
    { x: LIB.cx, y: LIB.gy - 200, r: 700, a: 0.55 * wake },
    { x: info.chest[0], y: info.chest[1], r: 230, a: 0.7 },
  ]);
  drawBeam(ctx, info.lamp[0], info.lamp[1], info.lampAng, 0.8, 1500, 0.24);
  // window halos once the library wakes
  if (wake > 0) {
    ctx.save(); ctx.translate(LIB.cx, LIB.gy); ctx.rotate(LIB.tilt); ctx.translate(-LIB.cx, -LIB.gy); ctx.globalCompositeOperation = 'lighter';
    for (const dx of [-240, -120, 120, 240]) glow(ctx, LIB.cx + dx, LIB.gy - 150, 120, '255,196,107', 0.28 * wake);
    glow(ctx, LIB.cx, LIB.gy - 180, 260, '255,196,107', 0.3 * wake);
    ctx.restore();
  }
  // plankton glittering in the beam
  const ls = toScreen(cam, info.lamp);
  ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
  FX.marineSnow(ctx, t, { n: 160, seed: 33, vy: -6, size: 2.2, alpha: 0.12, darkMul: 1,
    scrollX: (cam.x - 960) * 1.2, scrollY: (cam.y - 540) * 1.2, lightFn: (x, y) => coneLight(x, y, ls[0], ls[1], info.lampAng, 0.24, 1500 * cam.z) });
  FX.waterWobble(ctx, t, 1.1);
  camApply2(ctx, cam, W, H);
  // fade to black into the hall
  const fb = smooth(28.4, 29, t);
  if (fb > 0) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(0,0,0,${fb})`; ctx.fillRect(0, 0, W, H); ctx.restore(); }
}

// ======================================================================
// HALL (shots 4–8): one-point perspective interior
// ======================================================================
const F = 820, HALL = { wx: 5.5, floor: 3, shelfTop: -7, ceil: -9.5, zEnd: 44 };
function proj(cam, X, Y, Z) { const z = Z - cam.z; return z < 0.25 ? null : [cam.cx + (X - cam.x) / z * F, cam.cy + (Y - cam.y) / z * F, F / z]; }
const LAMPS = Array.from({ length: EV.lampN }, (_, i) => ({ Z: 6 + 4 * i, X: 0, Y: -6.2 })); // index 0 nearest
const lampLevelHall = (t, i) => { // i: 0 nearest .. N-1 farthest ; farthest goes out first
  const k = EV.lampN - 1 - i, to = lampOffTime(k);
  const flick = 0.85 + 0.15 * Math.sin(t * 9 + i * 2.1) * Math.sin(t * 3.3 + i);
  if (t < to) return flick;
  return flick * (1 + 1.2 * bump(t, to + 0.05, 0.05)) * (1 - smooth(to + 0.05, to + 0.35, t));
};
const SHELF_BOOKS = (() => {
  const r = rng(101), out = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 10; row++) {
      const yb = HALL.shelfTop + (row + 1) * 1.0;
      let z = 1.0;
      while (z < HALL.zEnd - 0.5) {
        const w = 0.1 + r() * 0.18;
        if (r() < 0.05) { z += 0.3 + r() * 0.4; continue; } // gap
        out.push({ side, row, yb, z0: z, z1: z + w, h: 0.55 + r() * 0.33, col: Math.floor(r() * BOOKCOL.length), lean: r() < 0.04 });
        z += w + 0.012;
      }
    }
  }
  return out;
})();
// specific shelf book the diver pulls (right wall)
const PULL = { side: 1, Y: -0.6, Z: 8.4 };
// shelf spots where memory orbs come from
const ORB_SRC = (() => { const r = rng(55); return Array.from({ length: EV.orbN }, (_, i) => ({ side: i % 2 ? 1 : -1, Y: -5 + r() * 6, Z: 9 + i * 3.2 + r() * 2, mem: i % MEMS.length, drift: (r() - 0.5) * 2, tX: (i % 2 ? 1 : -1) * (2.0 + ((i * 5) % 4) * 0.55), tY: -6.2 + ((i * 3) % 4) * 1.15 })); })();
const FLOATERS = (() => {
  const r = rng(77);
  return Array.from({ length: 16 }, () => ({ X: (r() - 0.5) * 8, Y: -5 + r() * 6, Z: 5 + r() * 30, ph: r() * TAU, col: Math.floor(r() * BOOKCOL.length), sp: 0.2 + r() * 0.3 }))
    // keep the air clear around the spot where the diver pulls the book (they read as "on his head" otherwise)
    .map((f) => (f.X > 1.2 && f.Z > 5 && f.Z < 13 ? { ...f, X: f.X - 4.2 } : f));
})();

function hallAmbient(t) {
  let s = 0; for (let i = 0; i < EV.lampN; i++) s += Math.min(1, lampLevelHall(t, i)); return s / EV.lampN;
}

function drawHall(ctx, t, cam, opts = {}) {
  const { wx, floor, shelfTop, ceil, zEnd } = HALL;
  const P = (X, Y, Z) => proj(cam, X, Y, Z);
  // base fill (deep water tone)
  ctx.fillStyle = '#0b1a26'; ctx.fillRect(-50, -50, VW + 100, VH + 100);
  const zN = Math.max(cam.z + 0.6, 0.3);
  // end wall with tall arched window
  const e0 = P(-wx, ceil, zEnd), e1 = P(wx, floor, zEnd);
  ctx.fillStyle = '#1a2a30'; ctx.fillRect(e0[0], e0[1], e1[0] - e0[0], e1[1] - e0[1]);
  const w0 = P(-1.5, -6, zEnd), w1 = P(1.5, 2, zEnd);
  ctx.fillStyle = '#2d5866'; ctx.beginPath(); ctx.moveTo(w0[0], w1[1]); ctx.lineTo(w0[0], w0[1] + (w1[0] - w0[0]) / 2);
  ctx.arc((w0[0] + w1[0]) / 2, w0[1] + (w1[0] - w0[0]) / 2, (w1[0] - w0[0]) / 2, Math.PI, 0); ctx.lineTo(w1[0], w1[1]); ctx.closePath(); ctx.fill();
  // floor
  const fq = [P(-wx, floor, zN), P(wx, floor, zN), P(wx, floor, zEnd), P(-wx, floor, zEnd)];
  poly(ctx, fq); ctx.fillStyle = '#3a3330'; ctx.fill();
  ctx.strokeStyle = 'rgba(20,15,15,0.55)'; ctx.lineWidth = 2;
  for (let z = Math.ceil(zN); z < zEnd; z += 1.5) { const a = P(-wx, floor, z), b = P(wx, floor, z); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  for (let x = -wx + 1.1; x < wx; x += 1.1) { const a = P(x, floor, zN), b = P(x, floor, zEnd); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  // carpet runner
  poly(ctx, [P(-1.4, floor, zN), P(1.4, floor, zN), P(1.4, floor, zEnd), P(-1.4, floor, zEnd)]); ctx.fillStyle = '#5a2a2e'; ctx.fill();
  // ceiling
  poly(ctx, [P(-wx, shelfTop, zN), P(wx, shelfTop, zN), P(wx, shelfTop, zEnd), P(-wx, shelfTop, zEnd)]); ctx.fillStyle = '#16242c'; ctx.fill();
  // walls (shelf back)
  for (const s of [-1, 1]) {
    poly(ctx, [P(s * wx, shelfTop, zN), P(s * wx, floor, zN), P(s * wx, floor, zEnd), P(s * wx, shelfTop, zEnd)]);
    ctx.fillStyle = '#2b1d16'; ctx.fill();
  }
  // books, batched by colour
  const X = (s) => s * (wx - 0.15);
  for (let c = 0; c < BOOKCOL.length; c++) {
    ctx.beginPath();
    for (const b of SHELF_BOOKS) {
      if (b.col !== c || b.z0 < zN || (opts.hidePull && b.side === PULL.side && Math.abs(b.yb - 0 - (PULL.Y + 0.6)) < 0.01 && b.z0 <= PULL.Z && b.z1 >= PULL.Z)) continue;
      const a = P(X(b.side), b.yb - b.h, b.z0), d = P(X(b.side), b.yb, b.z1);
      if (!a || !d) continue;
      const a2 = P(X(b.side), b.yb, b.z0), d2 = P(X(b.side), b.yb - b.h, b.z1);
      if (Math.abs(d[0] - a[0]) < 0.3) continue;
      ctx.moveTo(a[0], a[1]); ctx.lineTo(a2[0], a2[1]); ctx.lineTo(d[0], d[1]); ctx.lineTo(d2[0], d2[1]); ctx.closePath();
    }
    ctx.fillStyle = BOOKCOL[c]; ctx.fill();
  }
  // shelf boards + uprights
  ctx.fillStyle = '#4a3020';
  for (const s of [-1, 1]) {
    for (let row = 0; row <= 10; row++) {
      const y = shelfTop + row * 1.0;
      const q = [P(s * (wx - 0.45), y, zN), P(s * (wx - 0.45), y + 0.1, zN), P(s * (wx - 0.45), y + 0.1, zEnd), P(s * (wx - 0.45), y, zEnd)];
      poly(ctx, q); ctx.fill();
    }
    for (let z = 4; z < zEnd; z += 4) {
      if (z < zN) continue;
      poly(ctx, [P(s * (wx - 0.45), shelfTop - 0.3, z), P(s * (wx - 0.45), floor, z), P(s * (wx - 0.45), floor, z + 0.35), P(s * (wx - 0.45), shelfTop - 0.3, z + 0.35)]);
      ctx.fill();
    }
  }
  // ceiling ribs (pointed arches)
  ctx.strokeStyle = '#4a3a2e';
  for (let z = 4; z < zEnd; z += 4) {
    if (z < zN) continue;
    const a = P(-wx, shelfTop, z), b = P(0, ceil - 1.5, z), c = P(wx, shelfTop, z);
    ctx.lineWidth = Math.max(1, 0.25 * a[2]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(a[0], b[1], b[0], b[1]); ctx.quadraticCurveTo(c[0], b[1], c[0], c[1]); ctx.stroke();
  }
  // depth fog toward the vanishing point
  const vp = P(0, -1, zEnd);
  const fog = ctx.createRadialGradient(vp[0], vp[1], 0, vp[0], vp[1], 900);
  fog.addColorStop(0, 'rgba(14,40,52,0.95)'); fog.addColorStop(0.35, 'rgba(14,40,52,0.6)'); fog.addColorStop(1, 'rgba(14,40,52,0)');
  ctx.fillStyle = fog; ctx.fillRect(-50, -50, VW + 100, VH + 100);
  // floating books
  for (const fb of FLOATERS) {
    const q = P(fb.X + Math.sin(t * 0.3 + fb.ph) * 0.4, fb.Y + Math.sin(t * fb.sp + fb.ph) * 0.4, fb.Z);
    if (!q || q[2] > 400) continue;
    drawBookClosed(ctx, q[0], q[1], 0.5 * q[2], 0.7 * q[2], Math.sin(t * 0.4 + fb.ph) * 0.6, BOOKCOL[fb.col]);
  }
}

function drawHallLamps(ctx, t, cam, dim = 1) {
  for (let i = EV.lampN - 1; i >= 0; i--) {
    const L = LAMPS[i], q = proj(cam, L.X, L.Y, L.Z), top = proj(cam, L.X, HALL.ceil, L.Z);
    if (!q) continue;
    const lv = lampLevelHall(t, i) * dim;
    ctx.strokeStyle = '#2a2220'; ctx.lineWidth = Math.max(1, 0.05 * q[2]);
    ctx.beginPath(); ctx.moveTo(q[0], top[1]); ctx.lineTo(q[0], q[1] - 0.35 * q[2]); ctx.stroke();
    const r = 0.35 * q[2];
    ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, TAU);
    ctx.fillStyle = lv > 0.05 ? `rgb(${Math.round(lerp(60, 255, Math.min(1, lv)))},${Math.round(lerp(55, 214, Math.min(1, lv)))},${Math.round(lerp(50, 140, Math.min(1, lv)))})` : '#3a3a3c';
    ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = Math.max(1, 0.04 * q[2]); ctx.stroke();
    ctx.fillStyle = '#6b5030'; ctx.fillRect(q[0] - r * 0.5, q[1] - r * 1.15, r, r * 0.3);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; glow(ctx, q[0], q[1], 3.2 * q[2] * 0.5, '255,196,107', 0.55 * Math.min(1.5, lv));
    // soft cone of light falling to the floor
    const fl = proj(cam, L.X, HALL.floor, L.Z), fw = proj(cam, L.X + 1.6, HALL.floor, L.Z);
    if (fl && fw && lv > 0.02) {
      const hw = fw[0] - fl[0];
      const g = ctx.createLinearGradient(0, q[1], 0, fl[1]);
      g.addColorStop(0, `rgba(255,200,120,${0.12 * Math.min(1, lv)})`); g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(q[0] - r, q[1]); ctx.lineTo(q[0] + r, q[1]); ctx.lineTo(fl[0] + hw, fl[1]); ctx.lineTo(fl[0] - hw, fl[1]); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}
// sparks when a lamp dies
function lampSparks(ctx, t, cam) {
  for (let i = 0; i < EV.lampN; i++) {
    const to = lampOffTime(EV.lampN - 1 - i), k = t - to;
    if (k < 0 || k > 1.2) continue;
    const L = LAMPS[i], q = proj(cam, L.X, L.Y, L.Z); if (!q) continue;
    const r = rng(500 + i);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let j = 0; j < 10; j++) {
      const a = r() * TAU, v = (0.6 + r()) * q[2] * 0.9;
      const x = q[0] + Math.cos(a) * v * k, y = q[1] + Math.sin(a) * v * k + 0.5 * q[2] * k * k;
      ctx.fillStyle = `rgba(255,220,150,${(1 - k / 1.2) * 0.9})`; ctx.beginPath(); ctx.arc(x, y, Math.max(1, 0.035 * q[2]), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
}
// dust motes + wobble common to the hall shots (screen space)
function hallAtmos(ctx, t, W, H, cam, amb, wob = 1.0) {
  ctx.save(); ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
  FX.marineSnow(ctx, t, { n: 130, seed: 44, vy: -10, vx: 4, size: 2.0, alpha: 0.1 + 0.3 * amb, color: '255,226,170', scrollX: cam.x * 120, scrollY: cam.z * 30 });
  ctx.restore();
  FX.waterWobble(ctx, t, wob);
}
function hallLights(t, cam, extra = []) {
  const out = [];
  for (let i = 0; i < EV.lampN; i++) {
    const L = LAMPS[i], q = proj(cam, L.X, L.Y, L.Z); if (!q) continue;
    out.push({ x: q[0], y: q[1], r: 4.5 * q[2], a: 0.9 * Math.min(1, lampLevelHall(t, i)) });
  }
  return out.concat(extra);
}

// ---- shot 4: diver swims in and pulls a red book (29–40)
function shot4cam(t) {
  const u = easeInOut(lin(29, 40, t));
  const v = easeInOut(lin(33.5, 40, t)); // second move: push in on the diver at the shelf
  return { x: lerp(-0.6, 1.3, u) + 1.0 * v, y: lerp(-0.2, -0.6, u) + 0.25 * v, z: lerp(-2.6, 1.2, u) + 2.0 * v, cx: 960, cy: 470 };
}
// diver path in hall space (X,Y = pelvis, Z depth)
function shot4diver3D(t) {
  const u = lin(29.3, 34.6, t), e = 1 - Math.pow(1 - u, 2.4);
  const bob = Math.sin(t * 2.2) * 0.06;
  return [lerp(-1.2, 3.55, e), lerp(2.2, 0.75, e) + bob, lerp(3.4, PULL.Z - 0.2, e)];
}
function shot4pose(t) {
  const cam = shot4cam(t);
  // diver anchored in 3D, scaled by perspective
  const D = shot4diver3D(t), dq = proj(cam, D[0], D[1], D[2]);
  const swimming = 1 - smooth(33.6, 34.8, t);
  const ph = t * 2.6;
  return { x: dq[0], y: dq[1], s: dq[2] / 128, f: 1, t, scarfLift: 1, lamp: 1,
    rot: lerp(0.12, 1.05, swimming) + 0.06 * Math.sin(ph),
    lF: [lerp(0.15, 0.55 + 0.45 * Math.sin(ph + 1.6), swimming), lerp(-0.3, -1.0 - 0.6 * Math.max(0, Math.sin(ph + 1.6)), swimming)],
    lB: [lerp(-0.2, 0.35 + 0.45 * Math.sin(ph + 1.6), swimming), lerp(-0.4, -1.1 - 0.6 * Math.max(0, Math.sin(ph + 1.6)), swimming)],
    aF: [lerp(0.7, 2.3 + 0.75 * Math.sin(ph), swimming), lerp(0.5, 0.25 + 0.5 * Math.max(0, -Math.sin(ph)), swimming)],
    aB: [lerp(0.6, 2.2 + 0.75 * Math.sin(ph + 0.15), swimming), lerp(0.55, 0.3 + 0.5 * Math.max(0, -Math.sin(ph + 0.15)), swimming)],
    head: lerp(-0.25, -0.75, swimming) + 0.12 * bump(t, EV.pull + 1.4, 0.9) * 3 };
}
function shot4(ctx, t, W, H) {
  const cam = shot4cam(t);
  drawHall(ctx, t, cam, { hidePull: true });
  drawHallLamps(ctx, t, cam);
  const p = shot4pose(t);
  FX.bubbles(ctx, t, { ...BUB.s4,
    emit: (te) => { const q = shot4pose(Math.max(29.3, te)); const e = FX.exhaust(q); return [e[0], e[1], q.s]; } });
  // the red book: in the shelf -> slides out -> in the hand -> brought to the chest
  const slot = proj(cam, HALL.wx - 0.15, PULL.Y, PULL.Z);
  const slide = smooth(EV.pull - 0.3, EV.pull + 0.25, t);
  const bookOut = proj(cam, lerp(HALL.wx - 0.15, HALL.wx - 0.75, slide), PULL.Y + 0.05 * slide, PULL.Z);
  const reach = smooth(EV.pull - 1.4, EV.pull - 0.4, t);
  const toChest = smooth(EV.pull + 0.5, EV.pull + 1.6, t);
  const chest = [p.x + 34 * p.s, p.y - 52 * p.s];
  const holdPt = [lerp(bookOut[0], chest[0], toChest), lerp(bookOut[1], chest[1], toChest)];
  if (reach > 0) p.aF = mixA(p.aF, ikArm(p, t < EV.pull ? bookOut : holdPt), reach);
  if (toChest > 0) p.aB = mixA(p.aB, ikArm(p, [holdPt[0] - 6 * p.s, holdPt[1] + 10 * p.s]), toChest);
  const bw = 0.2 * slot[2], bh = 0.8 * slot[2];
  if (t < EV.pull + 0.25) {
    drawBookClosed(ctx, bookOut[0], bookOut[1] - bh * 0.1, lerp(bw, bw * 1.4, slide), bh, 0.05 * slide, BOOKCOL[0]);
  } else {
    p.held = (c) => drawBookClosed(c, holdPt[0], holdPt[1], lerp(bw * 1.6, 40 * p.s, toChest), lerp(bh, 56 * p.s, toChest), lerp(0.05, 0.2, toChest), BOOKCOL[0]);
  }
  const info = drawDiver(ctx, p);
  darkness(ctx, W, H, 0.45, '4,12,22', hallLights(t, cam, [{ x: info.lamp[0], y: info.lamp[1], cone: true, ang: info.lampAng, half: 0.2, len: 800, r: 80, a: 0.8 }]));
  drawBeam(ctx, info.lamp[0], info.lamp[1], info.lampAng, 0.5, 800, 0.2);
  hallAtmos(ctx, t, W, H, cam, 1, 1.0);
  fadeBlack(ctx, W, H, 1 - smooth(29, 29.6, t));
}

// ---- shot 5: pages turn into fish (40–50)
const S5 = { x: 640, y: 760, s: 2.3 };
function shot5cam(t) { return { x: 2.0, y: -0.6, z: 2.5, cx: 960, cy: 470 }; }
function fishState(i, t, book) {
  const pt = t - pageTime(i);
  if (pt < 0) return null;
  const r = rng(300 + i); const ph = r() * TAU, dirS = r() < 0.5 ? 1 : -1, rad = 230 + r() * 120;
  // phase A: lift off the right page; B: morph; C: swim circle; D: exit to depth
  const lift = easeOut(lin(0, 0.6, pt)), m = smooth(0.3, 1.0, pt);
  const start = [book.x + book.w * 0.5, book.y];
  const up = [start[0] + 40 * lift, start[1] - 140 * lift];
  const tau = Math.max(0, pt - 0.9);
  const centre = [S5.x + 270, S5.y - 370]; // front half of the orbit crosses the book, not the face window
  const th = Math.atan2(up[1] - centre[1], up[0] - centre[0]) + dirS * tau * 1.4;
  const circ = [centre[0] + Math.cos(th) * rad * (1 + 0.15 * Math.sin(tau * 2 + ph)), centre[1] + Math.sin(th) * rad * 0.55];
  const exit = smooth(2.2, 5.0, tau);
  const vp = [1280 + 80 * Math.sin(ph), 420 + 40 * Math.cos(ph)];
  const inC = smooth(0, 0.6, tau);
  const pos = [lerp(lerp(up[0], circ[0], inC), vp[0], exit), lerp(lerp(up[1], circ[1], inC), vp[1], exit)];
  // far half of the orbit (upper half of the ellipse) passes BEHIND the diver: a little smaller and dimmer
  const back = inC > 0.5 && exit < 0.35 && Math.sin(th) < 0;
  const depthK = 1 - 0.18 * inC * (1 - exit) * Math.max(0, -Math.sin(th));
  return { pos, m, sc: lerp(1.6, 0.18, exit) * (1 + 0.3 * m) * depthK, flap: t * 14 + ph, a: (1 - smooth(4.4, 5.0, tau)) * (0.75 + 0.25 * depthK), pt, back, i };
}
function shot5pose(t) {
  // head: looks down at the book, then follows the fish up, then toward the depth
  const head = track([[40, [0.42]], [42.0, [0.45]], [43.2, [-0.25]], [45, [-0.35]], [46.5, [-0.05]], [48.5, [-0.15]], [50, [-0.1]]], t)[0] + 0.06 * Math.sin(t * 1.3);
  return { x: S5.x, y: S5.y + Math.sin(t * 1.2) * 6, s: S5.s, f: 1, rot: 0.05 + 0.02 * Math.sin(t * 0.9), t, scarfLift: 1, lamp: 1, head,
    lF: [0.38 + 0.1 * Math.sin(t * 1.4), -0.75 - 0.1 * Math.sin(t * 1.4)], lB: [0.05 - 0.1 * Math.sin(t * 1.4), -0.95] };
}
// big soft out-of-focus particles in front of the lens
function bokeh(ctx, t, n, seed, col, a) {
  const r = rng(seed);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const x = ((r() * 2200 + t * (8 + r() * 14)) % 2200) - 140, y = ((r() * 1300 - t * (10 + r() * 20)) % 1300 + 1300) % 1300 - 110;
    const rad = 30 + r() * 70;
    glow(ctx, x, y, rad, col, a * (0.5 + 0.5 * Math.sin(t * 0.7 + i)));
  }
  ctx.restore();
}
function shot5(ctx, t, W, H) {
  const cam = shot5cam(t);
  cam.x += 0.5 * lin(40, 50, t); // slow parallax drift of the background
  // background hall rendered soft (shallow depth of field)
  {
    const [bc, bg] = layer('s5bg', W, H);
    bg.setTransform(W / VW, 0, 0, H / VH, 0, 0);
    drawHall(bg, t, cam); drawHallLamps(bg, t, cam);
    darkness(bg, W, H, 0.62, '4,12,22', hallLights(t, cam));
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = `blur(${Math.round(5 * W / 1920 + 1)}px)`; ctx.drawImage(bc, 0, 0); ctx.filter = 'none'; ctx.restore();
  }
  // foreground camera: slow pull back around the book
  const z = lerp(1.16, 1.0, easeInOut(lin(40, 49, t)));
  ctx.save(); ctx.translate(820, 560); ctx.scale(z, z); ctx.translate(-820, -560);
  const open = easeInOut(lin(40.4, 41.3, t));
  // head: looks down at the book, then follows the fish up, then toward the depth
  const p = shot5pose(t);
  FX.bubbles(ctx, t, { ...BUB.s5,
    emit: (te) => { const q = shot5pose(te); const e = FX.exhaust(q); return [e[0], e[1], q.s * 0.8]; } });
  const bookPos = [S5.x + 100 * S5.s, S5.y - 70 * S5.s + Math.sin(t * 1.2) * 6];
  p.aF = ikArm(p, [bookPos[0] + 42 * S5.s * lerp(0.4, 1, open), bookPos[1] + 26 * S5.s]);
  p.aB = ikArm(p, [bookPos[0] - 30 * S5.s * lerp(0.4, 1, open), bookPos[1] + 28 * S5.s]);
  const book = { x: bookPos[0], y: bookPos[1], w: 120, h: 160 };
  const fs = [];
  for (let i = 0; i < EV.pageN; i++) { const s = fishState(i, t, book); if (s) fs.push(s); }
  const drawFish = (back) => {
    for (const s of fs) {
      if (s.back !== back) continue;
      const s2 = fishState(s.i, t + 0.04, book) || s;
      const head = Math.atan2(s2.pos[1] - s.pos[1], s2.pos[0] - s.pos[0]);
      const ang = s.pt < 1.0 ? lerp(0.35 * Math.sin(s.pt * 11) * (1 - s.m), head, smooth(0.55, 1.0, s.pt)) : head;
      const sx = 1 - 0.6 * bump(s.pt, 0.28, 0.16) - 0.3 * bump(s.pt, 0.62, 0.12);
      // a short trail of tiny bubbles behind each swimming fish
      if (s.m > 0.9) for (let j = 1; j <= 3; j++) {
        const sb = fishState(s.i, t - j * 0.12, book); if (!sb) continue;
        FX.drawBubble(ctx, sb.pos[0] + Math.sin(t * 6 + j) * 3, sb.pos[1] - j * 6, 2 + j * 0.8 * sb.sc, s.a * (1 - j / 4), true);
      }
      drawPaperFish(ctx, s.pos[0], s.pos[1], ang, s.sc, s.m, s.flap, s.a, sx);
    }
  };
  drawFish(true);
  p.held = (c) => {
    const [bx, by] = bookPos;
    c.save(); c.translate(bx, by);
    if (open <= 0) drawBookClosed(c, 0, 0, 120, 160, 0, BOOKCOL[0]);
    else { c.save(); c.translate(lerp(-60, 0, open), 0); drawBookOpen(c, 120, 160, BOOKCOL[0], 1, 0); c.restore();
      if (open < 1) { c.save(); c.translate(-60 + 60 * open, 0); c.scale(Math.cos(open * Math.PI), 1); rrect(c, 0, -84, 126, 168, 8); fillOut(c, open < 0.5 ? BOOKCOL[0] : '#c9b48a', 4); c.restore(); } }
    c.restore();
  };
  drawDiver(ctx, p);
  drawFish(false);
  // warm light rising out of the open book
  if (book && open > 0) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; glow(ctx, book.x, book.y - 20, 260, '255,214,140', 0.22 * open); ctx.restore(); }
  ctx.restore();
  bokeh(ctx, t, 9, 61, '255,214,150', 0.07);
  ctx.save(); ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
  FX.marineSnow(ctx, t, { n: 70, seed: 55, vy: -12, size: 2.6, alpha: 0.3, color: '255,230,180' });
  ctx.restore();
  FX.waterWobble(ctx, t, 1.0);
  ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
  wipeFish(ctx, t);
}
// wipe 5->6: one big paper fish swims across the lens; the cut happens while it covers the frame
function wipeFish(ctx, t) {
  const wp = lin(49.4, 50.55, t);
  if (wp > 0 && wp < 1) drawPaperFish(ctx, lerp(3000, -1100, wp), 560 + 60 * Math.sin(wp * 6), Math.PI + 0.08 * Math.sin(wp * 9), 34, 1, t * 16, 1);
}

// ---- shot 6: teal book opens, push into the first memory (50–61)
function shot6(ctx, t, W, H) {
  ctx.fillStyle = '#0b1a26'; ctx.fillRect(0, 0, VW, VH);
  const cam = { x: 1.0 + 0.3 * lin(50, 61, t), y: -1.5, z: 4.0, cx: 960, cy: 440 };
  {
    const [bc, bg] = layer('s6bg', W, H);
    bg.setTransform(W / VW, 0, 0, H / VH, 0, 0);
    drawHall(bg, t, cam); drawHallLamps(bg, t, cam);
    bg.fillStyle = 'rgba(4,10,18,0.6)'; bg.fillRect(0, 0, VW, VH);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = `blur(${Math.round(7 * W / 1920 + 1)}px)`; ctx.drawImage(bc, 0, 0); ctx.filter = 'none'; ctx.restore();
  }
  const push = easeIn(lin(EV.iris - 0.6, EV.iris + 1.2, t)) * (1 - easeOut(lin(EV.irisOut + 0.3, 61, t)));
  const sc = lerp(1, 7, push) * (1 + 0.1 * smooth(50, EV.iris, t)) * (1 + 0.06 * smooth(EV.irisOut, 61, t));
  ctx.save(); ctx.translate(960, 600 + 6 * Math.sin(t * 1.1)); ctx.scale(sc, sc);
  const open = easeInOut(lin(EV.open2, EV.open2 + 1.1, t));
  const glowA = smooth(EV.open2 + 0.6, EV.open2 + 2.2, t);
  const pw = 300, ph = 400;
  // The cover swings around the spine (x=0): k = 1 closed (cover over the right page) .. -1 fully open (on the left).
  // The left page is revealed under the cover as it swings, and the whole book stays centred on screen.
  const k = Math.cos(open * Math.PI);
  const leftX = Math.min(0, k * pw), shift = -(pw + leftX) / 2;
  ctx.translate(shift, 0);
  // right page block (always there)
  rrect(ctx, 0, -ph / 2, pw, ph, 10); fillOut(ctx, PAPER, 4);
  if (open > 0.5) textLines(ctx, pw * 0.12, -ph * 0.4, pw * 0.76, ph * 0.8, 9, 'rgba(60,45,35,0.45)');
  // left page grows out from the spine under the cover
  if (leftX < -1) {
    rrect(ctx, leftX, -ph / 2, -leftX, ph, 10); fillOut(ctx, '#e6d6b0', 4);
    ctx.save(); ctx.scale(-k, 1); textLines(ctx, -pw * 0.88, -ph * 0.4, pw * 0.76, ph * 0.8, 9, 'rgba(60,45,35,0.45)'); ctx.restore();
  }
  // the cover itself: outside (teal, emblem) while k>0, inside (worn board) while k<0
  ctx.save(); ctx.scale(k, 1);
  rrect(ctx, 0, -ph / 2 - 8, pw + 10, ph + 16, 14);
  if (k > 0) {
    fillOut(ctx, BOOKCOL[1], 5);
    ctx.lineWidth = 6; ctx.strokeStyle = '#e9c46a'; ctx.beginPath(); ctx.arc(pw / 2, -30, 50, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#e9c46a'; ctx.font = 'bold 40px Georgia'; ctx.textAlign = 'center'; ctx.fillText('M', pw / 2, -16); ctx.fillRect(30, 120, pw - 60, 6);
  } else { fillOut(ctx, '#c9b48a', 5); }
  ctx.restore();
  ctx.fillStyle = BOOKCOL[1]; ctx.fillRect(-8, -ph / 2 - 8, 14, ph + 16); // spine
  ctx.restore(); ctx.save(); ctx.translate(960, 600 + 6 * Math.sin(t * 1.1)); ctx.scale(sc, sc);
  // gloves on the book's actual lower corners
  const edges = [shift + Math.min(leftX, k * (pw + 10)) , shift + pw];
  for (const [ii, s] of [[0, -1], [1, 1]]) {
    const gx = edges[ii] + s * 4, gy = ph / 2 - 40;
    ctx.save(); ctx.translate(gx, gy); ctx.rotate(s * 0.3); ctx.scale(1.55, 1.55);
    rrect(ctx, -26, 10, 52, 120, 18); fillOut(ctx, '#7d6c58', 5);           // sleeve
    ctx.beginPath(); ctx.ellipse(0, 18, 30, 12, 0, 0, TAU); fillOut(ctx, '#8a5a26', 4); // brass cuff
    ctx.beginPath(); ctx.ellipse(0, -4, 30, 30, 0, 0, TAU); fillOut(ctx, '#4b3a2d', 5);  // glove
    ctx.beginPath(); ctx.ellipse(-s * 22, -24, 12, 18, s * 0.6, 0, TAU); fillOut(ctx, '#4b3a2d', 4); // thumb over the page
    ctx.restore();
  }
  if (glowA > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    glow(ctx, 0, -10, 420, '255,214,130', glowA * 0.9);
    // slowly turning light spokes
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * TAU + t * 0.25, w = 0.07 + 0.04 * Math.sin(i * 2.3 + t);
      const g = ctx.createRadialGradient(0, -10, 0, 0, -10, 900);
      g.addColorStop(0, `rgba(255,226,160,${0.22 * glowA})`); g.addColorStop(1, 'rgba(255,226,160,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, -10); ctx.arc(0, -10, 900, a - w, a + w); ctx.closePath(); ctx.fill();
    }
    // golden motes rising out of the pages
    const r = rng(66);
    for (let i = 0; i < 40; i++) {
      const life = 2.2 + r() * 1.5, ph = r() * life, k = ((t - EV.open2 + ph) % life) / life;
      const x = (r() - 0.5) * pw * 1.6 + Math.sin(t * 2 + i) * 12, y = -20 - k * (260 + r() * 200);
      ctx.fillStyle = `rgba(255,232,170,${glowA * Math.sin(k * Math.PI) * 0.9})`;
      ctx.beginPath(); ctx.arc(x, y, 2 + r() * 3, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
  // white-out then memory in an iris
  const wo = smooth(EV.iris + 0.3, EV.iris + 1.2, t) * (1 - smooth(EV.iris + 1.2, EV.iris + 1.8, t));
  const irisR = t < EV.irisOut ? lerp(0, 1250, easeOut(lin(EV.iris + 1.1, EV.iris + 2.2, t))) : lerp(1250, 0, easeInOut(lin(EV.irisOut, EV.irisOut + 1.15, t)));
  if (irisR > 1) {
    ctx.save(); ctx.beginPath(); ctx.arc(960, 540, irisR, 0, TAU); ctx.clip();
    const mt = t - EV.iris, mz = 640 * (1 + 0.08 * lin(0, 6, mt));
    ctx.translate(960 + 60 - 22 * mt, 500); ctx.scale(mz, mz); memKite(ctx, mt);
    ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
    // memory "projector": light leak drifting in from the corner + gentle flicker + soft sepia vignette
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, 1700 + 120 * Math.sin(mt * 0.6), 120 + 60 * Math.sin(mt * 0.4), 700, '255,150,80', 0.22 + 0.06 * Math.sin(mt * 3.1));
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(255,240,210,${0.04 * (0.5 + 0.5 * Math.sin(mt * 23) * Math.sin(mt * 7))})`; ctx.fillRect(0, 0, VW, VH);
    const vg = ctx.createRadialGradient(960, 540, 300, 960, 540, 1100); vg.addColorStop(0, 'rgba(90,50,20,0)'); vg.addColorStop(1, 'rgba(90,50,20,0.45)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, VW, VH);
    ctx.restore();
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(255,226,160,0.35)'; ctx.lineWidth = 36; ctx.beginPath(); ctx.arc(960, 540, irisR, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,236,190,0.9)'; ctx.lineWidth = 8; ctx.stroke(); ctx.restore();
  }
  if (wo > 0) { ctx.fillStyle = `rgba(255,240,205,${wo})`; ctx.fillRect(0, 0, VW, VH); }
  wipeFish(ctx, t);
}

// ---- shots 7 & 8: memory orbs, then lamps go out (61–82)
function orbState(i, t, cam) {
  const o = ORB_SRC[i], k = t - orbTime(i);
  if (k < 0) return null;
  const rise = easeOut(lin(0, 6, k));
  const X = lerp(o.side * (HALL.wx - 0.6), o.tX, rise) + Math.sin(t * 0.5 + i * 2) * 0.12, Y = lerp(o.Y, o.tY, rise) + Math.sin(t * 0.8 + i) * 0.15;
  const q = proj(cam, X, Y, o.Z);
  if (!q) return null;
  // orbs fade when "their" lamps go out
  const off = lampOffTime(Math.min(EV.lampN - 1, Math.floor((EV.orbN - 1 - i) * EV.lampN / EV.orbN)));
  const a = smooth(0, 0.6, k) * (1 - smooth(off, off + 0.5, t));
  const src = proj(cam, o.side * (HALL.wx - 0.4), o.Y, o.Z);
  return { q, r: lerp(0.3, 1.35, smooth(0, 1.6, k)) * q[2], a, mem: o.mem, src, k };
}
function hallDiverPose(t) {
  const turn = smooth(66.0, 66.45, t);
  // f goes 1 -> -1 through a quick "card turn" (cut-out animation style)
  const f = Math.cos(turn * Math.PI);
  const fs = Math.sign(f || 1) * Math.max(0.12, Math.abs(f));
  // head: looks up at orbs; in shot 8 follows the lamps going out (far lamps are lower in frame -> nearer ones higher)
  let head = -0.5 + 0.12 * Math.sin(t * 0.6);
  if (t >= 72) {
    const k = clamp((t - EV.lampOffT0) / EV.lampOffGap, 0, EV.lampN - 1);
    head = lerp(-0.25, -0.95, k / (EV.lampN - 1)) + 0.05 * Math.sin(t * 0.8);
  }
  const p = { x: 960 + 60 * Math.sin(t * 0.3), y: 820 + Math.sin(t * 1.1) * 8, s: 1.1, f: fs, rot: 0.05 - 0.04 * smooth(78, 81, t),
    t, scarfLift: 1, lamp: 1, head,
    lF: [0.3 + Math.sin(t * 1.6) * 0.14, -0.65 - 0.12 * Math.max(0, Math.sin(t * 1.6))], lB: [-0.02 - Math.sin(t * 1.6) * 0.14, -0.8],
    aB: [0.9, 1.4], aF: [0.4 + Math.sin(t * 0.9) * 0.2, 0.5] };
  // reaches toward a memory orb (68.2–70.6)
  const reach = smooth(68.2, 69.0, t) * (1 - smooth(70.0, 70.8, t));
  if (reach > 0) p.aF = mixA(p.aF, [2.55 + 0.1 * Math.sin(t * 2), 0.15], reach);
  // hugs the book with both arms as the hall goes dark
  const hug = smooth(77.5, 79.0, t);
  if (hug > 0) { p.aF = mixA(p.aF, [1.15, 1.75], hug); p.aB = mixA(p.aB, [1.0, 1.7], hug); }
  return p;
}
// ---- shot 8 insert (79.4–82): helmet close-up as the last lamps die; ends on the book's glow (match cut to shot 9)
const CLOSE8 = 79.4; // = lampOffTime(8): the cut lands on that lamp's tick
function shot8close(ctx, t, W, H) {
  const u = lin(CLOSE8, 82, t);
  // background: the hall seen from below, looking up at the ceiling lamps, very soft
  const cam = { x: 0.3, y: -2.2, z: lerp(0.6, 1.2, u), cx: 900, cy: 760 };
  {
    const [bc, bg] = layer('s8bg', W, H);
    bg.setTransform(W / VW, 0, 0, H / VH, 0, 0);
    drawHall(bg, t, cam); drawHallLamps(bg, t, cam);
    darkness(bg, W, H, lerp(0.95, 0.45, hallAmbient(t)), '3,8,16', hallLights(t, cam));
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = `blur(${Math.round(9 * W / 1920 + 1)}px)`; ctx.drawImage(bc, 0, 0); ctx.filter = 'none'; ctx.restore();
  }
  // slow push on the helmet
  const z = lerp(1.0, 1.12, easeInOut(u));
  ctx.save(); ctx.translate(1000, 520); ctx.scale(z, z); ctx.translate(-1000, -520);
  const base = hallDiverPose(t);
  const p = { ...base, x: 1120 + 10 * Math.sin(t * 0.7), y: 880 + 8 * Math.sin(t * 1.1), s: 3.4, f: -1, rot: 0.04,
    head: lerp(-0.55, -0.95, smooth(CLOSE8 + 0.4, 81.2, t)) + 0.03 * Math.sin(t * 0.9), aF: [1.15, 1.75], aB: [1.0, 1.7] };
  const bookGlow = 1;
  p.held = (c, info) => drawBookClosed(c, info.handB[0] - 20, info.handB[1] - 40, 44 * 3.4, 58 * 3.4, 0.15, BOOKCOL[1], 0.45 * bookGlow);
  FX.bubbles(ctx, t, { ...BUB.s8close, lit: true,
    emit: (te) => { const q = { ...p, t: te, head: lerp(-0.55, -0.95, smooth(CLOSE8 + 0.4, 81.2, te)) }; const e = FX.exhaust(q); return [e[0], e[1], 2.2]; } });
  const info = drawDiver(ctx, p);
  // the last lamp's warm rim light on the brass, and its tiny reflection in the face window
  const last = Math.min(1, lampLevelHall(t, 0)), prev = Math.min(1, lampLevelHall(t, 1));
  const lit = Math.max(last, prev * 0.6);
  ctx.restore();
  // as everything dies, only the book is left: darkness closes in, the book light stays (matches shot 9's opening)
  const end = smooth(80.6, 81.8, t);
  const bookPt = [ (info.handB[0] - 20 - 1000) * z + 1000, (info.handB[1] - 40 - 520) * z + 520 ];
  const lampPt = [ (info.lamp[0] - 1000) * z + 1000, (info.lamp[1] - 520) * z + 520 ];
  darkness(ctx, W, H, lerp(0.55, 0.93, end), '3,8,16', [
    { x: bookPt[0], y: bookPt[1], r: 520, a: 0.9 },
    { x: lampPt[0], y: lampPt[1], cone: true, ang: info.lampAng, half: 0.2, len: 1600, r: 160, a: 0.8 * (1 - 0.5 * end) },
  ]);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  glow(ctx, bookPt[0], bookPt[1], 380, '255,214,130', 0.55);
  ctx.restore();
  drawBeam(ctx, lampPt[0], lampPt[1], info.lampAng, 0.5 * (1 - 0.5 * end), 1600, 0.2);
  // drawn after the darkness: warm rim light on the brass and the last lamps reflected in the face window
  const T = (pt) => [(pt[0] - 1000) * z + 1000, (pt[1] - 520) * z + 520];
  const hp = T(info.helmet), pp = T(info.port), hr = info.helmetR * z, pr = info.portR * z;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  glow(ctx, hp[0] - hr * 0.2, hp[1] - hr * 0.85, hr * 1.1, '255,200,120', 0.45 * lit);
  const g1 = [pp[0] + pr * 0.25, pp[1] - pr * 0.4];
  glow(ctx, g1[0], g1[1], pr * 0.55, '255,236,190', 1.0 * last);
  glow(ctx, g1[0] - pr * 0.4, g1[1] + pr * 0.15, pr * 0.35, '255,236,190', 0.9 * prev);
  ctx.globalCompositeOperation = 'source-over';
  for (const [pt, lv, rr] of [[g1, last, 0.2], [[g1[0] - pr * 0.4, g1[1] + pr * 0.15], prev, 0.13]]) {
    if (lv < 0.03) continue;
    ctx.fillStyle = `rgba(255,246,220,${Math.min(1, lv)})`; ctx.beginPath(); ctx.arc(pt[0], pt[1], pr * rr, 0, TAU); ctx.fill();
  }
  ctx.restore();
  FX.waterWobble(ctx, t, 1.0);
  ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
}
function shot78(ctx, t, W, H) {
  if (t >= CLOSE8) return shot8close(ctx, t, W, H);
  const s8 = t >= 72;
  const u7 = easeInOut(lin(61, 72, t));
  const cam = s8 ? { x: lerp(0.4, 0, smooth(72, 76, t)), y: -1.0, z: lerp(-0.2, 2.0, easeInOut(lin(73, 82, t))), cx: 960, cy: lerp(520, 470, smooth(72, 78, t)) }
    : { x: lerp(-0.9, 0.4, u7), y: -1.0, z: lerp(-1.4, -0.2, u7), cx: 960 + 40 * Math.sin(t * 0.25), cy: lerp(430, 520, u7) };
  drawHall(ctx, t, cam);
  drawHallLamps(ctx, t, cam);
  const orbs = [];
  for (let i = 0; i < EV.orbN; i++) { const s = orbState(i, t, cam); if (s) orbs.push(s); }
  // opening books on shelves
  for (const o of orbs) if (o.src && o.k < 3) { ctx.save(); ctx.translate(o.src[0], o.src[1]); drawBookOpen(ctx, 0.25 * o.src[2], 0.35 * o.src[2], BOOKCOL[1], 1, 0.6 * (1 - lin(0, 3, o.k))); ctx.restore(); }
  const p = hallDiverPose(t);
  FX.bubbles(ctx, t, { ...BUB.s78, lit: t > 79,
    emit: (te) => { const q = hallDiverPose(te); const e = FX.exhaust(q); return [e[0], e[1], q.s]; } });
  const bookGlow = 0.5 + 0.5 * smooth(78, 81, t);
  p.held = (c, info) => drawBookClosed(c, info.handB[0] + 10, info.handB[1] - 20, 44, 58, -0.15, BOOKCOL[1], 0.4 * bookGlow);
  const info = drawDiver(ctx, p);
  const amb = hallAmbient(t);
  const lights = hallLights(t, cam, [
    { x: info.lamp[0], y: info.lamp[1], cone: true, ang: info.lampAng, half: 0.2, len: 900, r: 90, a: 0.85 },
    { x: info.handB[0], y: info.handB[1], r: 260, a: 0.75 * bookGlow },
    ...orbs.map((o) => ({ x: o.q[0], y: o.q[1], r: o.r * 3, a: 0.6 * o.a })),
  ]);
  darkness(ctx, W, H, lerp(0.95, 0.45, amb), '3,8,16', lights);
  drawBeam(ctx, info.lamp[0], info.lamp[1], info.lampAng, 0.5, 900, 0.2);
  // orb sparkle trails (drawn first, under the discs)
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const o of orbs) {
    const r = rng(900 + o.mem * 13 + Math.round(o.k * 0));
    for (let j = 0; j < 12; j++) {
      const life = 1.6 + r() * 1.2, k = ((t + r() * life) % life) / life;
      const x = o.q[0] + (r() - 0.5) * o.r * 1.6 + Math.sin(t * 2 + j) * o.r * 0.1, y = o.q[1] + o.r * 0.6 + k * o.r * 1.8;
      ctx.fillStyle = `rgba(255,226,160,${0.8 * o.a * Math.sin(k * Math.PI)})`;
      ctx.beginPath(); ctx.arc(x, y, Math.max(1, o.r * 0.05), 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
  for (const o of orbs) drawMemoryDisc(ctx, o.q[0], o.q[1], o.r, MEMS[o.mem], t, o.a);
  lampSparks(ctx, t, cam);
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; glow(ctx, info.handB[0] + 10, info.handB[1] - 20, 120, '255,214,130', 0.5 * bookGlow); ctx.restore();
  hallAtmos(ctx, t, W, H, cam, amb, 1.0);
}

// ======================================================================
// SHOT 9 — ascent and breaching at dawn (82–90)
// ======================================================================
const SURF9 = 470;
function diverY9(t) {
  // world y of pelvis: rises from deep water, breaks the surface at EV.breach, then bobs on the waves
  if (t < EV.breach) { const u = lin(82, EV.breach, t); return lerp(2350, 610, 1 - Math.pow(1 - u, 1.6)) + 10 * Math.sin(t * 5); }
  const k = t - EV.breach;
  return 610 - 70 * easeOut(lin(0, 0.6, k)) + 18 * (1 - Math.exp(-k * 2)) * Math.sin(k * 5) + 30 * smooth(0.6, 1.6, k) + 8 * Math.sin(t * 1.4);
}
function shot9cam(t) {
  const dy = diverY9(t);
  // after the breach: push in on the diver holding the book up, horizon dropping to the lower third
  return { x: 960, y: Math.max(lerp(560, 440, smooth(EV.breach + 0.3, 89.6, t)), Math.min(dy - 80, 2000)), z: 1 + 0.55 * easeInOut(lin(EV.breach + 0.3, 89.8, t)) };
}
function shot9pose(t) {
  const kick = Math.sin(t * 6.2) * 0.42 * (1 - smooth(EV.breach, EV.breach + 0.6, t));
  return { x: 960 + 14 * Math.sin(t * 0.9), y: diverY9(t), s: 1.2, f: 1, rot: 0.03 * Math.sin(t * 1.2), t, scarfLift: 1 - 0.8 * smooth(EV.breach, EV.breach + 0.8, t),
    lamp: 1 - smooth(EV.breach, EV.breach + 0.5, t), head: lerp(-0.6, -0.15, smooth(EV.breach - 0.4, EV.breach + 0.8, t)),
    lF: [0.25 + kick, -0.35 - Math.max(0, kick) * 0.8], lB: [-0.15 - kick, -0.45 - Math.max(0, -kick) * 0.8] };
}
function shot9(ctx, t, W, H) {
  const surfY = SURF9;
  const cam = shot9cam(t);
  camApply(ctx, cam);
  // dawn sky + water column (world space; surface fixed at SURF9)
  ctx.save(); ctx.translate(0, surfY - WL); seaSurface(ctx, t, DAWN); ctx.restore();
  ctx.fillStyle = vgrad(ctx, surfY, surfY + 2200, [[0, '#4f9aa6'], [0.35, '#1d5a78'], [1, '#07121f']]); ctx.fillRect(-300, surfY, 2520, 2600);
  FX.godRays(ctx, t, { top: surfY, len: 1900, alpha: 0.26, x0: 100, span: 1700, seed: 12, tilt: -0.12, color: '255,226,210' });
  FX.caustics(ctx, t, { y0: surfY + 30, y1: surfY + 600, alpha: 0.07, cell: 100, color: '255,236,220' });
  const p = shot9pose(t);
  FX.bubbles(ctx, t, { ...BUB.s9, ceil: surfY + 8, lit: true,
    emit: (te) => { if (te > EV.breach - 0.3) return null; const q = shot9pose(Math.max(82, te)); const e = FX.exhaust(q); return [e[0], e[1], q.s]; } });
  const raise = smooth(EV.breach + 0.35, EV.breach + 1.25, t);
  const chest = [p.x + 36 * p.s, p.y - 54 * p.s];
  const up = [p.x + 22 * p.s, p.y - 150 * p.s]; // within arm reach (shoulder at -64, arm length 70)
  const bp = [lerp(chest[0], up[0], raise), lerp(chest[1], up[1], raise)];
  p.aF = ikArm(p, [bp[0] + 6 * p.s, bp[1] + 22 * p.s]);
  p.aB = raise > 0 ? mixA(ikArm(p, [chest[0] - 4 * p.s, chest[1] + 14 * p.s]), [0.5 + 0.2 * Math.sin(t * 2), 0.6], raise) : ikArm(p, [chest[0] - 4 * p.s, chest[1] + 14 * p.s]);
  p.held = (c) => drawBookClosed(c, bp[0], bp[1], 48, 64, lerp(-0.15, 0.08, raise), BOOKCOL[1], 0.55 * (1 - 0.6 * raise));
  drawDiver(ctx, p);
  // the water in front of the diver (only needed around the breach): translucent so the body reads underneath
  const front = smooth(EV.breach - 1.2, EV.breach - 0.2, t);
  if (front > 0) { ctx.save(); ctx.globalAlpha = front; ctx.fillStyle = vgrad(ctx, surfY, surfY + 500, [[0, 'rgba(79,154,166,0.55)'], [1, 'rgba(29,90,120,0.75)']]); ctx.fillRect(-300, surfY + 6, 2520, 2600); ctx.restore(); }
  surfaceLine(ctx, t, surfY, 'rgba(191,227,224,0.95)');
  // starts in the dark of shot 8: only the lamp and the book light the water, then dawn light takes over
  const dk = 0.93 * (1 - smooth(82.2, 85.0, t));
  if (dk > 0) {
    darkness(ctx, W, H, dk, '3,8,16', [{ x: bp[0], y: bp[1], r: 300, a: 0.85 }, { x: p.x + 20 * p.s, y: p.y - 150 * p.s, r: 140, a: 0.6 }]);
  }
  // breach splash
  const sp = t - EV.breach;
  if (sp > 0 && sp < 1.6) {
    const r = rng(19); ctx.fillStyle = `rgba(235,248,246,${1 - sp / 1.6})`;
    for (let i = 0; i < 30; i++) {
      const vx = (r() - 0.5) * 600, vy = -250 - r() * 450;
      const x = p.x + vx * sp, yy = surfY + vy * sp + 950 * sp * sp;
      if (yy < surfY + 4) { ctx.beginPath(); ctx.arc(x, yy, 4 + r() * 7, 0, TAU); ctx.fill(); }
    }
    ctx.strokeStyle = `rgba(235,248,246,${1 - sp / 1.6})`; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.ellipse(p.x, surfY + 4, 60 + sp * 300, 10 + sp * 18, 0, 0, TAU); ctx.stroke();
  }
  // water running off the helmet and the book after breaching
  if (sp > 0.2) {
    const r = rng(77);
    ctx.fillStyle = 'rgba(225,245,250,0.85)';
    for (let i = 0; i < 14; i++) {
      const per = 0.5 + r() * 0.5, ph = r() * per, k = ((sp + ph) % per) / per;
      const x0 = p.x + (r() - 0.3) * 70 * p.s, y0 = p.y - (90 + r() * 120) * p.s * (r() < 0.5 ? 1 : 0.6);
      const yy = y0 + k * k * 200;
      if (yy < surfY) { ctx.beginPath(); ctx.ellipse(x0, yy, 2.5, 4.5, 0, 0, TAU); ctx.fill(); }
    }
  }
  // sun glint on the helmet + sparkle on the water after breach
  if (sp > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const hx = p.x - 8 * p.s, hy = p.y - 135 * p.s;
    const tw = 0.6 + 0.4 * Math.sin(t * 5);
    glow(ctx, hx, hy, 60, '255,240,220', 0.6 * smooth(0, 0.5, sp) * tw);
    ctx.strokeStyle = `rgba(255,245,230,${0.7 * smooth(0, 0.5, sp) * tw})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(hx - 26, hy); ctx.lineTo(hx + 26, hy); ctx.moveTo(hx, hy - 26); ctx.lineTo(hx, hy + 26); ctx.stroke();
    const r = rng(88);
    for (let i = 0; i < 26; i++) {
      const x = r() * 1920, y = surfY - 150 + r() * 150 * 0.9, ph = r() * TAU;
      const a = Math.max(0, Math.sin(t * 3 + ph)) ** 6;
      if (a > 0.05) { ctx.fillStyle = `rgba(255,245,235,${a})`; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill(); }
    }
    ctx.restore();
  }
  ctx.setTransform(W / VW, 0, 0, H / VH, 0, 0);
  const surfS = (surfY - cam.y) * cam.z + VH / 2;
  if (surfS < VH) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, Math.max(0, surfS + 10), VW, VH); ctx.clip();
    FX.marineSnow(ctx, t, { n: 100, seed: 91, vy: 0, size: 2.2, alpha: 0.4, scrollY: cam.y - 540 });
    ctx.restore();
    FX.waterWobble(ctx, t, 1.4, Math.max(0, surfS + 12));
  }
  // end title
  const ea = smooth(EV.endTitle, EV.endTitle + 0.8, t);
  if (ea > 0) {
    ctx.save(); ctx.globalAlpha = ea; ctx.textAlign = 'center';
    ctx.font = '96px KaiTi'; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(60,40,60,0.5)'; ctx.strokeText('深海图书馆', 960, 200);
    ctx.fillStyle = '#fff4e0'; ctx.fillText('深海图书馆', 960, 200);
    ctx.restore();
  }
}

// ======================================================================
const POST = { // per-shot film look
  6: (t) => (t > EV.iris + 1.1 && t < EV.irisOut + 1.0 ? { grain: 0.12, paper: 0.7, vignette: 0.35, lift: 'rgb(40,26,18)' } : {}),
};
function render(ctx, t, W, H, createCanvas) {
  mkCanvas = createCanvas; FX.setFactory(createCanvas);
  renderShot(ctx, t, W, H);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  const id = shotAt(t).id;
  FX.filmPost(ctx, W, H, t, POST[id] ? POST[id](t) : {});
  fadeBlack(ctx, W, H, smooth(89.2, 90, t));
  ctx.restore();
}
function renderShot(ctx, t, W, H) {
  ctx.save();
  ctx.scale(W / VW, H / VH);
  const shot = shotAt(t).id;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, VW, VH);
  if (shot === 1) shot1(ctx, t, W, H);
  else if (shot === 2) shot2(ctx, t, W, H);
  else if (shot === 3) shot3(ctx, t, W, H);
  else if (shot === 4) shot4(ctx, t, W, H);
  else if (shot === 5) shot5(ctx, t, W, H);
  else if (shot === 6) shot6(ctx, t, W, H);
  else if (shot === 7 || shot === 8) shot78(ctx, t, W, H);
  else shot9(ctx, t, W, H);
  ctx.restore();
}

module.exports = { render };
