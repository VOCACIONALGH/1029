/* main.js
   Atualização solicitada:
   - Durante a calibragem, os vetores de direção (directions) dos raios são rotacionados
     pela pose da câmera (pitch, yaw, roll) para serem expressos no referencial do mundo
     (referencial fixo dos pixels pretos triangulados). Os raios continuam com origem na câmera.
   - Nenhuma outra função foi alterada.
*/

/* ---------- elementos DOM ---------- */
const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadCloudBtn = document.getElementById("downloadCloudBtn");

const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// mini canvas para visualização rápida da nuvem
const miniCanvas = document.getElementById("miniCloud");
const miniCtx = miniCanvas ? miniCanvas.getContext("2d") : null;

const redCountDisplay = document.getElementById("redCount");
const blackRegisteredCountDisplay = document.getElementById("blackRegisteredCount");
const rayCountDisplay = document.getElementById("rayCount");
const dirCountDisplay = document.getElementById("dirCount");
const triangulatedCountDisplay = document.getElementById("triangulatedCount");
const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");
const scaleEl = document.getElementById("scaleValue");
const zEl = document.getElementById("zValue");
const xEl = document.getElementById("xValue");
const yEl = document.getElementById("yValue");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

const ARROW_LENGTH_MM = 100;

/* ---------- estado da calibração ---------- */
let baseZmm = 0;
let lockedScale = 0;
let basePixelDistance = 0;
let baseOriginScreen = null;
let isCalibrated = false;

let isCalibrating = false;
let calibrationFrames = [];

let lastRcentroid = null;
let lastBcentroid = null;
let lastGcentroid = null;

let currentScale = 0;

let baseVecX_px = null;
let baseVecY_px = null;
let baseVecSet = false;

let cumulativeBlackPoints = [];
let blackDetectCounter = 0;

let cumulativeRaysCount = 0;
let cumulativeDirCount = 0;

const raysByKey = new Map();
const triangulatedPointsByKey = new Map();
let cumulativeTriangulatedCount = 0;
let triangulatedCloud = [];

/* ---------- Inicialização da câmera ---------- */
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

            if (miniCanvas) {
                miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
            }

            requestAnimationFrame(processFrame);
        }, { once: true });
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
});

/* ---------- comportamento do botão Calibrar (mantido) ---------- */
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

        baseVecX_px = null;
        baseVecY_px = null;
        baseVecSet = false;
        cumulativeBlackPoints = [];

        blackDetectCounter = 0;

        raysByKey.clear();
        triangulatedPointsByKey.clear();
        triangulatedCloud = [];
        cumulativeTriangulatedCount = 0;
        cumulativeRaysCount = 0;
        cumulativeDirCount = 0;

        isCalibrating = true;
        calibrationFrames = [];

        downloadCloudBtn.hidden = false;
        downloadCloudBtn.style.display = 'inline-block';

        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        xEl.textContent = "0.00";
        yEl.textContent = "0.00";
        blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;
        rayCountDisplay.textContent = `Raios definidos (cumulativo): ${cumulativeRaysCount}`;
        dirCountDisplay.textContent = `Pixels pretos com direção definida: ${cumulativeDirCount}`;
        triangulatedCountDisplay.textContent = `Pixels pretos com posição 3D: ${cumulativeTriangulatedCount}`;

        alert("Calibragem iniciada. Mova a câmera para coletar dados e clique em 'Calibrar' novamente para finalizar e baixar o arquivo .json.");
        return;
    }

    if (isCalibrating) {
        isCalibrating = false;

        if (calibrationFrames.length === 0) {
            alert("Nenhum frame coletado durante a calibragem.");
            return;
        }

        const triangulated_points = triangulatedCloud.map(p => ({
            x_mm: Number(p.x_mm.toFixed(6)),
            y_mm: Number(p.y_mm.toFixed(6)),
            z_mm: Number(p.z_mm.toFixed(6)),
            num_rays: p.num_rays,
            timestamp: p.timestamp
        }));

        const payload = {
            createdAt: new Date().toISOString(),
            baseZmm,
            lockedScale,
            baseOriginScreen,
            frames: calibrationFrames,
            black_points: cumulativeBlackPoints,
            triangulated_points
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

        downloadCloudBtn.hidden = true;
        downloadCloudBtn.style.display = 'none';

        alert(`Calibragem finalizada. Arquivo "${filename}" baixado.`);
        return;
    }
});

/* ---------- download live ---------- */
downloadCloudBtn.addEventListener('click', () => {
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `nuvem_triangulada_${now}.json`;
    const blob = new Blob([JSON.stringify(triangulatedCloud, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
});

/* ---------- utilitários de cor e detecção (mantidos) ---------- */
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

/* ---------- desenho de setas/planos (mantido) ---------- */
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

function computeArrowTip(cx, cy, dx, dy, lengthPx) {
    const mag = Math.hypot(dx, dy);
    if (!mag) return null;
    const ux = dx / mag;
    const uy = dy / mag;
    return { x: cx + ux * lengthPx, y: cy + uy * lengthPx, ux, uy };
}

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

/* ---------- normalização ---------- */
function normalizeVec(v) {
    const mag = Math.hypot(v.x, v.y, v.z);
    if (mag === 0) return { x: 0, y: 0, z: 0 };
    return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

/* ---------- pinhole approximation (mantido) ---------- */
function computePinholeDirectionForPixel(pixelX, pixelY) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const f_px = Math.max(canvas.width, canvas.height) * 0.8; // aproximação
    const x_cam = (pixelX - cx) / f_px;
    const y_cam = (pixelY - cy) / f_px;
    const z_cam = 1;
    const dir = normalizeVec({ x: x_cam, y: y_cam, z: z_cam });
    return dir;
}

/* ---------- triangulação (mantido) ---------- */
function triangulateRaysLeastSquares(rays) {
    let A = [[0,0,0],[0,0,0],[0,0,0]];
    let b = [0,0,0];

    for (let i = 0; i < rays.length; i++) {
        const p = rays[i].origin;
        const u = rays[i].dir;
        const uuT = [
            [u.x * u.x, u.x * u.y, u.x * u.z],
            [u.y * u.x, u.y * u.y, u.y * u.z],
            [u.z * u.x, u.z * u.y, u.z * u.z]
        ];
        const M = [
            [1 - uuT[0][0], -uuT[0][1], -uuT[0][2]],
            [-uuT[1][0], 1 - uuT[1][1], -uuT[1][2]],
            [-uuT[2][0], -uuT[2][1], 1 - uuT[2][2]]
        ];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                A[r][c] += M[r][c];
            }
        }
        b[0] += M[0][0]*p.x + M[0][1]*p.y + M[0][2]*p.z;
        b[1] += M[1][0]*p.x + M[1][1]*p.y + M[1][2]*p.z;
        b[2] += M[2][0]*p.x + M[2][1]*p.y + M[2][2]*p.z;
    }

    const detA = determinant3(A);
    if (Math.abs(detA) < 1e-12) return null;
    const invA = invert3(A);
    const X = {
        x: invA[0][0]*b[0] + invA[0][1]*b[1] + invA[0][2]*b[2],
        y: invA[1][0]*b[0] + invA[1][1]*b[1] + invA[1][2]*b[2],
        z: invA[2][0]*b[0] + invA[2][1]*b[1] + invA[2][2]*b[2]
    };
    return X;
}

function determinant3(m) {
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
         - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
         + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
}

function invert3(m) {
    const det = determinant3(m);
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    const a = m;
    const inv = [
        [
            (a[1][1]*a[2][2]-a[1][2]*a[2][1]) * invDet,
            (a[0][2]*a[2][1]-a[0][1]*a[2][2]) * invDet,
            (a[0][1]*a[1][2]-a[0][2]*a[1][1]) * invDet
        ],
        [
            (a[1][2]*a[2][0]-a[1][0]*a[2][2]) * invDet,
            (a[0][0]*a[2][2]-a[0][2]*a[2][0]) * invDet,
            (a[0][2]*a[1][0]-a[0][0]*a[1][2]) * invDet
        ],
        [
            (a[1][0]*a[2][1]-a[1][1]*a[2][0]) * invDet,
            (a[0][1]*a[2][0]-a[0][0]*a[2][1]) * invDet,
            (a[0][0]*a[1][1]-a[0][1]*a[1][0]) * invDet
        ]
    ];
    return inv;
}

/* ---------- bins de chave ---------- */
function keyFromXY(x_mm, y_mm) {
    const binSize = 0.5;
    const kx = Math.round(x_mm / binSize);
    const ky = Math.round(y_mm / binSize);
    return `${kx}_${ky}`;
}

/* ---------- mini-cloud (mantido) ---------- */
function drawMiniCloud() {
    if (!miniCtx) return;
    miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);

    if (triangulatedCloud.length === 0) {
        miniCtx.fillStyle = "rgba(255,255,255,0.03)";
        for (let i = 0; i < 5; i++) {
            miniCtx.fillRect(i * (miniCanvas.width / 5), miniCanvas.height / 2, 1, 1);
        }
        return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < triangulatedCloud.length; i++) {
        const p = triangulatedCloud[i];
        if (!isFinite(p.x_mm) || !isFinite(p.y_mm)) continue;
        if (p.x_mm < minX) minX = p.x_mm;
        if (p.x_mm > maxX) maxX = p.x_mm;
        if (p.y_mm < minY) minY = p.y_mm;
        if (p.y_mm > maxY) maxY = p.y_mm;
    }
    if (minX === Infinity) return;

    const padX = (maxX - minX) * 0.08 || 1;
    const padY = (maxY - minY) * 0.08 || 1;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;

    const rangeX = maxX - minX;
    const rangeY = maxY - minY;
    const w = miniCanvas.width;
    const h = miniCanvas.height;

    for (let i = 0; i < triangulatedCloud.length; i++) {
        const p = triangulatedCloud[i];
        if (!isFinite(p.x_mm) || !isFinite(p.y_mm)) continue;
        const nx = (p.x_mm - minX) / rangeX;
        const ny = (p.y_mm - minY) / rangeY;
        const px = Math.round(nx * (w - 4) + 2);
        const py = Math.round((1 - ny) * (h - 4) + 2);

        miniCtx.fillStyle = "rgba(255,182,193,0.95)";
        miniCtx.fillRect(px, py, 2, 2);
    }
}

/* ---------- desenho dos pontos triangulados no canvas principal (mantido) ---------- */
function drawTriangulatedOnMain(screenX, screenY) {
    if (!screenX || !screenY) return;
    ctx.save();
    ctx.fillStyle = "rgba(255,182,193,0.95)";
    ctx.beginPath();
    ctx.arc(screenX, screenY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

/* ---------- NOVO: rotação do vetor de direção pela pose da câmera ---------- */
/*
  Convenções usadas:
  - Vetor de entrada 'dir' está no referencial da câmera (x: direita, y: down, z: forward).
  - Os ângulos recebidos (pitch, yaw, roll) vêm dos elementos de UI (deviceorientation),
    já em graus. São convertidos para radianos aqui.
  - Ordem de rotação escolhida (multiplicação de matrizes): R = Rz(yaw) * Rx(pitch) * Ry(roll)
    (ou seja: aplica-se roll em Y, depois pitch em X, depois yaw em Z — ao vetor do sistema da câmera).
    Essa ordem foi escolhida por coerência com os eixos expostos (alpha= yaw ~Z, beta= pitch ~X, gamma= roll ~Y).
    Se for necessário um comportamento diferente, é fácil trocar a ordem.
  - Depois de rotacionado, normalizamos o vetor e retornamos.
*/
function deg2rad(deg) {
    return deg * Math.PI / 180;
}

function matMulVec3(m, v) {
    return {
        x: m[0][0]*v.x + m[0][1]*v.y + m[0][2]*v.z,
        y: m[1][0]*v.x + m[1][1]*v.y + m[1][2]*v.z,
        z: m[2][0]*v.x + m[2][1]*v.y + m[2][2]*v.z
    };
}

function rotationMatrixFromEuler(pitch_deg, yaw_deg, roll_deg) {
    const px = deg2rad(pitch_deg || 0);
    const py = deg2rad(yaw_deg || 0);
    const pr = deg2rad(roll_deg || 0);

    // Rx (pitch about X)
    const Rx = [
        [1, 0, 0],
        [0, Math.cos(px), -Math.sin(px)],
        [0, Math.sin(px),  Math.cos(px)]
    ];

    // Ry (roll about Y)
    const Ry = [
        [ Math.cos(pr), 0, Math.sin(pr)],
        [ 0,            1, 0],
        [-Math.sin(pr), 0, Math.cos(pr)]
    ];

    // Rz (yaw about Z)
    const Rz = [
        [Math.cos(py), -Math.sin(py), 0],
        [Math.sin(py),  Math.cos(py), 0],
        [0, 0, 1]
    ];

    // Combined R = Rz * Rx * Ry
    // first compute A = Rx * Ry
    const A = multiplyMatrix3(Rx, Ry);
    const R = multiplyMatrix3(Rz, A);
    return R;
}

function multiplyMatrix3(A, B) {
    const C = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
            C[i][j] = s;
        }
    }
    return C;
}

function rotateVecByCameraPose(dir_cam, pitch_deg, yaw_deg, roll_deg) {
    // handle nulls gracefully
    const pitch = Number(pitch_deg) || 0;
    const yaw = Number(yaw_deg) || 0;
    const roll = Number(roll_deg) || 0;

    const R = rotationMatrixFromEuler(pitch, yaw, roll);
    const vWorld = matMulVec3(R, dir_cam);
    return normalizeVec(vWorld);
}

/* ---------- loop principal de processamento de frames (mantido, com o ponto de rotação adicionado) ---------- */
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

    const blackPixels = [];

    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];

        const { h, s, v } = rgbToHsv(r, g, b);
        if (s < 0.35 || v < 0.12) {
            // skip color-based detections
        } else {
            const p = i / 4, x = p % canvas.width, y = (p / canvas.width) | 0;

            if (hueDistance(h, 0) <= rTol) {
                rC++; rX += x; rY += y;
                d[i] = 255; d[i + 1] = 165; d[i + 2] = 0;
            } else if (hueDistance(h, 230) <= bTol) {
                bC++; bX += x; bY += y;
                d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
            } else if (hueDistance(h, 120) <= gTol) {
                gC++; gX += x; gY += y;
                d[i] = 160; d[i + 1] = 32; d[i + 2] = 240;
            }
        }

        const BLACK_THR = 30;
        if (isCalibrating && r < BLACK_THR && g < BLACK_THR && b < BLACK_THR) {
            d[i] = 255;
            d[i + 1] = 0;
            d[i + 2] = 0;

            const p = i / 4, x = p % canvas.width, y = (p / canvas.width) | 0;
            blackPixels.push({ x, y });
        }
    }

    ctx.putImageData(img, 0, 0);

    let r = null, b = null, g = null;

    if (rC) {
        r = { x: rX / rC, y: rY / rC };
        lastRcentroid = r;
    } else {
        lastRcentroid = null;
    }

    if (bC) {
        b = { x: bX / bC, y: bY / bC };
        lastBcentroid = b;
    }

    if (gC) {
        g = { x: gX / gC, y: gY / gC };
        lastGcentroid = g;
    }

    let currentPixelDistance = 0;
    if (r && b) {
        currentPixelDistance = Math.hypot(b.x - r.x, b.y - r.y);
        currentScale = currentPixelDistance / ARROW_LENGTH_MM; // px/mm
        if (!isCalibrated) {
            scaleEl.textContent = currentScale.toFixed(3);
        } else {
            scaleEl.textContent = lockedScale.toFixed(3);
        }
    }

    if (isCalibrating && !baseVecSet && isCalibrated && lastRcentroid && lastBcentroid && lastGcentroid && lockedScale) {
        const dxB = lastBcentroid.x - lastRcentroid.x;
        const dyB = lastBcentroid.y - lastRcentroid.y;
        const magB = Math.hypot(dxB, dyB);

        const dxG = lastGcentroid.x - lastRcentroid.x;
        const dyG = lastGcentroid.y - lastRcentroid.y;
        const magG = Math.hypot(dxG, dyG);

        if (magB > 5 && magG > 5) {
            const ux = { x: dxB / magB, y: dyB / magB };
            const uy = { x: dxG / magG, y: dyG / magG };

            baseVecX_px = { x: ux.x * lockedScale, y: ux.y * lockedScale };
            baseVecY_px = { x: uy.x * lockedScale, y: uy.y * lockedScale };
            baseVecSet = true;
        }
    }

    if (isCalibrating && r && b && g) {
        const scaleUsed = isCalibrated ? lockedScale : currentScale;
        const lengthPx = ARROW_LENGTH_MM * scaleUsed;

        const tipX = computeArrowTip(r.x, r.y, b.x - r.x, b.y - r.y, lengthPx);
        const tipY = computeArrowTip(r.x, r.y, g.x - r.x, g.y - r.y, lengthPx);

        if (tipX && tipY) {
            drawPlanePolygon(r, tipX, tipY);
        }
    }

    if (r) {
        ctx.fillStyle = "red";
        ctx.beginPath(); ctx.arc(r.x, r.y, 6, 0, Math.PI * 2); ctx.fill();
    }
    if (b) {
        ctx.fillStyle = "blue";
        ctx.beginPath(); ctx.arc(b.x, b.y, 6, 0, Math.PI * 2); ctx.fill();
    }
    if (g) {
        ctx.fillStyle = "green";
        ctx.beginPath(); ctx.arc(g.x, g.y, 6, 0, Math.PI * 2); ctx.fill();
    }

    const scaleForArrows = isCalibrated ? lockedScale : currentScale;
    if (r && b && scaleForArrows) {
        drawArrowFromCenter(r.x, r.y, b.x - r.x, b.y - r.y, ARROW_LENGTH_MM * scaleForArrows, "blue");
    }
    if (r && g && scaleForArrows) {
        drawArrowFromCenter(r.x, r.y, g.x - r.x, g.y - r.y, ARROW_LENGTH_MM * scaleForArrows, "green");
    }

    let computedZ = null;
    if (isCalibrated && currentPixelDistance) {
        const dzMm = (basePixelDistance - currentPixelDistance) / lockedScale;
        computedZ = baseZmm + dzMm;
        zEl.textContent = computedZ.toFixed(2);
    } else {
        if (!isCalibrated) zEl.textContent = "0.00";
        else zEl.textContent = baseZmm.toFixed(2);
    }

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

    if (isCalibrating) {
        const pitch = parseFloat(pitchEl.textContent) || 0;
        const yaw = parseFloat(yawEl.textContent) || 0;
        const roll = parseFloat(rollEl.textContent) || 0;

        const record = {
            timestamp: new Date().toISOString(),
            x_mm: txMm !== null ? Number(txMm.toFixed(4)) : null,
            y_mm: tyMm !== null ? Number(tyMm.toFixed(4)) : null,
            z_mm: computedZ !== null ? Number(computedZ.toFixed(4)) : null,
            pitch_deg: Number(pitch.toFixed(3)),
            yaw_deg: Number(yaw.toFixed(3)),
            roll_deg: Number(roll.toFixed(3))
        };
        calibrationFrames.push(record);
    }

    // MAPPING + REGISTRO + TRIANGULAÇÃO (adicionada rotação dos vetores de direção)
    if (isCalibrating && baseVecSet && baseOriginScreen && blackPixels.length > 0) {
        const ux = baseVecX_px;
        const uy = baseVecY_px;
        const a = ux.x, b_ = uy.x, c = ux.y, d = uy.y;
        const det = a * d - b_ * c;
        if (Math.abs(det) > 1e-9) {
            const inv00 = d / det;
            const inv01 = -b_ / det;
            const inv10 = -c / det;
            const inv11 = a / det;

            const poseXmm = (function() {
                if (isCalibrated && lastRcentroid && baseOriginScreen) {
                    const dxPixels = lastRcentroid.x - baseOriginScreen.x;
                    const dyPixels = lastRcentroid.y - baseOriginScreen.y;
                    const tx = -(dxPixels) / lockedScale;
                    const ty = (dyPixels) / lockedScale;
                    return { x_mm: Number(tx.toFixed(4)), y_mm: Number(ty.toFixed(4)) };
                }
                return { x_mm: null, y_mm: null };
            })();

            const poseZmm = (isCalibrated && currentPixelDistance) ? Number((computedZ !== null ? computedZ : baseZmm).toFixed(4)) : (isCalibrated ? Number(baseZmm.toFixed(4)) : null);

            // read pose angles for rotation of direction vectors
            const pitch = parseFloat(pitchEl.textContent) || 0;
            const yaw = parseFloat(yawEl.textContent) || 0;
            const roll = parseFloat(rollEl.textContent) || 0;

            const timestampNow = new Date().toISOString();

            for (let k = 0; k < blackPixels.length; k++) {
                const p = blackPixels[k];
                const vx = p.x - baseOriginScreen.x;
                const vy = p.y - baseOriginScreen.y;

                const x_mm = inv00 * vx + inv01 * vy;
                const y_mm = inv10 * vx + inv11 * vy;

                if (isFinite(x_mm) && !isNaN(x_mm) && isFinite(y_mm) && !isNaN(y_mm)) {
                    blackDetectCounter++;
                    if ((blackDetectCounter % 10) === 0) {
                        // direção no referencial da câmera (pinhole)
                        const dir_cam = computePinholeDirectionForPixel(p.x, p.y);

                        // ROTACIONA direção da câmera para o referencial do mundo usando a pose atual
                        const dir_world = rotateVecByCameraPose(dir_cam, pitch, yaw, roll);

                        cumulativeBlackPoints.push({
                            x_mm: Number(x_mm.toFixed(4)),
                            y_mm: Number(y_mm.toFixed(4)),
                            timestamp: timestampNow,
                            camera_pose: {
                                x_mm: poseXmm.x_mm,
                                y_mm: poseXmm.y_mm,
                                z_mm: poseZmm,
                                pitch_deg: Number(pitch.toFixed(3)),
                                yaw_deg: Number(yaw.toFixed(3)),
                                roll_deg: Number(roll.toFixed(3))
                            },
                            // armazenamos a direção já transformada para o referencial do mundo
                            direction_cam: {
                                dx: Number(dir_world.x.toFixed(6)),
                                dy: Number(dir_world.y.toFixed(6)),
                                dz: Number(dir_world.z.toFixed(6))
                            }
                        });

                        cumulativeRaysCount++;
                        cumulativeDirCount++;

                        // origem do raio continua sendo a pose da câmera (em mm)
                        const origin = { x: poseXmm.x_mm, y: poseXmm.y_mm, z: poseZmm };

                        // o raio usa agora a direção rotacionada (referencial do mundo)
                        const ray = { origin, dir: dir_world, timestamp: timestampNow, pixel: { x: p.x, y: p.y } };

                        const key = keyFromXY(x_mm, y_mm);

                        if (!raysByKey.has(key)) raysByKey.set(key, []);
                        raysByKey.get(key).push(ray);

                        const raysForKey = raysByKey.get(key);
                        if (raysForKey.length >= 2 && !triangulatedPointsByKey.has(key)) {
                            const X = triangulateRaysLeastSquares(raysForKey);
                            if (X) {
                                triangulatedPointsByKey.set(key, {
                                    x: X.x,
                                    y: X.y,
                                    z: X.z,
                                    num_rays: raysForKey.length,
                                    timestamp: new Date().toISOString()
                                });

                                let sumSX = 0, sumSY = 0, cntS = 0;
                                for (let ri = 0; ri < raysForKey.length; ri++) {
                                    if (raysForKey[ri].pixel) {
                                        sumSX += raysForKey[ri].pixel.x;
                                        sumSY += raysForKey[ri].pixel.y;
                                        cntS++;
                                    }
                                }
                                let repScreenX = null, repScreenY = null;
                                if (cntS > 0) {
                                    repScreenX = sumSX / cntS;
                                    repScreenY = sumSY / cntS;
                                }

                                triangulatedCloud.push({
                                    x_mm: X.x,
                                    y_mm: X.y,
                                    z_mm: X.z,
                                    num_rays: raysForKey.length,
                                    timestamp: new Date().toISOString(),
                                    screen_x: repScreenX,
                                    screen_y: repScreenY
                                });

                                if (repScreenX !== null && repScreenY !== null) {
                                    drawTriangulatedOnMain(repScreenX, repScreenY);
                                }

                                cumulativeTriangulatedCount++;
                            }
                        }
                    }
                }
            }
        }
    }

    if (isCalibrating) {
        drawMiniCloud();
    }

    // atualizações visuais
    blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;
    rayCountDisplay.textContent = `Raios definidos (cumulativo): ${cumulativeRaysCount}`;
    dirCountDisplay.textContent = `Pixels pretos com direção definida: ${cumulativeDirCount}`;
    triangulatedCountDisplay.textContent = `Pixels pretos com posição 3D: ${cumulativeTriangulatedCount}`;

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
