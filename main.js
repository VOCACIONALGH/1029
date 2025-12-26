// main.js — versão corrigida com alterações mínimas (agrupamento por pixel, inclusão de pixel em ray, reprojeção média)
const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadBtn = document.getElementById("downloadBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const pcCanvas = document.getElementById("pcCanvas");
const pcCtx = pcCanvas.getContext("2d");

const blackSlider = document.getElementById("blackThreshold");
const blueSlider = document.getElementById("blueThreshold");
const greenSlider = document.getElementById("greenThreshold");

const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");

const scaleEl = document.getElementById("scale");
const scaleLockEl = document.getElementById("scaleLock");

const zCameraEl = document.getElementById("zCamera");
const zWorldEl = document.getElementById("zWorld");

const xCameraEl = document.getElementById("xCamera");
const yCameraEl = document.getElementById("yCamera");

const raysCountEl = document.getElementById("raysCount");
const pinkDirCountEl = document.getElementById("pinkDirCount");
const rotatedCountEl = document.getElementById("rotatedCount");
const triangulatedCountEl = document.getElementById("triangulatedCount");

let pitch = 0, yaw = 0, roll = 0;

let pixelPerMM_current = 0;
let pixelPerMM_locked = null;
let calibration_px = null;
let calibrationZ_mm = null;
let isCalibrated = false;

let lastAvgPx = null;

let currentOriginX = null;
let currentOriginY = null;
let originCalX = null;
let originCalY = null;

let cameraX_mm = 0;
let cameraY_mm = 0;
let cameraZ_mm = null;

let isRecording = false;
let calibrationLog = [];
let calibrationStartTime = null;

// logs e contadores
let raysCount = 0;
let raysLog = []; // agora inclui pixel: { origin:{x,y,z}, direction:{dx,dy,dz}, pixel:{x,y}, t }

let pinkDirCount = 0;
let rotatedCount = 0;

// triangulação
let nRaysRequired = null;
let pendingRaysForTriang = []; // raios world-fixed aguardando agrupamento
let triangulatedPoints = []; // { x,y,z, residual, numRays, t, avgPixel: {x,y} }
let triangulatedCount = 0;

// para desenhar pontos triangulados na tela principal (em pixels)
// cada entrada: { x, y } (coordenadas da imagem, média dos pixels dos rays usados)
let triangulatedScreenPoints = [];

// Matrizes homogeneas iniciais
let initialCamH = null;
let initialCamHInv = null;

const TRI_PIXEL_TOL = 8; // tolerância em pixels para agrupar raios (ajustável)
const TRI_RESIDUAL_THRESH = 12; // mm, limiar de aceitação do resíduo médio (ajustável)
const REGULARIZATION_EPS = 1e-6; // para estabilizar inversão 3x3

// request camera: use ideal facingMode e fallback
async function openCamera() {
    try {
        return await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false
        });
    } catch (err) {
        // fallback sem facingMode — melhora compatibilidade em desktops
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
}

scanBtn.addEventListener("click", async () => {
    const stream = await openCamera();
    video.srcObject = stream;

    video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        processFrame();
    };

    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission === "granted") {
                window.addEventListener("deviceorientation", onOrientation);
            }
        } catch {}
    } else {
        window.addEventListener("deviceorientation", onOrientation);
    }
});

downloadBtn.addEventListener("click", () => {
    const payload = {
        meta: {
            generatedAt: Date.now(),
            pointCount: triangulatedPoints.length,
            nRaysRequired: nRaysRequired
        },
        points: triangulatedPoints
    };

    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = (new Date()).toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `pointcloud_${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
});

calibrateBtn.addEventListener("click", () => {
    if (!isCalibrated) {
        const nrInput = prompt("Informe a quantidade de raios necessários para triangular cada ponto rosa (inteiro >= 2):", "3");
        if (!nrInput) {
            alert("Calibração cancelada: número de raios não fornecido.");
            return;
        }
        const nr = parseInt(nrInput, 10);
        if (isNaN(nr) || nr < 2) {
            alert("Valor inválido para número de raios. Calibração cancelada.");
            return;
        }
        nRaysRequired = nr;

        if (!lastAvgPx || lastAvgPx <= 0) {
            alert("Impossível calibrar: não foi detectada distância entre origem e pontos. Certifique-se de que origem e pontos existam na cena.");
            return;
        }
        if (currentOriginX === null || currentOriginY === null) {
            alert("Impossível calibrar: origem (ponto branco) não detectada no momento.");
            return;
        }

        const currentPixelPerMM = lastAvgPx / 100;
        pixelPerMM_locked = currentPixelPerMM;
        calibration_px = lastAvgPx;

        originCalX = currentOriginX;
        originCalY = currentOriginY;

        const input = prompt("Informe o valor atual de +Z em milímetros (por exemplo: 250):");
        if (!input) {
            pixelPerMM_locked = null;
            calibration_px = null;
            originCalX = null;
            originCalY = null;
            isCalibrated = false;
            scaleLockEl.textContent = "aberta";
            return;
        }
        const zVal = parseFloat(input.replace(",", "."));
        if (isNaN(zVal) || zVal <= 0) {
            alert("Valor de +Z inválido. Calibração cancelada.");
            pixelPerMM_locked = null;
            calibration_px = null;
            originCalX = null;
            originCalY = null;
            isCalibrated = false;
            scaleLockEl.textContent = "aberta";
            return;
        }

        calibrationZ_mm = zVal;
        isCalibrated = true;
        scaleLockEl.textContent = "travada";

        cameraX_mm = 0;
        cameraY_mm = 0;
        cameraZ_mm = calibrationZ_mm;

        initialCamH = buildHomogeneous(yaw, pitch, roll, cameraX_mm, cameraY_mm, cameraZ_mm);
        initialCamHInv = invertHomogeneous(initialCamH);

        isRecording = true;
        calibrationLog = [];
        calibrationStartTime = Date.now();

        raysCount = 0;
        raysLog = [];
        raysCountEl.textContent = raysCount.toString();

        pinkDirCount = 0;
        pinkDirCountEl.textContent = pinkDirCount.toString();

        rotatedCount = 0;
        rotatedCountEl.textContent = rotatedCount.toString();

        pendingRaysForTriang = [];
        triangulatedPoints = [];
        triangulatedCount = 0;
        triangulatedCountEl.textContent = triangulatedCount.toString();

        triangulatedScreenPoints = [];

        downloadBtn.style.display = "inline-block";
        downloadBtn.disabled = true;

        zCameraEl.textContent = cameraZ_mm.toFixed(2);
        xCameraEl.textContent = cameraX_mm.toFixed(2);
        yCameraEl.textContent = cameraY_mm.toFixed(2);

        clearPointCloudView();

        return;
    }

    if (isCalibrated && isRecording) {
        isRecording = false;
        downloadBtn.style.display = "none";

        const exportObj = {
            meta: {
                calibration_px: calibration_px,
                calibrationZ_mm: calibrationZ_mm,
                pixelPerMM_locked: pixelPerMM_locked,
                originCalX: originCalX,
                originCalY: originCalY,
                nRaysRequired: nRaysRequired,
                calibrationStart: calibrationStartTime,
                calibrationEnd: Date.now(),
                frames: calibrationLog.length,
                raysDefined: raysCount,
                pinkDirsDefined: pinkDirCount,
                rotatedDefined: rotatedCount,
                triangulatedCount: triangulatedPoints.length
            },
            frames: calibrationLog,
            rays: raysLog,
            triangulatedPoints: triangulatedPoints
        };

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const ts = (new Date()).toISOString().replace(/[:.]/g, "-");
        a.href = url;
        a.download = `calibration_log_${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        alert("Calibração finalizada. Arquivo JSON baixado.");
        return;
    }
});

// orientation
function onOrientation(e) {
    pitch = e.beta || 0;
    yaw = e.alpha || 0;
    roll = e.gamma || 0;

    pitchEl.textContent = pitch.toFixed(1);
    yawEl.textContent = yaw.toFixed(1);
    rollEl.textContent = roll.toFixed(1);
}

// --- matrices & util ---
function buildHomogeneous(alphaDeg, betaDeg, gammaDeg, tx, ty, tz) {
    const R = getRotationMatrix(alphaDeg, betaDeg, gammaDeg);
    return [
        [R[0][0], R[0][1], R[0][2], tx],
        [R[1][0], R[1][1], R[1][2], ty],
        [R[2][0], R[2][1], R[2][2], tz],
        [0, 0, 0, 1]
    ];
}

function invertHomogeneous(H) {
    const R = [
        [H[0][0], H[0][1], H[0][2]],
        [H[1][0], H[1][1], H[1][2]],
        [H[2][0], H[2][1], H[2][2]]
    ];
    const t = [H[0][3], H[1][3], H[2][3]];
    const RT = [
        [R[0][0], R[1][0], R[2][0]],
        [R[0][1], R[1][1], R[2][1]],
        [R[0][2], R[1][2], R[2][2]]
    ];
    const nt = [
        -(RT[0][0]*t[0] + RT[0][1]*t[1] + RT[0][2]*t[2]),
        -(RT[1][0]*t[0] + RT[1][1]*t[1] + RT[1][2]*t[2]),
        -(RT[2][0]*t[0] + RT[2][1]*t[1] + RT[2][2]*t[2])
    ];
    return [
        [RT[0][0], RT[0][1], RT[0][2], nt[0]],
        [RT[1][0], RT[1][1], RT[1][2], nt[1]],
        [RT[2][0], RT[2][1], RT[2][2], nt[2]],
        [0, 0, 0, 1]
    ];
}

function mul4(A, B) {
    const C = Array(4).fill(0).map(()=>Array(4).fill(0));
    for (let i=0;i<4;i++){
        for (let j=0;j<4;j++){
            let s = 0;
            for (let k=0;k<4;k++) s += A[i][k]*B[k][j];
            C[i][j] = s;
        }
    }
    return C;
}
function mul4Vec(M, v) {
    const out = [0,0,0,0];
    for (let i=0;i<4;i++){
        out[i] = M[i][0]*v[0] + M[i][1]*v[1] + M[i][2]*v[2] + M[i][3]*v[3];
    }
    return out;
}

function rgbToHsv(r,g,b){
    r/=255; g/=255; b/=255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const d = max - min;
    let h = 0; let s = max === 0 ? 0 : d / max; let v = max;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60; if (h < 0) h += 360;
    }
    return { h, s, v };
}

function drawArrow(x1,y1,x2,y2,color){
    const headLength = 10;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1,y1);
    ctx.lineTo(x2,y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(x2 - headLength * Math.cos(angle - Math.PI/6),
               y2 - headLength * Math.sin(angle - Math.PI/6));
    ctx.lineTo(x2 - headLength * Math.cos(angle + Math.PI/6),
               y2 - headLength * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fill();
}

function getRotationMatrix(alphaDeg,betaDeg,gammaDeg){
    const a = alphaDeg * Math.PI/180;
    const b = betaDeg * Math.PI/180;
    const g = gammaDeg * Math.PI/180;
    const Rz = [
        [Math.cos(a), -Math.sin(a), 0],
        [Math.sin(a), Math.cos(a), 0],
        [0,0,1]
    ];
    const Rx = [
        [1,0,0],
        [0, Math.cos(b), -Math.sin(b)],
        [0, Math.sin(b), Math.cos(b)]
    ];
    const Ry = [
        [Math.cos(g), 0, Math.sin(g)],
        [0,1,0],
        [-Math.sin(g), 0, Math.cos(g)]
    ];
    function mul(A,B){
        const C = Array(A.length).fill(0).map(()=>Array(B[0].length).fill(0));
        for (let i=0;i<A.length;i++){
            for (let j=0;j<B[0].length;j++){
                for (let k=0;k<B.length;k++){
                    C[i][j] += A[i][k]*B[k][j];
                }
            }
        }
        return C;
    }
    return mul(mul(Rz,Rx),Ry);
}

function matMulVec(M,v){
    return [
        M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
        M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
        M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
    ];
}

// --- triangulação por mínimos quadrados (usando apenas raios world-fixed) ---
function triangulateRaysWorld(rays) {
    if (!rays || rays.length < 2) return null;

    let A = [[0,0,0],[0,0,0],[0,0,0]];
    let b = [0,0,0];

    for (const r of rays) {
        if (!r.origin || !r.direction) return null;
        const o = [r.origin.x, r.origin.y, r.origin.z];
        const d = [r.direction.dx, r.direction.dy, r.direction.dz];
        const n = Math.hypot(d[0], d[1], d[2]) || 1;
        const dd = [d[0]/n, d[1]/n, d[2]/n];

        const M = [
            [1 - dd[0]*dd[0], -dd[0]*dd[1], -dd[0]*dd[2]],
            [-dd[1]*dd[0], 1 - dd[1]*dd[1], -dd[1]*dd[2]],
            [-dd[2]*dd[0], -dd[2]*dd[1], 1 - dd[2]*dd[2]]
        ];

        for (let i=0;i<3;i++){
            for (let j=0;j<3;j++){
                A[i][j] += M[i][j];
            }
        }
        for (let i=0;i<3;i++){
            b[i] += M[i][0]*o[0] + M[i][1]*o[1] + M[i][2]*o[2];
        }
    }

    // regularização leve
    for (let i=0;i<3;i++) A[i][i] += REGULARIZATION_EPS;

    const invA = invert3x3(A);
    if (!invA) return null;

    const x = [
        invA[0][0]*b[0] + invA[0][1]*b[1] + invA[0][2]*b[2],
        invA[1][0]*b[0] + invA[1][1]*b[1] + invA[1][2]*b[2],
        invA[2][0]*b[0] + invA[2][1]*b[1] + invA[2][2]*b[2]
    ];
    return { x: x[0], y: x[1], z: x[2] };
}

function invert3x3(M) {
    const a = M[0][0], b = M[0][1], c = M[0][2];
    const d = M[1][0], e = M[1][1], f = M[1][2];
    const g = M[2][0], h = M[2][1], i = M[2][2];

    const A = e*i - f*h;
    const B = -(d*i - f*g);
    const C = d*h - e*g;
    const D = -(b*i - c*h);
    const E = a*i - c*g;
    const F = -(a*h - b*g);
    const G = b*f - c*e;
    const H = -(a*f - c*d);
    const I = a*e - b*d;

    const det = a*A + b*B + c*C;
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    return [
        [A * invDet, D * invDet, G * invDet],
        [B * invDet, E * invDet, H * invDet],
        [C * invDet, F * invDet, I * invDet]
    ];
}

// --- point-cloud quick view utilities ---
function clearPointCloudView() {
    if (!pcCtx) return;
    pcCtx.clearRect(0,0,pcCanvas.width,pcCanvas.height);
    pcCtx.fillStyle = "#111";
    pcCtx.fillRect(0,0,pcCanvas.width,pcCanvas.height);
}

function updatePointCloudView() {
    if (!pcCtx) return;
    clearPointCloudView();
    const pts = triangulatedPoints;
    if (!pts || pts.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
        if (typeof p.x !== "number" || typeof p.y !== "number") continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX) || !isFinite(minY)) return;
    const pad = 1e-3;
    if (Math.abs(maxX - minX) < pad) { maxX = minX + 1; minX = minX - 1; }
    if (Math.abs(maxY - minY) < pad) { maxY = minY + 1; minY = minY - 1; }

    const w = pcCanvas.width, h = pcCanvas.height, margin = 8;
    const availW = w - 2*margin, availH = h - 2*margin;
    const scaleX = availW / (maxX - minX);
    const scaleY = availH / (maxY - minY);
    const scale = Math.min(scaleX, scaleY);

    pcCtx.fillStyle = "rgba(255,182,193,0.95)";
    for (const p of pts) {
        if (typeof p.x !== "number" || typeof p.y !== "number") continue;
        const sx = margin + (p.x - minX) * scale;
        const sy = margin + (maxY - p.y) * scale; // invert y
        pcCtx.fillRect(Math.round(sx)-1, Math.round(sy)-1, 3, 3);
    }
}

// returns indices of rays in pendingRaysForTriang within tol pixels of refPixel
function findCloseRaysIndices(refPixel, tolPx) {
    const indices = [];
    for (let i=0;i<pendingRaysForTriang.length;i++) {
        const r = pendingRaysForTriang[i];
        if (!r.pixel) continue;
        const dx = r.pixel.x - refPixel.x;
        const dy = r.pixel.y - refPixel.y;
        if (Math.hypot(dx,dy) <= tolPx) indices.push(i);
    }
    return indices;
}

// compute average perpendicular distance from point P to each ray (in mm)
function computeAvgResidual(point, rays) {
    // distance from point to line: || (o - p) x d ||
    let sum = 0; let count = 0;
    for (const r of rays) {
        const o = [r.origin.x, r.origin.y, r.origin.z];
        const d = [r.direction.dx, r.direction.dy, r.direction.dz];
        const n = Math.hypot(d[0],d[1],d[2]) || 1;
        const dd = [d[0]/n, d[1]/n, d[2]/n];
        const op = [point.x - o[0], point.y - o[1], point.z - o[2]];
        // cross product op x dd
        const cx = op[1]*dd[2] - op[2]*dd[1];
        const cy = op[2]*dd[0] - op[0]*dd[2];
        const cz = op[0]*dd[1] - op[1]*dd[0];
        const dist = Math.hypot(cx,cy,cz);
        sum += dist;
        count++;
    }
    return (count>0) ? (sum/count) : Infinity;
}

function processFrame() {
    if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0,0,canvas.width,canvas.height);
        const data = frame.data;

        const vBlack = blackSlider.value / 100;
        const sBlue = blueSlider.value / 100;
        const sGreen = greenSlider.value / 100;

        let sbx=0,sby=0,cb=0;
        let blx=0,bly=0,cbl=0;
        let grx=0,gry=0,cgr=0;
        let rdx=0,rdy=0,cr=0;

        for (let i=0;i<data.length;i+=4){
            const hsv = rgbToHsv(data[i],data[i+1],data[i+2]);
            const idx = i/4;
            const x = idx % canvas.width;
            const y = Math.floor(idx / canvas.width);

            if (hsv.v < vBlack) {
                data[i]=255; data[i+1]=165; data[i+2]=0;
                sbx+=x; sby+=y; cb++;
            } else if (hsv.h >= 200 && hsv.h <= 260 && hsv.s > sBlue) {
                data[i]=255; data[i+1]=255; data[i+2]=255;
                blx+=x; bly+=y; cbl++;
            } else if (hsv.h >= 90 && hsv.h <= 150 && hsv.s > sGreen) {
                data[i]=128; data[i+1]=0; data[i+2]=128;
                grx+=x; gry+=y; cgr++;
            }

            if ((hsv.h <= 15 || hsv.h >= 345) && hsv.s > 0.4 && hsv.v > 0.2) {
                rdx += x; rdy += y; cr++;
            }
        }

        ctx.putImageData(frame, 0, 0);

        // desenhar pontos triangulados persistentes (rosa claro) — desenhar *depois* dos desenhos atuais para evitar sobreposição indesejada
        let ox, oy, bx, by, gx, gy;
        let distBlue = 0, distGreen = 0, nDist = 0;

        if (cb > 0) {
            ox = sbx / cb; oy = sby / cb;
            ctx.fillStyle = "white";
            ctx.beginPath(); ctx.arc(ox,oy,4,0,Math.PI*2); ctx.fill();
            currentOriginX = ox; currentOriginY = oy;
        } else {
            currentOriginX = null; currentOriginY = null;
        }

        if (cbl > 0) {
            bx = blx / cbl; by = bly / cbl;
            ctx.fillStyle = "blue";
            ctx.beginPath(); ctx.arc(bx,by,4,0,Math.PI*2); ctx.fill();
            if (cb) { distBlue = Math.hypot(bx-ox,by-oy); nDist++; }
        }

        if (cgr > 0) {
            gx = grx / cgr; gy = gry / cgr;
            ctx.fillStyle = "green";
            ctx.beginPath(); ctx.arc(gx,gy,4,0,Math.PI*2); ctx.fill();
            if (cb) { distGreen = Math.hypot(gx-ox,gy-oy); nDist++; }
        }

        // centroid dos vermelhos (ponto rosa)
        let redCx = null, redCy = null;
        if (cr > 0) {
            redCx = rdx / cr; redCy = rdy / cr;
            ctx.fillStyle = "#FF69B4";
            ctx.beginPath(); ctx.arc(redCx, redCy, 4, 0, Math.PI*2); ctx.fill();

            if (isRecording && isCalibrated && pixelPerMM_locked && cameraZ_mm && initialCamHInv) {
                const f = pixelPerMM_locked * cameraZ_mm;
                if (f > 0 && canvas.width > 0 && canvas.height > 0) {
                    const cx = canvas.width / 2;
                    const cy = canvas.height / 2;
                    const u = redCx, v = redCy;
                    let dir_cam = [(u - cx)/f, (v - cy)/f, 1];
                    const normP = Math.hypot(dir_cam[0],dir_cam[1],dir_cam[2]) || 1;
                    dir_cam = [dir_cam[0]/normP, dir_cam[1]/normP, dir_cam[2]/normP];

                    pinkDirCount++;
                    pinkDirCountEl.textContent = pinkDirCount.toString();

                    const Hc = buildHomogeneous(yaw, pitch, roll, cameraX_mm, cameraY_mm, cameraZ_mm);
                    const Hrel = mul4(initialCamHInv, Hc);

                    const originWF4 = mul4Vec(Hrel, [0,0,0,1]);
                    const originWF = { x: originWF4[0], y: originWF4[1], z: originWF4[2] };

                    const Rrel = [
                        [Hrel[0][0], Hrel[0][1], Hrel[0][2]],
                        [Hrel[1][0], Hrel[1][1], Hrel[1][2]],
                        [Hrel[2][0], Hrel[2][1], Hrel[2][2]]
                    ];
                    let dir_world = matMulVec(Rrel, dir_cam);
                    const normW = Math.hypot(dir_world[0],dir_world[1],dir_world[2]) || 1;
                    dir_world = [dir_world[0]/normW, dir_world[1]/normW, dir_world[2]/normW];

                    rotatedCount++;
                    rotatedCountEl.textContent = rotatedCount.toString();

                    // registrar pixel também — essencial para agrupamento
                    const rayWorld = {
                        origin: originWF,
                        direction: { dx: dir_world[0], dy: dir_world[1], dz: dir_world[2] },
                        pixel: { x: u, y: v },
                        t: Date.now()
                    };

                    raysLog.push(rayWorld);
                    raysCount++;
                    raysCountEl.textContent = raysCount.toString();

                    // acumular para triangulação
                    pendingRaysForTriang.push(rayWorld);

                    // tentar agrupar: usar o pixel do novo raio como referência
                    if (nRaysRequired && pendingRaysForTriang.length >= nRaysRequired) {
                        // procurar índices de raios próximos ao pixel atual
                        const closeIdx = findCloseRaysIndices(rayWorld.pixel, TRI_PIXEL_TOL);
                        if (closeIdx.length >= nRaysRequired) {
                            // selecionar os N mais antigos entre os índices encontrados
                            closeIdx.sort((a,b)=> pendingRaysForTriang[a].t - pendingRaysForTriang[b].t);
                            const takeIdx = closeIdx.slice(0, nRaysRequired);
                            const subset = takeIdx.map(i => pendingRaysForTriang[i]);

                            // triangular
                            const tri = triangulateRaysWorld(subset);
                            if (tri) {
                                const residual = computeAvgResidual(tri, subset);
                                if (isFinite(residual) && residual <= TRI_RESIDUAL_THRESH) {
                                    // média de pixel para desenhar na tela
                                    let sumX=0,sumY=0,count=0;
                                    for (const r of subset) { if (r.pixel) { sumX+=r.pixel.x; sumY+=r.pixel.y; count++; } }
                                    const avgPx = (count>0) ? { x: sumX/count, y: sumY/count } : null;

                                    triangulatedPoints.push({
                                        x: tri.x, y: tri.y, z: tri.z,
                                        residual: residual,
                                        numRays: subset.length,
                                        t: Date.now(),
                                        avgPixel: avgPx
                                    });
                                    triangulatedCount++;
                                    triangulatedCountEl.textContent = triangulatedCount.toString();

                                    // registrar ponto de tela com média dos pixels usados
                                    if (avgPx) triangulatedScreenPoints.push({ x: avgPx.x, y: avgPx.y });

                                    if (triangulatedPoints.length > 0) downloadBtn.disabled = false;
                                    updatePointCloudView();
                                } else {
                                    // tri rejeitada por alto residual — descartar
                                }
                            }
                            // remover os raios usados de pending (remover por índices — em ordem decrescente para não invalidar índices)
                            takeIdx.sort((a,b)=>b-a);
                            for (const idx of takeIdx) pendingRaysForTriang.splice(idx,1);
                        } else {
                            // não há cluster suficiente ainda; aguardamos mais raios
                        }
                    }
                }
            }
        }

        // desenhar pontos triangulados persistentes (após desenho do frame, para ficarem visíveis)
        if (triangulatedScreenPoints.length > 0) {
            ctx.save();
            ctx.fillStyle = "rgba(255,182,193,0.95)"; // lightpink
            for (const sp of triangulatedScreenPoints) {
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, 6, 0, Math.PI*2);
                ctx.fill();
            }
            ctx.restore();
        }

        let avgPx = null;
        if (nDist > 0) {
            avgPx = (distBlue + distGreen) / nDist;
            lastAvgPx = avgPx;
        } else {
            lastAvgPx = null;
        }

        if (!isCalibrated) {
            if (avgPx && avgPx > 0) {
                pixelPerMM_current = avgPx / 100;
                scaleEl.textContent = pixelPerMM_current.toFixed(3);
                scaleLockEl.textContent = "aberta";
            } else {
                pixelPerMM_current = 0;
                scaleEl.textContent = "-";
                scaleLockEl.textContent = "aberta";
            }
        } else {
            scaleEl.textContent = (pixelPerMM_locked !== null) ? pixelPerMM_locked.toFixed(3) : "-";
            scaleLockEl.textContent = "travada";
        }

        let zCamera = null;
        if (isCalibrated && lastAvgPx && lastAvgPx > 0 && calibration_px && calibrationZ_mm) {
            zCamera = calibrationZ_mm * (calibration_px / lastAvgPx);
            zCameraEl.textContent = zCamera.toFixed(2);
            cameraZ_mm = zCamera;
        } else {
            zCameraEl.textContent = "-";
            cameraZ_mm = null;
        }

        const effectivePixelPerMM = (isCalibrated && pixelPerMM_locked !== null) ? pixelPerMM_locked : pixelPerMM_current;

        let exX=null, exY=null, eyX=null, eyY=null, cornerX=null, cornerY=null;

        if (cb && effectivePixelPerMM > 0) {
            const desiredPx = effectivePixelPerMM * 100;
            if (cbl) {
                let dx = bx - ox, dy = by - oy, norm = Math.hypot(dx,dy);
                if (norm > 0) {
                    exX = ox + (dx / norm) * desiredPx;
                    exY = oy + (dy / norm) * desiredPx;
                    drawArrow(ox, oy, exX, exY, "blue");
                }
            }
            if (cgr) {
                let dx2 = gx - ox, dy2 = gy - oy, norm2 = Math.hypot(dx2,dy2);
                if (norm2 > 0) {
                    eyX = ox + (dx2 / norm2) * desiredPx;
                    eyY = oy + (dy2 / norm2) * desiredPx;
                    drawArrow(ox, oy, eyX, eyY, "green");
                }
            }
        }
        if (isRecording && cb && exX !== null && eyX !== null) {
            cornerX = exX + eyX - ox;
            cornerY = exY + eyY - oy;
            ctx.save();
            ctx.fillStyle = 'rgba(173,216,230,0.35)';
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(exX, exY);
            ctx.lineTo(cornerX, cornerY);
            ctx.lineTo(eyX, eyY);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = 'rgba(173,216,230,0.9)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(exX, exY);
            ctx.lineTo(cornerX, cornerY);
            ctx.lineTo(eyX, eyY);
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }

        if (isCalibrated && pixelPerMM_locked && originCalX !== null && originCalY !== null && currentOriginX !== null) {
            const delta_px_x = originCalX - currentOriginX;
            const delta_px_y = currentOriginY - originCalY;
            const dx_mm_image = delta_px_x / pixelPerMM_locked;
            const dy_mm_image = delta_px_y / pixelPerMM_locked;
            const camVec = [dx_mm_image, dy_mm_image, 0];
            const R = getRotationMatrix(yaw, pitch, roll);
            const worldVec = matMulVec(R, camVec);
            cameraX_mm = worldVec[0];
            cameraY_mm = worldVec[1];
            xCameraEl.textContent = cameraX_mm.toFixed(2);
            yCameraEl.textContent = cameraY_mm.toFixed(2);
        } else {
            xCameraEl.textContent = "-";
            yCameraEl.textContent = "-";
        }

        if (isCalibrated && cameraZ_mm !== null) {
            const camVecZ = [0,0,cameraZ_mm];
            const R2 = getRotationMatrix(yaw, pitch, roll);
            const worldZVec = matMulVec(R2, camVecZ);
            zWorldEl.textContent = worldZVec[2].toFixed(2);
        } else {
            zWorldEl.textContent = "-";
        }

        if (isRecording) {
            const record = {
                t: Date.now(),
                x_mm: (typeof cameraX_mm === "number") ? cameraX_mm : null,
                y_mm: (typeof cameraY_mm === "number") ? cameraY_mm : null,
                z_mm: (typeof cameraZ_mm === "number") ? cameraZ_mm : null,
                pitch: pitch,
                yaw: yaw,
                roll: roll
            };
            calibrationLog.push(record);
        }
    }

    requestAnimationFrame(processFrame);
}
