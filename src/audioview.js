// Audio self-check: draw RMS envelope (dB) of a WAV with shot boundaries and cue markers.
// Usage: node src/audioview.js in.wav cues.txt out.png [t0 t1]
const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const { SHOTS } = require('./common');
const [wav, cuesF, out] = process.argv.slice(2, 5);
const T0 = Number(process.argv[5] || 0), T1 = Number(process.argv[6] || 90);
const b = fs.readFileSync(wav), SR = b.readUInt32LE(24), n = (b.length - 44) / 4;
const W = 1900, H = 520, cv = createCanvas(W, H), g = cv.getContext('2d');
g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
const X = (t) => (t - T0) / (T1 - T0) * W;
const Y = (db) => 40 + (-db) / 60 * (H - 120);
for (const s of SHOTS) {
  g.fillStyle = s.id % 2 ? '#181c22' : '#1e2329'; g.fillRect(X(s.t0), 0, X(s.t1) - X(s.t0), H);
  g.fillStyle = '#9ab'; g.font = '14px "Microsoft YaHei"'; g.fillText(`${s.id} ${s.name}`, X(s.t0) + 4, 16);
}
g.strokeStyle = '#333'; for (const db of [0, -12, -24, -36, -48]) { g.beginPath(); g.moveTo(0, Y(db)); g.lineTo(W, Y(db)); g.stroke(); g.fillStyle = '#666'; g.fillText(`${db}dB`, 2, Y(db) - 2); }
const win = Math.round(SR * (T1 - T0) / W);
for (const [ch, col] of [[0, 'rgba(120,200,255,0.9)'], [1, 'rgba(255,170,120,0.6)']]) {
  g.strokeStyle = col; g.beginPath();
  for (let x = 0; x < W; x++) {
    const s0 = Math.round((T0 + x / W * (T1 - T0)) * SR); let e = 0, pk = 0;
    for (let i = 0; i < win; i++) { const j = s0 + i; if (j >= n) break; const v = b.readInt16LE(44 + j * 4 + ch * 2) / 32768; e += v * v; pk = Math.max(pk, Math.abs(v)); }
    const db = 10 * Math.log10(e / win + 1e-9);
    if (x === 0) g.moveTo(x, Y(db)); else g.lineTo(x, Y(db));
  }
  g.stroke();
}
const cues = fs.readFileSync(cuesF, 'utf8').trim().split('\n').map((l) => { const m = l.match(/^\s*([\d.]+)s\s+(.*)$/); return [Number(m[1]), m[2]]; }).filter(([t]) => t >= T0 && t <= T1);
cues.forEach(([t, name], i) => {
  g.strokeStyle = 'rgba(120,255,160,0.5)'; g.beginPath(); g.moveTo(X(t), 24); g.lineTo(X(t), H - 80); g.stroke();
  g.save(); g.translate(X(t) + 3, H - 76 + (i % 4) * 0); g.rotate(Math.PI / 2.6); g.fillStyle = '#8f8'; g.font = '12px "Microsoft YaHei"'; g.fillText(name.slice(0, 30), 0, 0); g.restore();
});
fs.writeFileSync(out, cv.toBuffer('image/png'));
