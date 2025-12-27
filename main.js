const scanBtn = document.getElementById('scanBtn');
const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const scaleValue = document.getElementById('scaleValue');
const pitchValue = document.getElementById('pitchValue');
const yawValue   = document.getElementById('yawValue');
const rollValue  = document.getElementById('rollValue');

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

    // Atualizar Pitch, Yaw, Roll em tempo real
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', (event) => {
        // α = rotation around z axis (yaw), β = x axis (pitch), γ = y axis (roll)
        const pitch = event.beta || 0;
        const roll  = event.gamma || 0;
        const yaw   = event.alpha || 0;

        pitchValue.textContent = pitch.toFixed(1);
        yawValue.textContent   = yaw.toFixed(1);
        rollValue.textContent  = roll.toFixed(1);
      }, true);
    }

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
  let sumRedX   = 0, sumRedY   = 0, countRed   = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const p = i / 4;
    const x = p % canvas.width;
    const y = Math.floor(p / canvas.width);

    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      data[i] = 255; data[i+1] = 165; data[i+2] = 0;
      sumBlackX += x; sumBlackY += y; countBlack++;
    }
    else if (b > blueThreshold && r < blueThreshold && g < blueThreshold) {
      data[i] = 255; data[i+1] = 255; data[i+2] = 255;
      sumBlueX += x; sumBlueY += y; countBlue++;
    }
    else if (g > greenThreshold && r < greenThreshold && b < greenThreshold) {
      data[i] = 128; data[i+1] = 0; data[i+2] = 128;
      sumGreenX += x; sumGreenY += y; countGreen++;
    }
    else if (r > 150 && g < 100 && b < 100) {
      sumRedX += x; sumRedY += y; countRed++;
    }
  }

  ctx.putImageData(frame, 0, 0);

  let origin = null;
  let bluePt = null;
  let greenPt = null;

  if (countBlack) {
    origin = { x: sumBlackX / countBlack, y: sumBlackY / countBlack };
    drawPoint(origin.x, origin.y, "#FFFFFF");
  }

  if (countBlue) {
    bluePt = { x: sumBlueX / countBlue, y: sumBlueY / countBlue };
    drawPoint(bluePt.x, bluePt.y, "#0000FF");
  }

  if (countGreen) {
    greenPt = { x: sumGreenX / countGreen, y: sumGreenY / countGreen };
    drawPoint(greenPt.x, greenPt.y, "#00FF00");
  }

  if (countRed) {
    drawPoint(sumRedX / countRed, sumRedY / countRed, "#FF69B4");
  }

  // Vetores +X e +Y com 100 mm
  if (origin && bluePt) {
    const dx = bluePt.x - origin.x;
    const dy = bluePt.y - origin.y;
    const lenPx = Math.hypot(dx, dy);

    const scalePxPerMm = lenPx / 100;
    scaleValue.textContent = scalePxPerMm.toFixed(3);

    drawArrow(origin.x, origin.y, bluePt.x, bluePt.y, "#0000FF");
  }

  if (origin && greenPt) {
    drawArrow(origin.x, origin.y, greenPt.x, greenPt.y, "#00FF00");
  }

  requestAnimationFrame(processFrame);
}

function drawPoint(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawArrow(x1, y1, x2, y2, color) {
  const headLength = 10;
  const angle = Math.atan2(y2 - y1, x2 - x1);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 6),
    y2 - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 6),
    y2 - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
