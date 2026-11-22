// Self-check: render 3 keyframes per shot into one contact sheet per shot (with thirds guides + timestamps).
// Usage: node src/keyframes.js <outDir> [shotId ...]
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { render } = require('./scene');
const { SHOTS } = require('./common');

const outDir = process.argv[2] || path.join(__dirname, '..', 'shots');
const want = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });
const W = 1280, H = 720, TW = 640, TH = 360;
for (const s of SHOTS) {
  if (want.length && !want.includes(String(s.id))) continue;
  const d = s.t1 - s.t0;
  const times = [s.t0 + d * 0.12, s.t0 + d * 0.5, s.t0 + d * 0.88].map((x) => Math.round(x * 100) / 100);
  const sheet = createCanvas(TW * 3, TH + 34), sg = sheet.getContext('2d');
  sg.fillStyle = '#111'; sg.fillRect(0, 0, sheet.width, sheet.height);
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  times.forEach((t, i) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    const t0 = Date.now(); render(ctx, t, W, H, createCanvas); const ms = Date.now() - t0;
    sg.drawImage(cv, i * TW, 34, TW, TH);
    sg.strokeStyle = 'rgba(0,255,140,0.35)'; sg.setLineDash([5, 5]); sg.lineWidth = 1;
    for (const k of [1, 2]) {
      sg.beginPath(); sg.moveTo(i * TW + TW * k / 3, 34); sg.lineTo(i * TW + TW * k / 3, 34 + TH); sg.stroke();
      sg.beginPath(); sg.moveTo(i * TW, 34 + TH * k / 3); sg.lineTo(i * TW + TW, 34 + TH * k / 3); sg.stroke();
    }
    sg.setLineDash([]);
    sg.fillStyle = '#ddd'; sg.font = '20px "Microsoft YaHei"'; sg.fillText(`镜头${s.id} ${s.name}  t=${t}s  ${ms}ms`, i * TW + 8, 24);
  });
  fs.writeFileSync(path.join(outDir, `shot${s.id}.png`), sheet.toBuffer('image/png'));
  console.log('shot', s.id, times.join(', '));
}
