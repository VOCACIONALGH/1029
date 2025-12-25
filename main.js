/* main.js
   Atualizado para:
   - definir um referencial de mundo fixo no instante inicial da calibragem
   - para cada frame subsequente: calcular a matriz homogênea 4x4 da pose atual da câmera,
     transformar para o referencial do mundo usando a inversa da pose inicial e
     expressar cada raio (origem + direção) no referencial do mundo antes de gravar.
   - a triangulação deverá usar apenas raios já expressos no referencial do mundo.
   Nenhuma outra funcionalidade além do acima foi adicionada.
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
let calibrationFrames = []; // array of frame summary objects saved durante calibragem
let calibrationRays = [];   // array of ray records { origin:{x,y,z}, direction:{dx,dy,dz} } -- agora em referencial do mundo

let lastRcentroid = null;     // {x,y} of last detected red centroid
let currentScale = 0;         // px/mm live estimate (before locking)

// WORLD POSE state
let initialPoseMatrix = null;      // 4x4 matrix (referencial do mundo = instante inicial da calibragem)
let initialPoseMatrixInverse = null;
let initialPoseCaptured = false;

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

    // Estimate focal length in pixels.
    const f = Math.max(canvas.width, canvas.height) * 0.9;

    // coordinates in camera frame (z forward)
    const vx = (px - cx) / f;
    const vy = (py - cy) / f;
    const vz = 1.0;

    const norm = Math.hypot(vx, vy, vz);
    if (!isFinite(norm) || norm === 0) return null;

    return { x: vx / norm, y: vy / norm, z: vz / norm };
}

/* --- ROTATION: yaw/pitch/roll --- */
/* Converte graus para radianos */
function degToRad(deg) {
    return deg * Math.PI / 180;
}

/* Rotaciona o vetor v ({x,y,z}) usando yaw (deg, z), pitch (deg, x) e roll (deg, y).
   Aplica a matriz 3x3 R = Rz(yaw) * Rx(pitch) * Ry(roll)
   Retorna vetor normalizado {x,y,z} ou null se inválido.
*/
function rotateVectorByYawPitchRoll(v, yawDeg, pitchDeg, rollDeg) {
    if (!v) return null;

    const yaw = degToRad(yawDeg || 0);
    const pitch = degToRad(pitchDeg || 0);
    const roll = degToRad(rollDeg || 0);

    // Rotation matrices components
    // Rz(yaw)
    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    // Rx(pitch)
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    // Ry(roll)
    const cy = Math.cos(roll), sy = Math.sin(roll);  // Build combined R = Rz * Rx * Ry
    // Compute R = Rz * (Rx * Ry)
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

    // apply rotation
    const rx = R00 * v.x + R01 * v.y + R02 * v.z;
    const ry = R10 * v.x + R11 * v.y + R12 * v.z;
    const rz = R20 * v.x + R21 * v.y + R22 * v.z;

    const norm = Math.hypot(rx, ry, rz);
    if (!isFinite(norm) || norm === 0) return null;

    return { x: rx / norm, y: ry / norm, z: rz / norm };
}

/* --- MATRIZES HOMOGÊNEAS 4x4 (row-major com acesso m[row][col]) --- */

/* constroi matriz 4x4 de pose a partir de tx,ty,tz (mm) e yaw/pitch/roll (deg),
   usando a mesma ordem de rotações R = Rz(yaw) * Rx(pitch) * Ry(roll).
   Retorna matriz 4x4 (array de 4 arrays de 4 elementos).
*/
function poseMatrixFromYawPitchRollAndTranslation(tx, ty, tz, yawDeg, pitchDeg, rollDeg) {
    const yaw = degToRad(yawDeg || 0);
    const pitch = degToRad(pitchDeg || 0);
    const roll = degToRad(rollDeg || 0);

    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    const cy = Math.cos(roll), sy = Math.sin(roll);

    // Rx * Ry parts (as in rotateVectorByYawPitchRoll implementation)
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

    return [
        [R00, R01, R02, tx],
        [R10, R11, R12, ty],
        [R20, R21, R22, tz],
        [0,   0,   0,   1 ]
    ];
}

/* multiplica duas matrizes 4x4 (row-major) */
function multiplyMat4(A, B) {
    const C = [];
    for (let i = 0; i < 4; i++) {
        C[i] = [];
        for (let j = 0; j < 4; j++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += A[i][k] * B[k][j];
            C[i][j] = s;
        }
    }
    return C;
}

/* inversa de matriz de transformação rígida [R t; 0 1] = [R^T, -R^T t; 0 1] */
function invertPoseMatrix(M) {
    // M assumed 4x4 rigid transform
    const R = [
        [M[0][0], M[0][1], M[0][2]],
        [M[1][0], M[1][1], M[1][2]],
        [M[2][0], M[2][1], M[2][2]]
    ];
    const t = [M[0][3], M[1][3], M[2][3]];
    // R^T
    const Rt = [
        [R[0][0], R[1][0], R[2][0]],
        [R[0][1], R[1][1], R[2][1]],
        [R[0][2], R[1][2], R[2][2]]
    ];
    // -R^T * t
    const ntx = -(Rt[0][0] * t[0] + Rt[0][1] * t[1] + Rt[0][2] * t[2]);
    const nty = -(Rt[1][0] * t[0] + Rt[1][1] * t[1] + Rt[1][2] * t[2]);
    const ntz = -(Rt[2][0] * t[0] + Rt[2][1] * t[1] + Rt[2][2] * t[2]);

    return [
        [Rt[0][0], Rt[0][1], Rt[0][2], ntx],
        [Rt[1][0], Rt[1][1], Rt[1][2], nty],
        [Rt[2][0], Rt[2][1], Rt[2][2], ntz],
        [0,        0,        0,        1  ]
    ];
}

/* aplica rotação 3x3 (parte superior esquerda da matriz 4x4) a vetor v */
function applyRotationFromMat4(M, v) {
    return {
        x: M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z,
        y: M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z,
        z: M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z
    };
}

/* extrai tradução da matriz 4x4 */
function extractTranslationFromMat4(M) {
    return { x: M[0][3], y: M[1][3], z: M[2][3] };
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
 - Se não está calibrando: valida origem & escala, pede +Z, bloqueia escala, registra pose inicial (matriz homogênea)
   e inicia a coleta de frames (isCalibrating = true).
 - Se está calibrando: finaliza a coleta, gera JSON com frames + raios (já em referencial do mundo) e baixa o arquivo.
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

        // capture initial pose (world reference) at the instant calibration begins
        // At this instant, since baseOriginScreen == lastRcentroid, tx0 and ty0 are zero in our screen->mm model
        const pitch0 = parseFloat(pitchEl.textContent) || 0;
        const yaw0 = parseFloat(yawEl.textContent) || 0;
        const roll0 = parseFloat(rollEl.textContent) || 0;

        // initial camera position in mm relative to piece origin: X=0, Y=0, Z=baseZmm
        initialPoseMatrix = poseMatrixFromYawPitchRollAndTranslation(0.0, 0.0, baseZmm, yaw0, pitch0, roll0);
        initialPoseMatrixInverse = invertPoseMatrix(initialPoseMatrix);
        initialPoseCaptured = true;

        // start collecting frames (calibragem ativa)
        isCalibrating = true;
        calibrationFrames = [];
        calibrationRays = [];

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

        // include initialPoseMatrix and its inverse in the payload for reference (flattened)
        function mat4ToNestedArray(M) { return M; }

        const payload = {
            createdAt: new Date().toISOString(),
            baseZmm,
            lockedScale,
            baseOriginScreen,
            initialPoseMatrix: mat4ToNestedArray(initialPoseMatrix),
            initialPoseMatrixInverse: mat4ToNestedArray(initialPoseMatrixInverse),
            frames: calibrationFrames,
            rays: calibrationRays // já em referencial do mundo fixo
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
    // Read current orientation values (as numbers) to use for rotation
    const pitchDegLive = parseFloat(pitchEl.textContent) || 0;
    const yawDegLive = parseFloat(yawEl.textContent) || 0;
    const rollDegLive = parseFloat(rollEl.textContent) || 0;

    let blackPixelCount = 0;
    let raysDefinedCount = 0;
    const BLACK_THR = 30;

    // Precompute current camera-to-world transformation in world referential:
    // cameraPoseCurrent (4x4) built from txMm,tyMm,computedZ,yawDegLive,pitchDegLive,rollDegLive
    // transformToWorld = inverse(initialPose) * cameraPoseCurrent  (so coordinates are expressed in the world fixed at t0)
    let transformToWorld = null;
    if (isCalibrating && initialPoseCaptured) {
        // use txMm/tyMm/computedZ (should be numbers during calibragem)
        const txUse = txMm !== null ? txMm : 0.0;
        const tyUse = tyMm !== null ? tyMm : 0.0;
        const tzUse = computedZ !== null ? computedZ : baseZmm;

        const cameraPoseCurrent = poseMatrixFromYawPitchRollAndTranslation(txUse, tyUse, tzUse, yawDegLive, pitchDegLive, rollDegLive);
        // transform current camera pose into world referential (world = initial camera pose)
        transformToWorld = multiplyMat4(initialPoseMatrixInverse, cameraPoseCurrent);
        // transformToWorld maps points expressed in camera coordinates into world coordinates
    }

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

            // compute pinhole direction for this pixel in camera frame
            const dirCamera = computePinholeDirection(x, y);
            if (dirCamera && isFinite(dirCamera.x) && isFinite(dirCamera.y) && isFinite(dirCamera.z)) {
                // Transform this direction into the fixed world reference using transformToWorld (rotation part)
                if (transformToWorld) {
                    const dirWorldRaw = applyRotationFromMat4(transformToWorld, dirCamera);
                    // normalize
                    const mag = Math.hypot(dirWorldRaw.x, dirWorldRaw.y, dirWorldRaw.z);
                    if (mag > 0 && isFinite(mag)) {
                        const dirWorld = { dx: Number((dirWorldRaw.x / mag).toFixed(6)), dy: Number((dirWorldRaw.y / mag).toFixed(6)), dz: Number((dirWorldRaw.z / mag).toFixed(6)) };

                        // origin in world coordinates = translation part of transformToWorld (camera center in world frame)
                        const originWorld = extractTranslationFromMat4(transformToWorld);

                        raysDefinedCount++;

                        calibrationRays.push({
                            origin: { x: Number(originWorld.x.toFixed(4)), y: Number(originWorld.y.toFixed(4)), z: Number(originWorld.z.toFixed(4)) },
                            direction: dirWorld
                        });
                    }
                } else {
                    // fallback: if for some reason transform not ready, still provide rotated ray in camera-local rotated frame (previous behavior)
                    const dirRotated = rotateVectorByYawPitchRoll(dirCamera, yawDegLive, pitchDegLive, rollDegLive);
                    if (dirRotated) {
                        const originX = txMm !== null ? Number(txMm.toFixed(4)) : null;
                        const originY = tyMm !== null ? Number(tyMm.toFixed(4)) : null;
                        const originZ = computedZ !== null ? Number(computedZ.toFixed(4)) : (isCalibrated ? Number(baseZmm.toFixed(4)) : null);

                        raysDefinedCount++;

                        calibrationRays.push({
                            origin: { x: originX, y: originY, z: originZ },
                            direction: { dx: Number(dirRotated.x.toFixed(6)), dy: Number(dirRotated.y.toFixed(6)), dz: Number(dirRotated.z.toFixed(6)) }
                        });
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
    } else {
        // quando não calibrando, contador deve mostrar 0
        raysEl.textContent = "0";
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
