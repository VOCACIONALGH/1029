import { rgbToHsv } from './matematica.js';

const videoElement = document.getElementById('camera');
const canvas = document.getElementById('visionCanvas');
const ctx = canvas.getContext('2d');

let orangeTolerance = 40;

// Origem estabilizada
let stableX = null;
let stableY = null;
const stabilizationFactor = 0.15;

export function setOrangeTolerance(value) {
  orangeTolerance = value;
}

function isOrangeHSV(h, s, v) {
  /*
    Escala de LARANJA extremamente abrangente:
    - Hue central ~30°
    - Inclui amarelo-alaranjado e vermelho-alaranjado
    - Saturação pode variar bastante
    - Valor pode ser baixo ou alto
  */

  const hueCenter = 30;
  const hueOrange =
    h >= hueCenter - orangeTolerance &&
    h <= hueCenter + orangeTolerance;

  const saturationOrange =
    s >= 0.2 || v <= 0.4;

  const valueOrange =
    v >= 0.15;

  return hueOrange && saturationOrange && valueOrange;
}

function contarPixelsLaranja() {
  if (videoElement.videoWidth === 0) return;

  canvas.width = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;

  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  let orangeCount = 0;
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const { h, s, v } = rgbToHsv(r, g, b);

    if (isOrangeHSV(h, s, v)) {
      orangeCount++;

      const index = i / 4;
      const x = index % canvas.width;
      const y = Math.floor(index / canvas.width);

      sumX += x;
      sumY += y;
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (orangeCount > 0) {
    const centerX = sumX / orangeCount;
    const centerY = sumY / orangeCount;

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
    ctx.fillStyle = 'orange';
    ctx.fill();
  }

  window.orangePixelCount = orangeCount;
  requestAnimationFrame(contarPixelsLaranja);
}

videoElement.addEventListener('play', () => {
  requestAnimationFrame(contarPixelsLaranja);
});
