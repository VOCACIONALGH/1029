/* main.js
   Atualizado: durante a calibragem, o programa coleta raios 3D (origem + direção)
   referentes a pixels pretos detectados em múltiplas poses. Esses raios são agrupados
   por proximidade angular/espacial para estimar posições 3D por triangulação simples.
   O contador exibido em raysValue agora mostra a quantidade de pixels pretos cuja
   posição 3D foi determinada (ou seja, pontos com >= 2 raios associados).
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
let lockedScale = 0;           // px per mm locked at calibration
let basePixelDistance = 0;     // calibrated arrow length in px (ARROW_LENGTH_MM * lockedScale)
let baseOriginScreen = null;   // {x,y} of origin in screen coords at calibration
let isCalibrated = false;

// calibragem ativa (coleta de frames)
let isCalibrating = false;
let calibrationFrames = []; // array of frame objects saved durante calibragem

let lastRcentroid = null;     // {x,y} of last detected red centroid
let currentScale = 0;         // px/mm live estimate (before locking)

/* point cloud candidates built during calibragem
   cada entry: { pos: {x,y,z}, raysCount: n, lastUpdated: timestamp }
   representa um ponto 3D estimado a partir de múltiplos raios.
*/
const pointCandidates = [];
const MAX_POINT_CANDIDATES = 50000; // limite de segurança
const ASSOCIATION_DIST_MM = 5.0;    // distância máxima (mm) para associar um novo raio a um ponto existente

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

/* --- PINHOLE MODEL --- */
/* Retorna vetor unitário de direção do raio no sistema da câmera (x, y, z)
   usando aproximação pinhole simples:
   - principal point (cx,cy) assumido no centro do canvas
   - focal length (f) estimado a partir do tamanho do canvas (em pixels)
*/
function computePinholeDirection(px, py) {
    if (!canvas || !canvas.width || !canvas.height) return null;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // Estimate focal length in pixels (aproximação simples).
    const f = Math.max(canvas.width, canvas.height) * 0.9;

    // coordinates in camera frame (z forward)
    const vx = (px - cx) / f;
    const vy = (py - cy) / f;
    const vz = 1.0;

    const norm = Math.hypot(vx, vy, vz);
    if (!isFinite(norm) || norm === 0) return null;

    return { x: vx / norm, y: vy / norm, z: vz / norm };
}

/* --- EULER -> MATRIZ de rotação (deg -> rad) ---
   Usamos a ordem Z (yaw / alpha) * X (pitch / beta) * Y (roll / gamma)
   para transformar vetores da câmera para o referencial do mundo:
   v_world = Rz(alpha) * Rx(beta) * Ry(gamma) * v_camera
*/
function degToRad(d) { return d * Math.PI / 180; }

function eulerToRotationMatrix(alphaDeg, betaDeg, gammaDeg) {
    const a = degToRad(alphaDeg || 0); // yaw
    const b = degToRad(betaDeg || 0);  // pitch
    const g = degToRad(gammaDeg || 0); // roll

    const ca = Math.cos(a), sa = Math.sin(a);
    const cb = Math.cos(b), sb = Math.sin(b);
    const cg = Math.cos(g), sg = Math.sin(g);

    // Rz * Rx * Ry
    // Rz:
    // [ ca -sa 0 ]
    // [ sa  ca 0 ]
    // [  0   0 1 ]
    // Rx:
    // [1  0   0 ]
    // [0 cb -sb ]
    // [0 sb  cb ]
    // Ry:
    // [ cg 0 sg ]
    // [  0 1  0 ]
    // [-sg 0 cg ]
    //
    // Multiply them in order (Rz * Rx * Ry)
    const r00 = ca * (1 * cg) + (-sa) * (0 * cg) + 0 * (-sg); // simplified multiplication done explicitly below
    // to avoid errors, compute full multiplication:
    // First compute A = Rz * Rx
    const A00 = ca * 1 + (-sa) * 0 + 0 * 0;
    const A01 = ca * 0 + (-sa) * cb + 0 * sb;
    const A02 = ca * 0 + (-sa) * (-sb) + 0 * cb;

    const A10 = sa * 1 + ca * 0 + 0 * 0;
    const A11 = sa * 0 + ca * cb + 0 * sb;
    const A12 = sa * 0 + ca * (-sb) + 0 * cb;

    const A20 = 0 * 1 + 0 * 0 + 1 * 0;
    const A21 = 0 * 0 + 0 * cb + 1 * sb;
    const A22 = 0 * 0 + 0 * (-sb) + 1 * cb;

    // Now R = A * Ry
    const R00 = A00 * cg + A01 * 0 + A02 * (-sg);
    const R01 = A00 * 0 + A01 * 1 + A02 * 0;
    const R02 = A00 * sg + A01 * 0 + A02 * cg;

    const R10 = A10 * cg + A11 * 0 + A12 * (-sg);
    const R11 = A10 * 0 + A11 * 1 + A12 * 0;
    const R12 = A10 * sg + A11 * 0 + A12 * cg;

    const R20 = A20 * cg + A21 * 0 + A22 * (-sg);
    const R21 = A20 * 0 + A21 * 1 + A22 * 0;
    const R22 = A20 * sg + A21 * 0 + A22 * cg;

    return [
        [R00, R01, R02],
        [R10, R11, R12],
        [R20, R21, R22]
    ];
}

function rotateVector(R, v) {
    return {
        x: R[0][0] * v.x + R[0][1] * v.y + R[0][2] * v.z,
        y: R[1][0] * v.x + R[1][1] * v.y + R[1][2] * v.z,
        z: R[2][0] * v.x + R[2][1] * v.y + R[2][2] * v.z
    };
}

/* --- Triangulation helpers --- */

/* distancia (mm) entre ponto P e reta (o + t*d) */
function distancePointToRay(point, rayOrigin, rayDir) {
    // vector from ray origin to point
    const vx = point.x - rayOrigin.x;
    const vy = point.y - rayOrigin.y;
    const vz = point.z - rayOrigin.z;

    // projection length along ray
    const t = vx * rayDir.x + vy * rayDir.y + vz * rayDir.z;

    const cx = rayOrigin.x + rayDir.x * t;
    const cy = rayOrigin.y + rayDir.y * t;
    const cz = rayOrigin.z + rayDir.z * t;

    const dx = point.x - cx;
    const dy = point.y - cy;
    const dz = point.z - cz;

    return Math.hypot(dx, dy, dz);
}

/* closest point on ray to given point */
function closestPointOnRayToPoint(point, rayOrigin, rayDir) {
    const vx = point.x - rayOrigin.x;
    const vy = point.y - rayOrigin.y;
    const vz = point.z - rayOrigin.z;
    const t = vx * rayDir.x + vy * rayDir.y + vz * rayDir.z;
    return {
        x: rayOrigin.x + rayDir.x * t,
        y: rayOrigin.y + rayDir.y * t,
        z: rayOrigin.z + rayDir.z * t
    };
}

/* adiciona um novo raio à nuvem de candidatos; tenta associar a um ponto existente,
   caso contrário cria um novo candidato. */
function addRayToCandidates(rayOrigin, rayDir) {
    // tenta achar ponto existente com distância pequena ao raio
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < pointCandidates.length; i++) {
        const pt = pointCandidates[i];
        const dist = distancePointToRay(pt.pos, rayOrigin, rayDir);
        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
        }
    }

    if (bestIdx !== -1 && bestDist <= ASSOCIATION_DIST_MM) {
        // associa ao ponto bestIdx e o refina (média ponderada com a posição do ponto mais próxima no raio)
        const existing = pointCandidates[bestIdx];
        const closest = closestPointOnRayToPoint(existing.pos, rayOrigin, rayDir);

        // atualizar posição média incrementalmente
        const n = existing.raysCount;
        existing.pos.x = (existing.pos.x * n + closest.x) / (n + 1);
        existing.pos.y = (existing.pos.y * n + closest.y) / (n + 1);
        existing.pos.z = (existing.pos.z * n + closest.z) / (n + 1);
        existing.raysCount += 1;
        existing.lastUpdated = Date.now();
        return;
    }

    // se não achou, cria novo candidato (posição inicial: ponto a uma distância razoável ao longo do raio)
    if (pointCandidates.length < MAX_POINT_CANDIDATES) {
        // distância inicial em mm: use baseZmm se disponível, senão 100 mm
        const initDist = (baseZmm && isFinite(baseZmm)) ? Math.abs(baseZmm) : 100;
        const pos = {
            x: rayOrigin.x + rayDir.x * initDist,
            y: rayOrigin.y + rayDir.y * initDist,
            z: rayOrigin.z + rayDir.z * initDist
        };
        pointCandidates.push({ pos, raysCount: 1, lastUpdated: Date.now() });
    }
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
            requestAnimationFrame(processFrame);
        }, { once: true });
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
});

/*
 Calibrar button behavior:
 - If not currently calibrating: validate origin & scale, prompt +Z, lock scale, record base origin and start collecting frames (isCalibrating = true).
 - If currently calibrating: finish collecting, generate JSON with recorded frames, download automatically, stop collecting (isCalibrating = false). Keep calibration locked (isCalibrated = true).
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

        // reset pointCandidates for a fresh triangulação
        pointCandidates.length = 0;

        // display locked scale & base Z
        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        xEl.textContent = "0.00";
        yEl.textContent = "0.00";
        raysEl.textContent = "0";

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

        const payload = {
            createdAt: new Date().toISOString(),
            baseZmm,
            lockedScale,
            baseOriginScreen,
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

    // NEW: collect black pixel screen coords in this frame for later triangulation
    const blackPixelsThisFrame = [];
    const BLACK_THR = 30;

    // per-pixel detection + coloring
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const p = i / 4;
        const x = p % canvas.width;
        const y = (p / canvas.width) | 0;

        const { h, s, v } = rgbToHsv(r, g, b);
        if (s >= 0.35 && v >= 0.12) {
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

        // recolor visualmente pixels pretos durante calibragem e registre sua tela para triangulação
        if (isCalibrating && r < BLACK_THR && g < BLACK_THR && b < BLACK_THR) {
            // paint visually red
            d[i] = 255;
            d[i + 1] = 0;
            d[i + 2] = 0;

            // armazenar pixel (x,y) para processamento pós-loop
            blackPixelsThisFrame.push({ x, y });
        }
    }

    // update visible image
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

    // Plane drawing during calibragem
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

    // --- Triangulação: processa blackPixelsThisFrame usando pose atual (txMm,tyMm,computedZ,pitch,yaw,roll) ---
    if (isCalibrating && blackPixelsThisFrame.length > 0) {
        // pose / orientation usados para transformar cada raio de câmera->mundo
        const pitch = parseFloat(pitchEl.textContent) || 0;
        const yaw = parseFloat(yawEl.textContent) || 0;
        const roll = parseFloat(rollEl.textContent) || 0;

        // se alguma das coordenadas da câmera for null, usamos fallback 0 / baseZmm
        const camOrigin = {
            x: (txMm !== null && isFinite(txMm)) ? txMm : 0,
            y: (tyMm !== null && isFinite(tyMm)) ? tyMm : 0,
            z: (computedZ !== null && isFinite(computedZ)) ? computedZ : (isFinite(baseZmm) ? baseZmm : 100)
        };

        const R = eulerToRotationMatrix(yaw, pitch, roll); // note: yaw (alpha), pitch (beta), roll (gamma)

        // processar cada pixel preto deste frame
        for (let idx = 0; idx < blackPixelsThisFrame.length; idx++) {
            const px = blackPixelsThisFrame[idx].x;
            const py = blackPixelsThisFrame[idx].y;

            const dirCam = computePinholeDirection(px, py);
            if (!dirCam) continue;

            // converter direção para o referencial do mundo
            const dirWorld = rotateVector(R, dirCam);
            // garantir normalização
            const norm = Math.hypot(dirWorld.x, dirWorld.y, dirWorld.z) || 1;
            dirWorld.x /= norm; dirWorld.y /= norm; dirWorld.z /= norm;

            // adicionar o raio ao conjunto de candidatos (triangulação incremental)
            addRayToCandidates(camOrigin, dirWorld);
        }
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

        // atualizar contador: numeros de pontos com pelo menos 2 raios (triangulados)
        let triangulatedCount = 0;
        for (let i = 0; i < pointCandidates.length; i++) {
            if (pointCandidates[i].raysCount >= 2) triangulatedCount++;
        }
        raysEl.textContent = String(triangulatedCount);
    } else {
        // quando não calibrando, contador deve mostrar 0
        raysEl.textContent = "0";
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
