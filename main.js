// main.js — completo atualizado com botão "Calibrar"
// Mantém todas as funcionalidades anteriores e adiciona apenas o pedido.

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");

const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const redCountDisplay = document.getElementById("redCount");
const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");

const scaleEl = document.getElementById("scaleValue");
const zMmEl = document.getElementById("zMm");
const zPxEl = document.getElementById("zPx");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

const ARROW_LENGTH_MM = 100;

// variável global para armazenar escala atual (px per mm)
let currentPxPerMm = 0;

// variável para armazenar última calibração +Z (mm e px)
let calibratedZmm = null;
let calibratedZpx = null;

scanBtn.addEventListener("click", async () => {
    // request permission for device orientation on iOS if needed
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try { await DeviceOrientationEvent.requestPermission(); } catch (e) { /* ignore */ }
    }

    // orientation updates
    window.addEventListener("deviceorientation", (e) => {
        pitchEl.textContent = (e.beta ?? 0).toFixed(1);
        yawEl.textContent = (e.alpha ?? 0).toFixed(1);
        rollEl.textContent = (e.gamma ?? 0).toFixed(1);
    });

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

// Calibrar button behavior:
// - Ask user to input current +Z in mm
// - If currentPxPerMm is known (>0), calculate corresponding pixels and show both values
// - If scale not known, alert user
calibrateBtn.addEventListener("click", () => {
    if (!currentPxPerMm || currentPxPerMm <= 0) {
        alert("Escala desconhecida. Primeiro posicione vermelho e azul para que a escala (px/mm) seja calculada.");
        return;
    }

    const input = prompt("Informe o valor atual de +Z em milímetros (mm):", "0");
    if (input === null) return; // usuário cancelou

    const mm = parseFloat(input.replace(",", "."));
    if (Number.isNaN(mm) || !isFinite(mm)) {
        alert("Valor inválido. Informe um número válido em mm.");
        return;
    }

    const px = mm * currentPxPerMm;

    // armazena calibração
    calibratedZmm = mm;
    calibratedZpx = px;

    // atualiza exibição
    zMmEl.textContent = calibratedZmm.toFixed(2);
    zPxEl.textContent = Math.round(calibratedZpx);
});

// ---------- utilidades e processamento de frames (mantidos) ----------

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

function sliderToHueTolerance(v) {
    return 5 + ((v - 50) / (255 - 50)) * 55;
}

function hueDistance(a, b) {
    let d = Math.abs(a - b);
    return d > 180 ? 360 - d : d;
}

function drawArrowFromCenter(cx, cy, dx, dy, lengthPx, color) {
    const mag = Math.hypot(dx, dy);
    if (!mag) return;

    const ux = dx / mag;
    const uy = dy / mag;

    const x2 = cx + ux * lengthPx;
    const y2 = cy + uy * lengthPx;

    const headLen = 12;
    const angle = Math.atan2(y2 - cx, x2 - cx); // minor harmless; used for head direction

    // correct angle computation
    const angleCorrect = Math.atan2(y2 - cy, x2 - cx);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angleCorrect - Math.PI/6),
               y2 - headLen * Math.sin(angleCorrect - Math.PI/6));
    ctx.lineTo(x2 - headLen * Math.cos(angleCorrect + Math.PI/6),
               y2 - headLen * Math.sin(angleCorrect + Math.PI/6));
    ctx.closePath();
    ctx.fill();
}

function processFrame(){
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;

    const rTol = sliderToHueTolerance(Number(redThresholdSlider.value));
    const bTol = sliderToHueTolerance(Number(blueThresholdSlider.value));
    const gTol = sliderToHueTolerance(Number(greenThresholdSlider.value));

    const minS = 0.35;
    const minV = 0.12;

    let rCount = 0, rX = 0, rY = 0;
    let bCount = 0, bX = 0, bY = 0;
    let gCount = 0, gX = 0, gY = 0;

    for (let i = 0; i < d.length; i += 4) {
        const { h, s, v } = rgbToHsv(d[i], d[i+1], d[i+2]);
        if (s < minS || v < minV) continue;

        const idx = i / 4;
        const x = idx % canvas.width;
        const y = Math.floor(idx / canvas.width);

        // vermelho (centro 0°)
        if (hueDistance(h, 0) <= rTol) {
            rCount++; rX += x; rY += y;
            d[i] = 255; d[i+1] = 165; d[i+2] = 0;
            continue;
        }

        // azul (centro 230° aprox)
        if (hueDistance(h, 230) <= bTol) {
            bCount++; bX += x; bY += y;
            d[i] = 255; d[i+1] = 255; d[i+2] = 255;
            continue;
        }

        // verde (centro 120° aprox)
        if (hueDistance(h, 120) <= gTol) {
            gCount++; gX += x; gY += y;
            d[i] = 160; d[i+1] = 32; d[i+2] = 240;
            continue;
        }
    }

    // aplica imagem modificada
    ctx.putImageData(img, 0, 0);

    let rC = null, bC = null, gC = null;

    if (rCount > 0) {
        rC = { x: rX / rCount, y: rY / rCount };
        ctx.fillStyle = "red";
        ctx.beginPath(); ctx.arc(rC.x, rC.y, 6, 0, Math.PI * 2); ctx.fill();
    }

    if (bCount > 0) {
        bC = { x: bX / bCount, y: bY / bCount };
        ctx.fillStyle = "blue";
        ctx.beginPath(); ctx.arc(bC.x, bC.y, 6, 0, Math.PI * 2); ctx.fill();
    }

    if (gCount > 0) {
        gC = { x: gX / gCount, y: gY / gCount };
        ctx.fillStyle = "green";
        ctx.beginPath(); ctx.arc(gC.x, gC.y, 6, 0, Math.PI * 2); ctx.fill();
    }

    // calcula escala a partir do vetor vermelho→azul quando possível
    if (rC && bC) {
        const distPx = Math.hypot(bC.x - rC.x, bC.y - rC.y);
        currentPxPerMm = distPx / ARROW_LENGTH_MM;
        scaleEl.textContent = currentPxPerMm.toFixed(3);
        // desenha seta com comprimento físico ARROW_LENGTH_MM
        drawArrowFromCenter(rC.x, rC.y, bC.x - rC.x, bC.y - rC.y, ARROW_LENGTH_MM * currentPxPerMm, "blue");
    }

    // desenho do vetor +Y (vermelho→verde)
    if (rC && gC) {
        // se também quisermos usar escala a partir de r→g, poderíamos recalcular currentPxPerMm,
        // mas aqui mantemos currentPxPerMm vindo do r→b (como anteriormente).
        drawArrowFromCenter(rC.x, rC.y, gC.x - rC.x, gC.y - rC.y, ARROW_LENGTH_MM * currentPxPerMm, "green");
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${rCount}`;

    requestAnimationFrame(processFrame);
}
