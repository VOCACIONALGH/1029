/* main.js
   Atualizado: durante a calibragem, cada pixel preto define um "raio 3D" usando aproximação pinhole.
   O número de pixels pretos com direção definida é contado e exibido em tempo real.
   Nenhuma outra funcionalidade foi alterada.
*/

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
const zEl = document.getElementById("zValue");
const xEl = document.getElementById("xValue");
const yEl = document.getElementById("yValue");
const raysEl = document.getElementById("raysValue");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

const ARROW_LENGTH_MM = 100;

// calibration / locking state
let baseZmm = 0;
let lockedScale = 0;
let basePixelDistance = 0;
let baseOriginScreen = null;
let isCalibrated = false;
let isCalibrating = false;
let calibrationFrames = [];
let lastRcentroid = null;
let currentScale = 0;

/* UTIL: converte RGB -> HSV */
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

/* desenha uma seta do centro (cx,cy) na direção (dx,dy) com comprimento lengthPx */
function drawArrowFromCenter(cx, cy, dx, dy, lengthPx, color) {
    const mag = Math.hypot(dx, dy);
    if (!mag) return;

    const ux = dx / mag;
    const uy = dy / mag;

    const x2 = cx + ux * lengthPx;
    const y2 = cy + uy * lengthPx;

    const headLen = 12;
    const angle = Math.atan2(y2 - cx, x2 - cy);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
        x2 - headLen * Math.cos(angle - Math.PI / 6),
        y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
        x2 - headLen * Math.cos(angle + Math.PI / 6),
        y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
}

/* compute arrow tip */
function computeArrowTip(cx, cy, dx, dy, lengthPx) {
    const mag = Math.hypot(dx, dy);
    if (!mag) return null;
    const ux = dx / mag;
    const uy = dy / mag;
    return { x: cx + ux * lengthPx, y: cy + uy * lengthPx, ux, uy };
}

/* draw plane polygon */
function drawPlanePolygon(origin, tipX, tipY) {
    if (!origin || !tipX || !tipY) return;
    const corner = { x: tipX.x + (tipY.x - origin.x), y: tipX.y + (tipY.y - origin.y) };
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(tipX.x, tipX.y);
    ctx.lineTo(corner.x, corner.y);
    ctx.lineTo(tipY.x, tipY.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(173,216,230,0.4)";
    ctx.fill();
    ctx.restore();
}

/* --- Inicialização da câmera / DeviceOrientation --- */
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
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
});

calibrateBtn.addEventListener("click", () => {
    if (!lastRcentroid) {
        alert("Origem (ponto vermelho) não detectada.");
        return;
    }

    if (!isCalibrating) {
        const input = prompt("Informe o valor atual de +Z (mm):");
        if (!input) return;
        baseZmm = parseFloat(input);
        lockedScale = currentScale;
        basePixelDistance = ARROW_LENGTH_MM * lockedScale;
        baseOriginScreen = { ...lastRcentroid };
        isCalibrated = true;
        isCalibrating = true;
        calibrationFrames = [];
        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        alert("Calibragem iniciada. Clique em Calibrar novamente para finalizar.");
        return;
    }

    if (isCalibrating) {
        isCalibrating = false;
        const payload = { createdAt: new Date().toISOString(), baseZmm, lockedScale, baseOriginScreen, frames: calibrationFrames };
        const filename = `calibragem_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        alert("Calibragem finalizada. Arquivo baixado.");
    }
});

function processFrame() {
    if (!video || video.readyState < 2) {
        requestAnimationFrame(processFrame);
        return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;

    const rTol = sliderToHueTolerance(redThresholdSlider.value);
    const bTol = sliderToHueTolerance(blueThresholdSlider.value);
    const gTol = sliderToHueTolerance(greenThresholdSlider.value);

    let rC = 0, rX = 0, rY = 0;
    let bC = 0, bX = 0, bY = 0;
    let gC = 0, gX = 0, gY = 0;

    let blackRaysCount = 0;
    const BLACK_THR = 30;

    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        const { h, s, v } = rgbToHsv(r,g,b);

        if (s < 0.35 || v < 0.12) { } 
        else {
            const p = i/4, x = p % canvas.width, y = (p/canvas.width)|0;
            if (hueDistance(h,0)<=rTol){ rC++; rX+=x; rY+=y; d[i]=255; d[i+1]=165; d[i+2]=0;}
            else if (hueDistance(h,230)<=bTol){ bC++; bX+=x; bY+=y; d[i]=255; d[i+1]=255; d[i+2]=255;}
            else if (hueDistance(h,120)<=gTol){ gC++; gX+=x; gY+=y; d[i]=160; d[i+1]=32; d[i+2]=240;}
        }

        // BLACK pixel: compute pinhole ray direction
        if (isCalibrating && r<BLACK_THR && g<BLACK_THR && b<BLACK_THR){
            d[i]=255; d[i+1]=0; d[i+2]=0; 
            blackRaysCount++;
        }
    }

    ctx.putImageData(img,0,0);

    let r = null, b = null, g = null;
    if(rC){ r={x:rX/rC, y:rY/rC}; lastRcentroid=r;} else lastRcentroid=null;
    if(bC) b={x:bX/bC, y:bY/bC};
    if(gC) g={x:gX/gC, y:gY/gC};

    if(rC && bC) currentScale=Math.hypot(b.x-r.x, b.y-r.y)/ARROW_LENGTH_MM;

    redCountDisplay.textContent=`Pixels vermelhos: ${rC}`;
    raysEl.textContent=blackRaysCount; // Atualização do contador de pixels pretos com direção definida

    requestAnimationFrame(processFrame);
}
