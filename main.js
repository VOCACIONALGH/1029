// main.js — atualizado para incluir sliders de calibração azul/verde
const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const redCountDisplay = document.getElementById("redCount");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

scanBtn.addEventListener("click", async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: "environment" } },
            audio: false
        });

        video.srcObject = stream;

        video.addEventListener("loadedmetadata", () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        }, { once: true });

        video.play().catch(()=>{});
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
});

/**
 * Converte RGB [0..255] → HSV {h:0..360, s:0..1, v:0..1}
 */
function rgbToHsv(r, g, b) {
    const rN = r / 255, gN = g / 255, bN = b / 255;
    const max = Math.max(rN, gN, bN);
    const min = Math.min(rN, gN, bN);
    const d = max - min;

    let h = 0;
    if (d !== 0) {
        if (max === rN) h = ((gN - bN) / d) % 6;
        else if (max === gN) h = (bN - rN) / d + 2;
        else h = (rN - gN) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }

    const s = max === 0 ? 0 : d / max;
    const v = max;

    return { h, s, v };
}

/**
 * Mapeia slider (50..255) → tolerância de hue (5..60 graus)
 * Reutiliza mapeamento existente usado para vermelho.
 */
function sliderToHueTolerance(sliderValue) {
    const minSlider = 50;
    const maxSlider = 255;
    const minTol = 5;   // graus
    const maxTol = 60;  // graus
    const t = (sliderValue - minSlider) / (maxSlider - minSlider);
    return minTol + t * (maxTol - minTol);
}

/**
 * distância angular mínima entre dois ângulos de 0..360
 */
function hueDistance(a, b) {
    let d = Math.abs(a - b);
    if (d > 180) d = 360 - d;
    return d;
}

function processFrame() {
    // desenha frame do vídeo
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // tolerâncias a partir dos sliders
    const redTol = sliderToHueTolerance(Number(redThresholdSlider.value));   // graus
    const blueTol = sliderToHueTolerance(Number(blueThresholdSlider.value)); // graus
    const greenTol = sliderToHueTolerance(Number(greenThresholdSlider.value));// graus

    // centros de hue para cada cor (em graus)
    const centerRed = 0;    // 0° / 360°
    const centerBlue = 230; // centro aproximado do azul anteriormente usado
    const centerGreen = 120; // centro aproximado do verde

    const minS = 0.35;
    const minV = 0.12;

    // acumuladores para centroides
    let rCount = 0, rSumX = 0, rSumY = 0;
    let bCount = 0, bSumX = 0, bSumY = 0;
    let gCount = 0, gSumX = 0, gSumY = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const { h, s, v } = rgbToHsv(r, g, b);

        // filtragem básica por saturação/valor
        if (s < minS || v < minV) continue;

        const pixelIndex = i / 4;
        const x = pixelIndex % canvas.width;
        const y = Math.floor(pixelIndex / canvas.width);

        // VERMELHO: distancia ao centro 0 (considerando wrap)
        if (hueDistance(h, centerRed) <= redTol) {
            rCount++;
            rSumX += x;
            rSumY += y;

            // transforma vermelho → laranja
            data[i]     = 255;
            data[i + 1] = 165;
            data[i + 2] = 0;
            continue;
        }

        // AZUL: distancia ao centroBlue ≤ blueTol
        if (hueDistance(h, centerBlue) <= blueTol) {
            bCount++;
            bSumX += x;
            bSumY += y;

            // transforma azul → branco
            data[i]     = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            continue;
        }

        // VERDE: distancia ao centerGreen ≤ greenTol
        if (hueDistance(h, centerGreen) <= greenTol) {
            gCount++;
            gSumX += x;
            gSumY += y;

            // transforma verde → roxo
            data[i]     = 160;
            data[i + 1] = 32;
            data[i + 2] = 240;
            continue;
        }

        // caso não se enquadre em nenhuma detecção, mantém o pixel original
    }

    // escreve pixels modificados de volta
    ctx.putImageData(imageData, 0, 0);

    // desenha os pontos de origem (centroides) — apenas se houver pixels detectados
    if (rCount > 0) {
        const cx = rSumX / rCount;
        const cy = rSumY / rCount;
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "red";
        ctx.fill();
    }

    if (bCount > 0) {
        const cx = bSumX / bCount;
        const cy = bSumY / bCount;
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "blue";
        ctx.fill();
    }

    if (gCount > 0) {
        const cx = gSumX / gCount;
        const cy = gSumY / gCount;
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "green";
        ctx.fill();
    }

    // mantém o contador de pixels vermelhos visível como antes
    redCountDisplay.textContent = `Pixels vermelhos: ${rCount}`;

    requestAnimationFrame(processFrame);
}
