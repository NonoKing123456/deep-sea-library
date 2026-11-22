const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const { drawDiver } = require('./diver');
const cv = createCanvas(1600, 500), ctx = cv.getContext('2d');
ctx.fillStyle = '#245a6e'; ctx.fillRect(0, 0, 1600, 500);
const poses = [
  { x: 150, y: 300, aF: [0.2, 0.3], aB: [-0.2, 0.3], lF: [0.15, -0.1], lB: [-0.15, -0.2] },
  { x: 450, y: 300, aF: [1.3, 0.6], aB: [1.1, 0.7], lF: [1.5, -1.5], lB: [1.4, -1.6] }, // sitting
  { x: 750, y: 300, aF: [1.2, 0.5], aB: [1.0, 0.6], lF: [0.3, -0.4], lB: [-0.2, -0.3], held: (c, i) => { c.fillStyle = '#8c2f39'; c.fillRect(i.handF[0] - 20, i.handF[1] - 30, 40, 50); } },
  { x: 1050, y: 300, f: -1, aF: [2.6, 0.3], aB: [2.4, 0.2], lF: [0.4, -0.6], lB: [-0.3, -0.5], head: -0.4, lamp: 1 },
  { x: 1350, y: 300, rot: -1.4, aF: [2.2, 0.3], aB: [1.9, 0.2], lF: [0.2, -0.2], lB: [-0.1, -0.3], lamp: 1 },
];
for (const p of poses) { p.t = 1; const info = drawDiver(ctx, p); ctx.fillStyle = '#ff0'; ctx.beginPath(); ctx.arc(info.lamp[0], info.lamp[1], 4, 0, 7); ctx.fill();
  ctx.strokeStyle = '#ff0'; ctx.beginPath(); ctx.moveTo(...info.lamp); ctx.lineTo(info.lamp[0] + 80 * Math.cos(info.lampAng), info.lamp[1] + 80 * Math.sin(info.lampAng)); ctx.stroke(); }
fs.writeFileSync(process.argv[2], cv.toBuffer('image/png'));
