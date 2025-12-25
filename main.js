/*
 main.js - VERSÃO OTIMIZADA PARA DISPOSITIVOS FRACOS
 - Mantém todas as funcionalidades anteriores (calibração, mundo fixado,
   coleta de raios, triangulação por votes, download da nuvem, mini-visualização).
 - Otimizações principais:
   * processamento em resolução reduzida (processingCanvas)
   * subsampling / stride no loop de pixels
   * limite de rays processados por frame (maxRaysPerFrame)
   * janela reduzida ao comparar accumulatedRays (maxAccCheck)
   * throttle de processamento (targetFPS)
   * atualização da mini-view e overlay com frequência reduzida
   * limites de memória no acumulador (maxAccumulatedRays)
 - Nenhuma outra funcionalidade foi adicionada.
*/

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadBtn = document.getElementById("downloadBtn");

const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const miniCanvas = document.getElementById("miniCanvas");
const mctx = miniCanvas.getContext("2d");

const redCountDisplay = document.getElementById("redCount");
const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");
const scaleEl = document.getElementById("scaleValue");
const zEl = document.getElementById("zValue");
const xEl = document.getElementById("xValue");
const yEl = document.getElementById("yValue");
const raysEl = document.getElementById("raysValue");
const triagEl = document.getElementById("triangValue");
const worldMsgEl = document.getElementById("worldMsg");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

const ARROW_LENGTH_MM = 100;

// === Otimização / parâmetros adaptativos ===
// Você pode ajustar esses valores se quiser mais precisão (tradeoff desempenho).
let PROCESSING_SCALE = 0.5;        // escala da resolução de processamento (0.3..1.0)
let SUBSAMPLE_STRIDE = 2;         // saltar pixels (2 -> processa 1/4 dos pixels)
const TARGET_FPS = 15;            // taxa de processamento visada
const MAX_RAYS_PER_FRAME = 800;   // máximo de raios processados por frame (reduz trabalho)
const MAX_ACC_CHECK = 800;        // ao triangular, comparar newRays com no máximo esse número de accumulatedRays (mais recentes)
const MAX_ACCUMULATED_RAYS = 4000; // manter acumulador limitado (evita OOM)
const MINI_UPDATE_EVERY = 8;      // atualiza mini-view a cada N frames
const BLINK_INTERVAL_MS = 500;    // piscar pontos triangulados

// Ajuste dinâmico baseado em capacidades do dispositivo
(function adaptToDevice() {
    try {
        const hc = navigator.hardwareConcurrency || 2;
        const dm = navigator.deviceMemory || 4;
        if (hc <= 2 || dm <= 2) {
            PROCESSING_SCALE = 0.45;
            SUBSAMPLE_STRIDE = 3;
            // reduzir trabalho ainda mais
            MAX_RAYS_PER_FRAME = 600;
            MAX_ACC_CHECK = 500;
            MAX_ACCUMULATED_RAYS = 3000;
        } else if (hc <= 4 || dm <= 4) {
            PROCESSING_SCALE = 0.6;
            SUBSAMPLE_STRIDE = 2;
        } else {
            PROCESSING_SCALE = 0.8;
            SUBSAMPLE_STRIDE = 1;
        }
    } catch (e) {
        // fallback se alguma API não existir
        PROCESSING_SCALE = 0.5;
    }
})();

// === Estado e dados (mantidos das versões anteriores) ===
let baseZmm = 0;
let lockedScale = 0;
let basePixelDistance = 0;
let baseOriginScreen = null;
let isCalibrated = false;

let isCalibrating = false;
let calibrationFrames = [];

let lastRcentroid = null;
let currentScale = 0;

let worldFixed = false;
let initialPose = null;
let initialPoseMatrix = null;
let initialPoseInv = null;

// accumulated rays & triangulated points
let accumulatedRays = []; // { origin:{x,y,z}, direction:{dx,dy,dz}, frameTimestamp, px, py }
let triangulatedPoints = []; // {x,y,z}

// votes per pixel
let triangVotes = {};
let requiredTriangulations = 1; // definível pelo usuário no início da calibração

// triang thresholds
const TRIANG_DIST_THR_MM = 5.0;
const MERGE_THR_MM = 5.0;

// processing helpers
let processingCanvas = document.createElement('canvas');
let pctx = processingCanvas.getContext('2d');
let procWidth = 0, procHeight = 0;
let lastProcessTime = 0;
let processIntervalMs = 1000 / TARGET_FPS;
let frameCounter = 0;
let lastMiniUpdateFrame = 0;

// ===== UTILIDADES (mantidas / levemente otimizadas) =====
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

function degToRad(deg) { return deg * Math.PI / 180; }

function dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }

function multiplyMatrix3(A,B){
    const C = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i=0;i<3;i++){
        for (let j=0;j<3;j++){
            let s=0;
            for (let k=0;k<3;k++) s += A[i][k]*B[k][j];
            C[i][j]=s;
        }
    }
    return C;
}

function buildRotationMatrix(yawRad,pitchRad,rollRad){
    const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
    const Rz = [[cy,-sy,0],[sy,cy,0],[0,0,1]];
    const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
    const Rx = [[1,0,0],[0,cp,-sp],[0,sp,cp]];
    const cr = Math.cos(rollRad), sr = Math.sin(rollRad);
    const Ry = [[cr,0,sr],[0,1,0],[-sr,0,cr]];
    return multiplyMatrix3(multiplyMatrix3(Rz,Rx),Ry);
}

function applyRotationToVec(v,R){
    if (!R) return v;
    const x = R[0][0]*v.x + R[0][1]*v.y + R[0][2]*v.z;
    const y = R[1][0]*v.x + R[1][1]*v.y + R[1][2]*v.z;
    const z = R[2][0]*v.x + R[2][1]*v.y + R[2][2]*v.z;
    const mag = Math.hypot(x,y,z);
    if (!isFinite(mag) || mag === 0) return null;
    return { x: x/mag, y: y/mag, z: z/mag };
}

function buildPoseMatrix(tx,ty,tz,yawRad,pitchRad,rollRad){
    const R = buildRotationMatrix(yawRad,pitchRad,rollRad);
    return [
        [R[0][0],R[0][1],R[0][2],tx],
        [R[1][0],R[1][1],R[1][2],ty],
        [R[2][0],R[2][1],R[2][2],tz],
        [0,0,0,1]
    ];
}

function invertPoseMatrix(T){
    const R = [[T[0][0],T[0][1],T[0][2]],[T[1][0],T[1][1],T[1][2]],[T[2][0],T[2][1],T[2][2]]];
    const Rt = [[R[0][0],R[1][0],R[2][0]],[R[0][1],R[1][1],R[2][1]],[R[0][2],R[1][2],R[2][2]]];
    const t = [T[0][3], T[1][3], T[2][3]];
    const negRtT = [
        -(Rt[0][0]*t[0] + Rt[0][1]*t[1] + Rt[0][2]*t[2]),
        -(Rt[1][0]*t[0] + Rt[1][1]*t[1] + Rt[1][2]*t[2]),
        -(Rt[2][0]*t[0] + Rt[2][1]*t[1] + Rt[2][2]*t[2])
    ];
    return [
        [Rt[0][0],Rt[0][1],Rt[0][2], negRtT[0]],
        [Rt[1][0],Rt[1][1],Rt[1][2], negRtT[1]],
        [Rt[2][0],Rt[2][1],Rt[2][2], negRtT[2]],
        [0,0,0,1]
    ];
}

function multiplyMatrix4(A,B){
    const C = Array.from({length:4}, ()=>Array(4).fill(0));
    for (let i=0;i<4;i++){
        for (let j=0;j<4;j++){
            let s=0;
            for (let k=0;k<4;k++) s += A[i][k]*B[k][j];
            C[i][j]=s;
        }
    }
    return C;
}

// triang helpers (optimized)
function closestPointsBetweenLines(o1,d1,o2,d2){
    const w0 = { x: o1.x - o2.x, y: o1.y - o2.y, z: o1.z - o2.z };
    const a = dot(d1,d1), b = dot(d1,d2), c = dot(d2,d2), d = dot(d1,w0), e = dot(d2,w0);
    const denom = a*c - b*b;
    if (Math.abs(denom) < 1e-12) return null;
    const s = (b*e - c*d) / denom;
    const t = (a*e - b*d) / denom;
    const p1 = { x: o1.x + d1.x*s, y: o1.y + d1.y*s, z: o1.z + d1.z*s };
    const p2 = { x: o2.x + d2.x*t, y: o2.y + d2.y*t, z: o2.z + d2.z*t };
    const mid = { x: 0.5*(p1.x+p2.x), y: 0.5*(p1.y+p2.y), z: 0.5*(p1.z+p2.z) };
    const dist = Math.hypot(p1.x-p2.x, p1.y-p2.y, p1.z-p2.z);
    return { p1, p2, midpoint: mid, dist, s, t };
}

// Update UI small helpers (batched updates)
function updateTriangCountUI(){
    triagEl.textContent = String(triangulatedPoints.length);
}

// --- try triangulation but optimized: only compare against recent window and limit checks
function tryTriangulateAndAccumulate(newRays){
    const accLen = accumulatedRays.length;
    // choose window to check: recent MAX_ACC_CHECK rays
    const startIdx = Math.max(0, accLen - MAX_ACC_CHECK);
    for (let i = 0; i < newRays.length; i++){
        const nr = newRays[i];
        for (let j = startIdx; j < accLen; j++){
            const ar = accumulatedRays[j];
            if (nr.frameTimestamp === ar.frameTimestamp) continue;
            const cp = closestPointsBetweenLines(
                nr.origin, { x: nr.direction.dx, y: nr.direction.dy, z: nr.direction.dz },
                ar.origin, { x: ar.direction.dx, y: ar.direction.dy, z: ar.direction.dz }
            );
            if (!cp) continue;
            if (cp.dist <= TRIANG_DIST_THR_MM) {
                const pt = { x: Number(cp.midpoint.x.toFixed(4)), y: Number(cp.midpoint.y.toFixed(4)), z: Number(cp.midpoint.z.toFixed(4)) };
                // check near existing triangulatedPoints
                let merged = false;
                for (let k = 0; k < triangulatedPoints.length; k++){
                    const p = triangulatedPoints[k];
                    const d = Math.hypot(p.x - pt.x, p.y - pt.y, p.z - pt.z);
                    if (d <= MERGE_THR_MM) { merged = true; break; }
                }
                if (merged) continue;
                // vote keyed by pixel of NEW ray (nr.px,nr.py)
                const key = `${nr.px},${nr.py}`;
                const entry = triangVotes[key] || { count: 0, lastPoint: null, added: false };
                entry.count += 1;
                entry.lastPoint = pt;
                if (!entry.added && entry.count >= requiredTriangulations) {
                    // double-check duplicate
                    let tooClose = false;
                    for (let k = 0; k < triangulatedPoints.length; k++){
                        const p = triangulatedPoints[k];
                        const d = Math.hypot(p.x - pt.x, p.y - pt.y, p.z - pt.z);
                        if (d <= MERGE_THR_MM) { tooClose = true; break; }
                    }
                    if (!tooClose) {
                        triangulatedPoints.push(pt);
                        updateTriangCountUI();
                    }
                    entry.added = true;
                }
                triangVotes[key] = entry;
            }
        }
    }
    // append newRays to accumulatedRays (and keep cap)
    for (let i = 0; i < newRays.length; i++){
        accumulatedRays.push(newRays[i]);
    }
    if (accumulatedRays.length > MAX_ACCUMULATED_RAYS) {
        // drop oldest to keep memory bounded
        accumulatedRays.splice(0, accumulatedRays.length - MAX_ACCUMULATED_RAYS);
    }
}

// Draw triangulated points overlay (light pink blinking) - optimized: skip heavy work if none
function drawTriangulatedOnMainCanvas() {
    if (!triangulatedPoints || triangulatedPoints.length === 0) return;
    if (!baseOriginScreen || !lockedScale) return; // cannot project without base
    const blinkOn = Math.floor(Date.now() / BLINK_INTERVAL_MS) % 2 === 0;
    const size = 3; // smaller draw for performance
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < triangulatedPoints.length; i++) {
        const p = triangulatedPoints[i];
        const sx = baseOriginScreen.x - (p.x * lockedScale);
        const sy = baseOriginScreen.y + (p.y * lockedScale);
        if (sx < -10 || sx > canvas.width + 10 || sy < -10 || sy > canvas.height + 10) continue;
        ctx.beginPath();
        ctx.fillStyle = blinkOn ? 'rgba(255,182,193,0.95)' : 'rgba(255,182,193,0.22)';
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

// Draw mini cloud density but updated infrequently
function drawMiniCloud() {
    if (!triangulatedPoints) return;
    // clear
    mctx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
    mctx.fillStyle = '#071017';
    mctx.fillRect(0,0,miniCanvas.width,miniCanvas.height);
    if (triangulatedPoints.length === 0) return;

    // bounding box compute (cheap enough but performed only every MINI_UPDATE_EVERY frames)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pts = triangulatedPoints;
    for (let i=0;i<pts.length;i++){
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    const pad = 10;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);

    // draw points as small rectangles (semi-transparent), accumulate density visually
    mctx.fillStyle = 'rgba(255,182,193,0.14)';
    for (let i=0;i<pts.length;i++){
        const p = pts[i];
        const nx = (p.x - minX) / spanX;
        const ny = (p.y - minY) / spanY;
        const px = Math.floor(nx * (miniCanvas.width - 1));
        const py = Math.floor((1 - ny) * (miniCanvas.height - 1));
        mctx.fillRect(px, py, 2, 2);
    }
}

// --- camera + device orientation + start/stop logic (kept, but init processing canvas) ---
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
            // set display canvas to camera resolution (to keep visual quality)
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            // create processing canvas scaled down for analysis
            procWidth = Math.max(32, Math.floor(canvas.width * PROCESSING_SCALE));
            procHeight = Math.max(32, Math.floor(canvas.height * PROCESSING_SCALE));
            processingCanvas.width = procWidth;
            processingCanvas.height = procHeight;
            pctx = processingCanvas.getContext('2d');

            requestAnimationFrame(processFrame);
        }, { once: true });
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
});

// Calibrate button: includes prompt for requiredTriangulations as before (keeps behavior)
calibrateBtn.addEventListener("click", () => {
    if (!isCalibrating) {
        if (!lastRcentroid) {
            alert("Origem (ponto vermelho) não detectada. Posicione a câmera sobre a origem antes de calibrar.");
            return;
        }
        if (!currentScale || currentScale === 0 || !isFinite(currentScale)) {
            alert("Escala atual inválida. Aguarde detecção e tente novamente.");
            return;
        }

        const reqStr = prompt("Número de triangulações necessárias por pixel para virar ponto 3D (inteiro >= 1):", "3");
        if (reqStr === null) return;
        const req = parseInt(reqStr);
        if (isNaN(req) || req < 1) {
            alert("Valor inválido. Calibração cancelada.");
            return;
        }
        requiredTriangulations = req;

        const input = prompt("Informe o valor atual de +Z (em mm):");
        if (input === null) return;
        const z = parseFloat(input);
        if (isNaN(z)) {
            alert("Valor inválido. Calibração cancelada.");
            return;
        }

        baseZmm = z;
        lockedScale = currentScale;
        basePixelDistance = ARROW_LENGTH_MM * lockedScale;
        baseOriginScreen = { x: lastRcentroid.x, y: lastRcentroid.y };
        isCalibrated = true;

        isCalibrating = true;
        calibrationFrames = [];

        const initX = parseFloat(xEl.textContent) || 0;
        const initY = parseFloat(yEl.textContent) || 0;
        const initZ = parseFloat(zEl.textContent) || 0;
        const initPitch = parseFloat(pitchEl.textContent) || 0;
        const initYaw = parseFloat(yawEl.textContent) || 0;
        const initRoll = parseFloat(rollEl.textContent) || 0;

        initialPose = { x_mm: initX, y_mm: initY, z_mm: initZ, pitch_deg: initPitch, yaw_deg: initYaw, roll_deg: initRoll };
        const yawRad0 = degToRad(initYaw);
        const pitchRad0 = degToRad(initPitch);
        const rollRad0 = degToRad(initRoll);
        initialPoseMatrix = buildPoseMatrix(initX, initY, initZ, yawRad0, pitchRad0, rollRad0);
        initialPoseInv = invertPoseMatrix(initialPoseMatrix);

        accumulatedRays = [];
        triangulatedPoints = [];
        triangVotes = {};
        updateTriangCountUI();

        worldFixed = true;
        worldMsgEl.hidden = false;
        worldMsgEl.textContent = "Mundo fixado";

        downloadBtn.hidden = false;

        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        xEl.textContent = "0.00";
        yEl.textContent = "0.00";
        raysEl.textContent = "0";

        alert(`Calibragem iniciada e mundo fixado.\nTriangulações exigidas por pixel: ${requiredTriangulations}.\nMova a câmera para coletar dados e clique em 'Calibrar' novamente para finalizar e baixar o arquivo .json.`);
        return;
    }

    if (isCalibrating) {
        isCalibrating = false;
        downloadBtn.hidden = true;
        if (calibrationFrames.length === 0) {
            alert("Nenhum frame coletado durante a calibragem.");
            return;
        }
        const payload = {
            createdAt: new Date().toISOString(),
            baseZmm,
            lockedScale,
            baseOriginScreen,
            initialPose,
            requiredTriangulations,
            frames: calibrationFrames
        };
        const filename = `calibragem_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        alert(`Calibragem finalizada. Arquivo "${filename}" baixado.`);
        return;
    }
});

// download button (point cloud)
downloadBtn.addEventListener("click", () => {
    const payload = {
        createdAt: new Date().toISOString(),
        pointCloud: triangulatedPoints
    };
    const filename = `nuvem_pontos_${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
});

// compute pinhole direction using full-resolution canvas coords (so direction approx stays consistent)
function computePinholeDirectionAtFullRes(px, py) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const f = Math.max(canvas.width, canvas.height) * 0.9;
    const vx = (px - cx) / f;
    const vy = (py - cy) / f;
    const vz = 1.0;
    const norm = Math.hypot(vx, vy, vz);
    if (!isFinite(norm) || norm === 0) return null;
    return { x: vx / norm, y: vy / norm, z: vz / norm };
}

// Main loop (throttled)
function processFrame(ts) {
    frameCounter++;
    const now = performance.now();
    if (!lastProcessTime) lastProcessTime = now;

    // Always draw full-resolution video to main canvas for UI
    if (video && video.readyState >= 2) {
        try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch (e) {
            // some devices may throw if video size changes; ignore for robustness
        }
    }

    // Only run heavy processing at target FPS
    if (now - lastProcessTime < processIntervalMs) {
        // still draw overlays occasionally
        if (isCalibrating && (frameCounter % 2 === 0)) {
            drawTriangulatedOnMainCanvas();
        }
        requestAnimationFrame(processFrame);
        return;
    }
    lastProcessTime = now;

    // If no video/canvas sizes set yet, skip processing
    if (!canvas || !canvas.width || !canvas.height || !processingCanvas) {
        requestAnimationFrame(processFrame);
        return;
    }

    // Draw scaled frame into processing canvas (cheaper)
    pctx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);

    // Get imageData from processing canvas
    let img;
    try {
        img = pctx.getImageData(0,0,processingCanvas.width, processingCanvas.height);
    } catch (e) {
        // some browsers block getImageData in certain conditions; fallback to skip
        requestAnimationFrame(processFrame);
        return;
    }
    const d = img.data;
    const w = processingCanvas.width;
    const h = processingCanvas.height;

    // prepare rotation matrix for this frame if calibrating
    let rotationMatrix = null;
    if (isCalibrating) {
        const pitchDeg = parseFloat(pitchEl.textContent) || 0;
        const yawDeg = parseFloat(yawEl.textContent) || 0;
        const rollDeg = parseFloat(rollEl.textContent) || 0;
        const pitchRad = degToRad(pitchDeg);
        const yawRad = degToRad(yawDeg);
        const rollRad = degToRad(rollDeg);
        rotationMatrix = buildRotationMatrix(yawRad, pitchRad, rollRad);
    }

    // thresholds
    const rTol = sliderToHueTolerance(redThresholdSlider.value);
    const bTol = sliderToHueTolerance(blueThresholdSlider.value);
    const gTol = sliderToHueTolerance(greenThresholdSlider.value);

    // per-frame counters
    let rC = 0, rX = 0, rY = 0;
    let bC = 0, bX = 0, bY = 0;
    let gC = 0, gX = 0, gY = 0;

    const BLACK_THR = 30;

    // We'll collect newRays (bounded)
    const newRays = [];
    // We'll limit rays processed per frame to MAX_RAYS_PER_FRAME
    let raysCollected = 0;

    // Subsample by stride for speed: iterate by y step and x step
    const stride = Math.max(1, SUBSAMPLE_STRIDE);
    // Map from processing canvas coords to full-res coords
    const scaleX = canvas.width / w;
    const scaleY = canvas.height / h;

    for (let yy = 0; yy < h; yy += stride) {
        const rowStart = yy * w * 4;
        for (let xx = 0; xx < w; xx += stride) {
            const idx = rowStart + xx * 4;
            const rr = d[idx], gg = d[idx+1], bb = d[idx+2];
            const { h:hh, s:hs, v:hv } = rgbToHsv(rr, gg, bb);
            if (hs >= 0.35 && hv >= 0.12) {
                if (hueDistance(hh, 0) <= rTol) {
                    rC++; rX += xx; rY += yy;
                    // paint detection on processing canvas for debug (optional)
                    d[idx] = 255; d[idx+1] = 165; d[idx+2] = 0;
                } else if (hueDistance(hh, 230) <= bTol) {
                    bC++; bX += xx; bY += yy;
                    d[idx] = 255; d[idx+1] = 255; d[idx+2] = 255;
                } else if (hueDistance(hh, 120) <= gTol) {
                    gC++; gX += xx; gY += yy;
                    d[idx] = 160; d[idx+1] = 32; d[idx+2] = 240;
                }
            }
            // black pixel detection (only when calibrating)
            if (isCalibrating && rr < BLACK_THR && gg < BLACK_THR && bb < BLACK_THR) {
                if (raysCollected >= MAX_RAYS_PER_FRAME) continue;
                // compute approximate full-res pixel coords for pinhole computation
                const fullPx = (xx + 0.5) * scaleX;
                const fullPy = (yy + 0.5) * scaleY;
                const dirCam = computePinholeDirectionAtFullRes(fullPx, fullPy);
                if (!dirCam) continue;
                const dirRot = applyRotationToVec(dirCam, rotationMatrix);
                if (!dirRot) continue;
                // build world direction later (we'll rotate by pose matrix below)
                newRays.push({ px: Math.floor(fullPx), py: Math.floor(fullPy), dir_cam_rot: dirRot });
                raysCollected++;
                // paint red on processing canvas to show detection (cheap)
                d[idx] = 255; d[idx+1] = 0; d[idx+2] = 0;
            }
        }
    }

    // push processed image back to processing canvas (not strictly necessary for core logic)
    pctx.putImageData(img, 0, 0);

    // Update centroids (convert processing coords to full coords for centroid)
    if (rC) {
        const rcx = (rX / rC) * scaleX;
        const rcy = (rY / rC) * scaleY;
        lastRcentroid = { x: rcx, y: rcy };
    } else {
        lastRcentroid = null;
    }
    if (bC) {
        // convert centroid to full coords
        // not used for rays, only for scale calc
    }
    // compute scale using full-res centroids if possible: approximate b centroid similarly
    let currentPixelDistance = 0;
    if (rC && bC) {
        const bx = (bX / bC) * scaleX;
        const by = (bY / bC) * scaleY;
        currentPixelDistance = Math.hypot(bx - lastRcentroid.x, by - lastRcentroid.y);
        currentScale = currentPixelDistance / ARROW_LENGTH_MM;
        if (!isCalibrated) scaleEl.textContent = currentScale.toFixed(3);
        else scaleEl.textContent = lockedScale.toFixed(3);
    }

    // plane drawing and arrows: we keep drawing on main canvas using last detected centroids (cheap)
    // (existing code draws arrows using r,b,g in screen coords — keep behavior as before but reduced frequency)
    if (isCalibrating && lastRcentroid && bC && gC) {
        const bx = (bX / bC) * scaleX;
        const by = (bY / bC) * scaleY;
        const gx = (gX / gC) * scaleX;
        const gy = (gY / gC) * scaleY;
        const scaleUsed = isCalibrated ? lockedScale : currentScale;
        if (scaleUsed && isFinite(scaleUsed) && scaleUsed > 0) {
            const lengthPx = ARROW_LENGTH_MM * scaleUsed;
            // compute tips approximate
            const tipX = computeArrowTip(lastRcentroid.x, lastRcentroid.y, bx - lastRcentroid.x, by - lastRcentroid.y, lengthPx);
            const tipY = computeArrowTip(lastRcentroid.x, lastRcentroid.y, gx - lastRcentroid.x, gy - lastRcentroid.y, lengthPx);
            if (tipX && tipY) drawPlanePolygon(lastRcentroid, tipX, tipY);
        }
    }

    // +Z calculation (as before)
    let computedZ = null;
    if (isCalibrated && currentPixelDistance) {
        const dzMm = (basePixelDistance - currentPixelDistance) / lockedScale;
        computedZ = baseZmm + dzMm;
        zEl.textContent = computedZ.toFixed(2);
    } else {
        if (!isCalibrated) zEl.textContent = "0.00";
        else zEl.textContent = baseZmm.toFixed(2);
    }

    // +X and +Y (as before)
    let txMm = null, tyMm = null;
    if (isCalibrated && lastRcentroid && baseOriginScreen) {
        const dxPixels = lastRcentroid.x - baseOriginScreen.x;
        const dyPixels = lastRcentroid.y - baseOriginScreen.y;
        const tx = -(dxPixels) / lockedScale;
        const ty = (dyPixels) / lockedScale;
        txMm = tx; tyMm = ty;
        xEl.textContent = txMm.toFixed(2);
        yEl.textContent = tyMm.toFixed(2);
    } else {
        if (!isCalibrated) { xEl.textContent = "0.00"; yEl.textContent = "0.00"; }
        else { xEl.textContent = "0.00"; yEl.textContent = "0.00"; }
    }

    // if calibrating and we collected some new rays, convert them to world-fixed rays and triangulate
    if (isCalibrating && newRays.length > 0) {
        const pitch = parseFloat(pitchEl.textContent) || 0;
        const yaw = parseFloat(yawEl.textContent) || 0;
        const roll = parseFloat(rollEl.textContent) || 0;

        const camTx = txMm !== null ? txMm : 0;
        const camTy = tyMm !== null ? tyMm : 0;
        const camTz = computedZ !== null ? computedZ : 0;

        const yawRad = degToRad(yaw);
        const pitchRad = degToRad(pitch);
        const rollRad = degToRad(roll);

        const T_cam = buildPoseMatrix(camTx, camTy, camTz, yawRad, pitchRad, rollRad);

        let T_world_rel = T_cam;
        if (worldFixed && initialPoseInv) {
            T_world_rel = multiplyMatrix4(initialPoseInv, T_cam);
        }

        const R_world_rel = [
            [ T_world_rel[0][0], T_world_rel[0][1], T_world_rel[0][2] ],
            [ T_world_rel[1][0], T_world_rel[1][1], T_world_rel[1][2] ],
            [ T_world_rel[2][0], T_world_rel[2][1], T_world_rel[2][2] ]
        ];
        const t_world_rel = { x: T_world_rel[0][3], y: T_world_rel[1][3], z: T_world_rel[2][3] };

        // Convert newRays to world coordinates, include px,py for voting
        const raysWorld = [];
        for (let k = 0; k < newRays.length; k++) {
            const entry = newRays[k];
            const dirCamRot = entry.dir_cam_rot;
            const rx = R_world_rel[0][0]*dirCamRot.x + R_world_rel[0][1]*dirCamRot.y + R_world_rel[0][2]*dirCamRot.z;
            const ry = R_world_rel[1][0]*dirCamRot.x + R_world_rel[1][1]*dirCamRot.y + R_world_rel[1][2]*dirCamRot.z;
            const rz = R_world_rel[2][0]*dirCamRot.x + R_world_rel[2][1]*dirCamRot.y + R_world_rel[2][2]*dirCamRot.z;
            const mag = Math.hypot(rx, ry, rz);
            if (!isFinite(mag) || mag === 0) continue;
            const dirWorld = { dx: rx / mag, dy: ry / mag, dz: rz / mag };
            const originWorld = { x: t_world_rel.x, y: t_world_rel.y, z: t_world_rel.z };
            raysWorld.push({ origin: originWorld, direction: dirWorld, frameTimestamp: new Date().toISOString(), px: entry.px, py: entry.py });
        }

        // append minimal frame record (keeps compatibility)
        calibrationFrames.push({ timestamp: new Date().toISOString(), rays: raysWorld });

        // triangulate (optimized)
        tryTriangulateAndAccumulate(raysWorld);

        raysEl.textContent = String(raysWorld.length);
    } else {
        raysEl.textContent = "0";
    }

    // draw triangulated overlay, but only occasionally to reduce GPU pressure
    if (frameCounter % 2 === 0) {
        drawTriangulatedOnMainCanvas();
    }

    // update mini cloud at lower frequency
    if (frameCounter - lastMiniUpdateFrame >= MINI_UPDATE_EVERY) {
        drawMiniCloud();
        lastMiniUpdateFrame = frameCounter;
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${ (rC) }`;

    requestAnimationFrame(processFrame);
}

// Start loop
requestAnimationFrame(processFrame);
