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

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const pixelIndex = i / 4;
    const x = pixelIndex % canvas.width;
    const y = Math.floor(pixelIndex / canvas.width);

    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      // transforma pixel preto em laranja
      data[i]     = 255;
      data[i + 1] = 165;
      data[i + 2] = 0;

      sumX += x;
      sumY += y;
      count++;
    }
  }

  ctx.putImageData(frame, 0, 0);

  // desenha ponto branco no centro da área dos pixels pretos (origem)
  if (count > 0) {
    const cx = sumX / count;
    const cy = sumY / count;

    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  requestAnimationFrame(processFrame);
}
