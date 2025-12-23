// INTERFACE DO USUÁRIO: conecta DOM com visao
import { openRearCamera, setTolerance, getLatestCount } from './visao.js';

const scanButton = document.getElementById('scanButton');
const slider = document.getElementById('toleranceSlider');
const pixelCounter = document.getElementById('pixelCounter');

scanButton.addEventListener('click', async () => {
  scanButton.disabled = true;
  scanButton.textContent = 'Abrindo câmera...';
  const ok = await openRearCamera();
  if (!ok) {
    scanButton.disabled = false;
    scanButton.textContent = 'ESCÂNER 3D';
    alert('Não foi possível abrir a câmera traseira. Verifique HTTPS ou permissões.');
    return;
  }
  scanButton.textContent = 'Câmera ativa';
});

slider.addEventListener('input', (e) => {
  setTolerance(Number(e.target.value));
});

// atualiza contador com requestAnimationFrame (suave)
function updateCounter() {
  const c = getLatestCount();
  pixelCounter.textContent = `Pixels laranja: ${c || 0}`;
  requestAnimationFrame(updateCounter);
}
requestAnimationFrame(updateCounter);
