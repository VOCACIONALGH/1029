/* main.js
   Atualizado: durante a calibração,
   - triangulated 3D points são mantidos por clusters (implementação incremental leve).
   - a posição 3D de cada ponto triangulado (pixel preto) é registrada num arquivo .json (pontos em mm).
   - o botão "Download (.json)" aparece durante a calibração para baixar a nuvem de pontos.
   - NOVO: durante a calibração, cada ponto triangulado é pintado de rosa claro no canvas principal.
   - NOVO: adicionada visualização rápida da nuvem em mini-canvas para ver densidade.
   Nenhuma outra funcionalidade foi alterada.
*/

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadPointsBtn = document.getElementById("downloadPointsBtn");

const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const miniCanvas = document.getElementById("miniCloud");
const miniCtx = miniCanvas ? miniCanvas.getContext("2d") : null;
const miniContainer = document.getElementById("miniCloudContainer");

const redCountDisplay = document.getElementById("redCount");
const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");
const scaleEl = document.getElementById("scaleValue");
const zEl = document.getElementById("zValue");
const xEl = document.getElementById("xValue");
const yEl = document.getElementById("yValue");
const raysEl = document.getElementById("raysValue");
const points3DEl = document.getElementById("points3DValue");

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
let calibrationFrames = []; // array of frame summary objects saved durante calibragem
let calibrationRays = [];   // array of ray records { origin:{x,y,z}, direction:{dx,dy,dz} }

// clusters for triangulated 3D points
let calibrationClusters = []; // each cluster: { point: {x,y,z}, raysCount, repRay: {origin, direction}, midpointsCounted }

let lastRcentroid = null;     // {x,y} of last detected red centroid
let currentScale = 0;         // px/mm live estimate (before locking)

/* UTIL: converte RGB -> HSV (h:0..360, s:0..1, v:0..1) */
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
    const angle = Math.atan2(y2 - cy, x2 - cx);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;

    ctx.beginPath(); ctx.moveTo(cx, cy);
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

/* --- PINHOLE MODEL --- */
function computePinholeDirection(px, py) {
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

/* --- ROTATION: yaw/pitch/roll --- */
function degToRad(deg) {
    return deg * Math.PI / 180;
}

function rotateVectorByYawPitchRoll(v, yawDeg, pitchDeg, rollDeg) {
    if (!v) return null;

    const yaw = degToRad(yawDeg || 0);
    const pitch = degToRad(pitchDeg || 0);
    const roll = degToRad(rollDeg || 0);

    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    const cy = Math.cos(roll), sy = Math.sin(roll);

    const r00 = cy;
    const r01 = 0;
    const r02 = sy;

    const r10 = sx * sy;
    const r11 = cx;
    const r12 = -sx * cy;

    const r20 = -cx * sy;
    const r21 = sx;
    const r22 = cx * cy;

    const R00 = cz * r00 + (-sz) * r10 + 0 * r20;
    const R01 = cz * r01 + (-sz) * r11 + 0 * r21;
    const R02 = cz * r02 + (-sz) * r12 + 0 * r22;

    const R10 = sz * r00 + cz * r10 + 0 * r20;
    const R11 = sz * r01 + cz * r11 + 0 * r21;
    const R12 = sz * r02 + cz * r12 + 0 * r22;

    const R20 = r20;
    const R21 = r21;
    const R22 = r22;

    const rx = R00 * v.x + R01 * v.y + R02 * v.z;
    const ry = R10 * v.x + R11 * v.y + R12 * v.z;
    const rz = R20 * v.x + R21 * v.y + R22 * v.z;

    const norm = Math.hypot(rx, ry, rz);
    if (!isFinite(norm) || norm === 0) return null;

    return { x: rx / norm, y: ry / norm, z: rz / norm };
}

/* rotation without normalization (useful to rotate position vectors) */
function applyYawPitchRollNoNorm(v, yawDeg, pitchDeg, rollDeg) {
    if (!v) return null;

    const yaw = degToRad(yawDeg || 0);
    const pitch = degToRad(pitchDeg || 0);
    const roll = degToRad(rollDeg || 0);

    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    const cy = Math.cos(roll), sy = Math.sin(roll);

    const r00 = cy;
    const r01 = 0;
    const r02 = sy;

    const r10 = sx * sy;
    const r11 = cx;
    const r12 = -sx * cy;

    const r20 = -cx * sy;
    const r21 = sx;
    const r22 = cx * cy;

    const R00 = cz * r00 + (-sz) * r10 + 0 * r20;
    const R01 = cz * r01 + (-sz) * r11 + 0 * r21;
    const R02 = cz * r02 + (-sz) * r12 + 0 * r22;

    const R10 = sz * r00 + cz * r10 + 0 * r20;
    const R11 = sz * r01 + cz * r11 + 0 * r21;
    const R12 = sz * r02 + cz * r12 + 0 * r22;

    const R20 = r20;
    const R21 = r21;
    const R22 = r22;

    const rx = R00 * v.x + R01 * v.y + R02 * v.z;
    const ry = R10 * v.x + R11 * v.y + R12 * v.z;
    const rz = R20 * v.x + R21 * v.y + R22 * v.z;

    return { x: rx, y: ry, z: rz };
}

/* --- GEOMETRY: closest points between two (infinite) lines --- */
function closestPointsBetweenLines(p1, u1, p2, u2) {
    const w0 = { x: p1.x - p2.x, y: p1.y - p2.y, z: p1.z - p2.z };
    const a = 1.0;
    const b = u1.x * u2.x + u1.y * u2.y + u1.z * u2.z;
    const c = 1.0;
    const d = u1.x * w0.x + u1.y * w0.y + u1.z * w0.z;
    const e = u2.x * w0.x + u2.y * w0.y + u2.z * w0.z;
    const denom = a * c - b * b;
    let sc, tc;

    if (Math.abs(denom) < 1e-9) {
        sc = 0;
        tc = e / c;
    } else {
        sc = (b * e - c * d) / denom;
        tc = (a * e - b * d) / denom;
    }

    const c1 = { x: p1.x + u1.x * sc, y: p1.y + u1.y * sc, z: p1.z + u1.z * sc };
    const c2 = { x: p2.x + u2.x * tc, y: p2.y + u2.y * tc, z: p2.z + u2.z * tc };

    const dx = c1.x - c2.x, dy = c1.y - c2.y, dz = c1.z - c2.z;
    const distance = Math.hypot(dx, dy, dz);

    return { c1, c2, distance };
}

/* --- CLUSTERING / TRIANGULATION (incremental) --- */
/* Parameters controlling triangulation sensitivity */
const TRIANGULATION_DISTANCE_THRESH_MM = 6.0; // max distance between skew rays to consider intersecting (mm)
const CLUSTER_MERGE_RADIUS_MM = 8.0; // when midpoint near existing cluster point, merge into cluster

function addRayToTriangulation(ray) {
    if (!ray || !ray.origin) return;
    if (ray.origin.x === null || ray.direction.dx === null) return;

    const pNew = { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z };
    const uNew = { x: ray.direction.dx, y: ray.direction.dy, z: ray.direction.dz };

    let matchedClusterIndex = -1;
    let bestMidpoint = null;
    let bestDistance = Infinity;

    for (let i = 0; i < calibrationClusters.length; i++) {
        const cluster = calibrationClusters[i];
        const rep = cluster.repRay;
        if (!rep || !rep.origin) continue;
        const pRep = { x: rep.origin.x, y: rep.origin.y, z: rep.origin.z };
        const uRep = { x: rep.direction.dx, y: rep.direction.dy, z: rep.direction.dz };

        const { c1, c2, distance } = closestPointsBetweenLines(pNew, uNew, pRep, uRep);

        if (distance <= TRIANGULATION_DISTANCE_THRESH_MM && distance < bestDistance) {
            bestDistance = distance;
            bestMidpoint = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2, z: (c1.z + c2.z) / 2 };
            matchedClusterIndex = i;
        }
    }

    if (matchedClusterIndex >= 0 && bestMidpoint) {
        const cluster = calibrationClusters[matchedClusterIndex];
        const n = cluster.midpointsCounted || 1;
        cluster.point = {
            x: (cluster.point.x * n + bestMidpoint.x) / (n + 1),
            y: (cluster.point.y * n + bestMidpoint.y) / (n + 1),
            z: (cluster.point.z * n + bestMidpoint.z) / (n + 1)
        };
        cluster.midpointsCounted = n + 1;
        cluster.raysCount = (cluster.raysCount || 1) + 1;
    } else {
        calibrationClusters.push({
            point: { x: pNew.x, y: pNew.y, z: pNew.z },
            raysCount: 1,
            repRay: { origin: { x: pNew.x, y: pNew.y, z: pNew.z }, direction: { dx: uNew.x, dy: uNew.y, dz: uNew.z } },
            midpointsCounted: 0
        });
    }

    mergeNearbyClustersIfNeeded();
}

function mergeNearbyClustersIfNeeded() {
    if (calibrationClusters.length < 2) return;
    const merged = [];
    const used = new Array(calibrationClusters.length).fill(false);

    for (let i = 0; i < calibrationClusters.length; i++) {
        if (used[i]) continue;
        let base = calibrationClusters[i];
        used[i] = true;

        for (let j = i + 1; j < calibrationClusters.length; j++) {
            if (used[j]) continue;
            const other = calibrationClusters[j];
            const dx = base.point.x - other.point.x;
            const dy = base.point.y - other.point.y;
            const dz = base.point.z - other.point.z;
            const d = Math.hypot(dx, dy, dz);
            if (d <= CLUSTER_MERGE_RADIUS_MM) {
                const w1 = base.midpointsCounted || base.raysCount || 1;
                const w2 = other.midpointsCounted || other.raysCount || 1;
                const tot = w1 + w2;
                base.point = {
                    x: (base.point.x * w1 + other.point.x * w2) / tot,
                    y: (base.point.y * w1 + other.point.y * w2) / tot,
                    z: (base.point.z * w1 + other.point.z * w2) / tot
                };
                base.raysCount = (base.raysCount || 0) + (other.raysCount || 0);
                base.midpointsCounted = (base.midpointsCounted || 0) + (other.midpointsCounted || 0);
                used[j] = true;
            }
        }
        merged.push(base);
    }

    calibrationClusters = merged;
}

function countDetermined3DPoints() {
    let c = 0;
    for (const cl of calibrationClusters) {
        if ((cl.raysCount || 0) >= 2 || (cl.midpointsCounted || 0) >= 1) {
            c++;
        }
    }
    return c;
}

/* --- Inicialização da câmera / DeviceOrientation --- */
scanBtn.addEventListener("click", async () => {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try { await DeviceOrientationEvent.requestPermission(); } catch {}
    }
    window.addEventListener("deviceorientation", (e) => {
        document.getElementById("pitch").textContent = (e.beta ?? 0).toFixed(1);
        document.getElementById("yaw").textContent = (e.alpha ?? 0).toFixed(1);
        document.getElementById("roll").textContent = (e.gamma ?? 0).toFixed(1);
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

            // ensure mini canvas pixel size matches its internal size attributes
            if (miniCanvas) {
                // keep internal canvas actual pixel size unchanged; CSS controls display size
                // but set its drawing buffer to declared width/height
                miniCanvas.width = miniCanvas.getAttribute('width') || 240;
                miniCanvas.height = miniCanvas.getAttribute('height') || 160;
            }

            requestAnimationFrame(processFrame);
        }, { once: true });
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
});

/*
 Calibrar button behavior:
 - If not currently calibrating: validate origin & scale, prompt +Z, lock scale, record base origin and start collecting frames (isCalibrating = true).
 - If currently calibrating: finish collecting, generate JSON with recorded frames and recorded rays, download automatically, stop collecting (isCalibrating = false). Keep calibration locked (isCalibrated = true).
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

        // start collecting frames (calibragem ativa)
        isCalibrating = true;
        calibrationFrames = [];
        calibrationRays = [];
        calibrationClusters = [];

        // show download button for point cloud
        downloadPointsBtn.style.display = 'inline-block';
        if (miniContainer) miniContainer.style.display = 'flex';

        // display locked scale & base Z
        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        xEl.textContent = "0.00";
        yEl.textContent = "0.00";
        raysEl.textContent = "0";
        points3DEl.textContent = "0";

        alert("Calibragem iniciada. Mova a câmera para coletar dados e clique em 'Calibrar' novamente para finalizar e baixar o arquivo .json.");
        return;
    }

    // finalize calibration if currently calibrating
    if (isCalibrating) {
        isCalibrating = false;

        // hide download button when calibration stops
        downloadPointsBtn.style.display = 'none';
        if (miniContainer) miniContainer.style.display = 'none';

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
            rays: calibrationRays
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

/* Download current point cloud (triangulated clusters -> points) */
downloadPointsBtn.addEventListener('click', () => {
    // build array of triangulated points (use clusters considered determined)
    const points = [];
    for (const cl of calibrationClusters) {
        if ((cl.raysCount || 0) >= 2 || (cl.midpointsCounted || 0) >= 1) {
            // store mm values with reasonable precision
            points.push({
                x: Number(cl.point.x.toFixed(4)),
                y: Number(cl.point.y.toFixed(4)),
                z: Number(cl.point.z.toFixed(4))
            });
        }
    }

    const payload = {
        createdAt: new Date().toISOString(),
        pointsCount: points.length,
        points: points
    };

    const filename = `pontos3d_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
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

/* função auxiliar: projeta um ponto 3D world -> screen usando pose atual (origem e yaw/pitch/roll) */
function projectWorldPointToScreen(pointWorld, camOrigin, yawDeg, pitchDeg, rollDeg) {
    if (!pointWorld || !camOrigin) return null;
    // vector from camera to point
    const v = { x: pointWorld.x - camOrigin.x, y: pointWorld.y - camOrigin.y, z: pointWorld.z - camOrigin.z };
    // rotate by inverse camera rotation (i.e. apply -yaw,-pitch,-roll)
    const vCam = applyYawPitchRollNoNorm(v, -yawDeg, -pitchDeg, -rollDeg);
    if (!vCam) return null;

    // pinhole projection
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const f = Math.max(canvas.width, canvas.height) * 0.9;

    if (vCam.z <= 1e-6) return null; // behind camera or too close

    const px = cx + (vCam.x / vCam.z) * f;
    const py = cy + (vCam.y / vCam.z) * f;

    return { x: px, y: py, zcam: vCam.z };
}

function drawClustersOnMainCanvas(originCamera, yawDeg, pitchDeg, rollDeg) {
    if (!isCalibrating || !calibrationClusters || calibrationClusters.length === 0) return;

    // draw each determined cluster in light pink on the main canvas
    ctx.save();
    for (const cl of calibrationClusters) {
        // consider "determined" clusters (same rule as elsewhere)
        const determined = ((cl.raysCount || 0) >= 2 || (cl.midpointsCounted || 0) >= 1);
        if (!determined) continue;

        const proj = projectWorldPointToScreen(cl.point, originCamera, yawDeg, pitchDeg, rollDeg);
        if (proj) {
            ctx.beginPath();
            ctx.fillStyle = "rgba(255,182,193,0.95)"; // lightpink
            ctx.strokeStyle = "rgba(255,182,193,0.7)";
            ctx.lineWidth = 1;
            ctx.arc(proj.x, proj.y, 4, 0, Math.PI * 2);
            ctx.fill();
            // optional subtle outline
            ctx.stroke();
        }
    }
    ctx.restore();
}

/* desenha mini visualização da nuvem (top-down XY view em mm) */
function drawMiniCloud() {
    if (!miniCtx || !isCalibrating) return;

    miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);

    // build bounding box in world XY from clusters
    if (!calibrationClusters || calibrationClusters.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let anyDetermined = false;
    for (const cl of calibrationClusters) {
        if (!cl.point) continue;
        if ((cl.raysCount || 0) >= 1 || (cl.midpointsCounted || 0) >= 0) {
            anyDetermined = true;
            minX = Math.min(minX, cl.point.x);
            maxX = Math.max(maxX, cl.point.x);
            minY = Math.min(minY, cl.point.y);
            maxY = Math.max(maxY, cl.point.y);
        }
    }
    if (!anyDetermined) return;

    // add small padding if bbox degenerate
    if (minX === maxX) { minX -= 1; maxX += 1; }
    if (minY === maxY) { minY -= 1; maxY += 1; }

    const pad = 8; // px padding inside mini canvas
    const w = miniCanvas.width - pad * 2;
    const h = miniCanvas.height - pad * 2;

    const spanX = maxX - minX;
    const spanY = maxY - minY;

    // draw background grid optionally (subtle)
    miniCtx.save();
    miniCtx.fillStyle = "#030303";
    miniCtx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);
    miniCtx.restore();

    // draw each cluster as a small dot; size proportional to raysCount (capped)
    for (const cl of calibrationClusters) {
        if (!cl.point) continue;
        const px = pad + ((cl.point.x - minX) / spanX) * w;
        const py = pad + ((cl.point.y - minY) / spanY) * h;

        const count = cl.raysCount || 1;
        const size = Math.min(6, 2 + Math.log2(Math.max(1, count))); // small visual scaling

        miniCtx.beginPath();
        miniCtx.fillStyle = "rgba(255,182,193,0.95)"; // lightpink
        miniCtx.arc(px, py, size, 0, Math.PI * 2);
        miniCtx.fill();
    }

    // draw bbox border
    miniCtx.strokeStyle = "rgba(255,255,255,0.06)";
    miniCtx.lineWidth = 1;
    miniCtx.strokeRect(pad, pad, w, h);
}

/* processFrame mantém-se quase igual, incluindo novo desenho dos clusters/painel mini */
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

    // FIRST PASS: detect color centroids (não altera a imagem)
    let rC = 0, rX = 0, rY = 0;
    let bC = 0, bX = 0, bY = 0;
    let gC = 0, gX = 0, gY = 0;

    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const p = i / 4;
        const x = p % canvas.width;
        const y = (p / canvas.width) | 0;

        const { h, s, v } = rgbToHsv(r, g, b);
        if (s >= 0.35 && v >= 0.12) {
            if (hueDistance(h, 0) <= rTol) {
                rC++; rX += x; rY += y;
            } else if (hueDistance(h, 230) <= bTol) {
                bC++; bX += x; bY += y;
            } else if (hueDistance(h, 120) <= gTol) {
                gC++; gX += x; gY += y;
            }
        }
    }

    let r = null, b = null, g = null;

    if (rC) {
        r = { x: rX / rC, y: rY / rC };
        lastRcentroid = r;
    } else {
        lastRcentroid = null;
    }

    if (bC) {
        b = { x: bX / bC, y: bY / bC };
    }

    if (gC) {
        g = { x: gX / gC, y: gY / gC };
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

    // SECOND PASS: recolor image, draw overlays, and (se calibrando) registrar raios por pixel preto
    const pitchDegLive = parseFloat(pitchEl.textContent) || 0;
    const yawDegLive = parseFloat(yawEl.textContent) || 0;
    const rollDegLive = parseFloat(rollEl.textContent) || 0;

    let blackPixelCount = 0;
    let raysDefinedCount = 0;
    const BLACK_THR = 30;

    for (let i = 0; i < d.length; i += 4) {
        const rr = d[i], gg = d[i + 1], bb = d[i + 2];
        const p = i / 4;
        const x = p % canvas.width;
        const y = (p / canvas.width) | 0;

        const { h, s, v } = rgbToHsv(rr, gg, bb);
        if (s >= 0.35 && v >= 0.12) {
            if (hueDistance(h, 0) <= rTol) {
                d[i] = 255; d[i + 1] = 165; d[i + 2] = 0;
            } else if (hueDistance(h, 230) <= bTol) {
                d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
            } else if (hueDistance(h, 120) <= gTol) {
                d[i] = 160; d[i + 1] = 32; d[i + 2] = 240;
            }
        }

        if (isCalibrating && rr < BLACK_THR && gg < BLACK_THR && bb < BLACK_THR) {
            // paint visually red
            d[i] = 255;
            d[i + 1] = 0;
            d[i + 2] = 0;

            blackPixelCount++;

            // compute pinhole direction for this pixel (camera frame)
            const dirCamera = computePinholeDirection(x, y);
            if (dirCamera && isFinite(dirCamera.x) && isFinite(dirCamera.y) && isFinite(dirCamera.z)) {
                // rotate this direction into the fixed pixel reference using current yaw/pitch/roll
                const dirRotated = rotateVectorByYawPitchRoll(dirCamera, yawDegLive, pitchDegLive, rollDegLive);
                if (dirRotated && isFinite(dirRotated.x) && isFinite(dirRotated.y) && isFinite(dirRotated.z)) {
                    raysDefinedCount++;

                    // compute origin (camera position) for this frame
                    const originX = txMm !== null ? Number(txMm.toFixed(4)) : null;
                    const originY = tyMm !== null ? Number(tyMm.toFixed(4)) : null;
                    const originZ = computedZ !== null ? Number(computedZ.toFixed(4)) : (isCalibrated ? Number(baseZmm.toFixed(4)) : null);

                    // push single ray record as requested previously
                    const rayRecord = {
                        origin: { x: originX, y: originY, z: originZ },
                        direction: { dx: Number(dirRotated.x.toFixed(6)), dy: Number(dirRotated.y.toFixed(6)), dz: Number(dirRotated.z.toFixed(6)) }
                    };
                    calibrationRays.push(rayRecord);

                    // TRIANGULATE / AGGREGATE: add this ray to incremental triangulation
                    if (originX !== null && originY !== null && originZ !== null) {
                        addRayToTriangulation(rayRecord);
                    }
                }
            }
        }
    }

    // update visible image (after recolor)
    ctx.putImageData(img, 0, 0);

    // Plane drawing durante calibragem (mantido)
    const scaleForArrows = isCalibrated ? lockedScale : currentScale;
    if (isCalibrating && r && b && g) {
        const lengthPx = ARROW_LENGTH_MM * scaleForArrows;
        const tipX = computeArrowTip(r.x, r.y, b.x - r.x, b.y - r.y, lengthPx);
        const tipY = computeArrowTip(r.x, r.y, g.x - r.x, g.y - r.y, lengthPx);

        if (tipX && tipY) {
            drawPlanePolygon(r, tipX, tipY);
        }
    }

    // draw points and arrows (mantido)
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

    if (r && b && scaleForArrows) {
        drawArrowFromCenter(r.x, r.y, b.x - r.x, b.y - r.y, ARROW_LENGTH_MM * scaleForArrows, "blue");
    }
    if (r && g && scaleForArrows) {
        drawArrowFromCenter(r.x, r.y, g.x - r.x, g.y - r.y, ARROW_LENGTH_MM * scaleForArrows, "green");
    }

    // Prepare camera origin for projecting clusters
    const originCamera = {
        x: txMm !== null ? Number(txMm.toFixed(4)) : (isCalibrated ? 0 : null),
        y: tyMm !== null ? Number(tyMm.toFixed(4)) : (isCalibrated ? 0 : null),
        z: computedZ !== null ? Number(computedZ.toFixed(4)) : (isCalibrated ? Number(baseZmm.toFixed(4)) : null)
    };

    // If calibragem ativa, save a frame record (summary) and update rays display
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

        // update rays display (número de pixels pretos que tiveram direção definida neste frame)
        raysEl.textContent = String(raysDefinedCount);

        // update cumulative determined 3D points count
        const determinedCount = countDetermined3DPoints();
        points3DEl.textContent = String(determinedCount);

        // Draw clusters on main canvas (pink) using current pose
        if (originCamera.x !== null && originCamera.y !== null && originCamera.z !== null) {
            drawClustersOnMainCanvas(originCamera, yawDegLive, pitchDegLive, rollDegLive);
        }

        // Update mini cloud visualization
        drawMiniCloud();
    } else {
        raysEl.textContent = "0";
        // hide mini view if any (it toggles on calibrate start/stop)
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
