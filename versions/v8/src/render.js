// Render all frames, pipe into FFmpeg. Optional audio track.
// Usage: node src/render.js <W> <H> <fps> <out.mp4> [audio.wav] [t0] [t1]
const { spawn } = require('child_process');
const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const { render } = require('./scene');
const { DUR } = require('./common');

const [W, H, FPS] = process.argv.slice(2, 5).map(Number);
const out = process.argv[5];
const audio = process.argv[6] && process.argv[6] !== '-' ? process.argv[6] : null;
const T0 = Number(process.argv[7] || 0), T1 = Number(process.argv[8] || DUR);
const frames = Math.round((T1 - T0) * FPS);

const args = ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-'];
if (audio) args.push('-ss', String(T0), '-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', W >= 1920 ? '16' : '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-t', String(T1 - T0), out);
const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });

(async () => {
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    render(ctx, T0 + i / FPS, W, H, createCanvas);
    const px = Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer);
    if (!ff.stdin.write(px)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % (FPS * 5) === 0) process.stdout.write(`\r${i}/${frames} frames  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  }
  ff.stdin.end();
  ff.on('close', (code) => { console.log(`\nffmpeg exit ${code} -> ${out}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`); process.exit(code); });
})();
