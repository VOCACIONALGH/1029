/* main.js
   Atualizações:
   - Define um sistema de coordenadas do mundo fixo no instante inicial da calibração.
   - Exibe "Mundo fixado" quando o mundo é fixado.
   - Para cada frame da calibragem: converte a pose da câmera em matriz homogênea 4x4,
     transforma-a para o referencial do mundo fixo (usando a inversa da pose inicial),
     e exprime cada raio 3D (origem + direção) no referencial do mundo fixo.
   - As direções são normalizadas; as origens estão em mm no referencial do mundo fixo.
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
const worldMsgEl = document.getElementById("worldMsg");

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

// world-fixed reference
let worldFixed = false;
let initialPose = null;       // initial pose object captured at the instant of fixation
let initialPoseMatrix = null; // 4x4
let initialPoseInv = null;    // inverse 4x4
let initialInvR = null;       // 3x3 inverse rotation (for directions)

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
    // Escolha razoável: use a maior dimensão e um fator para obter f em ordem de pixels.
    // Isso é apenas uma aproximação (o real depende da câmera).
    const f = Math.max(canvas.width, canvas.height) * 0.9;

    // coordinates in camera frame (z forward)
    const vx = (px - cx) / f;
    const vy = (py - cy) / f;
    const vz = 1.0;

    const norm = Math.hypot(vx, vy, vz);
    if (!isFinite(norm) || norm === 0) return null;

    return { x: vx / norm, y: vy / norm, z: vz / norm };
}

/* --- Rotation utilities: yaw (Z), pitch (X), roll (Y) ---
   Convert degrees -> radians, build combined rotation matrix R = Rz(yaw) * Rx(pitch) * Ry(roll)
   and apply to vectors. Result is normalized.
*/
function degToRad(deg) {
    return deg * Math.PI / 180;
}

function buildRotationMatrix(yawRad, pitchRad, rollRad) {
    // Rz (yaw)
    const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
    const Rz = [
        [ cy, -sy, 0 ],
        [ sy,  cy, 0 ],
        [  0,   0, 1 ]
    ];

    // Rx (pitch)
    const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
    const Rx = [
        [ 1,   0,   0 ],
        [ 0,  cp, -sp ],
        [ 0,  sp,  cp ]
    ];

    // Ry (roll)
    const cr = Math.cos(rollRad), sr = Math.sin(rollRad);
    const Ry = [
        [ cr, 0, sr ],
        [  0, 1,  0 ],
        [ -sr,0, cr ]
    ];

    // Multiply Rz * Rx -> tmp, then tmp * Ry -> R
    const tmp = multiplyMatrix3(Rz, Rx);
    const R = multiplyMatrix3(tmp, Ry);
    return R;
}

function multiplyMatrix3(A, B) {
    const C = [
        [0,0,0],
        [0,0,0],
        [0,0,0]
    ];
    for (let i=0;i<3;i++){
        for (let j=0;j<3;j++){
            let s = 0;
            for (let k=0;k<3;k++) s += A[i][k] * B[k][j];
            C[i][j] = s;
        }
    }
    return C;
}

function applyRotationToVec(v, R) {
    if (!R) return v;
    const x = R[0][0]*v.x + R[0][1]*v.y + R[0][2]*v.z;
    const y = R[1][0]*v.x + R[1][1]*v.y + R[1][2]*v.z;
    const z = R[2][0]*v.x + R[2][1]*v.y + R[2][2]*v.z;
    const mag = Math.hypot(x, y, z);
    if (!isFinite(mag) || mag === 0) return null;
    return { x: x/mag, y: y/mag, z: z/mag };
}

/* --- 4x4 pose helpers (R from buildRotationMatrix, t in mm) --- */
function buildPoseMatrix(tx, ty, tz, yawRad, pitchRad, rollRad) {
    const R = buildRotationMatrix(yawRad, pitchRad, rollRad);
    // 4x4: [ R | t ]
    return [
        [ R[0][0], R[0][1], R[0][2], tx ],
        [ R[1][0], R[1][1], R[1][2], ty ],
        [ R[2][0], R[2][1], R[2][2], tz ],
        [ 0,       0,       0,       1  ]
    ];
}

// inverse of rigid transform [R | t; 0 1] is [R^T | -R^T t; 0 1]
function invertPoseMatrix(T) {
    const R = [
        [T[0][0], T[0][1], T[0][2]],
        [T[1][0], T[1][1], T[1][2]],
        [T[2][0], T[2][1], T[2][2]]
    ];
    // transpose
    const Rt = [
        [R[0][0], R[1][0], R[2][0]],
        [R[0][1], R[1][1], R[2][1]],
        [R[0][2], R[1][2], R[2][2]]
    ];
    const t = [ T[0][3], T[1][3], T[2][3] ];
    const negRtT = [
        -(Rt[0][0]*t[0] + Rt[0][1]*t[1] + Rt[0][2]*t[2]),
        -(Rt[1][0]*t[0] + Rt[1][1]*t[1] + Rt[1][2]*t[2]),
        -(Rt[2][0]*t[0] + Rt[2][1]*t[1] + Rt[2][2]*t[2])
    ];
    return [
        [ Rt[0][0], Rt[0][1], Rt[0][2], negRtT[0] ],
        [ Rt[1][0], Rt[1][1], Rt[1][2], negRtT[1] ],
        [ Rt[2][0], Rt[2][1], Rt[2][2], negRtT[2] ],
        [ 0,        0,        0,        1         ]
    ];
}

function multiplyMatrix4(A, B) {
    const C = Array.from({length:4}, () => Array(4).fill(0));
    for (let i=0;i<4;i++){
        for (let j=0;j<4;j++){
            let s = 0;
            for (let k=0;k<4;k++) s += A[i][k] * B[k][j];
            C[i][j] = s;
        }
    }
    return C;
}

function applyPoseToPoint(T, p) { // p: {x,y,z}
    const x = T[0][0]*p.x + T[0][1]*p.y + T[0][2]*p.z + T[0][3];
    const y = T[1][0]*p.x + T[1][1]*p.y + T[1][2]*p.z + T[1][3];
    const z = T[2][0]*p.x + T[2][1]*p.y + T[2][2]*p.z + T[2][3];
    return { x, y, z };
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
 - If not currently calibrating: validate origin & scale, prompt +Z, lock scale, record base origin and start collecting frames (isCalibrating = true), FIXAR o MUNDO (capturar pose inicial).
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

        // FIXAR o mundo: capture pose inicial (x,y,z e yaw/pitch/roll)
        // Use os valores visíveis atualmente (xEl,yEl,zEl podem estar em "0.00" por design no instante de fixação)
        // Por segurança, use os valores calculados a partir das leitura ao toque: xEl,yEl,zEl exibem mm
        const initX = parseFloat(xEl.textContent) || 0;
        const initY = parseFloat(yEl.textContent) || 0;
        const initZ = parseFloat(zEl.textContent) || 0;
        const initPitch = parseFloat(pitchEl.textContent) || 0;
        const initYaw = parseFloat(yawEl.textContent) || 0;
        const initRoll = parseFloat(rollEl.textContent) || 0;

        initialPose = {
            x_mm: initX,
            y_mm: initY,
            z_mm: initZ,
            pitch_deg: initPitch,
            yaw_deg: initYaw,
            roll_deg: initRoll
        };

        // build initial pose matrix and its inverse
        const yawRad0 = degToRad(initYaw);
        const pitchRad0 = degToRad(initPitch);
        const rollRad0 = degToRad(initRoll);
        initialPoseMatrix = buildPoseMatrix(initX, initY, initZ, yawRad0, pitchRad0, rollRad0);
        initialPoseInv = invertPoseMatrix(initialPoseMatrix);
        // store inverse rotation (3x3) for quick direction transforms
        initialInvR = [
            [ initialPoseInv[0][0], initialPoseInv[0][1], initialPoseInv[0][2] ],
            [ initialPoseInv[1][0], initialPoseInv[1][1], initialPoseInv[1][2] ],
            [ initialPoseInv[2][0], initialPoseInv[2][1], initialPoseInv[2][2] ]
        ];

        // mark world fixed and show message
        worldFixed = true;
        worldMsgEl.hidden = false;
        worldMsgEl.textContent = "Mundo fixado";

        // display locked scale & base Z
        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        xEl.textContent = "0.00";
        yEl.textContent = "0.00";
        raysEl.textContent = "0";

        alert("Calibragem iniciada e mundo fixado. Mova a câmera para coletar dados e clique em 'Calibrar' novamente para finalizar e baixar o arquivo .json.");
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
            initialPose,
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

    // NEW: count black pixels for ray estimation in this frame
    let blackPixelCount = 0;
    // NEW: count of black pixels for which we successfully defined a direction via pinhole + rotation + transform
    let raysDefinedCount = 0;
    const BLACK_THR = 30;

    // Prepare rotation matrix for this frame if calibrating (camera orientation -> device/world)
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

    // TEMP store of black-pixel directions (in camera/device-rotated frame) for later transform to world
    const blackRaysTemp = []; // { px, py, dir_cam_rotated }

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

        // ---- ADDED: during calibragem, recolor visualmente pixels pretos para vermelho, contar e calcular direção via pinhole + rotate ----
        if (isCalibrating && r < BLACK_THR && g < BLACK_THR && b < BLACK_THR) {
            // paint visually red
            d[i] = 255;
            d[i + 1] = 0;
            d[i + 2] = 0;

            // increment black pixel count (cada define um raio)
            blackPixelCount++;

            // compute pinhole direction for this pixel (camera frame)
            const dirCam = computePinholeDirection(x, y);
            if (dirCam && isFinite(dirCam.x) && isFinite(dirCam.y) && isFinite(dirCam.z)) {
                // rotate the direction with the device orientation matrix (camera -> device/world-local)
                const dirRot = applyRotationToVec(dirCam, rotationMatrix);
                if (dirRot) {
                    // store temporarily; we'll transform to world-fixed after we compute the camera pose for this frame
                    blackRaysTemp.push({ px: x, py: y, dir_cam_rot: dirRot });
                }
            }
        }
        // ---------------------------------------------------------------------------------------------------
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

    // Now: if calibragem ativa, transform stored black rays into the world-fixed reference
    if (isCalibrating) {
        const pitch = parseFloat(pitchEl.textContent) || 0;
        const yaw = parseFloat(yawEl.textContent) || 0;
        const roll = parseFloat(rollEl.textContent) || 0;

        // Build current camera pose matrix (in mm) using txMm, tyMm, computedZ and yaw/pitch/roll
        // If txMm/tyMm/computedZ are null (missing), default to 0 to avoid crash (frame will have null pose)
        const camTx = txMm !== null ? txMm : 0;
        const camTy = tyMm !== null ? tyMm : 0;
        const camTz = computedZ !== null ? computedZ : 0;

        const yawRad = degToRad(yaw);
        const pitchRad = degToRad(pitch);
        const rollRad = degToRad(roll);

        const T_cam = buildPoseMatrix(camTx, camTy, camTz, yawRad, pitchRad, rollRad);

        // Transform camera pose to world-fixed reference: T_world_rel = initialPoseInv * T_cam
        // (if worldFixed; otherwise treat world == camera initial and simply use T_cam)
        let T_world_rel = T_cam;
        let R_world_rel = [
            [ T_cam[0][0], T_cam[0][1], T_cam[0][2] ],
            [ T_cam[1][0], T_cam[1][1], T_cam[1][2] ],
            [ T_cam[2][0], T_cam[2][1], T_cam[2][2] ]
        ];
        let t_world_rel = { x: T_cam[0][3], y: T_cam[1][3], z: T_cam[2][3] };

        if (worldFixed && initialPoseInv) {
            T_world_rel = multiplyMatrix4(initialPoseInv, T_cam);
            R_world_rel = [
                [ T_world_rel[0][0], T_world_rel[0][1], T_world_rel[0][2] ],
                [ T_world_rel[1][0], T_world_rel[1][1], T_world_rel[1][2] ],
                [ T_world_rel[2][0], T_world_rel[2][1], T_world_rel[2][2] ]
            ];
            t_world_rel = { x: T_world_rel[0][3], y: T_world_rel[1][3], z: T_world_rel[2][3] };
        }

        // For each stored rotated camera-direction, compute world direction: dir_world = R_world_rel * dir_cam_rot
        const raysWorld = [];
        for (let k = 0; k < blackRaysTemp.length; k++) {
            const entry = blackRaysTemp[k];
            const dirCamRot = entry.dir_cam_rot; // already rotated by current rotationMatrix earlier
            // apply R_world_rel (3x3)
            const rx = R_world_rel[0][0]*dirCamRot.x + R_world_rel[0][1]*dirCamRot.y + R_world_rel[0][2]*dirCamRot.z;
            const ry = R_world_rel[1][0]*dirCamRot.x + R_world_rel[1][1]*dirCamRot.y + R_world_rel[1][2]*dirCamRot.z;
            const rz = R_world_rel[2][0]*dirCamRot.x + R_world_rel[2][1]*dirCamRot.y + R_world_rel[2][2]*dirCamRot.z;
            const mag = Math.hypot(rx, ry, rz);
            if (!isFinite(mag) || mag === 0) continue;
            const dirWorld = { dx: rx / mag, dy: ry / mag, dz: rz / mag };
            // origin of ray in world-fixed coordinates is the camera origin transformed: that's t_world_rel (in mm)
            const originWorld = { x: t_world_rel.x, y: t_world_rel.y, z: t_world_rel.z };
            raysWorld.push({ origin: originWorld, direction: dirWorld });
        }

        // push frame record (pose + rays expressed in world-fixed coordinates)
        const record = {
            timestamp: new Date().toISOString(),
            // camera pose in world-fixed coordinates (translation & rotation as displayed)
            x_mm: camTx !== null ? Number(camTx.toFixed(4)) : null,
            y_mm: camTy !== null ? Number(camTy.toFixed(4)) : null,
            z_mm: camTz !== null ? Number(camTz.toFixed(4)) : null,
            pitch_deg: Number(pitch.toFixed(3)),
            yaw_deg: Number(yaw.toFixed(3)),
            roll_deg: Number(roll.toFixed(3)),
            // rays: array of { origin: {x,y,z}, direction: {dx,dy,dz} } all in world-fixed coordinates
            rays: raysWorld
        };
        calibrationFrames.push(record);

        // update rays display (número de pixels pretos que tiveram direção definida e transformada para o mundo)
        raysDefinedCount = raysWorld.length;
        raysEl.textContent = String(raysDefinedCount);
    } else {
        // quando não calibrando, contador deve mostrar 0
        raysEl.textContent = "0";
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
