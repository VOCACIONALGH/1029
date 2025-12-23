// ui.js - responsabilidade: DOM, eventos e layout
import { startCamera, stopCamera } from "./camera.js";

let currentStream = null;

function getEls() {
  return {
    landing: document.getElementById("landing"),
    split: document.getElementById("split"),
    openBtn: document.getElementById("openScannerBtn"),
    video: document.getElementById("cameraVideo"),
  };
}

async function handleOpenClick(els) {
  // mostrar split e iniciar câmera
  els.landing.classList.add("hidden");
  els.split.classList.remove("hidden");
  try {
    currentStream = await startCamera(els.video);
  } catch (err) {
    console.error("Erro ao iniciar câmera:", err);
    // se falhar, volta para landing para evitar estado quebrado
    els.split.classList.add("hidden");
    els.landing.classList.remove("hidden");
    alert("Não foi possível acessar a câmera.\nPermita o acesso e tente novamente.");
  }
}

function bind(els) {
  els.openBtn.addEventListener("click", () => handleOpenClick(els));
  // quando a página for descarregada, parar a câmera
  window.addEventListener("pagehide", () => stopCamera(currentStream));
  window.addEventListener("beforeunload", () => stopCamera(currentStream));
}

export function setupUI() {
  const els = getEls();
  bind(els);
}
