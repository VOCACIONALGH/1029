// main.js — atualizado para incluir botão "Calibrar" e cálculo +Z usando escala

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
const zValueEl = document.getElementById("zValue");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

const ARROW_LENGTH_MM = 100;

// variáveis para armazenar últimos centroides / escala
let lastR = null;
let lastB = null;
let lastG = null;
let lastPxPerMm = 0;

scanBtn.addEventListener("click", async () => {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try { await DeviceOrientationEvent.requestPermission(); } catch {}
    }

    window.addEventListener("deviceorientation", (e) => {
        pitchEl.textContent = (e.beta ?? 0).toFixed(1);
        yawEl.textContent = (e.alpha ?? 0).toFixed(1);
        rollEl.textContent = (e.gamma ?? 0).toFixed(1);
    });

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
});

// Função utilitária: RGB -> HSV
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

// desenha seta a partir de um centro, na direção (dx,dy) com comprimento em pixels = lengthPx
function drawArrowFromCenter(cx, cy, dx, dy, lengthPx, color) {
    const mag = Math.hypot(dx, dy);
    if (!mag) return;
    const ux = dx / mag;
    const uy = dy / mag;
    const x2 = cx + ux * lengthPx;
    const y2 = cy + uy * lengthPx;
    const headLen = 12;
    const angle = Math.atan2(y2 - cy, x2 - cx);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6),
               y2 - headLen * Math.sin(angle - Math.PI/6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6),
               y2 - headLen * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fill();
}

// handler do botão Calibrar
calibrateBtn.addEventListener("click", () => {
    // pede para o usuário informar o valor de +Z atual (em mm)
    const userInput = prompt("Informe o valor de +Z atual (em mm):", "0");
    if (userInput === null) return; // usuário cancelou
    const userZ = parseFloat(userInput);
    if (Number.isNaN(userZ)) {
        alert("Valor inválido.");
        return;
    }

    // usa última escala disponível
    const pxPerMm = lastPxPerMm;
    if (!pxPerMm || !lastR || (!lastB && !lastG)) {
        alert("Não há medições válidas disponíveis para calcular +Z. Certifique-se de que as três cores foram detectadas.");
        return;
    }

    // se tivermos ambos vetores (r->b e r->g), usamos cross product para obter área em px^2
    if (lastB && lastG) {
        const vXx = lastB.x - lastR.x;
        const vXy = lastB.y - lastR.y;
        const vYx = lastG.x - lastR.x;
        const vYy = lastG.y - lastR.y;

        // 'z' em pixels^2 (escala de área = px^2)
        const crossPx2 = Math.abs(vXx * vYy - vXy * vYx);

        // converte para mm: cross_px2 / (px/mm)^2 => mm^2 — interpretamos +Z como a "altura" cuja área projetada
        // corresponde a cross, para fornecer um valor linear aproximado: usamos sqrt(mm^2).
        const crossMm2 = crossPx2 / (pxPerMm * pxPerMm);

        // derivamos um valor linear representativo (mm) — este é um design razoável quando se quer
        // transformar área projetada em uma medida linear de "profundidade" (por exemplo).
        const zCalculated = Math.sqrt(crossMm2);

        zValueEl.textContent = zCalculated.toFixed(2);
        // também guardamos a entrada do usuário (não alteramos a escala)
        console.log("Calibração informada pelo usuário (mm):", userZ, " | +Z calculado (mm):", zCalculated);
        return;
    }

    // se não houver ambos vetores, mas houver um vetor e uma escala, não faz sentido calcular cross - avisamos.
    alert("Para calcular +Z é necessário detectar simultaneamente as três cores (vermelho, azul e verde).");
});

// loop principal de processamento de frames
function processFrame(){
    if (!video || video.readyState < 2) {
        requestAnimationFrame(processFrame);
        return;
    }

    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const img = ctx.getImageData(0,0,canvas.width,canvas.height);
    const d = img.data;

    const rTol = sliderToHueTolerance(redThresholdSlider.value);
    const bTol = sliderToHueTolerance(blueThresholdSlider.value);
    const gTol = sliderToHueTolerance(greenThresholdSlider.value);

    let rCount=0, rX=0, rY=0;
    let bCount=0, bX=0, bY=0;
    let gCount=0, gX=0, gY=0;

    for(let i=0;i<d.length;i+=4){
        const {h,s,v} = rgbToHsv(d[i], d[i+1], d[i+2]);
        if(s < 0.35 || v < 0.12) continue;

        const p = i/4;
        const x = p % canvas.width;
        const y = Math.floor(p / canvas.width);

        if (hueDistance(h, 0) <= rTol) {
            rCount++; rX += x; rY += y;
            d[i]=255; d[i+1]=165; d[i+2]=0;
        } else if (hueDistance(h, 230) <= bTol) {
            bCount++; bX += x; bY += y;
            d[i]=255; d[i+1]=255; d[i+2]=255;
        } else if (hueDistance(h, 120) <= gTol) {
            gCount++; gX += x; gY += y;
            d[i]=160; d[i+1]=32; d[i+2]=240;
        }
    }

    ctx.putImageData(img,0,0);

    let rC = null, bC = null, gC = null;

    if (rCount) {
        rC = { x: rX / rCount, y: rY / rCount };
        ctx.fillStyle = "red";
        ctx.beginPath(); ctx.arc(rC.x, rC.y, 6, 0, Math.PI*2); ctx.fill();
    }
    if (bCount) {
        bC = { x: bX / bCount, y: bY / bCount };
        ctx.fillStyle = "blue";
        ctx.beginPath(); ctx.arc(bC.x, bC.y, 6, 0, Math.PI*2); ctx.fill();
    }
    if (gCount) {
        gC = { x: gX / gCount, y: gY / gCount };
        ctx.fillStyle = "green";
        ctx.beginPath(); ctx.arc(gC.x, gC.y, 6, 0, Math.PI*2); ctx.fill();
    }

    // calcula escala px/mm preferencialmente usando vermelho→azul; se não disponível, usa vermelho→verde
    let pxPerMm = lastPxPerMm;
    if (rC && bC) {
        const distPx = Math.hypot(bC.x - rC.x, bC.y - rC.y);
        pxPerMm = distPx / ARROW_LENGTH_MM;
        lastPxPerMm = pxPerMm;
        scaleEl.textContent = pxPerMm.toFixed(3);
    } else if (rC && gC) {
        const distPx = Math.hypot(gC.x - rC.x, gC.y - rC.y);
        pxPerMm = distPx / ARROW_LENGTH_MM;
        lastPxPerMm = pxPerMm;
        scaleEl.textContent = pxPerMm.toFixed(3);
    } else {
        // mantém último px/mm na tela (se já calculado). se não, fica 0.
        scaleEl.textContent = (lastPxPerMm || 0).toFixed(3);
    }

    // desenha vetores (comprimento físico = 100mm, convertido para pixels)
    if (rC && bC) {
        drawArrowFromCenter(rC.x, rC.y, bC.x - rC.x, bC.y - rC.y, ARROW_LENGTH_MM * (pxPerMm || 0), "blue");
    }
    if (rC && gC) {
        drawArrowFromCenter(rC.x, rC.y, gC.x - rC.x, gC.y - rC.y, ARROW_LENGTH_MM * (pxPerMm || 0), "green");
    }

    // atualiza contadores e salva últimos centroides
    redCountDisplay.textContent = `Pixels vermelhos: ${rCount}`;
    lastR = rC;
    lastB = bC;
    lastG = gC;

    requestAnimationFrame(processFrame);
}
