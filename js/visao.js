// VISÃO: detecção laranja, estabilização e desenho no canvas
import { rgbToHsv } from './matematica.js';

const videoEl = document.getElementById('camera');
const canvas = document.getElementById('visionCanvas');
const ctx = canvas.getContext('2d');

let tolerance = 40; // graus no hue
let processing = false;

let stableX = null;
let stableY = null;
const stabilizationFactor = 0.15;

let latestCount = 0;

/**
 * Abre a câmera traseira de forma robusta.
 * - tenta facingMode exact
 * - se falhar, tenta ideal
 * - se falhar, tenta video:true
 * - suporta legacy callbacks como último recurso
 */
export async function openRearCamera() {
  // if already streaming, return
  try {
    // prefer exact environment, fallback sequence
    const constraintsList = [
      { video: { facingMode: { exact: 'environment' } }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false }
    ];

    let stream = null;

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      for (const constraints of constraintsList) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (e) {
          // try next
        }
      }
    }

    // legacy fallback
    if (!stream) {
      const legacyGet = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
      if (legacyGet) {
        stream = await new Promise((resolve, reject) => {
          legacyGet.call(navigator,
            { video: true, audio: false },
            s => resolve(s),
            err => reject(err)
          );
        });
      }
    }

    if (!stream) throw new Error('Não foi possível obter stream de câmera');

    // attach stream
    if ('srcObject' in videoEl) {
      videoEl.srcObject = stream;
    } else {
      videoEl.src = window.URL.createObjectURL(stream);
    }

    // ensure play after metadata
    await new Promise((resolve) => {
      videoEl.onloadedmetadata = () => {
        videoEl.play().catch(()=>{/*ignore*/});
        resolve();
      };
      // if already have metadata / playing, resolve quickly
      if (videoEl.readyState >= 2) resolve();
    });

    // start processing if not already
    if (!processing) {
      processing = true;
      requestAnimationFrame(processFrame);
    }

    return true;
  } catch (err) {
    console.error('openRearCamera erro:', err);
    return false;
  }
}

/**
 * Ajusta tolerância (em graus do Hue central ~30)
 */
export function setTolerance(v) {
  tolerance = Number(v);
}

/**
 * Retorna contagem mais recente (para UI)
 */
export function getLatestCount() {
  return latestCount;
}

/**
 * Define se um pixel HSV é laranja (escala abrangente)
 */
function isOrangeHSV(h, s, v) {
  // Central em ~30 graus (laranja)
  // Accepta variação definida por 'tolerance', e também considera saturação/valor amplos
  const lower = 30 - tolerance;
  const upper = 30 + tolerance;

  const hueOk = (h >= lower && h <= upper);
  const satOk = s >= 0.15 || v <= 0.45; // permite tons menos saturados
  const valOk = v >= 0.12;

  return hueOk && satOk && valOk;
}

/**
 * Loop de processamento: captura frame, converte para HSV, calcula centroide, desenha origem
 */
function processFrame() {
  if (!processing) return;

  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    // câmera ainda não pronta
    requestAnimationFrame(processFrame);
    return;
  }

  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;

  // desenha frame no canvas (usado para readPixel)
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  let count = 0;
  let sumX = 0;
  let sumY = 0;

  // percorre pixels
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const { h, s, v } = rgbToHsv(r, g, b);

    if (isOrangeHSV(h, s, v)) {
      const p = i / 4;
      const x = p % canvas.width;
      const y = Math.floor(p / canvas.width);
      sumX += x;
      sumY += y;
      count++;
    }
  }

  // limpa overlay (não acumular)
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (count > 0) {
    const cx = sumX / count;
    const cy = sumY / count;

    if (stableX === null || stableY === null) {
      stableX = cx;
      stableY = cy;
    } else {
      stableX += (cx - stableX) * stabilizationFactor;
      stableY += (cy - stableY) * stabilizationFactor;
    }

    // desenha ponto laranja estabilizado
    ctx.beginPath();
    ctx.arc(stableX, stableY, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'orange';
    ctx.fill();
  } else {
    // sem pixels - decai a origem suavemente para null ao longo do tempo?
    // (mantemos a origem até nova detecção, para estabilidade)
  }

  latestCount = count;
  requestAnimationFrame(processFrame);
}
