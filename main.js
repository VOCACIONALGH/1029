// main.js
const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const redCountDisplay = document.getElementById("redCount");
const redThresholdSlider = document.getElementById("redThreshold");

// Ao clicar em ESCÂNER → abre câmera traseira
scanBtn.addEventListener("click", async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: "environment" }
            },
            audio: false
        });

        video.srcObject = stream;

        video.addEventListener("loadedmetadata", () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            // inicia loop de processamento
            requestAnimationFrame(processFrame);
        }, { once: true });

        // Algumas implementações exigem chamada explícita
        video.play().catch(()=>{});
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
});

/**
 * Converte canais RGB [0..255] para HSV:
 * Retorna { h: 0..360, s: 0..1, v: 0..1 }
 */
function rgbToHsv(r, g, b) {
    const rN = r / 255;
    const gN = g / 255;
    const bN = b / 255;

    const max = Math.max(rN, gN, bN);
    const min = Math.min(rN, gN, bN);
    const delta = max - min;

    let h = 0;
    if (delta === 0) {
        h = 0;
    } else if (max === rN) {
        h = 60 * (((gN - bN) / delta) % 6);
    } else if (max === gN) {
        h = 60 * (((bN - rN) / delta) + 2);
    } else { // max === bN
        h = 60 * (((rN - gN) / delta) + 4);
    }

    if (h < 0) h += 360;

    const s = max === 0 ? 0 : (delta / max);
    const v = max;

    return { h, s, v };
}

/**
 * Mapeia valor do slider (50..255) para tolerância de hue em graus (5..60)
 * Mantém o slider existente, mas o interpreta como controle da tolerância de hue.
 */
function sliderToHueTolerance(sliderValue) {
    const minSlider = 50;
    const maxSlider = 255;
    const minTol = 5;   // graus
    const maxTol = 60;  // graus
    const t = (sliderValue - minSlider) / (maxSlider - minSlider);
    return minTol + t * (maxTol - minTol);
}

function processFrame() {
    // desenha frame atual do vídeo no canvas
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // pega pixels
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // lê tolerância de hue a partir do slider
    const hueTol = sliderToHueTolerance(Number(redThresholdSlider.value)); // em graus
    // settings mínimos: saturação e valor (v) para considerar "vermelho"
    const minS = 0.35; // saturação mínima
    const minV = 0.12; // valor (brightness) mínima

    let redPixels = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // converte para HSV
        const { h, s, v } = rgbToHsv(r, g, b);

        // red em HSV: hue próximo de 0° (ou próximo de 360°)
        // consideramos true se (h <= hueTol) || (h >= 360 - hueTol)
        const isHueRed = (h <= hueTol) || (h >= 360 - hueTol);
        const isSufficientS = s >= minS;
        const isSufficientV = v >= minV;

        if (isHueRed && isSufficientS && isSufficientV) {
            redPixels++;

            // transforma vermelho → laranja (visual)
            data[i]     = 255; // R
            data[i + 1] = 165; // G
            data[i + 2] = 0;   // B
        }
        // caso contrário deixamos o pixel como estava
    }

    // escreve pixels modificados de volta
    ctx.putImageData(imageData, 0, 0);

    // atualiza contador exibido
    redCountDisplay.textContent = `Pixels vermelhos: ${redPixels}`;

    // loop
    requestAnimationFrame(processFrame);
}
