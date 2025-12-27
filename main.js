const scanBtn = document.getElementById('scanBtn');
const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const blackSlider = document.getElementById('blackSlider');
const blackValue = document.getElementById('blackValue');

let blackThreshold = Number(blackSlider.value);
blackValue.textContent = blackThreshold;

blackSlider.addEventListener('input', () => {
  blackThreshold = Number(blackSlider.value);
  blackValue.textContent = blackThreshold;
});

scanBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: "environment" }
      },
      audio: false
    });

    video.srcObject = stream;
    video.style.display = "block";
    canvas.style.display = "block";
    scanBtn.style.display = "none";

    video.addEventListener('loadedmetadata', () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      processFrame();
    });

  } catch (err) {
    alert("Não foi possível acessar a câmera traseira.");
  }
});

function processFrame() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  let sumBlackX = 0, sumBlackY = 0, countBlack = 0;
  let sumBlueX = 0,  sumBlueY = 0,  countBlue = 0;
  let sumGreenX = 0, sumGreenY = 0, countGreen = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const pixelIndex = i / 4;
    const x = pixelIndex % canvas.width;
    const y = Math.floor(pixelIndex / canvas.width);

    // PRETO → LARANJA
    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      data[i]     = 255;
      data[i + 1] = 165;
      data[i + 2] = 0;

      sumBlackX += x;
      sumBlackY += y;
      countBlack++;
    }

    // AZUL → BRANCO
    else if (b > 150 && r < 100 && g < 100) {
      data[i]     = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;

      sumBlueX += x;
      sumBlueY += y;
      countBlue++;
    }

    // VERDE → ROXO
    else if (g > 150 && r < 100 && b < 100) {
      data[i]     = 128;
      data[i + 1] = 0;
      data[i + 2] = 128;

      sumGreenX += x;
      sumGreenY += y;
      countGreen++;
    }
  }

  ctx.putImageData(frame, 0, 0);

  // ORIGEM PRETA (ponto branco)
  if (countBlack > 0) {
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(sumBlackX / countBlack, sumBlackY / countBlack, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // ORIGEM AZUL (ponto azul)
  if (countBlue > 0) {
    ctx.fillStyle = "#0000FF";
    ctx.beginPath();
    ctx.arc(sumBlueX / countBlue, sumBlueY / countBlue, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // ORIGEM VERDE (ponto verde)
  if (countGreen > 0) {
    ctx.fillStyle = "#00FF00";
    ctx.beginPath();
    ctx.arc(sumGreenX / countGreen, sumGreenY / countGreen, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  requestAnimationFrame(processFrame);
}
