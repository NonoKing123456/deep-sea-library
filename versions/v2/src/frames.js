// Contact sheet of arbitrary times (for checking specific actions). Usage: node src/frames.js out.png t1 t2 ... (3 per row)
const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const { render } = require('./scene');
const out = process.argv[2], times = process.argv.slice(3).map(Number);
const TW = 640, TH = 360, cols = Math.min(3, times.length), rows = Math.ceil(times.length / cols);
const sheet = createCanvas(TW * cols, (TH + 30) * rows), sg = sheet.getContext('2d');
sg.fillStyle = '#111'; sg.fillRect(0, 0, sheet.width, sheet.height);
const cv = createCanvas(1280, 720), ctx = cv.getContext('2d');
times.forEach((t, i) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1280, 720);
  render(ctx, t, 1280, 720, createCanvas);
  const x = (i % cols) * TW, y = Math.floor(i / cols) * (TH + 30);
  sg.drawImage(cv, x, y + 30, TW, TH);
  sg.fillStyle = '#ddd'; sg.font = '20px "Microsoft YaHei"'; sg.fillText(`t=${t}s`, x + 8, y + 22);
});
fs.writeFileSync(out, sheet.toBuffer('image/png'));
