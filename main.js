/* main.js
   Atualizações pequenas para:
   - estabilizar câmera/origem (média móvel)
   - agregar (média) e filtrar outliers antes de registrar ponto na nuvem
   Nenhuma outra função extra.
*/

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadBtn = document.getElementById("downloadBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const miniCanvas = document.getElementById("miniCanvas");
const miniCtx = miniCanvas.getContext("2d");

const blackSlider = document.getElementById("blackThreshold");
const blueSlider = document.getElementById("blueThreshold");
const greenSlider = document.getElementById("greenThreshold");

const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");

const scaleEl = document.getElementById("scale");
const scaleLockEl = document.getElementById("scaleLock");

const zCameraEl = document.getElementById("zCamera");
const zWorldEl = document.getElementById("zWorld");

const xCameraEl = document.getElementById("xCamera");
const yCameraEl = document.getElementById("yCamera");

const raysCountEl = document.getElementById("raysCount");
const pinkDirCountEl = document.getElementById("pinkDirCount");
const rotatedCountEl = document.getElementById("rotatedCount");
const triangulatedCountEl = document.getElementById("triangulatedCount");

let pitch = 0, yaw = 0, roll = 0;

let pixelPerMM_current = 0;   // atualizado dinamicamente
let pixelPerMM_locked = null; // valor travado após calibrar
let calibration_px = null;    // px observado quando calibrado (média)
let calibrationZ_mm = null;   // +Z informado pelo usuário durante calibração
let isCalibrated = false;

let lastAvgPx = null; // último avg px calculado (entre origem e pontos)

let currentOriginX = null; // posição atual da origem (em pixels na tela)
let currentOriginY = null;
let originCalX = null; // posição da origem registrada na calibração
let originCalY = null;

let cameraX_mm = 0; // posição atual da câmera no referencial (mm)
let cameraY_mm = 0;
let cameraZ_mm = null;

let isRecording = false; // true enquanto a calibração está registrando frames
let calibrationLog = []; // array para armazenar os frames durante calibração
let calibrationStartTime = null;

// contagem e registro de raios gerados pelo ponto rosa
let raysCount = 0;
let raysLog = []; // cada entrada: { origin: {x,y,z}, direction: {dx,dy,dz} }

// contagem de pontos rosas com direção definida (pinhole)
let pinkDirCount = 0;

// contagem de vetores rotacionados (aplicados à direção para colocá-los no referencial world-fixed)
let rotatedCount = 0;

// triangulação
let nRaysRequired = null; // número de raios por triangulação (definido pelo usuário no início da calibração)
let pendingRaysForTriang = []; // raios acumulados (world-fixed) para próxima triangulação
let triangulatedPoints = []; // pontos triangulados (armazenados relativos ao primeiro triangulado)
let triangulatedCount = 0;

// Nuvem de pontos (registrada durante calibração; conteúdo salvo em JSON quando o usuário clicar em Download)
let pointCloud = []; // cada item: { x, y, z } (relativos ao primeiro triangulado quando definido)

// Primeiro ponto triangulado que serve como origem (world coords antes de tornar relativo)
let originTriPoint = null; // { x, y, z } ou null

// lista de destaques temporários na imagem (cada item: { x, y, expireAt })
let tempHighlights = [];

// Matrizes homogeneas iniciais (definem o referencial world fixo no instante de calibração)
let initialCamH = null;    // H0 (4x4) camera0 -> world_global
let initialCamHInv = null; // inverse(H0)

/* --- Novas estruturas para estabilização e agregação --- */

// média móvel de pose/origem para estabilizar leituras (frames)
const POSE_BUFFER_SIZE = 6;
let poseBuffer = []; // cada item: { yaw, pitch, roll, cameraX_mm, cameraY_mm, cameraZ_mm, originX, originY }

// agregação de triangulações para reduzir ruído
const TRI_AGG_SIZE = 3; // quantos candidatos acumular antes de aceitar por média
let triAggBuffer = [];  // cada item: { x, y, z, t }

/* --- utilitários para média móvel / smoothing --- */
function pushPoseSample(sample) {
    poseBuffer.push(sample);
    if (poseBuffer.length > POSE_BUFFER_SIZE) poseBuffer.shift();
}

function getSmoothedPose() {
    if (poseBuffer.length === 0) return null;
    const fields = ["yaw","pitch","roll","cameraX_mm","cameraY_mm","cameraZ_mm","originX","originY"];
    const out = {};
    for (const f of fields) {
        let sum = 0;
        let cnt = 0;
        for (const s of poseBuffer) {
            const v = s[f];
            if (v !== null && v !== undefined && Number.isFinite(v)) {
                sum += v;
                cnt++;
            }
        }
        out[f] = (cnt>0) ? (sum / cnt) : null;
    }
    return out;
}

/* --- função para agregar candidatos de triangulação e filtrar outliers ---
   Estratégia simples:
   - acumular até TRI_AGG_SIZE candidatos (triWorld já traduzido pelo originCal)
   - quando atingir TRI_AGG_SIZE, calcular média e desvios; remover outliers (i.e., pontos cuja distância ao mean > max(THRESH_MM, 3*std))
   - se sobram >=1 ponto após filtragem, usar média dos restantes como ponto final aceito
   - limpar buffer apropriado
*/
const MIN_ACCEPTED_AFTER_FILTER = 1;
const MIN_RELIABLE_STD_MM = 2.0; // valor mínimo razoável para std (mm)
const THRESH_MM = 12.0; // limite absoluto de corte (mm)

function acceptTriCandidate(candidate) {
    // candidate: { x,y,z, t }
    triAggBuffer.push(candidate);
    if (triAggBuffer.length < TRI_AGG_SIZE) {
        return null; // esperar mais candidatos
    }

    // calc mean
    const n = triAggBuffer.length;
    let mean = { x:0, y:0, z:0 };
    for (const c of triAggBuffer) { mean.x += c.x; mean.y += c.y; mean.z += c.z; }
    mean.x /= n; mean.y /= n; mean.z /= n;

    // calc std (RMS distance components)
    let sumSq = 0;
    let distArr = [];
    for (const c of triAggBuffer) {
        const dx = c.x - mean.x;
        const dy = c.y - mean.y;
        const dz = c.z - mean.z;
        const d = Math.hypot(dx,dy,dz);
        distArr.push(d);
        sumSq += d*d;
    }
    const rms = Math.sqrt(sumSq / n); // RMS distance
    const std = rms; // aproximação razoável

    // filtro: manter candidatos cuja distância <= max(THRESH_MM, 3*std)
    const cutoff = Math.max(THRESH_MM, 3 * std, MIN_RELIABLE_STD_MM);
    const kept = [];
    for (let i=0;i<triAggBuffer.length;i++){
        if (distArr[i] <= cutoff) kept.push(triAggBuffer[i]);
    }

    let acceptedPoint = null;
    if (kept.length >= MIN_ACCEPTED_AFTER_FILTER) {
        // média dos mantidos
        let sx=0, sy=0, sz=0;
        for (const k of kept) { sx += k.x; sy += k.y; sz += k.z; }
        acceptedPoint = { x: sx/kept.length, y: sy/kept.length, z: sz/kept.length };
    }

    // limpar buffer (sempre limpar para começar nova janela)
    triAggBuffer = [];

    return acceptedPoint; // pode ser null (descartado)
}

/* --- funcoes já existentes (matrizes, triangulação, etc.) --- */

// buildHomogeneous(yaw, pitch, roll, tx, ty, tz) -> H (4x4) camera->world
function buildHomogeneous(alphaDeg, betaDeg, gammaDeg, tx, ty, tz) {
    const R = getRotationMatrix(alphaDeg, betaDeg, gammaDeg); // 3x3
    // build 4x4
    return [
        [R[0][0], R[0][1], R[0][2], tx],
        [R[1][0], R[1][1], R[1][2], ty],
        [R[2][0], R[2][1], R[2][2], tz],
        [0, 0, 0, 1]
    ];
}

function invertHomogeneous(H) {
    const R = [
        [H[0][0], H[0][1], H[0][2]],
        [H[1][0], H[1][1], H[1][2]],
        [H[2][0], H[2][1], H[2][2]]
    ];
    const t = [H[0][3], H[1][3], H[2][3]];
    const RT = [
        [R[0][0], R[1][0], R[2][0]],
        [R[0][1], R[1][1], R[2][1]],
        [R[0][2], R[1][2], R[2][2]]
    ];
    const nt = [
        -(RT[0][0]*t[0] + RT[0][1]*t[1] + RT[0][2]*t[2]),
        -(RT[1][0]*t[0] + RT[1][1]*t[1] + RT[1][2]*t[2]),
        -(RT[2][0]*t[0] + RT[2][1]*t[1] + RT[2][2]*t[2])
    ];
    return [
        [RT[0][0], RT[0][1], RT[0][2], nt[0]],
        [RT[1][0], RT[1][1], RT[1][2], nt[1]],
        [RT[2][0], RT[2][1], RT[2][2], nt[2]],
        [0, 0, 0, 1]
    ];
}

function mul4(A, B) {
    const C = Array(4).fill(0).map(()=>Array(4).fill(0));
    for (let i=0;i<4;i++){
        for (let j=0;j<4;j++){
            let s = 0;
            for (let k=0;k<4;k++) s += A[i][k]*B[k][j];
            C[i][j] = s;
        }
    }
    return C;
}
function mul4Vec(M, v) {
    const out = [0,0,0,0];
    for (let i=0;i<4;i++){
        out[i] = M[i][0]*v[0] + M[i][1]*v[1] + M[i][2]*v[2] + M[i][3]*v[3];
    }
    return out;
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    let s = max === 0 ? 0 : d / max;
    let v = max;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s, v };
}

function drawArrow(x1, y1, x2, y2, color) {
    const headLength = 10;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
        x2 - headLength * Math.cos(angle - Math.PI / 6),
        y2 - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
        x2 - headLength * Math.cos(angle + Math.PI / 6),
        y2 - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
}

function getRotationMatrix(alphaDeg, betaDeg, gammaDeg) {
    const a = alphaDeg * Math.PI / 180; // yaw (z)
    const b = betaDeg * Math.PI / 180;  // pitch (x)
    const g = gammaDeg * Math.PI / 180; // roll (y)

    const Rz = [
        [Math.cos(a), -Math.sin(a), 0],
        [Math.sin(a),  Math.cos(a), 0],
        [0, 0, 1]
    ];
    const Rx = [
        [1, 0, 0],
        [0, Math.cos(b), -Math.sin(b)],
        [0, Math.sin(b),  Math.cos(b)]
    ];
    const Ry = [
        [ Math.cos(g), 0, Math.sin(g)],
        [ 0, 1, 0],
        [-Math.sin(g), 0, Math.cos(g)]
    ];

    function mul(A, B) {
        const C = Array(A.length).fill(0).map(()=>Array(B[0].length).fill(0));
        for (let i=0;i<A.length;i++){
            for (let j=0;j<B[0].length;j++){
                for (let k=0;k<B.length;k++){
                    C[i][j] += A[i][k]*B[k][j];
                }
            }
        }
        return C;
    }

    const RzRx = mul(Rz, Rx);
    const R = mul(RzRx, Ry);
    return R;
}

function matMulVec(M, v) {
    return [
        M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
        M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
        M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
    ];
}

// triangulação mínima (igual à original)
function triangulateRaysWorld(rays) {
    if (!rays || rays.length < 2) return null;

    let A = [
        [0,0,0],
        [0,0,0],
        [0,0,0]
    ];
    let b = [0,0,0];

    for (const r of rays) {
        if (!r.origin || !r.direction) return null;
        const o = [r.origin.x, r.origin.y, r.origin.z];
        const d = [r.direction.dx, r.direction.dy, r.direction.dz];
        const n = Math.hypot(d[0], d[1], d[2]) || 1;
        const dd = [d[0]/n, d[1]/n, d[2]/n];

        const M = [
            [1 - dd[0]*dd[0], -dd[0]*dd[1],    -dd[0]*dd[2]],
            [-dd[1]*dd[0],    1 - dd[1]*dd[1], -dd[1]*dd[2]],
            [-dd[2]*dd[0],    -dd[2]*dd[1],    1 - dd[2]*dd[2]]
        ];

        for (let i=0;i<3;i++){
            for (let j=0;j<3;j++){
                A[i][j] += M[i][j];
            }
        }
        for (let i=0;i<3;i++){
            b[i] += M[i][0]*o[0] + M[i][1]*o[1] + M[i][2]*o[2];
        }
    }

    const invA = invert3x3(A);
    if (!invA) return null;

    const x = [
        invA[0][0]*b[0] + invA[0][1]*b[1] + invA[0][2]*b[2],
        invA[1][0]*b[0] + invA[1][1]*b[1] + invA[1][2]*b[2],
        invA[2][0]*b[0] + invA[2][1]*b[1] + invA[2][2]*b[2]
    ];

    return { x: x[0], y: x[1], z: x[2] };
}

function invert3x3(M) {
    const a = M[0][0], b = M[0][1], c = M[0][2];
    const d = M[1][0], e = M[1][1], f = M[1][2];
    const g = M[2][0], h = M[2][1], i = M[2][2];

    const A = e*i - f*h;
    const B = -(d*i - f*g);
    const C = d*h - e*g;
    const D = -(b*i - c*h);
    const E = a*i - c*g;
    const F = -(a*h - b*g);
    const G = b*f - c*e;
    const H = -(a*f - c*d);
    const I = a*e - b*d;

    const det = a*A + b*B + c*C;
    if (Math.abs(det) < 1e-9) return null;

    const invDet = 1 / det;
    return [
        [A * invDet, D * invDet, G * invDet],
        [B * invDet, E * invDet, H * invDet],
        [C * invDet, F * invDet, I * invDet]
    ];
}

// desenha destaques temporários
function drawTempHighlights() {
    const now = Date.now();
    tempHighlights = tempHighlights.filter(h => h.expireAt > now);
    for (const h of tempHighlights) {
        ctx.save();
        ctx.fillStyle = "rgba(255,182,193,0.85)"; // lightpink semi-transparente
        ctx.beginPath();
        ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

function clearMiniCanvas() {
    miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
    miniCtx.fillStyle = "rgba(0,0,0,0.0)";
    miniCtx.fillRect(0,0,miniCanvas.width,miniCanvas.height);
}

function drawMiniCloud() {
    clearMiniCanvas();
    if (!pointCloud || pointCloud.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pointCloud) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (minX === maxX) { minX -= 1; maxX += 1; }
    if (minY === maxY) { minY -= 1; maxY += 1; }

    const pad = 6;
    const w = miniCanvas.width - pad*2;
    const h = miniCanvas.height - pad*2;

    miniCtx.save();
    for (const p of pointCloud) {
        const nx = (p.x - minX) / (maxX - minX);
        const ny = (p.y - minY) / (maxY - minY);
        const vx = pad + nx * w;
        const vy = pad + (1 - ny) * h;
        miniCtx.beginPath();
        miniCtx.fillStyle = "rgba(255,255,255,0.9)";
        miniCtx.arc(vx, vy, 1.3, 0, Math.PI*2);
        miniCtx.fill();
    }
    miniCtx.restore();
}

/* ----------------- fluxo principal (captura/processamento) ----------------- */

scanBtn.addEventListener("click", async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: { exact: "environment" }
        },
        audio: false
    });

    video.srcObject = stream;

    video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        miniCanvas.width = 200;
        miniCanvas.height = 200;
        processFrame();
    };

    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission === "granted") {
                window.addEventListener("deviceorientation", onOrientation);
            }
        } catch {}
    } else {
        window.addEventListener("deviceorientation", onOrientation);
    }
});

calibrateBtn.addEventListener("click", () => {
    if (!isCalibrated) {
        const nrInput = prompt("Informe a quantidade de raios necessários para triangular cada ponto rosa (inteiro >= 2):", "3");
        if (!nrInput) {
            alert("Calibração cancelada: número de raios não fornecido.");
            downloadBtn.style.display = "none";
            miniCanvas.style.display = "none";
            return;
        }
        const nr = parseInt(nrInput, 10);
        if (isNaN(nr) || nr < 2) {
            alert("Valor inválido para número de raios. Calibração cancelada.");
            downloadBtn.style.display = "none";
            miniCanvas.style.display = "none";
            return;
        }
        nRaysRequired = nr;

        if (!lastAvgPx || lastAvgPx <= 0) {
            alert("Impossível calibrar: não foi detectada distância entre origem e pontos. Certifique-se de que origem e pontos existam na cena.");
            downloadBtn.style.display = "none";
            miniCanvas.style.display = "none";
            return;
        }
        if (currentOriginX === null || currentOriginY === null) {
            alert("Impossível calibrar: origem (ponto branco) não detectada no momento.");
            downloadBtn.style.display = "none";
            miniCanvas.style.display = "none";
            return;
        }
        const currentPixelPerMM = lastAvgPx / 100;
        pixelPerMM_locked = currentPixelPerMM;
        calibration_px = lastAvgPx;

        originCalX = currentOriginX;
        originCalY = currentOriginY;

        const input = prompt("Informe o valor atual de +Z em milímetros (por exemplo: 250):");
        if (!input) {
            pixelPerMM_locked = null;
            calibration_px = null;
            originCalX = null;
            originCalY = null;
            isCalibrated = false;
            scaleLockEl.textContent = "aberta";
            downloadBtn.style.display = "none";
            miniCanvas.style.display = "none";
            return;
        }

        const zVal = parseFloat(input.replace(",", "."));
        if (isNaN(zVal) || zVal <= 0) {
            alert("Valor de +Z inválido. Calibração cancelada.");
            pixelPerMM_locked = null;
            calibration_px = null;
            originCalX = null;
            originCalY = null;
            isCalibrated = false;
            scaleLockEl.textContent = "aberta";
            downloadBtn.style.display = "none";
            miniCanvas.style.display = "none";
            return;
        }

        calibrationZ_mm = zVal;
        isCalibrated = true;
        scaleLockEl.textContent = "travada";

        cameraX_mm = 0;
        cameraY_mm = 0;
        cameraZ_mm = calibrationZ_mm;

        initialCamH = buildHomogeneous(yaw, pitch, roll, cameraX_mm, cameraY_mm, cameraZ_mm);
        initialCamHInv = invertHomogeneous(initialCamH);

        isRecording = true;
        calibrationLog = [];
        calibrationStartTime = Date.now();

        raysCount = 0; raysLog = []; raysCountEl.textContent = raysCount.toString();
        pinkDirCount = 0; pinkDirCountEl.textContent = pinkDirCount.toString();
        rotatedCount = 0; rotatedCountEl.textContent = rotatedCount.toString();

        pendingRaysForTriang = [];
        triangulatedPoints = [];
        triangulatedCount = 0; triangulatedCountEl.textContent = triangulatedCount.toString();

        pointCloud = [];
        originTriPoint = null;
        triAggBuffer = [];
        poseBuffer = [];

        downloadBtn.style.display = "inline-block";
        miniCanvas.style.display = "block";
        clearMiniCanvas();

        zCameraEl.textContent = cameraZ_mm.toFixed(2);
        xCameraEl.textContent = cameraX_mm.toFixed(2);
        yCameraEl.textContent = cameraY_mm.toFixed(2);

        return;
    }

    if (isCalibrated && isRecording) {
        isRecording = false;

        const exportObj = {
            meta: {
                calibration_px: calibration_px,
                calibrationZ_mm: calibrationZ_mm,
                pixelPerMM_locked: pixelPerMM_locked,
                originCalX: originCalX,
                originCalY: originCalY,
                nRaysRequired: nRaysRequired,
                calibrationStart: calibrationStartTime,
                calibrationEnd: Date.now(),
                frames: calibrationLog.length,
                raysDefined: raysCount,
                pinkDirsDefined: pinkDirCount,
                rotatedDefined: rotatedCount,
                triangulatedCount: triangulatedPoints.length
            },
            frames: calibrationLog,
            rays: raysLog,
            triangulatedPoints: triangulatedPoints
        };

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const ts = (new Date()).toISOString().replace(/[:.]/g, "-");
        a.href = url;
        a.download = `calibration_log_${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        downloadBtn.style.display = "none";
        miniCanvas.style.display = "none";

        alert("Calibração finalizada. Arquivo JSON baixado.");
        return;
    }
});

downloadBtn.addEventListener("click", () => {
    if (!pointCloud || pointCloud.length === 0) {
        alert("Nenhum ponto triangulado registrado ainda.");
        return;
    }
    const obj = {
        meta: {
            originCalX: originCalX,
            originCalY: originCalY,
            calibrationZ_mm: calibrationZ_mm,
            pixelPerMM_locked: pixelPerMM_locked,
            generatedAt: Date.now(),
            points: pointCloud.length,
            originFirstDefined: originTriPoint !== null
        },
        points: pointCloud
    };
    const jsonStr = JSON.stringify(obj, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = (new Date()).toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `pointcloud_${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
});

function onOrientation(e) {
    pitch = e.beta || 0;
    yaw = e.alpha || 0;
    roll = e.gamma || 0;

    pitchEl.textContent = pitch.toFixed(1);
    yawEl.textContent = yaw.toFixed(1);
    rollEl.textContent = roll.toFixed(1);
}

function processFrame() {
    if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = frame.data;

        const vBlack = blackSlider.value / 100;
        const sBlue = blueSlider.value / 100;
        const sGreen = greenSlider.value / 100;

        let sbx = 0, sby = 0, cb = 0;
        let blx = 0, bly = 0, cbl = 0;
        let grx = 0, gry = 0, cgr = 0;

        let rdx = 0, rdy = 0, cr = 0;

        for (let i = 0; i < data.length; i += 4) {
            const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);

            const idx = i / 4;
            const x = idx % canvas.width;
            const y = Math.floor(idx / canvas.width);

            if (hsv.v < vBlack) {
                data[i] = 255; data[i + 1] = 165; data[i + 2] = 0;
                sbx += x; sby += y; cb++;
            } else if (hsv.h >= 200 && hsv.h <= 260 && hsv.s > sBlue) {
                data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
                blx += x; bly += y; cbl++;
            } else if (hsv.h >= 90 && hsv.h <= 150 && hsv.s > sGreen) {
                data[i] = 128; data[i + 1] = 0; data[i + 2] = 128;
                grx += x; gry += y; cgr++;
            }

            if ((hsv.h <= 15 || hsv.h >= 345) && hsv.s > 0.4 && hsv.v > 0.2) {
                rdx += x;
                rdy += y;
                cr++;
            }
        }

        ctx.putImageData(frame, 0, 0);

        let ox, oy, bx, by, gx, gy;
        let distBlue = 0, distGreen = 0, nDist = 0;

        if (cb > 0) {
            ox = sbx / cb;
            oy = sby / cb;
            ctx.fillStyle = "white";
            ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();

            currentOriginX = ox;
            currentOriginY = oy;
        } else { currentOriginX = null; currentOriginY = null; }

        if (cbl > 0) {
            bx = blx / cbl;
            by = bly / cbl;
            ctx.fillStyle = "blue";
            ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
            if (cb) {
                distBlue = Math.hypot(bx - ox, by - oy);
                nDist++;
            }
        }

        if (cgr > 0) {
            gx = grx / cgr;
            gy = gry / cgr;
            ctx.fillStyle = "green";
            ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.fill();
            if (cb) {
                distGreen = Math.hypot(gx - ox, gy - oy);
                nDist++;
            }
        }

        let redCx = null, redCy = null;
        if (cr > 0) {
            redCx = rdx / cr;
            redCy = rdy / cr;
            ctx.fillStyle = "#FF69B4";
            ctx.beginPath();
            ctx.arc(redCx, redCy, 4, 0, Math.PI * 2);
            ctx.fill();

            // antes de usar leituras para cálculo de raio, empurrar amostra na poseBuffer para estabilizar
            const samplePose = {
                yaw: yaw,
                pitch: pitch,
                roll: roll,
                cameraX_mm: cameraX_mm,
                cameraY_mm: cameraY_mm,
                cameraZ_mm: cameraZ_mm,
                originX: currentOriginX,
                originY: currentOriginY
            };
            pushPoseSample(samplePose);
            const smooth = getSmoothedPose(); // media móvel

            // se estamos gravando, gerar raio usando valores estabilizados (quando disponíveis)
            if (isRecording) {
                if (isCalibrated && pixelPerMM_locked && smooth && smooth.cameraZ_mm && initialCamHInv) {
                    const camZUsed = smooth.cameraZ_mm;
                    const f = pixelPerMM_locked * camZUsed;
                    if (f > 0 && canvas.width > 0 && canvas.height > 0) {
                        const cx = canvas.width / 2;
                        const cy = canvas.height / 2;

                        const u = redCx;
                        const v = redCy;

                        let dir_cam = [
                            (u - cx) / f,
                            (v - cy) / f,
                            1
                        ];
                        const normP = Math.hypot(dir_cam[0], dir_cam[1], dir_cam[2]) || 1;
                        dir_cam = [dir_cam[0] / normP, dir_cam[1] / normP, dir_cam[2] / normP];

                        pinkDirCount++;
                        pinkDirCountEl.textContent = pinkDirCount.toString();

                        // usar pose suavizada para construir Hc
                        const Hc = buildHomogeneous(
                            (smooth.yaw !== null) ? smooth.yaw : yaw,
                            (smooth.pitch !== null) ? smooth.pitch : pitch,
                            (smooth.roll !== null) ? smooth.roll : roll,
                            (smooth.cameraX_mm !== null) ? smooth.cameraX_mm : cameraX_mm,
                            (smooth.cameraY_mm !== null) ? smooth.cameraY_mm : cameraY_mm,
                            (smooth.cameraZ_mm !== null) ? smooth.cameraZ_mm : cameraZ_mm
                        );

                        const Hrel = mul4(initialCamHInv, Hc);
                        const originWF4 = mul4Vec(Hrel, [0,0,0,1]);
                        const originWF = { x: originWF4[0], y: originWF4[1], z: originWF4[2] };

                        const Rrel = [
                            [Hrel[0][0], Hrel[0][1], Hrel[0][2]],
                            [Hrel[1][0], Hrel[1][1], Hrel[1][2]],
                            [Hrel[2][0], Hrel[2][1], Hrel[2][2]]
                        ];
                        let dir_world = matMulVec(Rrel, dir_cam);
                        const normW = Math.hypot(dir_world[0], dir_world[1], dir_world[2]) || 1;
                        dir_world = [dir_world[0]/normW, dir_world[1]/normW, dir_world[2]/normW];

                        rotatedCount++;
                        rotatedCountEl.textContent = rotatedCount.toString();

                        const rayWorld = {
                            origin: originWF,
                            direction: { dx: dir_world[0], dy: dir_world[1], dz: dir_world[2] }
                        };

                        raysLog.push(rayWorld);
                        raysCount++;
                        raysCountEl.textContent = raysCount.toString();

                        pendingRaysForTriang.push(rayWorld);

                        if (nRaysRequired && pendingRaysForTriang.length >= nRaysRequired) {
                            const subset = pendingRaysForTriang.slice(0, nRaysRequired);
                            const tri = triangulateRaysWorld(subset);
                            if (tri) {
                                // aplicar translação de calibração (origemCal) como antes
                                let triTranslated = tri;
                                if (isCalibrated && originCalX !== null && originCalY !== null && calibrationZ_mm && pixelPerMM_locked) {
                                    const f_cal = pixelPerMM_locked * calibrationZ_mm;
                                    const cx_cal = canvas.width / 2;
                                    const cy_cal = canvas.height / 2;

                                    const originCamX = (originCalX - cx_cal) / f_cal * calibrationZ_mm;
                                    const originCamY = (originCalY - cy_cal) / f_cal * calibrationZ_mm;
                                    const originCamZ = calibrationZ_mm;

                                    triTranslated = {
                                        x: tri.x - originCamX,
                                        y: tri.y - originCamY,
                                        z: tri.z - originCamZ
                                    };
                                }

                                // agregar candidato (usar timestamp)
                                const accepted = acceptTriCandidate({ x: triTranslated.x, y: triTranslated.y, z: triTranslated.z, t: Date.now() });

                                if (accepted) {
                                    // accepted is averaged and filtered point in world-fixed coordinates translated by originCam
                                    // aplicar regra do primeiro triangulado como origem fixa
                                    if (originTriPoint === null) {
                                        originTriPoint = { x: accepted.x, y: accepted.y, z: accepted.z };
                                        const relativeZero = { x:0, y:0, z:0 };
                                        triangulatedPoints.push(relativeZero);
                                        triangulatedCount++;
                                        triangulatedCountEl.textContent = triangulatedCount.toString();
                                        if (isRecording) { pointCloud.push(relativeZero); drawMiniCloud(); }
                                    } else {
                                        const rel = {
                                            x: accepted.x - originTriPoint.x,
                                            y: accepted.y - originTriPoint.y,
                                            z: accepted.z - originTriPoint.z
                                        };
                                        triangulatedPoints.push(rel);
                                        triangulatedCount++;
                                        triangulatedCountEl.textContent = triangulatedCount.toString();
                                        if (isRecording) { pointCloud.push(rel); drawMiniCloud(); }
                                    }

                                    // highlight breve
                                    if (typeof redCx === "number" && typeof redCy === "number") {
                                        tempHighlights.push({ x: redCx, y: redCy, expireAt: Date.now() + 300 });
                                    }
                                }
                            }
                            pendingRaysForTriang = pendingRaysForTriang.slice(nRaysRequired);
                        }
                    }
                }
            }
        }

        drawTempHighlights();

        // média das distâncias observadas (em pixels)
        let avgPx = null;
        if (nDist > 0) {
            avgPx = (distBlue + distGreen) / nDist;
            lastAvgPx = avgPx;
        } else {
            lastAvgPx = null;
        }

        // escala px/mm
        if (!isCalibrated) {
            if (avgPx && avgPx > 0) {
                pixelPerMM_current = avgPx / 100;
                scaleEl.textContent = pixelPerMM_current.toFixed(3);
                scaleLockEl.textContent = "aberta";
            } else {
                pixelPerMM_current = 0;
                scaleEl.textContent = "-";
                scaleLockEl.textContent = "aberta";
            }
        } else {
            scaleEl.textContent = (pixelPerMM_locked !== null) ? pixelPerMM_locked.toFixed(3) : "-";
            scaleLockEl.textContent = "travada";
        }

        // calcular +Z se calibrado (usando média móvel para estabilidade)
        let smoothPose = getSmoothedPose();
        let zCamera = null;
        if (isCalibrated && lastAvgPx && lastAvgPx > 0 && calibration_px && calibrationZ_mm) {
            zCamera = calibrationZ_mm * (calibration_px / lastAvgPx);
            zCameraEl.textContent = zCamera.toFixed(2);
            cameraZ_mm = zCamera;
        } else {
            zCameraEl.textContent = "-";
            cameraZ_mm = null;
        }

        // desenhar setas com comprimento correspondente a 100 mm
        const effectivePixelPerMM = (isCalibrated && pixelPerMM_locked !== null) ? pixelPerMM_locked : pixelPerMM_current;

        let exX = null, exY = null, eyX = null, eyY = null, cornerX = null, cornerY = null;

        if (cb && effectivePixelPerMM > 0) {
            const desiredPx = effectivePixelPerMM * 100;

            if (cbl) {
                let dx = bx - ox;
                let dy = by - oy;
                let norm = Math.hypot(dx, dy);
                if (norm > 0) {
                    exX = ox + (dx / norm) * desiredPx;
                    exY = oy + (dy / norm) * desiredPx;
                    drawArrow(ox, oy, exX, exY, "blue");
                }
            }

            if (cgr) {
                let dx2 = gx - ox;
                let dy2 = gy - oy;
                let norm2 = Math.hypot(dx2, dy2);
                if (norm2 > 0) {
                    eyX = ox + (dx2 / norm2) * desiredPx;
                    eyY = oy + (dy2 / norm2) * desiredPx;
                    drawArrow(ox, oy, eyX, eyY, "green");
                }
            }
        }

        if (isRecording && cb && exX !== null && eyX !== null) {
            cornerX = exX + eyX - ox;
            cornerY = exY + eyY - oy;

            ctx.save();
            ctx.fillStyle = 'rgba(173,216,230,0.35)';
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(exX, exY);
            ctx.lineTo(cornerX, cornerY);
            ctx.lineTo(eyX, eyY);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = 'rgba(173,216,230,0.9)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(exX, exY);
            ctx.lineTo(cornerX, cornerY);
            ctx.lineTo(eyX, eyY);
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }

        // translação da câmera em +X e +Y após calibração (usando média móvel para origemCal comparada à origem atual)
        if (isCalibrated && pixelPerMM_locked && originCalX !== null && originCalY !== null && currentOriginX !== null) {
            // usar origem suavizada se disponível
            const smooth = getSmoothedPose();
            const curOriginX = (smooth && smooth.originX !== null) ? smooth.originX : currentOriginX;
            const curOriginY = (smooth && smooth.originY !== null) ? smooth.originY : currentOriginY;

            const delta_px_x = originCalX - curOriginX;
            const delta_px_y = curOriginY - originCalY;

            const dx_mm_image = delta_px_x / pixelPerMM_locked;
            const dy_mm_image = delta_px_y / pixelPerMM_locked;

            const camVec = [dx_mm_image, dy_mm_image, 0];

            const R = getRotationMatrix(
                (smooth && smooth.yaw !== null) ? smooth.yaw : yaw,
                (smooth && smooth.pitch !== null) ? smooth.pitch : pitch,
                (smooth && smooth.roll !== null) ? smooth.roll : roll
            );
            const worldVec = matMulVec(R, camVec);

            cameraX_mm = worldVec[0];
            cameraY_mm = worldVec[1];

            xCameraEl.textContent = cameraX_mm.toFixed(2);
            yCameraEl.textContent = cameraY_mm.toFixed(2);
        } else {
            xCameraEl.textContent = "-";
            yCameraEl.textContent = "-";
        }

        if (isCalibrated && cameraZ_mm !== null) {
            const camVecZ = [0, 0, cameraZ_mm];
            const R2 = getRotationMatrix(yaw, pitch, roll);
            const worldZVec = matMulVec(R2, camVecZ);
            zWorldEl.textContent = worldZVec[2].toFixed(2);
        } else {
            zWorldEl.textContent = "-";
        }

        if (isRecording) {
            const record = {
                t: Date.now(),
                x_mm: (typeof cameraX_mm === "number") ? cameraX_mm : null,
                y_mm: (typeof cameraY_mm === "number") ? cameraY_mm : null,
                z_mm: (typeof cameraZ_mm === "number") ? cameraZ_mm : null,
                pitch: pitch,
                yaw: yaw,
                roll: roll
            };
            calibrationLog.push(record);
        }
    }

    requestAnimationFrame(processFrame);
}
