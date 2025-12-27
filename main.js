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

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // pixel considerado preto conforme calibração
    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      // transforma em laranja
      data[i]     = 255; // R
      data[i + 1] = 165; // G
      data[i + 2] = 0;   // B
    }
  }

  ctx.putImageData(frame, 0, 0);
  requestAnimationFrame(processFrame);
}
