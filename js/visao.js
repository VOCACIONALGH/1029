// js/visao.js
import { rgbToHsv } from './matematica.js';

const videoEl = document.getElementById('camera');
const canvas = document.getElementById('visionCanvas');
const ctx = canvas.getContext('2d');

let tolerance = 40; // em graus (hue)
let processing = false;

let stableX = null;
let stableY = null;
const stabilizationFactor = 0.15;

let latestCount = 0;

// Target color em HSV {h,s,v} ou null se não selecionado
let targetHSV = null;

// Abre a câmera traseira (robusto, retorna true/false)
export async function openRearCamera() {
  try {
    const constraintsList = [
      { video: { facingMode: { exact: 'environment' } }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false }
    ];

    let stream = null;

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      for (const c of constraintsList) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(c);
          break;
        } catch (e) {
          // tenta próximo
        }
      }
    }

    // fallback legacy (callbacks)
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

    if ('srcObject' in videoEl) {
      videoEl.srcObject = stream;
    } else {
      videoEl.src = window.URL.createObjectURL(stream);
    }

    await new Promise((resolve) => {
      videoEl.onloadedmetadata = () => {
        videoEl.play().catch(()=>{/*ignore*/});
        resolve();
      };
      if (videoEl.readyState >= 2) resolve();
    });

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

// Define tolerância (slider)
export function setTolerance(v) {
  tolerance = Number(v);
}

// Limpa alvo (nenhuma cor selecionada)
export function clearTarget() {
  targetHSV = null;
}

// Define target a partir de RGB (0..255)
export function setTargetHSVFromRgb(r, g, b) {
  const hsv = rgbToHsv(r, g, b);
  targetHSV = hsv;
  // reset estabilidade para não saltar muito
  stableX = null;
  stableY = null;
}

// retorna o HSV alvo (ou null)
export function getTargetHSV() {
  return targetHSV;
}

export function getLatestCount() {
  return latestCount;
}

// calcula distância circular de hue (em graus)
function hueDistance(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

// verifica se pixel HSV corresponde ao target
function isMatchTarget(h, s, v) {
  if (!targetHSV) return false;
  const dh = hueDistance(h, targetHSV.h);
  if (dh > tolerance) return false;

  // permitimos variação ampla em saturação/valor, mas podemos exigir mínimos leves
  if (s < 0.08 && v > 0.95) return false; // ignora branco quase puro
  // aceitar em geral
  return true;
}

function processFrame() {
  if (!processing) return;

  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    requestAnimationFrame(processFrame);
    return;
  }

  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;

  // desenha frame (usado também para leitura de pixel)
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  let count = 0;
  let sumX = 0;
  let sumY = 0;

  if (targetHSV) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      const { h, s, v } = rgbToHsv(r, g, b);
      if (isMatchTarget(h, s, v)) {
        const p = i / 4;
        const x = p % canvas.width;
        const y = Math.floor(p / canvas.width);
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  // Limpa overlay (após leitura)
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

    // desenha ponto no centro estabilizado
    ctx.beginPath();
    ctx.arc(stableX, stableY, 6, 0, Math.PI * 2);
    ctx.fillStyle = targetHSV ? `rgba(255,128,0,1)` : 'orange';
    ctx.fill();
  }

  latestCount = count;
  requestAnimationFrame(processFrame);
}
