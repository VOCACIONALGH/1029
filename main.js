/* main.js
   Atualização: durante a calibração, além das funções já existentes, o programa:
   - mantém em memória uma nuvem de pontos 3D (pontos triangulados com real_pos_mm)
   - exibe o botão "Download Nuvem (.json)" enquanto a calibração estiver ativa
   - ao clicar em Download, baixa um arquivo .json contendo a nuvem de pontos
   Mantive todas as demais funcionalidades inalteradas.
*/

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadBtn = document.getElementById("downloadBtn");

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
let calibrationFrames = []; // array of frame objects saved durante calibragem

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
// Each entry: { x_mm, y_mm, timestamp, camera_pose: {...}, direction_cam: {dx,dy,dz}, screen_x_px, screen_y_px, real_pos_mm? }
let cumulativeBlackPoints = [];

// COUNTER: increment for every black pixel detected; only register when counter % 10 === 0
let blackDetectCounter = 0;

// cumulative rays (kept for display/count). Each registered point also defines a ray; count maintained.
let cumulativeRaysCount = 0;

// cumulative count of points with direction defined (should increment when we add direction to a registered point)
let cumulativeDirCount = 0;

// triangulation bookkeeping
// real_pos_mm will be written into cumulativeBlackPoints entries when triangulated
let cumulativeTriangulatedCount = 0;

// point cloud in memory (unique triangulated points) to be downloaded
let pointCloud = [];

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
 - Se estiver calibrando: finaliza, gera JSON com frames + black_points (incluindo direction_cam e possivelmente real_pos_mm) e faz download.
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

        // reset cumulative rays and direction counts
        cumulativeRaysCount = 0;
        cumulativeDirCount = 0;
        cumulativeTriangulatedCount = 0;
        pointCloud = [];

        // start collecting frames (calibragem ativa)
        isCalibrating = true;
        calibrationFrames = [];

        // show download button while calibrating
        downloadBtn.style.display = 'inline-block';

        // display locked scale & base Z
        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        xEl.textContent = "0.00";
        yEl.textContent = "0.00";
        blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;
        rayCountDisplay.textContent = `Raios definidos (cumulativo): ${cumulativeRaysCount}`;
        dirCountDisplay.textContent = `Pixels pretos com direção definida: ${cumulativeDirCount}`;
        triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;

        alert("Calibragem iniciada. Mova a câmera para coletar dados e clique em 'Calibrar' novamente para finalizar e baixar o arquivo .json.");
        return;
    }

    // finalize calibration if currently calibrating
    if (isCalibrating) {
        isCalibrating = false;

        // hide download button when calibration ends
        downloadBtn.style.display = 'none';

        if (calibrationFrames.length === 0) {
            alert("Nenhum frame coletado durante a calibragem.");
            return;
        }

        const payload = {
            createdAt: new Date().toISOString(),
            baseZmm,
            lockedScale,
            baseOriginScreen,
            frames: calibrationFrames,
            black_points: cumulativeBlackPoints
            // black_points entries include direction_cam and, when available, real_pos_mm
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

downloadBtn.addEventListener('click', () => {
    // build point cloud payload (unique triangulated points)
    const payload = {
        createdAt: new Date().toISOString(),
        point_count: pointCloud.length,
        points: pointCloud // array of { x_mm, y_mm, z_mm, timestamp }
    };

    const filename = `nuvem_pontos_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
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

/* ... (rest of functions remain identical in behavior) ... */

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

/* deg -> rad */
function deg2rad(d) {
    return d * Math.PI / 180;
}

/* rotate vector by yaw (Z), pitch (X), roll (Y)
   Rotation applied as R = Rz(yaw) * Rx(pitch) * Ry(roll)
*/
function rotateVectorByYawPitchRoll(v, yawDeg, pitchDeg, rollDeg) {
    const y = deg2rad(yawDeg);
    const p = deg2rad(pitchDeg);
    const r = deg2rad(rollDeg);

    const cy = Math.cos(y), sy = Math.sin(y);
    const cp = Math.cos(p), sp = Math.sin(p);
    const cr = Math.cos(r), sr = Math.sin(r);

    // Combined rotation matrix R = Rz * Rx * Ry
    const R00 = cy * cr - sy * sp * sr;
    const R01 = -sy * cp;
    const R02 = cy * sr + sy * sp * cr;

    const R10 = sy * cr + cy * sp * sr;
    const R11 = cy * cp;
    const R12 = sy * sr - cy * sp * cr;

    const R20 = -cp * sr;
    const R21 = sp;
    const R22 = cp * cr;

    const x = R00 * v.x + R01 * v.y + R02 * v.z;
    const yv = R10 * v.x + R11 * v.y + R12 * v.z;
    const zv = R20 * v.x + R21 * v.y + R22 * v.z;

    return { x, y: yv, z: zv };
}

/* pinhole direction approximation:
   - principal point assumed at image center (cx,cy)
   - focal length (px) approximated as 0.8 * max(image width, height) (reasonable approximation)
   - camera coordinate convention: z forward, x to right, y down (direction vector normalized)
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

/* Solve 3x3 linear system A * x = b using analytic inverse (returns null if singular) */
function solve3x3(A, b) {
    // A is [[a00,a01,a02],[a10,a11,a12],[a20,a21,a22]]
    const a00 = A[0][0], a01 = A[0][1], a02 = A[0][2];
    const a10 = A[1][0], a11 = A[1][1], a12 = A[1][2];
    const a20 = A[2][0], a21 = A[2][1], a22 = A[2][2];

    const det =
        a00 * (a11 * a22 - a12 * a21) -
        a01 * (a10 * a22 - a12 * a20) +
        a02 * (a10 * a21 - a11 * a20);

    if (Math.abs(det) < 1e-9) return null;

    const invDet = 1 / det;

    const inv = [
        [
            (a11 * a22 - a12 * a21) * invDet,
            (a02 * a21 - a01 * a22) * invDet,
            (a01 * a12 - a02 * a11) * invDet
        ],
        [
            (a12 * a20 - a10 * a22) * invDet,
            (a00 * a22 - a02 * a20) * invDet,
            (a02 * a10 - a00 * a12) * invDet
        ],
        [
            (a10 * a21 - a11 * a20) * invDet,
            (a01 * a20 - a00 * a21) * invDet,
            (a00 * a11 - a01 * a10) * invDet
        ]
    ];

    // multiply inv * b
    return {
        x: inv[0][0] * b.x + inv[0][1] * b.y + inv[0][2] * b.z,
        y: inv[1][0] * b.x + inv[1][1] * b.y + inv[1][2] * b.z,
        z: inv[2][0] * b.x + inv[2][1] * b.y + inv[2][2] * b.z
    };
}

/* Triangulation:
   - groups cumulativeBlackPoints into spatial clusters on the plane (quantized by CLUSTER_TOL_MM)
   - for each cluster with >=2 rays from distinct camera poses, solve for best-fit 3D point
   - writes real_pos_mm into member entries when successful
   - also rebuilds the in-memory pointCloud (unique points) used by the Download button
*/
const CLUSTER_TOL_MM = 0.5; // tolerance to group mapped plane points (adjustable)

function updateTriangulation() {
    if (cumulativeBlackPoints.length === 0) {
        cumulativeTriangulatedCount = 0;
        triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;
        pointCloud = [];
        return;
    }

    // build clusters
    const clusters = {}; // key -> array of indices
    for (let i = 0; i < cumulativeBlackPoints.length; i++) {
        const p = cumulativeBlackPoints[i];
        if (typeof p.x_mm !== 'number' || typeof p.y_mm !== 'number') continue;
        const kx = Math.round(p.x_mm / CLUSTER_TOL_MM);
        const ky = Math.round(p.y_mm / CLUSTER_TOL_MM);
        const key = `${kx}_${ky}`;
        if (!clusters[key]) clusters[key] = [];
        clusters[key].push(i);
    }

    // attempt triangulation for each cluster
    for (const key in clusters) {
        const membersIdx = clusters[key];
        if (membersIdx.length < 2) continue;

        // collect valid rays for this cluster
        const rays = [];
        for (let idx of membersIdx) {
            const entry = cumulativeBlackPoints[idx];
            if (!entry.direction_cam) continue;
            if (!entry.camera_pose) continue;
            const ox = entry.camera_pose.x_mm;
            const oy = entry.camera_pose.y_mm;
            const oz = entry.camera_pose.z_mm;
            if (ox === null || oy === null || oz === null) continue;
            const d = entry.direction_cam;
            if (!isFinite(d.dx) || !isFinite(d.dy) || !isFinite(d.dz)) continue;
            const dir = normalizeVec({ x: d.dx, y: d.dy, z: d.dz });
            // ensure direction length is valid
            if (Math.hypot(dir.x, dir.y, dir.z) < 1e-6) continue;
            rays.push({ O: { x: ox, y: oy, z: oz }, u: dir, idx });
        }

        if (rays.length < 2) continue;

        // build A and b: sum (I - u u^T) and sum (I - u u^T) * O
        let A = [
            [0,0,0],
            [0,0,0],
            [0,0,0]
        ];
        let b = { x: 0, y: 0, z: 0 };

        for (const r of rays) {
            const ux = r.u.x, uy = r.u.y, uz = r.u.z;
            const outer00 = 1 - ux * ux;
            const outer01 = -ux * uy;
            const outer02 = -ux * uz;
            const outer10 = -ux * uy;
            const outer11 = 1 - uy * uy;
            const outer12 = -uy * uz;
            const outer20 = -ux * uz;
            const outer21 = -uy * uz;
            const outer22 = 1 - uz * uz;

            A[0][0] += outer00; A[0][1] += outer01; A[0][2] += outer02;
            A[1][0] += outer10; A[1][1] += outer11; A[1][2] += outer12;
            A[2][0] += outer20; A[2][1] += outer21; A[2][2] += outer22;

            b.x += outer00 * r.O.x + outer01 * r.O.y + outer02 * r.O.z;
            b.y += outer10 * r.O.x + outer11 * r.O.y + outer12 * r.O.z;
            b.z += outer20 * r.O.x + outer21 * r.O.y + outer22 * r.O.z;
        }

        const P = solve3x3(A, b);
        if (!P) continue; // could not solve (singular)

        // mark all member entries with real_pos_mm (only if not already set)
        for (const r of rays) {
            const entry = cumulativeBlackPoints[r.idx];
            entry.real_pos_mm = { x: Number(P.x.toFixed(4)), y: Number(P.y.toFixed(4)), z: Number(P.z.toFixed(4)) };
        }
    }

    // rebuild in-memory unique point cloud (timestamp kept from first occurrence)
    const seen = new Set();
    const pc = [];
    for (const p of cumulativeBlackPoints) {
        if (p.real_pos_mm) {
            const key = `${p.real_pos_mm.x}_${p.real_pos_mm.y}_${p.real_pos_mm.z}`;
            if (!seen.has(key)) {
                seen.add(key);
                pc.push({
                    x_mm: p.real_pos_mm.x,
                    y_mm: p.real_pos_mm.y,
                    z_mm: p.real_pos_mm.z,
                    timestamp: p.timestamp || null
                });
            }
        }
    }
    pointCloud = pc;

    // update cumulativeTriangulatedCount: number of cumulativeBlackPoints with real_pos_mm set
    let c = 0;
    for (const p of cumulativeBlackPoints) {
        if (p.real_pos_mm) c++;
    }
    cumulativeTriangulatedCount = c;
    triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;
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
            // keep scanning — we will still possibly recolor black pixels below if calibrating
            // but skip color-based detections
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

        // ---- recolor visually pixels pretos para vermelho durante calibragem ----
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

    // ---- NEW: map black pixels to XY (mm) using baseOriginScreen and baseVecs, register cumulatively with 1-in-10 sampling,
    //           define ray and compute pinhole direction for each registered pixel; rotate direction by yaw/pitch/roll
    //           into the referencial dos pixels pretos; then attempt triangulation entre múltiplos raios (clusters).
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

            // current camera pose to attach to each registered point
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
                        // compute pinhole direction for the screen pixel (camera reference)
                        const dirCam = computePinholeDirectionForPixel(p.x, p.y);

                        // rotate this camera-frame direction into the pixels/world reference using yaw/pitch/roll
                        const dirRotated = rotateVectorByYawPitchRoll(dirCam, yaw, pitch, roll);
                        const dirFinal = normalizeVec(dirRotated);

                        // register cumulative black point with direction_cam included (also keep screen coords for triangulation)
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
                                dx: Number(dirFinal.x.toFixed(6)),
                                dy: Number(dirFinal.y.toFixed(6)),
                                dz: Number(dirFinal.z.toFixed(6))
                            },
                            screen_x_px: p.x,
                            screen_y_px: p.y
                            // real_pos_mm will be added by triangulation when possible
                        });

                        // increment rays & directions counters (one ray and one direction per registered point)
                        cumulativeRaysCount++;
                        cumulativeDirCount++;
                    }
                }
            }

            // after adding new points, attempt triangulation on the whole set
            updateTriangulation();
        }
    }
    // update cumulative counts on screen
    blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;
    rayCountDisplay.textContent = `Raios definidos (cumulativo): ${cumulativeRaysCount}`;
    dirCountDisplay.textContent = `Pixels pretos com direção definida: ${cumulativeDirCount}`;
    triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;
    // ---- end mapping & registration & pinhole direction rotation & triangulation logic ----

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
