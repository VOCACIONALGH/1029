import { rgbToHsv } from './matematica.js';

const videoElement = document.getElementById('camera');
const canvas = document.getElementById('visionCanvas');
const ctx = canvas.getContext('2d');

let orangeTolerance = 40;

let stableX = null;
let stableY = null;
const stabilizationFactor = 0.15;

export function setOrangeTolerance(v) {
  orangeTolerance = v;
}

function isOrangeHSV(h, s, v) {
  return (
    h >= 30 - orangeTolerance &&
    h <= 30 + orangeTolerance &&
    s >= 0.2 &&
    v >= 0.15
  );
}

function process() {
  if (videoElement.videoWidth === 0) return requestAnimationFrame(process);

  canvas.width = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;

  ctx.drawImage(videoElement, 0, 0);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = frame.data;

  let count = 0, sx = 0, sy = 0;

  for (let i = 0; i < d.length; i += 4) {
    const { h, s, v } = rgbToHsv(d[i], d[i+1], d[i+2]);
    if (isOrangeHSV(h, s, v)) {
      const p = i / 4;
      sx += p % canvas.width;
      sy += Math.floor(p / canvas.width);
      count++;
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (count > 0) {
    const cx = sx / count;
    const cy = sy / count;

    stableX ??= cx;
    stableY ??= cy;

    stableX += (cx - stableX) * stabilizationFactor;
    stableY += (cy - stableY) * stabilizationFactor;

    ctx.fillStyle = 'orange';
    ctx.beginPath();
    ctx.arc(stableX, stableY, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  window.orangePixelCount = count;
  requestAnimationFrame(process);
}

videoElement.addEventListener('play', process);
