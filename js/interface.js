import { setRedTolerance } from './visao.js';

const scanButton = document.getElementById('scanButton');
const video = document.getElementById('camera');
const counter = document.getElementById('redPixelCounter');
const slider = document.getElementById('redThreshold');

scanButton.addEventListener('click', async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false
  });

  video.srcObject = stream;

  video.onloadedmetadata = () => {
    video.play();
  };
});

slider.addEventListener('input', () => {
  setRedTolerance(Number(slider.value));
});

function atualizarContador() {
  if (typeof window.redPixelCount === 'number') {
    counter.textContent = `Pixels vermelhos: ${window.redPixelCount}`;
  }
  requestAnimationFrame(atualizarContador);
}

requestAnimationFrame(atualizarContador);
