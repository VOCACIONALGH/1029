import { setOrangeTolerance } from './visao.js';

const slider = document.getElementById('toleranceSlider');
const label = document.getElementById('pixelCount');

slider.addEventListener('input', e => {
  setOrangeTolerance(Number(e.target.value));
});

setInterval(() => {
  label.textContent = `Pixels laranja: ${window.orangePixelCount || 0}`;
}, 100);
