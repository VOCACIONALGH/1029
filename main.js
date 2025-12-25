/* main.js
   Atualização: durante a calibração a nuvem de pontos triangulados é salva em um arquivo .json.
   O botão "Download" aparece durante a calibração para baixar a nuvem de pontos.
   Nenhuma outra funcionalidade foi alterada.
*/

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadBtn = document.getElementById("downloadBtn");

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
const triagEl = document.getElementById("triangValue");
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

// ACUMULAÇÃO DE RAIOS (em world-fixed) para triangulação
// Cada item: { origin: {x,y,z}, direction: {dx,dy,dz}, frameTimestamp: string }
let accumulatedRays = [];

// PONTOS TRIANGULADOS DETERMINADOS (lista de {x,y,z})
let triangulatedPoints = [];

// parâmetros de triangulação / fusão (ajustáveis)
const TRIANG_DIST_THR_MM = 1;   // distância máxima entre as duas linhas no ponto de menor aproximação para aceitar triangulação
const MERGE_THR_MM = 5.0;         // distância para considerar dois pontos como o mesmo (merge)

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

/* --- Rotation utilities: yaw (Z), pitch (X), roll (Y) --- */
function degToRad(deg) {
    return deg * Math.PI / 180;
}

function buildRotationMatrix(yawRad, pitchRad, rollRad) {
    const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
    const Rz = [
        [ cy, -sy, 0 ],
        [ sy,  cy, 0 ],
        [  0,   0, 1 ]
    ];

    const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
    const Rx = [
        [ 1,   0,   0 ],
        [ 0,  cp, -sp ],
        [ 0,  sp,  cp ]
    ];

    const cr = Math.cos(rollRad), sr = Math.sin(rollRad);
    const Ry = [
        [ cr, 0, sr ],
        [  0, 1,  0 ],
        [ -sr,0, cr ]
    ];

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

/* --- 4x4 pose helpers --- */
function buildPoseMatrix(tx, ty, tz, yawRad, pitchRad, rollRad) {
    const R = buildRotationMatrix(yawRad, pitchRad, rollRad);
    return [
        [ R[0][0], R[0][1], R[0][2], tx ],
        [ R[1][0], R[1][1], R[1][2], ty ],
        [ R[2][0], R[2][1], R[2][2], tz ],
        [ 0,       0,       0,       1  ]
    ];
}

function invertPoseMatrix(T) {
    const R = [
        [T[0][0], T[0][1], T[0][2]],
        [T[1][0], T[1][1], T[1][2]],
        [T[2][0], T[2][1], T[2][2]]
    ];
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

/* --- UTIL: triangulação entre duas retas (o1 + s*d1, o2 + t*d2)
   Retorna { p1, p2, midpoint, dist } onde p1 e p2 são os pontos de menor aproximação
*/
function closestPointsBetweenLines(o1, d1, o2, d2) {
    const w0 = { x: o1.x - o2.x, y: o1.y - o2.y, z: o1.z - o2.z };
    const a = dot(d1, d1);
    const b = dot(d1, d2);
    const c = dot(d2, d2);
    const d = dot(d1, w0);
    const e = dot(d2, w0);

    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-12) {
        return null;
    }
    const s = (b * e - c * d) / denom;
    const t = (a * e - b * d) / denom;

    const p1 = { x: o1.x + d1.x * s, y: o1.y + d1.y * s, z: o1.z + d1.z * s };
    const p2 = { x: o2.x + d2.x * t, y: o2.y + d2.y * t, z: o2.z + d2.z * t };
    const mid = { x: 0.5 * (p1.x + p2.x), y: 0.5 * (p1.y + p2.y), z: 0.5 * (p1.z + p2.z) };
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
    return { p1, p2, midpoint: mid, dist, s, t };
}

function dot(a, b) {
    return a.x*b.x + a.y*b.y + a.z*b.z;
}

function updateTriangCountUI() {
    triagEl.textContent = String(triangulatedPoints.length);
}

/* tenta triangular newRays contra accumulatedRays, atualiza triangulatedPoints e accumulatedRays. */
function tryTriangulateAndAccumulate(newRays) {
    for (let i = 0; i < newRays.length; i++) {
        const nr = newRays[i];
        for (let j = 0; j < accumulatedRays.length; j++) {
            const ar = accumulatedRays[j];
            if (nr.frameTimestamp === ar.frameTimestamp) continue;

            const cp = closestPointsBetweenLines(
                nr.origin, { x: nr.direction.dx, y: nr.direction.dy, z: nr.direction.dz },
                ar.origin, { x: ar.direction.dx, y: ar.direction.dy, z: ar.direction.dz }
            );
            if (!cp) continue;
            if (cp.dist <= TRIANG_DIST_THR_MM) {
                const pt = {
                    x: Number(cp.midpoint.x.toFixed(4)),
                    y: Number(cp.midpoint.y.toFixed(4)),
                    z: Number(cp.midpoint.z.toFixed(4))
                };
                let merged = false;
                for (let k = 0; k < triangulatedPoints.length; k++) {
                    const p = triangulatedPoints[k];
                    const d = Math.hypot(p.x - pt.x, p.y - pt.y, p.z - pt.z);
                    if (d <= MERGE_THR_MM) {
                        merged = true;
                        break;
                    }
                }
                if (!merged) {
                    triangulatedPoints.push(pt);
                    updateTriangCountUI();
                }
            }
        }
    }

    for (let i = 0; i < newRays.length; i++) {
        accumulatedRays.push(newRays[i]);
    }
}

/* handler do botão de download: baixa a nuvem de pontos triangulados em .json */
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

        // FIXAR o mundo: capture pose inicial
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

        const yawRad0 = degToRad(initYaw);
        const pitchRad0 = degToRad(initPitch);
        const rollRad0 = degToRad(initRoll);
        initialPoseMatrix = buildPoseMatrix(initX, initY, initZ, yawRad0, pitchRad0, rollRad0);
        initialPoseInv = invertPoseMatrix(initialPoseMatrix);

        // reset accumulators when fixando o mundo
        accumulatedRays = [];
        triangulatedPoints = [];
        updateTriangCountUI();

        // mark world fixed and show message
        worldFixed = true;
        worldMsgEl.hidden = false;
        worldMsgEl.textContent = "Mundo fixado";

        // show download button during calibration
        downloadBtn.hidden = false;

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

        // hide download button when calibration ends
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

    let blackPixelCount = 0;
    const BLACK_THR = 30;

    // Prepare rotation matrix for this frame if calibrating
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

    // temporary store of dir vectors (already rotated by device orientation) for black pixels this frame
    const blackRaysTemp = []; // { px, py, dir_cam_rot }

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

        if (isCalibrating && r < BLACK_THR && g < BLACK_THR && b < BLACK_THR) {
            d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
            blackPixelCount++;

            const dirCam = computePinholeDirection(x, y);
            if (dirCam) {
                const dirRot = applyRotationToVec(dirCam, rotationMatrix);
                if (dirRot) {
                    blackRaysTemp.push({ px: x, py: y, dir_cam_rot: dirRot });
                }
            }
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
    }

    if (gC) {
        g = { x: gX / gC, y: gY / gC };
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

    // If calibragem ativa, transform stored black rays into the world-fixed reference and attempt triangulação
    if (isCalibrating) {
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

        // Build rays in world-fixed coordinates; each ray follows format { origin, direction, frameTimestamp }
        const raysWorld = [];
        const frameTimestamp = new Date().toISOString();
        for (let k = 0; k < blackRaysTemp.length; k++) {
            const dirCamRot = blackRaysTemp[k].dir_cam_rot;
            const rx = R_world_rel[0][0]*dirCamRot.x + R_world_rel[0][1]*dirCamRot.y + R_world_rel[0][2]*dirCamRot.z;
            const ry = R_world_rel[1][0]*dirCamRot.x + R_world_rel[1][1]*dirCamRot.y + R_world_rel[1][2]*dirCamRot.z;
            const rz = R_world_rel[2][0]*dirCamRot.x + R_world_rel[2][1]*dirCamRot.y + R_world_rel[2][2]*dirCamRot.z;
            const mag = Math.hypot(rx, ry, rz);
            if (!isFinite(mag) || mag === 0) continue;
            const dirWorld = { dx: rx / mag, dy: ry / mag, dz: rz / mag };
            const originWorld = { x: t_world_rel.x, y: t_world_rel.y, z: t_world_rel.z };
            raysWorld.push({ origin: originWorld, direction: dirWorld, frameTimestamp });
        }

        // Append frame record (keeps previous behavior)
        const frameRecord = {
            timestamp: frameTimestamp,
            rays: raysWorld
        };
        calibrationFrames.push(frameRecord);

        // TRY TRIANGULATION: compare new rays (raysWorld) against accumulatedRays and update triangulatedPoints
        tryTriangulateAndAccumulate(raysWorld);

        // update rays display (número de raios registrados neste frame)
        raysEl.textContent = String(raysWorld.length);
    } else {
        raysEl.textContent = "0";
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
