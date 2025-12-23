const scanButton = document.getElementById('scanButton');
const video = document.getElementById('camera');
const counter = document.getElementById('redPixelCounter');

/**
 * Handle a MediaStream for the video element (works with older and modern browsers).
 */
function handleStream(stream) {
  if ("srcObject" in video) {
    video.srcObject = stream;
  } else {
    // Older browsers
    video.src = window.URL.createObjectURL(stream);
  }
  // Mute the element to help autoplay on some mobile browsers
  video.muted = true;
  // Try to play (user clicked the button so should succeed)
  video.play().catch(() => {
    // ignore play() rejection — stream is still attached
  });
}

/**
 * Open camera, robust across modern and legacy implementations.
 * - tenta preferir a traseira (facingMode: "environment")
 * - se falhar, tenta com video: true
 * - suporta callbacks legacy (webkitGetUserMedia / mozGetUserMedia)
 */
async function openCamera() {
  const preferredConstraints = { video: { facingMode: "environment" }, audio: false };
  const fallbackConstraints = { video: true, audio: false };

  // If modern API exists, try it first
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
      handleStream(stream);
      return;
    } catch (err) {
      // Tentar fallback moderno
      try {
        const stream2 = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
        handleStream(stream2);
        return;
      } catch (err2) {
        console.error('Falha ao obter câmera (modern API):', err2);
      }
    }
  }

  // Legacy API (callback style)
  const legacyGet = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if (legacyGet) {
    // Primeiro try preferredConstraints, se falhar tenta fallbackConstraints
    legacyGet.call(navigator, preferredConstraints, handleStream, async function () {
      // onError -> tentar fallback
      legacyGet.call(navigator, fallbackConstraints, handleStream, function (err) {
        console.error('Falha ao obter câmera (legacy API):', err);
      });
    });
    return;
  }

  // Se chegamos aqui, getUserMedia não suportado
  console.error('getUserMedia não suportado neste navegador / contexto. Execute em https:// ou http://localhost.');
}

// Evento do botão (única ação do botão: abrir a câmera)
scanButton.addEventListener('click', () => {
  openCamera();
});

/* Contador continua igual (não alterei lógica) */
function atualizarContador() {
  if (typeof window.redPixelCount === 'number') {
    counter.textContent = `Pixels vermelhos: ${window.redPixelCount}`;
  }
  requestAnimationFrame(atualizarContador);
}

requestAnimationFrame(atualizarContador);
