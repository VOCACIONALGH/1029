const scanButton = document.getElementById('scanButton');
const video = document.getElementById('camera');
const counter = document.getElementById('redPixelCounter');

/**
 * Compat layer para getUserMedia (inclui prefixed legacy APIs)
 * Retorna uma Promise que resolve com o MediaStream ou rejeita com erro.
 */
function getUserMediaCompat(constraints) {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  const getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if (!getUserMedia) {
    return Promise.reject(new Error('getUserMedia não suportado neste navegador'));
  }

  return new Promise((resolve, reject) => {
    getUserMedia.call(navigator, constraints, resolve, reject);
  });
}

scanButton.addEventListener('click', async () => {
  try {
    let stream = null;

    // 1) Tenta preferir câmera traseira (ideal) — se falhar, cai no fallback abaixo
    try {
      stream = await getUserMediaCompat({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
    } catch (e) {
      // 2) Fallback simples: pede qualquer câmera (máxima compatibilidade)
      stream = await getUserMediaCompat({ video: true, audio: false });
    }

    // Atribui o stream ao elemento <video>
    try {
      video.srcObject = stream;
    } catch (e) {
      // alguns browsers antigos usam URL.createObjectURL
      try {
        video.src = window.URL.createObjectURL(stream);
      } catch (_) {
        // se mesmo isso falhar, rethrow para cair no catch externo
        throw e;
      }
    }

    // Alguns navegadores exigem chamada explícita a play() após atribuição do srcObject
    try {
      await video.play();
    } catch (playError) {
      // Se play falhar, apenas registre — não adicionamos outra função
      console.warn('video.play() falhou (pode ser política de autoplay).', playError);
    }
  } catch (err) {
    // Log para debug — sem alterar fluxo do programa
    console.error('Falha ao abrir câmera:', err);
  }
});

function atualizarContador() {
  if (typeof window.redPixelCount === 'number') {
    counter.textContent = `Pixels vermelhos: ${window.redPixelCount}`;
  }
  requestAnimationFrame(atualizarContador);
}

requestAnimationFrame(atualizarContador);
