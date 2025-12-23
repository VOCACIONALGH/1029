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

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (
      r > 150 &&
      g < redTolerance &&
      b < redTolerance
    ) {
      redCount++;
    }
  }

  window.redPixelCount = redCount;
  requestAnimationFrame(contarPixelsVermelhos);
}

videoElement.addEventListener('play', () => {
  requestAnimationFrame(contarPixelsVermelhos);
});
