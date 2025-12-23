const videoElement = document.getElementById('camera');
const canvas = document.getElementById('visionCanvas');
const ctx = canvas.getContext('2d');

let redTolerance = 80;

export function setRedTolerance(value) {
  redTolerance = value;
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

    if (r > 150 && g < redTolerance && b < redTolerance) {
      redCount++;

      const pixelIndex = i / 4;
      const x = pixelIndex % canvas.width;
      const y = Math.floor(pixelIndex / canvas.width);

      sumX += x;
      sumY += y;
    }
  }

  // Limpa apenas o overlay (evita acumular pontos)
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Se houver pixels vermelhos, desenha o ponto central (origem)
  if (redCount > 0) {
    const centerX = sumX / redCount;
    const centerY = sumY / redCount;

    ctx.beginPath();
    ctx.arc(centerX, centerY, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'red';
    ctx.fill();
  }

  window.redPixelCount = redCount;
  requestAnimationFrame(contarPixelsVermelhos);
}

videoElement.addEventListener('play', () => {
  requestAnimationFrame(contarPixelsVermelhos);
});
