/* main.js
   Atualização: durante a calibragem, o programa triangula posições 3D reais de pixels pretos registrados
   usando múltiplos raios (de diferentes poses). A contagem cumulativa de pixels com posição 3D determinada
   é atualizada na tela e os pontos triangulados são incluídos no arquivo .json final.
   Nenhuma outra funcionalidade foi alterada.
*/

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");

const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

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

// calibration / locking state
let baseZmm = 0;
let lockedScale = 0;           // px per mm locked at calibration
let basePixelDistance = 0;     // calibrated arrow length in px (ARROW_LENGTH_MM * lockedScale)
let baseOriginScreen = null;   // {x,y} of origin in screen coords at calibration
let isCalibrated = false;

// calibragem ativa (coleta de frames)
let isCalibrating = false;
let calibrationFrames = []; // array of frame objects saved during calibragem

// last centroids
let lastRcentroid = null;     // {x,y} of last detected red centroid
let lastBcentroid = null;
let lastGcentroid = null;

let currentScale = 0;         // px/mm live estimate (before locking)

// base vectors (px per mm) used to map pixels -> XY mm durante calibragem
let baseVecX_px = null; // {x,y} px per mm along X-axis
let baseVecY_px = null; // {x,y} px per mm along Y-axis
let baseVecSet = false;

// cumulative registered black points across the whole calibration session
// Each entry: { x_mm, y_mm, timestamp, camera_pose: {...}, direction_cam: {dx,dy,dz} }
let cumulativeBlackPoints = [];

// COUNTER: increment for every black pixel detected; only register when counter % 10 === 0
let blackDetectCounter = 0;

// cumulative rays/directions counts
let cumulativeRaysCount = 0;
let cumulativeDirCount = 0;

// triangulation structures:
// map from spatial bin key -> array of rays { origin:{x,y,z}, dir:{x,y,z}, timestamp }
// when >=2 rays available for a key, try triangulation and store in triangulatedPointsByKey
const raysByKey = new Map();
const triangulatedPointsByKey = new Map(); // key -> { x,y,z, num_rays, timestamp }
let cumulativeTriangulatedCount = 0;

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

/*
 Calibrar button behavior:
 - If not atualmente calibrating: valida origem & escala, solicita +Z, trava escala, registra origem e inicia coleta (isCalibrating = true).
 - Se estiver calibrando: finaliza, gera JSON com frames + black_points + triangulated_points e faz download.
*/
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

        // lock calibration parameters
        baseZmm = z;
        lockedScale = currentScale; // px per mm locked now
        basePixelDistance = ARROW_LENGTH_MM * lockedScale;
        baseOriginScreen = { x: lastRcentroid.x, y: lastRcentroid.y };
        isCalibrated = true;

        // reset base vectors and cumulative black points for a fresh calibration session
        baseVecX_px = null;
        baseVecY_px = null;
        baseVecSet = false;
        cumulativeBlackPoints = [];

        // reset black detection counter so sampling starts fresh
        blackDetectCounter = 0;

        // reset rays/triangulation structures
        raysByKey.clear();
        triangulatedPointsByKey.clear();
        cumulativeTriangulatedCount = 0;
        cumulativeRaysCount = 0;
        cumulativeDirCount = 0;

        // start collecting frames (calibragem ativa)
        isCalibrating = true;
        calibrationFrames = [];

        // display locked scale & base Z
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

    // finalize calibration if currently calibrating
    if (isCalibrating) {
        isCalibrating = false;

        if (calibrationFrames.length === 0) {
            alert("Nenhum frame coletado durante a calibragem.");
            return;
        }

        // build triangulated_points array from triangulatedPointsByKey
        const triangulated_points = [];
        triangulatedPointsByKey.forEach((v, key) => {
            triangulated_points.push({
                key,
                x_mm: Number(v.x.toFixed(6)),
                y_mm: Number(v.y.toFixed(6)),
                z_mm: Number(v.z.toFixed(6)),
                num_rays: v.num_rays,
                timestamp: v.timestamp
            });
        });

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

        alert(`Calibragem finalizada. Arquivo "${filename}" baixado.`);
        return;
    }
});

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

/* Helper to compute arrow tip without drawing */
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
    ctx.fillStyle = "rgba(173,216,230,0.4)"; // lightblue
    ctx.fill();
    ctx.restore();
}

function normalizeVec(v) {
    const mag = Math.hypot(v.x, v.y, v.z);
    if (mag === 0) return { x: 0, y: 0, z: 0 };
    return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

/* pinhole direction approximation:
   - principal point assumed at image center (cx,cy)
   - focal length (px) approximated as 0.8 * max(image width, height)
   - camera coordinate convention: z forward, x right, y down
*/
function computePinholeDirectionForPixel(pixelX, pixelY) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const f_px = Math.max(canvas.width, canvas.height) * 0.8; // approximation
    const x_cam = (pixelX - cx) / f_px;
    const y_cam = (pixelY - cy) / f_px;
    const z_cam = 1;
    const dir = normalizeVec({ x: x_cam, y: y_cam, z: z_cam });
    return dir;
}

/* triangulate from multiple rays using linear least squares:
   Solve for X minimizing sum ||(I - u u^T) (X - p)||^2
   Which yields: (sum (I - u u^T)) X = sum (I - u u^T) p
*/
function triangulateRaysLeastSquares(rays) {
    // rays: [{origin:{x,y,z}, dir:{x,y,z}}]
    // build A (3x3) and b (3)
    let A = [[0,0,0],[0,0,0],[0,0,0]];
    let b = [0,0,0];

    for (let i = 0; i < rays.length; i++) {
        const p = rays[i].origin;
        const u = rays[i].dir;
        // compute I - u u^T
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
        // accumulate A += M
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                A[r][c] += M[r][c];
            }
        }
        // accumulate b += M * p
        b[0] += M[0][0]*p.x + M[0][1]*p.y + M[0][2]*p.z;
        b[1] += M[1][0]*p.x + M[1][1]*p.y + M[1][2]*p.z;
        b[2] += M[2][0]*p.x + M[2][1]*p.y + M[2][2]*p.z;
    }

    // solve A x = b (3x3)
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

// generate binning key for near-equal XY to group same physical pixel across frames
function keyFromXY(x_mm, y_mm) {
    const binSize = 0.5; // mm bins (adjustable). Groups points within 0.5 mm
    const kx = Math.round(x_mm / binSize);
    const ky = Math.round(y_mm / binSize);
    return `${kx}_${ky}`;
}

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

    // collect black pixels coords during this frame (so we can map them after centroids/vectors are known)
    const blackPixels = [];

    // per-pixel detection + coloring
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

        // recolor visually pixels pretos para vermelho durante calibragem
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

    // compute live scale (px/mm) from red->blue if available
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

    // If calibragem ativa, try to set base vectors (only once) using the detected blue/green directions
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

    // Plane drawing durante calibragem
    if (isCalibrating && r && b && g) {
        const scaleUsed = isCalibrated ? lockedScale : currentScale;
        const lengthPx = ARROW_LENGTH_MM * scaleUsed;

        const tipX = computeArrowTip(r.x, r.y, b.x - r.x, b.y - r.y, lengthPx);
        const tipY = computeArrowTip(r.x, r.y, g.x - r.x, g.y - r.y, lengthPx);

        if (tipX && tipY) {
            drawPlanePolygon(r, tipX, tipY);
        }
    }

    // draw points and arrows
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

    // +Z calculation (uses lockedScale if calibrated)
    let computedZ = null;
    if (isCalibrated && currentPixelDistance) {
        const dzMm = (basePixelDistance - currentPixelDistance) / lockedScale; // smaller arrow px => larger +Z
        computedZ = baseZmm + dzMm;
        zEl.textContent = computedZ.toFixed(2);
    } else {
        if (!isCalibrated) zEl.textContent = "0.00";
        else zEl.textContent = baseZmm.toFixed(2);
    }

    // +X and +Y calculations (camera translation), only after calibration and if origin detected
    let txMm = null, tyMm = null;
    if (isCalibrated && lastRcentroid && baseOriginScreen) {
        const dxPixels = lastRcentroid.x - baseOriginScreen.x;
        const dyPixels = lastRcentroid.y - baseOriginScreen.y;

        const tx = -(dxPixels) / lockedScale;        // X: negative of origin movement
        const ty = (dyPixels) / lockedScale;         // Y: positive when origin moves down
        txMm = tx; tyMm = ty;

        xEl.textContent = txMm.toFixed(2);
        yEl.textContent = tyMm.toFixed(2);
    } else {
        if (!isCalibrated) { xEl.textContent = "0.00"; yEl.textContent = "0.00"; }
        else { xEl.textContent = "0.00"; yEl.textContent = "0.00"; }
    }

    // If calibragem ativa, save a frame record
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

    // ---- NEW: process blackPixels -> map to XY, register subset (1-in-10), compute pinhole direction, store ray and try triangulation ----
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

            // current camera pose for attachment
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
                        // compute pinhole direction for the screen pixel
                        const dir = computePinholeDirectionForPixel(p.x, p.y);

                        // register cumulative black point with direction_cam included
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
                            direction_cam: {
                                dx: Number(dir.x.toFixed(6)),
                                dy: Number(dir.y.toFixed(6)),
                                dz: Number(dir.z.toFixed(6))
                            }
                        });

                        cumulativeRaysCount++;
                        cumulativeDirCount++;

                        // form ray in world coordinates:
                        // origin = camera pose (x_mm, y_mm, z_mm)
                        const origin = { x: poseXmm.x_mm, y: poseXmm.y_mm, z: poseZmm };
                        const dirCam = dir; // in camera coords (approx). We assume camera axes aligned with world for this app.
                        // NOTE: using camera coords as world coords because we only have approximate pose translations; this matches previous approximations in the program.

                        const ray = { origin, dir: dirCam, timestamp: timestampNow };

                        // decide key to group same physical point across frames using XY binning
                        const key = keyFromXY(x_mm, y_mm);

                        if (!raysByKey.has(key)) raysByKey.set(key, []);
                        raysByKey.get(key).push(ray);

                        // attempt triangulation if we have at least 2 rays and not yet triangulated for this key
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
                                cumulativeTriangulatedCount++;
                            }
                        }
                    }
                }
            }
        }
    }

    // update cumulative counts on screen
    blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;
    rayCountDisplay.textContent = `Raios definidos (cumulativo): ${cumulativeRaysCount}`;
    dirCountDisplay.textContent = `Pixels pretos com direção definida: ${cumulativeDirCount}`;
    triangulatedCountDisplay.textContent = `Pixels pretos com posição 3D: ${cumulativeTriangulatedCount}`;
    // ---- end mapping & registration & triangulation logic ----

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
