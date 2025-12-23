import { rgbToHsv } from './matematica.js';

const videoElement = document.getElementById('camera');
const canvas = document.getElementById('visionCanvas');
const ctx = canvas.getContext('2d');

let redTolerance = 80;

// Origem estabilizada
let stableX = null;
let stableY = null;
const stabilizationFactor = 0.15;

export function setRedTolerance(value) {
  redTolerance = value;
}

function isRedHSV(h, s, v) {
  /*
    Escala de vermelho EXTREMAMENTE abrangente:
    - Hue próximo de 0° ou 360°
    - Saturação pode ser baixa (vermelho claro / rosado)
    - Valor pode ser baixo (vermelho escuro / vinho)
  */

  const hueRed =
    h <= redTolerance || h >= 360 - redTolerance;

  const saturationRed =
    s >= 0.15 || v <= 0.35;

  const valueRed =
    v >= 0.15;

  return hueRed && saturationRed && valueRed;
}

function contarPixelsVermelhos() {
  if (videoElement.videoWidth === 0) return;

  canvas.width = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;

  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  let redCount = 0;
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const { h, s, v } = rgbToHsv(r, g, b);

    if (isRedHSV(h, s, v)) {
      redCount++;

      const index = i / 4;
      const x = index % canvas.width;
      const y = Math.floor(index / canvas.width);

      sumX += x;
      sumY += y;
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (redCount > 0) {
    const centerX = sumX / redCount;
    const centerY = sumY / redCount;

    // Estabilização temporal da origem
    if (stableX === null || stableY === null) {
      stableX = centerX;
      stableY = centerY;
    } else {
      stableX += (centerX - stableX) * stabilizationFactor;
      stableY += (centerY - stableY) * stabilizationFactor;
    }

    ctx.beginPath();
    ctx.arc(stableX, stableY, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'red';
    ctx.fill();
  }

  window.redPixelCount = redCount;
  requestAnimationFrame(contarPixelsVermelhos);
}

videoElement.addEventListener('play', () => {
  requestAnimationFrame(contarPixelsVermelhos);
});
