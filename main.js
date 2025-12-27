const scanBtn = document.getElementById('scanBtn');
const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const blackSlider = document.getElementById('blackSlider');
const blueSlider  = document.getElementById('blueSlider');
const greenSlider = document.getElementById('greenSlider');

const blackValue = document.getElementById('blackValue');
const blueValue  = document.getElementById('blueValue');
const greenValue = document.getElementById('greenValue');

let blackThreshold = Number(blackSlider.value);
let blueThreshold  = Number(blueSlider.value);
let greenThreshold = Number(greenSlider.value);

blackValue.textContent = blackThreshold;
blueValue.textContent  = blueThreshold;
greenValue.textContent = greenThreshold;

blackSlider.addEventListener('input', () => {
  blackThreshold = Number(blackSlider.value);
  blackValue.textContent = blackThreshold;
});

blueSlider.addEventListener('input', () => {
  blueThreshold = Number(blueSlider.value);
  blueValue.textContent = blueThreshold;
});

greenSlider.addEventListener('input', () => {
  greenThreshold = Number(greenSlider.value);
  greenValue.textContent = greenThreshold;
});

scanBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: "environment" } },
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
  let sumBlueX  = 0, sumBlueY  = 0, countBlue  = 0;
  let sumGreenX = 0, sumGreenY = 0, countGreen = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const p = i / 4;
    const x = p % canvas.width;
    const y = Math.floor(p / canvas.width);

    // PRETO → LARANJA
    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      data[i] = 255; data[i+1] = 165; data[i+2] = 0;
      sumBlackX += x; sumBlackY += y; countBlack++;
    }

    // AZUL → BRANCO
    else if (b > blueThreshold && r < blueThreshold && g < blueThreshold) {
      data[i] = 255; data[i+1] = 255; data[i+2] = 255;
      sumBlueX += x; sumBlueY += y; countBlue++;
    }

    // VERDE → ROXO
    else if (g > greenThreshold && r < greenThreshold && b < greenThreshold) {
      data[i] = 128; data[i+1] = 0; data[i+2] = 128;
      sumGreenX += x; sumGreenY += y; countGreen++;
    }
  }

  ctx.putImageData(frame, 0, 0);

  if (countBlack) drawPoint(sumBlackX / countBlack, sumBlackY / countBlack, "#FFFFFF");
  if (countBlue)  drawPoint(sumBlueX  / countBlue,  sumBlueY  / countBlue,  "#0000FF");
  if (countGreen) drawPoint(sumGreenX / countGreen, sumGreenY / countGreen, "#00FF00");

  requestAnimationFrame(processFrame);
}

function drawPoint(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}
