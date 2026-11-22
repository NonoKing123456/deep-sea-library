// Per-shot review boards: 6 evenly spaced frames per shot (rendered at 1080p, shown at 640x360) + thirds grid.
// Usage: node src/review.js <outDir> [shotId ...]
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { render } = require('./scene');
const { SHOTS } = require('./common');
const outDir = process.argv[2]; const want = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });
const cv = createCanvas(1920, 1080), ctx = cv.getContext('2d');
for (const s of SHOTS) {
  if (want.length && !want.includes(String(s.id))) continue;
  const ts = Array.from({ length: 6 }, (_, i) => Math.round((s.t0 + (s.t1 - s.t0) * (i + 0.5) / 6) * 100) / 100);
  const sheet = createCanvas(640 * 3, (360 + 26) * 2), g = sheet.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, sheet.width, sheet.height);
  ts.forEach((t, i) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1920, 1080);
    render(ctx, t, 1920, 1080, createCanvas);
    const x = (i % 3) * 640, y = Math.floor(i / 3) * 386;
    g.drawImage(cv, x, y + 26, 640, 360);
    g.strokeStyle = 'rgba(0,255,140,0.25)'; g.setLineDash([4, 6]);
    for (const k of [1, 2]) { g.beginPath(); g.moveTo(x + 640 * k / 3, y + 26); g.lineTo(x + 640 * k / 3, y + 386); g.stroke(); g.beginPath(); g.moveTo(x, y + 26 + 120 * k); g.lineTo(x + 640, y + 26 + 120 * k); g.stroke(); }
    g.setLineDash([]); g.fillStyle = '#ccc'; g.font = '17px "Microsoft YaHei"'; g.fillText(`镜头${s.id}  t=${t}s`, x + 6, y + 19);
  });
  fs.writeFileSync(path.join(outDir, `review_shot${s.id}.png`), sheet.toBuffer('image/png'));
}
