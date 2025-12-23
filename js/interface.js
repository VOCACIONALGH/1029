const scanButton = document.getElementById('scanButton');
const video = document.getElementById('camera');
const counter = document.getElementById('redPixelCounter');

scanButton.addEventListener('click', async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false
  });

  video.srcObject = stream;
});

function atualizarContador() {
  if (typeof window.redPixelCount === 'number') {
    counter.textContent = `Pixels vermelhos: ${window.redPixelCount}`;
  }
  requestAnimationFrame(atualizarContador);
}

requestAnimationFrame(atualizarContador);
