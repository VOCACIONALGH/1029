/* main.js
   Atualizações:
   - Durante a calibragem, pixels pretos (RGB baixos) continuam sendo pintados de vermelho visualmente.
   - Durante a calibragem, quando os vetores base são conhecidos, cada pixel preto mapeado tem sua posição XY (mm) calculada e **registrada cumulativamente**.
   - A tela exibe a contagem cumulativa de pixels pretos registrados.
   - Ao finalizar a calibragem (botão "Calibrar"), o arquivo .json agora inclui um array `black_points` com cada ponto registrado contendo:
       { x_mm, y_mm, timestamp, camera_pose: { x_mm, y_mm, z_mm, pitch_deg, yaw_deg, roll_deg } }
   - Nenhuma outra função foi alterada.
*/

const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");

const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const redCountDisplay = document.getElementById("redCount");
const blackRegisteredCountDisplay = document.getElementById("blackRegisteredCount");
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

// base vectors (px per mm) used to map pixels -> XY mm during calibragem
let baseVecX_px = null; // {x,y} px per mm along X-axis
let baseVecY_px = null; // {x,y} px per mm along Y-axis
let baseVecSet = false;

// cumulative registered black points across the whole calibration session
// Each entry: { x_mm, y_mm, timestamp, camera_pose: { x_mm, y_mm, z_mm, pitch_deg, yaw_deg, roll_deg } }
let cumulativeBlackPoints = [];

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
 - If not currently calibrating: validate origin & scale, prompt +Z, lock scale, record base origin and start collecting frames (isCalibrating = true).
 - If currently calibrating: finish collecting, generate JSON with recorded frames + cumulative black points, download automatically, stop collecting (isCalibrating = false). Keep calibration locked (isCalibrated = true).
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

        // start collecting frames (calibragem ativa)
        isCalibrating = true;
        calibrationFrames = [];

        // display locked scale & base Z
        scaleEl.textContent = lockedScale.toFixed(3);
        zEl.textContent = baseZmm.toFixed(2);
        xEl.textContent = "0.00";
        yEl.textContent = "0.00";
        blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;

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
            frames: calibrationFrames,
            black_points: cumulativeBlackPoints
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

        // ---- ADDED: during calibragem, recolor visually pixels pretos para vermelho ----
        // Criteria for "preto": all channels below BLACK_THR
        const BLACK_THR = 30;
        if (isCalibrating && r < BLACK_THR && g < BLACK_THR && b < BLACK_THR) {
            // paint visually red (does not affect detection for this iteration which already ran above)
            d[i] = 255;
            d[i + 1] = 0;
            d[i + 2] = 0;

            // store pixel coordinates for later mapping (use original screen coords)
            const p = i / 4, x = p % canvas.width, y = (p / canvas.width) | 0;
            blackPixels.push({ x, y });
        }
        // -------------------------------------------------------------------------------
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
        // direction from red to blue / green
        const dxB = lastBcentroid.x - lastRcentroid.x;
        const dyB = lastBcentroid.y - lastRcentroid.y;
        const magB = Math.hypot(dxB, dyB);

        const dxG = lastGcentroid.x - lastRcentroid.x;
        const dyG = lastGcentroid.y - lastRcentroid.y;
        const magG = Math.hypot(dxG, dyG);

        if (magB > 5 && magG > 5) {
            // unit vectors
            const ux = { x: dxB / magB, y: dyB / magB };
            const uy = { x: dxG / magG, y: dyG / magG };

            // baseVec in pixels per mm = unit direction * lockedScale (px/mm)
            baseVecX_px = { x: ux.x * lockedScale, y: ux.y * lockedScale };
            baseVecY_px = { x: uy.x * lockedScale, y: uy.y * lockedScale };
            baseVecSet = true;
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

    // ---- NEW: map black pixels to XY (mm) using baseOriginScreen and baseVecs, register cumulatively ----
    if (isCalibrating && baseVecSet && baseOriginScreen && blackPixels.length > 0) {
        // prepare matrix M = [ [ux.x, uy.x], [ux.y, uy.y] ]
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
                    // register cumulatively
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
                        }
                    });
                }
            }
        }
    }
    // update cumulative count on screen
    blackRegisteredCountDisplay.textContent = `Pixels pretos registrados (cumulativo): ${cumulativeBlackPoints.length}`;
    // ---- end mapping & registration logic ----

    redCountDisplay.textContent = `Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
