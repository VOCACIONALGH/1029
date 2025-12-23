// js/interface.js
import { openRearCamera, setTolerance, setTargetHSVFromRgb, getLatestCount, getTargetHSV, clearTarget } from './visao.js';

const scanButton = document.getElementById('scanButton');
const slider = document.getElementById('toleranceSlider');
const pixelCounter = document.getElementById('pixelCounter');
const selectedColorDiv = document.getElementById('selectedColor');
const canvas = document.getElementById('visionCanvas');
const ctx = canvas.getContext('2d');

scanButton.addEventListener('click', async () => {
  scanButton.disabled = true;
  scanButton.textContent = 'Abrindo câmera...';
  const ok = await openRearCamera();
  if (!ok) {
    scanButton.disabled = false;
    scanButton.textContent = 'ESCÂNER 3D';
    alert('Não foi possível abrir a câmera traseira. Verifique HTTPS/permissões.');
    return;
  }
  scanButton.textContent = 'Câmera ativa';
});

slider.addEventListener('input', (e) => {
  setTolerance(Number(e.target.value));
});

// quando usuário clicar no canvas, ler pixel (leitura ocorre sobre o canvas que está desenhando frames)
canvas.addEventListener('click', (ev) => {
  if (canvas.width === 0 || canvas.height === 0) return;

  // coords relativs
  const rect = canvas.getBoundingClientRect();
  const cssX = ev.clientX - rect.left;
  const cssY = ev.clientY - rect.top;

  // converter coords CSS para coords do canvas (considerando escalas)
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const x = Math.floor(cssX * scaleX);
  const y = Math.floor(cssY * scaleY);

  try {
    const img = ctx.getImageData(x, y, 1, 1);
    const d = img.data;
    const r = d[0], g = d[1], b = d[2];

    // define target
    setTargetHSVFromRgb(r, g, b);

    // mostra cor selecionada (hex e hsv)
    const hsv = getTargetHSV ? getTargetHSV() : null;
    const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('').toUpperCase();
    selectedColorDiv.textContent = `Cor selecionada: ${hex} ${hsv ? `(h=${Math.round(hsv.h)} s=${hsv.s.toFixed(2)} v=${hsv.v.toFixed(2)})` : ''}`;
    selectedColorDiv.style.background = `${hex}`;
    selectedColorDiv.style.color = (r*0.299 + g*0.587 + b*0.114) > 150 ? '#000' : '#fff';
  } catch (err) {
    console.error('Erro ao ler pixel:', err);
  }
});

// permitir limpar seleção com clique duplo
canvas.addEventListener('dblclick', () => {
  clearTarget();
  selectedColorDiv.textContent = 'Cor selecionada: nenhuma';
  selectedColorDiv.style.background = 'transparent';
});

// contador suave por animationFrame
function updateCounter() {
  const c = getLatestCount();
  pixelCounter.textContent = `Pixels detectados: ${c || 0}`;
  requestAnimationFrame(updateCounter);
}
requestAnimationFrame(updateCounter);
