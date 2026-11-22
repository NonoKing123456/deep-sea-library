// The diver: brass-helmet hard-hat diver, drawn as a flat retro illustration with dark outlines.
// Local frame: pelvis at (0,0), y down, facing +x (flipped by pose.f). Height ≈ 260 units at s=1.
const OUT = '#1b1620';
const C = {
  brass: '#c98a3c', brassHi: '#f0c27a', brassLo: '#8a5a26',
  suit: '#7d6c58', suitLo: '#5e5143', suitHi: '#97856d',
  boot: '#3a2b22', glove: '#4b3a2d', scarf: '#c8323a', scarfLo: '#8f1f2a',
  glass: '#1c3944', lead: '#4a4f55', belt: '#3b2a20',
};

// --- tiny 2x3 matrix helper so we can report world positions of body parts ---
const M = {
  id: () => [1, 0, 0, 1, 0, 0],
  mul: (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]],
  tr: (x, y) => [1, 0, 0, 1, x, y],
  rot: (r) => [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0],
  sc: (x, y) => [x, 0, 0, y, 0, 0],
  ap: (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]],
};

const dir = (a) => [Math.sin(a), Math.cos(a)]; // angle from straight down, + = forward

function strokeLimb(ctx, pts, w, col) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.strokeStyle = OUT; ctx.lineWidth = w + 6; ctx.stroke();
  ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
}

function chain(x, y, a1, l1, a2, l2) {
  const [d1x, d1y] = dir(a1), [d2x, d2y] = dir(a1 + a2);
  const e = [x + d1x * l1, y + d1y * l1];
  const h = [e[0] + d2x * l2, e[1] + d2y * l2];
  return { s: [x, y], e, h, a: a1 + a2 };
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function fillOut(ctx, fill, lw = 4) { ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = lw; ctx.stroke(); }

function drawLeg(ctx, L, shade) {
  const k = chain(0, 2, L[0], 46, L[1], 44);
  strokeLimb(ctx, [k.s, k.e, k.h], 22, shade ? C.suitLo : C.suit);
  // knee patch
  ctx.beginPath(); ctx.arc(k.e[0], k.e[1], 9, 0, Math.PI * 2); fillOut(ctx, shade ? C.suitLo : C.suitHi, 3);
  // boot (foot points forward, perpendicular to shin)
  ctx.save(); ctx.translate(k.h[0], k.h[1]); ctx.rotate(-k.a);
  rrect(ctx, -13, -4, 38, 18, 6); fillOut(ctx, C.boot, 4);
  ctx.fillStyle = shade ? '#2a1f18' : '#5a4636'; ctx.fillRect(-11, 9, 34, 4);
  ctx.restore();
  return k;
}

function drawArm(ctx, A, shade) {
  const k = chain(4, -64, A[0], 36, A[1], 34);
  strokeLimb(ctx, [k.s, k.e, k.h], 18, shade ? C.suitLo : C.suit);
  // brass cuff + glove
  const [dx, dy] = dir(k.a);
  ctx.beginPath(); ctx.arc(k.h[0] - dx * 4, k.h[1] - dy * 4, 8, 0, Math.PI * 2); fillOut(ctx, C.brassLo, 3);
  ctx.beginPath(); ctx.arc(k.h[0] + dx * 4, k.h[1] + dy * 4, 10, 0, Math.PI * 2); fillOut(ctx, C.glove, 3);
  return k;
}

function drawScarf(ctx, p) {
  const t = p.t || 0, lift = p.scarfLift == null ? 1 : p.scarfLift; // 1 = floats up (underwater), 0 = hangs
  const w1 = Math.sin(t * 2.6), w2 = Math.sin(t * 2.6 + 1.3);
  const x0 = -16, y0 = -82;
  const x1 = -38, y1 = lerp(-70, -96, lift) + w1 * 6;
  const x2 = -60 - lift * 8, y2 = lerp(-50, -104, lift) + w2 * 11;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x1, y1, x2, y2);
  ctx.strokeStyle = OUT; ctx.lineWidth = 15; ctx.stroke();
  ctx.strokeStyle = C.scarf; ctx.lineWidth = 9; ctx.stroke();
  // little forked end
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 10, y2 + 6 + w1 * 3);
  ctx.strokeStyle = OUT; ctx.lineWidth = 11; ctx.stroke(); ctx.strokeStyle = C.scarfLo; ctx.lineWidth = 5; ctx.stroke();
}
const lerp = (a, b, u) => a + (b - a) * u;

function drawHelmet(ctx, p) {
  const lamp = p.lamp || 0;
  // helmet sphere centred at (2,-28) in head space (neck at origin)
  ctx.beginPath(); ctx.arc(2, -28, 36, 0, Math.PI * 2); fillOut(ctx, C.brass, 5);
  ctx.save(); ctx.beginPath(); ctx.arc(2, -28, 36, 0, Math.PI * 2); ctx.clip();
  ctx.beginPath(); ctx.arc(14, -16, 40, 0, Math.PI * 2); ctx.arc(-40, -60, 60, 0, Math.PI * 2, true);
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillStyle = C.brassLo; ctx.beginPath(); ctx.arc(-20, -40, 52, 0, Math.PI * 2); ctx.rect(-60, -80, 130, 110); ctx.fill('evenodd');
  ctx.fillStyle = C.brassHi; ctx.beginPath(); ctx.ellipse(-8, -46, 16, 9, -0.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.arc(2, -28, 36, 0, Math.PI * 2); ctx.strokeStyle = OUT; ctx.lineWidth = 5; ctx.stroke();
  // side port
  ctx.beginPath(); ctx.arc(-14, -28, 9, 0, Math.PI * 2); fillOut(ctx, C.brassLo, 3);
  ctx.beginPath(); ctx.arc(-14, -28, 5, 0, Math.PI * 2); ctx.fillStyle = C.glass; ctx.fill();
  // front port (face window)
  ctx.beginPath(); ctx.arc(22, -26, 17, 0, Math.PI * 2); fillOut(ctx, C.brassLo, 4);
  ctx.beginPath(); ctx.arc(22, -26, 12, 0, Math.PI * 2); ctx.fillStyle = C.glass; ctx.fill();
  ctx.strokeStyle = 'rgba(240,194,122,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(22, -38); ctx.lineTo(22, -14); ctx.moveTo(10, -26); ctx.lineTo(34, -26); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(22, -26, 8, -2.6, -1.7); ctx.stroke();
  // lamp on top
  rrect(ctx, -6, -72, 24, 13, 4); fillOut(ctx, '#2f2a2c', 3);
  ctx.beginPath(); ctx.arc(19, -65.5, 6, 0, Math.PI * 2);
  ctx.fillStyle = lamp > 0.05 ? `rgba(255,${Math.round(220 + 30 * lamp)},${Math.round(150 + 80 * lamp)},1)` : '#6b6250';
  ctx.fill(); ctx.strokeStyle = OUT; ctx.lineWidth = 3; ctx.stroke();
  // rivets on the collar ring
  ctx.fillStyle = C.brassHi;
  for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.arc(i * 9, 4, 2.2, 0, Math.PI * 2); ctx.fill(); }
}

// Returns world (pre-camera) positions of useful parts.
function drawDiver(ctx, p) {
  const f = p.f || 1, s = p.s || 1;
  const base = M.mul(M.mul(M.tr(p.x, p.y), M.rot(p.rot || 0)), M.sc(s * f, s));
  const headM = M.mul(M.mul(base, M.tr(0, -84)), M.rot(p.head || 0));
  ctx.save();
  ctx.transform(...base);

  // back limbs (darker)
  const aB = drawArm(ctx, p.aB || [0.2, 0.3], true);
  const lB = drawLeg(ctx, p.lB || [-0.1, -0.15], true);
  // air tank on the back
  rrect(ctx, -44, -80, 22, 66, 9); fillOut(ctx, C.brass, 4);
  ctx.fillStyle = C.brassLo; ctx.fillRect(-42, -64, 18, 5); ctx.fillRect(-42, -32, 18, 5);
  rrect(ctx, -38, -90, 10, 12, 3); fillOut(ctx, '#2f2a2c', 3);
  // torso
  rrect(ctx, -24, -82, 48, 90, 16); fillOut(ctx, C.suit, 5);
  ctx.save(); rrect(ctx, -24, -82, 48, 90, 16); ctx.clip();
  ctx.fillStyle = C.suitLo; ctx.fillRect(-24, -82, 13, 90);
  ctx.fillStyle = C.suitHi; ctx.fillRect(14, -70, 5, 60);
  ctx.restore();
  // lead chest weight
  rrect(ctx, 2, -62, 18, 22, 3); fillOut(ctx, C.lead, 3);
  // belt
  ctx.fillStyle = C.belt; ctx.fillRect(-24, -8, 48, 10); ctx.strokeStyle = OUT; ctx.lineWidth = 3; ctx.strokeRect(-24, -8, 48, 10);
  rrect(ctx, 8, -10, 12, 14, 2); fillOut(ctx, C.brass, 2.5);
  // front leg
  const lF = drawLeg(ctx, p.lF || [0.1, -0.15], false);
  // breastplate (corselet)
  ctx.beginPath(); ctx.ellipse(0, -82, 33, 13, 0, 0, Math.PI * 2); fillOut(ctx, C.brass, 4);
  ctx.fillStyle = C.brassHi; ctx.beginPath(); ctx.ellipse(8, -86, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
  // scarf (always visible red accent)
  drawScarf(ctx, p);
  ctx.beginPath(); ctx.ellipse(0, -88, 24, 6, 0, 0, Math.PI * 2); fillOut(ctx, C.scarf, 3);
  // helmet
  ctx.save(); ctx.translate(0, -84); ctx.rotate(p.head || 0); drawHelmet(ctx, p); ctx.restore();
  ctx.restore();

  // held item between helmet and front arm
  const info = {
    lamp: M.ap(headM, 25, -65.5),
    lampAng: (p.rot || 0) + (f > 0 ? (p.head || 0) : Math.PI - (p.head || 0)), // world angle of lamp axis (0 = +x)
    helmet: M.ap(headM, 2, -28), helmetR: 36 * s,
    port: M.ap(headM, 22, -26), portR: 12 * s, // face window (for reflections)
    handF: null, handB: M.ap(base, aB.h[0], aB.h[1]),
    feet: [M.ap(base, lF.h[0], lF.h[1]), M.ap(base, lB.h[0], lB.h[1])],
    chest: M.ap(base, 10, -50),
    base,
  };
  if (p.armFFirst) {
    // hand behind the held object (object drawn by caller afterwards)
    ctx.save(); ctx.transform(...base); const aF = drawArm(ctx, p.aF || [0.2, 0.3], false); ctx.restore();
    info.handF = M.ap(base, aF.h[0], aF.h[1]);
    if (p.held) p.held(ctx, info);
  } else {
    // compute front hand first so the held object can be drawn under the glove
    const k = chain(4, -64, (p.aF || [0.2, 0.3])[0], 36, (p.aF || [0.2, 0.3])[1], 34);
    info.handF = M.ap(base, k.h[0], k.h[1]);
    if (p.held) p.held(ctx, info);
    ctx.save(); ctx.transform(...base); drawArm(ctx, p.aF || [0.2, 0.3], false); ctx.restore();
  }
  return info;
}

module.exports = { drawDiver, OUT, C, rrect, fillOut, M };
