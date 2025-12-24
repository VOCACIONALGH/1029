/* main.js — versão corrigida
   - Remove a projeção forçada do pixel para (x_mm,y_mm) no plano.
   - Registra apenas raios (origem da câmera em mm + direção 3D normalizada em referencial world/pixels).
   - Triangulação: calcula pontos candidatos a partir de pares de raios (ponto médio da menor conexão entre duas retas),
     filtra por distância de fechamento entre as retas, agrupa por proximidade (clustering) e produz a nuvem 3D.
   - Mantém contadores e botão Download durante calibragem.
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

// base vectors (px per mm) used to map pixels -> XY mm durante calibragem (still used for plane drawing)
let baseVecX_px = null; // {x,y} px per mm along X-axis
let baseVecY_px = null; // {x,y} px per mm along Y-axis
let baseVecSet = false;

// cumulative registered black points across the whole calibration session
// Each entry: { timestamp, camera_pose: {...}, direction_cam: {dx,dy,dz}, screen_x_px, screen_y_px, real_pos_mm? }
let cumulativeBlackPoints = [];

// COUNTER: increment for every black pixel detected; only register when counter % 10 === 0
let blackDetectCounter = 0;

// cumulative rays (kept for display/count). Each registered point also defines a ray; count maintained.
let cumulativeRaysCount = 0;

// cumulative count of points with direction defined (should increment when we add direction to a registered point)
let cumulativeDirCount = 0;

// triangulation bookkeeping
let cumulativeTriangulatedCount = 0;

// in-memory unique point cloud (for download)
let pointCloud = [];

/* PARAMETERS for triangulation */
const PAIR_MAX_DISTANCE_MM = 8.0; // maximum allowed shortest distance between two rays to accept their intersection candidate
const CLUSTER_TOL_MM = 1.0;       // clustering tolerance for candidate 3D points
const MIN_POINTS_PER_CLUSTER = 2; // minimum number of candidate points to accept a cluster

/* Utility math helpers */
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function mulScalar(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

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
            // black_points entries may include real_pos_mm when triangulated
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

/* Color/HSV helpers (unchanged) */
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
   - focal length (px) approximated as 0.8 * max(image width, height)
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

/* Given two rays (O1,u1) and (O2,u2) compute closest points P1,P2 and midpoint M.
   Returns {M, dist, P1, P2, s, t} or null if parallel/singular.
   Method: analytic solution solving for scalars s,t as in classical closest approach.
*/
function closestPointBetweenRays(O1, u1, O2, u2) {
    const w0 = sub(O1, O2);
    const a = dot(u1, u1);
    const b = dot(u1, u2);
    const c = dot(u2, u2);
    const d = dot(u1, w0);
    const e = dot(u2, w0);

    const den = a * c - b * b;
    if (Math.abs(den) < 1e-9) return null; // nearly parallel

    const s = (b * e - c * d) / den;
    const t = (a * e - b * d) / den;

    const P1 = add(O1, mulScalar(u1, s));
    const P2 = add(O2, mulScalar(u2, t));
    const M = mulScalar(add(P1, P2), 0.5);
    const distance = dist(P1, P2);
    return { M, distance, P1, P2, s, t };
}

/* Triangulation pipeline:
   1) From cumulativeBlackPoints (rays) compute pairwise candidates (midpoints) for pairs with small closest distance.
   2) Cluster the candidate midpoints spatially (grid quantization) and average positions in each cluster.
   3) For each resulting cluster center, associate rays whose closest approach to that center is small -> mark those entries' real_pos_mm.
   4) Rebuild unique pointCloud for download.
*/
function updateTriangulationFromRays() {
    // Require at least 2 valid rays with known camera_pose
    const rays = [];
    for (let i = 0; i < cumulativeBlackPoints.length; i++) {
        const e = cumulativeBlackPoints[i];
        if (!e.direction_cam || !e.camera_pose) continue;
        const ox = e.camera_pose.x_mm, oy = e.camera_pose.y_mm, oz = e.camera_pose.z_mm;
        if (ox === null || oy === null || oz === null) continue;
        const d = e.direction_cam;
        if (!isFinite(d.dx) || !isFinite(d.dy) || !isFinite(d.dz)) continue;
        const dir = normalizeVec({ x: d.dx, y: d.dy, z: d.dz });
        if (Math.hypot(dir.x, dir.y, dir.z) < 1e-6) continue;
        rays.push({ O: { x: ox, y: oy, z: oz }, u: dir, idx: i });
    }

    if (rays.length < 2) {
        cumulativeTriangulatedCount = 0;
        triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;
        pointCloud = [];
        return;
    }

    // pairwise candidate points
    const candidates = [];
    for (let i = 0; i < rays.length; i++) {
        for (let j = i + 1; j < rays.length; j++) {
            const r1 = rays[i], r2 = rays[j];
            const cp = closestPointBetweenRays(r1.O, r1.u, r2.O, r2.u);
            if (!cp) continue;
            if (cp.distance <= PAIR_MAX_DISTANCE_MM) {
                candidates.push({ point: cp.M, dist: cp.distance, idx1: r1.idx, idx2: r2.idx });
            }
        }
    }

    if (candidates.length === 0) {
        // nothing to triangulate yet
        cumulativeTriangulatedCount = 0;
        triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;
        pointCloud = [];
        return;
    }

    // cluster candidates by spatial quantization
    const clusters = {}; // key -> array of candidate indices
    for (let i = 0; i < candidates.length; i++) {
        const p = candidates[i].point;
        const kx = Math.round(p.x / CLUSTER_TOL_MM);
        const ky = Math.round(p.y / CLUSTER_TOL_MM);
        const kz = Math.round(p.z / CLUSTER_TOL_MM);
        const key = `${kx}_${ky}_${kz}`;
        if (!clusters[key]) clusters[key] = [];
        clusters[key].push(i);
    }

    // compute cluster centers and associate contributing rays
    const clusterCenters = []; // {center:{x,y,z}, candidates:[...], contributingRayIdx:Set}
    for (const key in clusters) {
        const list = clusters[key];
        if (list.length < MIN_POINTS_PER_CLUSTER) continue;
        let sum = { x: 0, y: 0, z: 0 };
        const contributingRays = new Set();
        for (const ci of list) {
            const cand = candidates[ci];
            sum.x += cand.point.x; sum.y += cand.point.y; sum.z += cand.point.z;
            contributingRays.add(cand.idx1);
            contributingRays.add(cand.idx2);
        }
        const n = list.length;
        const center = { x: sum.x / n, y: sum.y / n, z: sum.z / n };
        clusterCenters.push({ center, candidates: list, contributingRays });
    }

    // For each cluster center, mark cumulativeBlackPoints entries (rays) that are close enough to the center
    for (const cl of clusterCenters) {
        const center = cl.center;
        for (const ridx of cl.contributingRays) {
            const entry = cumulativeBlackPoints[ridx];
            if (!entry) continue;
            // compute distance from ray to center: shortest distance between point and line
            const O = entry.camera_pose ? { x: entry.camera_pose.x_mm, y: entry.camera_pose.y_mm, z: entry.camera_pose.z_mm } : null;
            const d = entry.direction_cam ? normalizeVec({ x: entry.direction_cam.dx, y: entry.direction_cam.dy, z: entry.direction_cam.dz }) : null;
            if (!O || !d) continue;
            // vector from camera origin to center
            const w = sub(center, O);
            // cross product magnitude / |d| gives distance
            const cross = {
                x: w.y * d.z - w.z * d.y,
                y: w.z * d.x - w.x * d.z,
                z: w.x * d.y - w.y * d.x
            };
            const distToRay = Math.hypot(cross.x, cross.y, cross.z);
            // accept if center is reasonably close to this ray
            if (distToRay <= PAIR_MAX_DISTANCE_MM) {
                // assign real_pos_mm
                entry.real_pos_mm = { x: Number(center.x.toFixed(4)), y: Number(center.y.toFixed(4)), z: Number(center.z.toFixed(4)) };
            }
        }
    }

    // rebuild unique point cloud (unique centers from entries' real_pos_mm)
    const seen = new Set();
    const pc = [];
    for (const e of cumulativeBlackPoints) {
        if (e.real_pos_mm) {
            const key = `${e.real_pos_mm.x}_${e.real_pos_mm.y}_${e.real_pos_mm.z}`;
            if (!seen.has(key)) {
                seen.add(key);
                pc.push({
                    x_mm: e.real_pos_mm.x,
                    y_mm: e.real_pos_mm.y,
                    z_mm: e.real_pos_mm.z,
                    timestamp: e.timestamp || null
                });
            }
        }
    }
    pointCloud = pc;

    // update triangulated count
    let c = 0;
    for (const p of cumulativeBlackPoints) if (p.real_pos_mm) c++;
    cumulativeTriangulatedCount = c;
    triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;
}

/* main frame processing */
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

    // collect black pixels coords during this frame (so we can register rays)
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

    // If calibragem ativa, try to set base vectors (only once) using the detected blue/green directions (unchanged)
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

    // Plane drawing durante calibragem (unchanged)
    if (isCalibrating && r && b && g) {
        const scaleUsed = isCalibrated ? lockedScale : currentScale;
        const lengthPx = ARROW_LENGTH_MM * scaleUsed;

        const tipX = computeArrowTip(r.x, r.y, b.x - r.x, b.y - r.y, lengthPx);
        const tipY = computeArrowTip(r.x, r.y, g.x - r.x, g.y - r.y, lengthPx);

        if (tipX && tipY) {
            drawPlanePolygon(r, tipX, tipY);
        }
    }

    // draw points and arrows (unchanged)
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

    // +Z calculation (uses lockedScale if calibrated) — unchanged (HUD only)
    let computedZ = null;
    if (isCalibrated && currentPixelDistance) {
        const dzMm = (basePixelDistance - currentPixelDistance) / lockedScale; // smaller arrow px => larger +Z
        computedZ = baseZmm + dzMm;
        zEl.textContent = computedZ.toFixed(2);
    } else {
        if (!isCalibrated) zEl.textContent = "0.00";
        else zEl.textContent = baseZmm.toFixed(2);
    }

    // +X and +Y calculations (camera translation), only after calibration and if origin detected (unchanged)
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

    // If calibragem ativa, save a frame record (unchanged)
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

    // ---- NEW: register rays (do NOT map pixel to a fixed plane). Triangulate using rays from different poses.
    if (isCalibrating && isCalibrated && baseOriginScreen && blackPixels.length > 0) {
        const pitch = parseFloat(pitchEl.textContent) || 0;
        const yaw = parseFloat(yawEl.textContent) || 0;
        const roll = parseFloat(rollEl.textContent) || 0;

        // compute current camera origin in mm (camera pose)
        const poseXmm = (function() {
            if (lastRcentroid && baseOriginScreen) {
                const dxPixels = lastRcentroid.x - baseOriginScreen.x;
                const dyPixels = lastRcentroid.y - baseOriginScreen.y;
                const tx = -(dxPixels) / lockedScale;
                const ty = (dyPixels) / lockedScale;
                return { x_mm: Number(tx.toFixed(4)), y_mm: Number(ty.toFixed(4)) };
            }
            return { x_mm: null, y_mm: null };
        })();

        const poseZmm = (isCalibrated && currentPixelDistance) ? Number((computedZ !== null ? computedZ : baseZmm).toFixed(4)) : (isCalibrated ? Number(baseZmm.toFixed(4)) : null);

        const timestampNow = new Date().toISOString();

        for (let k = 0; k < blackPixels.length; k++) {
            const p = blackPixels[k];

            blackDetectCounter++;
            if ((blackDetectCounter % 10) !== 0) continue;

            // compute pinhole direction (camera frame)
            const dirCam = computePinholeDirectionForPixel(p.x, p.y);

            // rotate to world/pixels reference using yaw/pitch/roll
            const dirRot = rotateVectorByYawPitchRoll(dirCam, yaw, pitch, roll);
            const dirFinal = normalizeVec(dirRot);

            // camera origin in mm
            const camOrigin = {
                x: poseXmm.x_mm,
                y: poseXmm.y_mm,
                z: poseZmm
            };

            // Must have valid origin to be a usable ray
            cumulativeBlackPoints.push({
                timestamp: timestampNow,
                camera_pose: {
                    x_mm: camOrigin.x,
                    y_mm: camOrigin.y,
                    z_mm: camOrigin.z,
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
                // real_pos_mm will be assigned by triangulation
            });

            cumulativeRaysCount++;
            cumulativeDirCount++;
        }

        // After adding new rays, attempt triangulation using only rays (no plane)
        updateTriangulationFromRays();
    }
    // update cumulative counts on screen
    blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;
    rayCountDisplay.textContent = `Raios definidos (cumulativo): ${cumulativeRaysCount}`;
    dirCountDisplay.textContent = `Pixels pretos com direção definida: ${cumulativeDirCount}`;
    triangulatedCountDisplay.textContent = `Pixels pretos 3D determinados: ${cumulativeTriangulatedCount}`;
    // ---- end mapping & registration & triangulation logic ----

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
