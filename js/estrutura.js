import './interface.js';
import './visao.js';
import './debug.js';

const scanBtn = document.getElementById('scanBtn');
const video = document.getElementById('camera');

scanBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: 'environment' }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

  } catch (err) {
    console.error('Erro ao abrir câmera traseira:', err);
    alert('Não foi possível acessar a câmera traseira.\nUse HTTPS ou localhost.');
  }
});
