const scanButton = document.getElementById('scanButton');
const video = document.getElementById('camera');
const counter = document.getElementById('redPixelCounter');

scanButton.addEventListener('click', () => {
  navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    .then(stream => {
      video.srcObject = stream;

      // garante execução após metadata
      video.onloadedmetadata = () => {
        video.play();
      };
    })
    .catch(err => {
      console.error('Erro ao abrir câmera:', err);
    });
});

function atualizarContador() {
  if (typeof window.redPixelCount === 'number') {
    counter.textContent = `Pixels vermelhos: ${window.redPixelCount}`;
  }
  requestAnimationFrame(atualizarContador);
}

requestAnimationFrame(atualizarContador);
