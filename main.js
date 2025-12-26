const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const downloadBtn = document.getElementById("downloadBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const miniCanvas = document.getElementById("miniCanvas");
const miniCtx = miniCanvas.getContext("2d");

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

let pixelPerMM_current = 0;   // atualizado dinamicamente
let pixelPerMM_locked = null; // valor travado após calibrar
let calibration_px = null;    // px observado quando calibrado (média)
let calibrationZ_mm = null;   // +Z informado pelo usuário durante calibração
let isCalibrated = false;

let lastAvgPx = null; // último avg px calculado (entre origem e pontos)

let currentOriginX = null; // posição atual da origem (em pixels na tela)
let currentOriginY = null;
let originCalX = null; // posição da origem registrada na calibração
let originCalY = null;

let cameraX_mm = 0; // posição atual da câmera no referencial (mm)
let cameraY_mm = 0;
let cameraZ_mm = null;

let isRecording = false; // true enquanto a calibração está registrando frames
let calibrationLog = []; // array para armazenar os frames durante calibração
let calibrationStartTime = null;

// contagem e registro de raios gerados pelo ponto rosa
let raysCount = 0;
let raysLog = []; // cada entrada: { origin: {x,y,z}, direction: {dx,dy,dz} }

// contagem de pontos rosas com direção definida (pinhole)
let pinkDirCount = 0;

// contagem de vetores rotacionados (aplicados à direção para colocá-los no referencial world-fixed)
let rotatedCount = 0;

// triangulação
let nRaysRequired = null; // número de raios por triangulação (definido pelo usuário no início da calibração)
let pendingRaysForTriang = []; // raios acumulados (world-fixed) para próxima triangulação
let triangulatedPoints = []; // array de pontos triangulados { x, y, z }
let triangulatedCount = 0;

// Nuvem de pontos (registrada durante calibração; conteúdo salvo em JSON quando o usuário clicar em Download)
let pointCloud = []; // cada item: { x, y, z }

// Matrizes homogeneas iniciais (definem o referencial world fixo no instante de calibração)
let initialCamH = null;    // H0 (4x4) camera0 -> world_global
let initialCamHInv = null; // inverse(H0)

// --- NOVO: controle de distância mínima entre raios aceitos ---
let MIN_CAMERA_MOVE_MM = 5; // default
let lastAcceptedCameraPos = null; // {x,y,z} em mm da última origem de raio aceita para triangulação

// --- NOVO: ângulo mínimo entre raios para aceitar triangulação (graus) ---
const MIN_PARALLEL_ANGLE_DEG = 5; // se dois raios tiverem ângulo menor que isso, consideramos "quase paralelos"

// --- NOVO: highlights temporários para desenho (cada entrada {x,y,expiry}) ---
let highlights = []; // desenha círculos rosa claros temporários no canvas quando um ponto é triangulado

// utilitários novos
function distance3(a, b) {
    if (!a || !b) return Infinity;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.hypot(dx, dy, dz);
}
function raysSufficientlyAngular(rays, minAngleDeg) {
    if (!rays || rays.length < 2) return true;
    const minCos = Math.cos(minAngleDeg * Math.PI / 180);
    // extrair direções normalizadas
    const dirs = rays.map(r => {
        const d = [r.direction.dx, r.direction.dy, r.direction.dz];
        const n = Math.hypot(d[0], d[1], d[2]) || 1;
        return [d[0]/n, d[1]/n, d[2]/n];
    });
    for (let i=0;i<dirs.length;i++){
        for (let j=i+1;j<dirs.length;j++){
            const a = dirs[i], b = dirs[j];
            const dot = Math.abs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2]);
            if (dot >= minCos) {
                // ângulo menor que minAngleDeg (quase paralelos)
                return false;
            }
        }
    }
    return true;
}

scanBtn.addEventListener("click", async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: { exact: "environment" }
        },
        audio: false
    });

    video.srcObject = stream;

    video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        processFrame();
    };

    // solicitar permissão para deviceorientation em iOS se necessário
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

calibrateBtn.addEventListener("click", () => {
    // Inicia calibração quando ainda não calibrado
    if (!isCalibrated) {
        // pedir ao usuário a quantidade de raios necessária por triangulação (no início)
        const nrInput = prompt("Informe a quantidade de raios necessários para triangular cada ponto rosa (inteiro >= 2):", "3");
        if (!nrInput) {
            alert("Calibração cancelada: número de raios não fornecido.");
            downloadBtn.style.display = "none";
            return;
        }
        const nr = parseInt(nrInput, 10);
        if (isNaN(nr) || nr < 2) {
            alert("Valor inválido para número de raios. Calibração cancelada.");
            downloadBtn.style.display = "none";
            return;
        }
        nRaysRequired = nr;

        // --- pedir ao usuário MIN_CAMERA_MOVE_MM assim que iniciar a calibração ---
        const minMoveInput = prompt("Informe MIN_CAMERA_MOVE_MM em milímetros (distância mínima da câmera entre raios aceitos). Padrão 5 mm:", "5");
        if (minMoveInput !== null && minMoveInput !== "") {
            const mm = parseFloat(minMoveInput.replace(",", "."));
            if (!isNaN(mm) && mm >= 0) {
                MIN_CAMERA_MOVE_MM = mm;
            } else {
                // se inválido, manter padrão 5
                MIN_CAMERA_MOVE_MM = 5;
            }
        } else {
            MIN_CAMERA_MOVE_MM = 5;
        }

        if (!lastAvgPx || lastAvgPx <= 0) {
            alert("Impossível calibrar: não foi detectada distância entre origem e pontos. Certifique-se de que origem e pontos existam na cena.");
            downloadBtn.style.display = "none";
            return;
        }
        if (currentOriginX === null || currentOriginY === null) {
            alert("Impossível calibrar: origem (ponto branco) não detectada no momento.");
            downloadBtn.style.display = "none";
            return;
        }
        // calcular pixelPerMM atual (média das distâncias observadas corresponde a 100 mm)
        const currentPixelPerMM = lastAvgPx / 100; // px por mm para 100 mm
        pixelPerMM_locked = currentPixelPerMM;
        calibration_px = lastAvgPx;

        // registrar posição da origem na tela no momento da calibração
        originCalX = currentOriginX;
        originCalY = currentOriginY;

        const input = prompt("Informe o valor atual de +Z em milímetros (por exemplo: 250):");
        if (!input) {
            // desfazer travamento se usuário cancelar
            pixelPerMM_locked = null;
            calibration_px = null;
            originCalX = null;
            originCalY = null;
            isCalibrated = false;
            scaleLockEl.textContent = "aberta";
            downloadBtn.style.display = "none";
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
            downloadBtn.style.display = "none";
            return;
        }

        calibrationZ_mm = zVal;
        isCalibrated = true;
        scaleLockEl.textContent = "travada";

        // inicializar câmera: considerada sob a origem no momento da calibração
        cameraX_mm = 0;
        cameraY_mm = 0;
        cameraZ_mm = calibrationZ_mm;

        // construir matriz homogênea inicial H0 (camera0 -> world_global)
        initialCamH = buildHomogeneous(yaw, pitch, roll, cameraX_mm, cameraY_mm, cameraZ_mm);
        initialCamHInv = invertHomogeneous(initialCamH);

        // iniciar gravação dos frames de calibração
        isRecording = true;
        calibrationLog = [];
        calibrationStartTime = Date.now();

        // reset contadores e logs de raios e triangulação
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

        // reset da nuvem de pontos
        pointCloud = [];

        // reset lastAcceptedCameraPos
        lastAcceptedCameraPos = null;

        // reset highlights
        highlights = [];

        // mostrar botão Download durante a calibração
        downloadBtn.style.display = "inline-block";

        // atualizar UI
        zCameraEl.textContent = cameraZ_mm.toFixed(2);
        xCameraEl.textContent = cameraX_mm.toFixed(2);
        yCameraEl.textContent = cameraY_mm.toFixed(2);

        return;
    }

    // Finaliza calibração (se estava gravando) e baixa JSON
    if (isCalibrated && isRecording) {
        isRecording = false;

        const exportObj = {
            meta: {
                calibration_px: calibration_px,
                calibrationZ_mm: calibrationZ_mm,
                pixelPerMM_locked: pixelPerMM_locked,
                originCalX: originCalX,
                originCalY: originCalY,
                nRaysRequired: nRaysRequired,
                MIN_CAMERA_MOVE_MM: MIN_CAMERA_MOVE_MM,
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

        // esconder o botão de download da nuvem (aparecia só durante gravação)
        downloadBtn.style.display = "none";

        alert("Calibração finalizada. Arquivo JSON baixado.");
        return;
    }
});

// botão para baixar a nuvem de pontos (.json) durante a calibração
downloadBtn.addEventListener("click", () => {
    if (!pointCloud || pointCloud.length === 0) {
        alert("Nenhum ponto triangulado registrado ainda.");
        return;
    }
    const obj = {
        meta: {
            originCalX: originCalX,
            originCalY: originCalY,
            calibrationZ_mm: calibrationZ_mm,
            pixelPerMM_locked: pixelPerMM_locked,
            MIN_CAMERA_MOVE_MM: MIN_CAMERA_MOVE_MM,
            generatedAt: Date.now(),
            points: pointCloud.length
        },
        points: pointCloud // array de { x, y, z }
    };
    const jsonStr = JSON.stringify(obj, null, 2);
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

// lê orientações do dispositivo
function onOrientation(e) {
    // alpha = yaw (z), beta = pitch (x), gamma = roll (y)
    pitch = e.beta || 0;
    yaw = e.alpha || 0;
    roll = e.gamma || 0;

    pitchEl.textContent = pitch.toFixed(1);
    yawEl.textContent = yaw.toFixed(1);
    rollEl.textContent = roll.toFixed(1);
}

// --- utilitários para matrizes 4x4 homogeneas ---
// buildHomogeneous(yaw, pitch, roll, tx, ty, tz) -> H (4x4) camera->world
function buildHomogeneous(alphaDeg, betaDeg, gammaDeg, tx, ty, tz) {
    const R = getRotationMatrix(alphaDeg, betaDeg, gammaDeg); // 3x3
    // build 4x4
    return [
        [R[0][0], R[0][1], R[0][2], tx],
        [R[1][0], R[1][1], R[1][2], ty],
        [R[2][0], R[2][1], R[2][2], tz],
        [0, 0, 0, 1]
    ];
}

// invert homogeneous H = [R t; 0 1] -> [R^T, -R^T*t; 0 1]
function invertHomogeneous(H) {
    // H is 4x4
    const R = [
        [H[0][0], H[0][1], H[0][2]],
        [H[1][0], H[1][1], H[1][2]],
        [H[2][0], H[2][1], H[2][2]]
    ];
    const t = [H[0][3], H[1][3], H[2][3]];
    // R^T
    const RT = [
        [R[0][0], R[1][0], R[2][0]],
        [R[0][1], R[1][1], R[2][1]],
        [R[0][2], R[1][2], R[2][2]]
    ];
    // -R^T * t
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

// multiply 4x4 matrices A*B
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
// multiply 4x4 by 4x1 vector
function mul4Vec(M, v) {
    const out = [0,0,0,0];
    for (let i=0;i<4;i++){
        out[i] = M[i][0]*v[0] + M[i][1]*v[1] + M[i][2]*v[2] + M[i][3]*v[3];
    }
    return out;
}
// converter RGB para HSV (mantive a mesma função)
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    let s = max === 0 ? 0 : d / max;
    let v = max;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return { h, s, v };
}

// desenha uma seta entre dois pontos
function drawArrow(x1, y1, x2, y2, color) {
    const headLength = 10;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
        x2 - headLength * Math.cos(angle - Math.PI / 6),
        y2 - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
        x2 - headLength * Math.cos(angle + Math.PI / 6),
        y2 - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
}

// cria matriz de rotação a partir de yaw(alpha), pitch(beta), roll(gamma) em graus
// (converte graus -> radianos internamente)
function getRotationMatrix(alphaDeg, betaDeg, gammaDeg) {
    const a = alphaDeg * Math.PI / 180; // yaw (z)
    const b = betaDeg * Math.PI / 180;  // pitch (x)
    const g = gammaDeg * Math.PI / 180; // roll (y)

    // Rz(alpha)
    const Rz = [
        [Math.cos(a), -Math.sin(a), 0],
        [Math.sin(a),  Math.cos(a), 0],
        [0, 0, 1]
    ];
    // Rx(beta)
    const Rx = [
        [1, 0, 0],
        [0, Math.cos(b), -Math.sin(b)],
        [0, Math.sin(b),  Math.cos(b)]
    ];
    // Ry(gamma)
    const Ry = [
        [ Math.cos(g), 0, Math.sin(g)],
        [ 0, 1, 0],
        [-Math.sin(g), 0, Math.cos(g)]
    ];

    // R = Rz * Rx * Ry  (ordem: yaw, pitch, roll)
    function mul(A, B) {
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

    const RzRx = mul(Rz, Rx);
    const R = mul(RzRx, Ry);
    return R;
}

// multiplica matriz 3x3 por vetor 3x1
function matMulVec(M, v) {
    return [
        M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
        M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
        M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
    ];
}

// --- função de triangulação por mínimos quadrados (usa apenas raios no referencial world-fixed) ---
// Recebe array de raios: { origin: {x,y,z}, direction: {dx,dy,dz} }
// Retorna ponto { x, y, z } ou null se falhar
function triangulateRaysWorld(rays) {
    if (!rays || rays.length < 2) return null;

    // Montar A = sum (I - d d^T), b = sum (I - d d^T) * o
    let A = [
        [0,0,0],
        [0,0,0],
        [0,0,0]
    ];
    let b = [0,0,0];

    for (const r of rays) {
        if (!r.origin || !r.direction) return null;
        const o = [r.origin.x, r.origin.y, r.origin.z];
        const d = [r.direction.dx, r.direction.dy, r.direction.dz];
        // garantir direção unitária
        const n = Math.hypot(d[0], d[1], d[2]) || 1;
        const dd = [d[0]/n, d[1]/n, d[2]/n];

        // Compute (I - d d^T)
        const M = [
            [1 - dd[0]*dd[0], -dd[0]*dd[1],    -dd[0]*dd[2]],
            [-dd[1]*dd[0],    1 - dd[1]*dd[1], -dd[1]*dd[2]],
            [-dd[2]*dd[0],    -dd[2]*dd[1],    1 - dd[2]*dd[2]]
        ];

        // A += M
        for (let i=0;i<3;i++){
            for (let j=0;j<3;j++){
                A[i][j] += M[i][j];
            }
        }
        // b += M * o
        for (let i=0;i<3;i++){
            b[i] += M[i][0]*o[0] + M[i][1]*o[1] + M[i][2]*o[2];
        }
    }

    // resolver A x = b (inverter A 3x3)
    const invA = invert3x3(A);
    if (!invA) return null;

    const x = [
        invA[0][0]*b[0] + invA[0][1]*b[1] + invA[0][2]*b[2],
        invA[1][0]*b[0] + invA[1][1]*b[1] + invA[1][2]*b[2],
        invA[2][0]*b[0] + invA[2][1]*b[1] + invA[2][2]*b[2]
    ];

    return { x: x[0], y: x[1], z: x[2] };
}

// inverter 3x3 (retorna null se singular)
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
    if (Math.abs(det) < 1e-9) return null;

    const invDet = 1 / det;
    return [
        [A * invDet, D * invDet, G * invDet],
        [B * invDet, E * invDet, H * invDet],
        [C * invDet, F * invDet, I * invDet]
    ];
}

function processFrame() {
    if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = frame.data;

        const vBlack = blackSlider.value / 100;
        const sBlue = blueSlider.value / 100;
        const sGreen = greenSlider.value / 100;

        let sbx = 0, sby = 0, cb = 0;
        let blx = 0, bly = 0, cbl = 0;
        let grx = 0, gry = 0, cgr = 0;

        // acumuladores para vermelho
        let rdx = 0, rdy = 0, cr = 0;

        for (let i = 0; i < data.length; i += 4) {
            const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);

            const idx = i / 4;
            const x = idx % canvas.width;
            const y = Math.floor(idx / canvas.width);

            if (hsv.v < vBlack) {
                data[i] = 255; data[i + 1] = 165; data[i + 2] = 0;
                sbx += x; sby += y; cb++;
            } else if (hsv.h >= 200 && hsv.h <= 260 && hsv.s > sBlue) {
                data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
                blx += x; bly += y; cbl++;
            } else if (hsv.h >= 90 && hsv.h <= 150 && hsv.s > sGreen) {
                data[i] = 128; data[i + 1] = 0; data[i + 2] = 128;
                grx += x; gry += y; cgr++;
            }

            // detectar VERMELHO (zonas em torno de 0/360)
            if ((hsv.h <= 15 || hsv.h >= 345) && hsv.s > 0.4 && hsv.v > 0.2) {
                rdx += x;
                rdy += y;
                cr++;
            }
        }

        ctx.putImageData(frame, 0, 0);

        let ox, oy, bx, by, gx, gy;
        let distBlue = 0, distGreen = 0, nDist = 0;

        if (cb > 0) {
            ox = sbx / cb;
            oy = sby / cb;
            ctx.fillStyle = "white";
            ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();

            // atualizar posição atual da origem global
            currentOriginX = ox;
            currentOriginY = oy;
        } else { currentOriginX = null;
            currentOriginY = null;
        }

        if (cbl > 0) {
            bx = blx / cbl;
            by = bly / cbl;
            ctx.fillStyle = "blue";
            ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
            if (cb) {
                distBlue = Math.hypot(bx - ox, by - oy);
                nDist++;
            }
        }

        if (cgr > 0) {
            gx = grx / cgr;
            gy = gry / cgr;
            ctx.fillStyle = "green";
            ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.fill();
            if (cb) {
                distGreen = Math.hypot(gx - ox, gy - oy);
                nDist++;
            }
        } 
        // calcular centroid dos VERMELHOS (ponto rosa)
        let redCx = null, redCy = null;
        if (cr > 0) {
            redCx = rdx / cr;
            redCy = rdy / cr;
            ctx.fillStyle = "#FF69B4"; // hotpink
            ctx.beginPath();
            ctx.arc(redCx, redCy, 4, 0, Math.PI * 2);
            ctx.fill();

            // se estamos gravando (durante calibragem), definir direção por aproximação pinhole
            if (isRecording) {
                // apenas definir direção se calibrado e tivermos escala travada e Z da câmera
                if (isCalibrated && pixelPerMM_locked && cameraZ_mm && initialCamHInv) {
                    // focal length (pixels) via relação f = pixelPerMM_locked * Z
                    const f = pixelPerMM_locked * cameraZ_mm;

                    if (f > 0 && canvas.width > 0 && canvas.height > 0) {
                        const cx = canvas.width / 2;
                        const cy = canvas.height / 2;

                        // coordenadas de imagem (u,v)
                        const u = redCx;
                        const v = redCy;

                        // direção em coordenadas da câmera: [(u - cx)/f, (v - cy)/f, 1]
                        let dir_cam = [
                            (u - cx) / f,
                            (v - cy) / f,
                            1
                        ];

                        // normalizar (direção do modelo pinhole)
                        const normP = Math.hypot(dir_cam[0], dir_cam[1], dir_cam[2]) || 1;
                        dir_cam = [dir_cam[0] / normP, dir_cam[1] / normP, dir_cam[2] / normP];

                        // registrar que temos um ponto rosa com direção definida (pinhole)
                        pinkDirCount++;
                        pinkDirCountEl.textContent = pinkDirCount.toString();

                        // build current camera homogeneous matrix Hc (camera_current -> world_global)
                        const Hc = buildHomogeneous(yaw, pitch, roll, cameraX_mm, cameraY_mm, cameraZ_mm);

                        // transformar Hc para o referencial fixo world (via inversa de H0)
                        // H_rel = initialCamHInv * Hc  => representa transform from camera_current to world_fixed (camera0) frame
                        const Hrel = mul4(initialCamHInv, Hc);

                        // origem do raio em world_fixed: Hrel * [0,0,0,1]
                        const originWF4 = mul4Vec(Hrel, [0,0,0,1]);
                        const originWF = { x: originWF4[0], y: originWF4[1], z: originWF4[2] };

                        // Rotacionar direção: R_rel (top-left 3x3 of Hrel) * dir_cam
                        const Rrel = [
                            [Hrel[0][0], Hrel[0][1], Hrel[0][2]],
                            [Hrel[1][0], Hrel[1][1], Hrel[1][2]],
                            [Hrel[2][0], Hrel[2][1], Hrel[2][2]]
                        ];
                        let dir_world = matMulVec(Rrel, dir_cam);
                        const normW = Math.hypot(dir_world[0], dir_world[1], dir_world[2]) || 1;
                        dir_world = [dir_world[0]/normW, dir_world[1]/normW, dir_world[2]/normW];

                        // verificar se posição atual da câmera está disponível
                        const camPosCurrent = (typeof cameraX_mm === "number" && typeof cameraY_mm === "number" && typeof cameraZ_mm === "number")
                            ? { x: cameraX_mm, y: cameraY_mm, z: cameraZ_mm }
                            : null;

                        // determinar se aceitamos este raio para triangulação (move suficiente)
                        let acceptRay = true;
                        if (camPosCurrent && lastAcceptedCameraPos) {
                            const distSinceLast = distance3(camPosCurrent, lastAcceptedCameraPos);
                            if (distSinceLast < MIN_CAMERA_MOVE_MM) {
                                acceptRay = false;
                            }
                        }
                        // se não há posição anterior, aceitamos (primeiro raio)

                        if (acceptRay && camPosCurrent) {
                            // contabilizar vetor rotacionado (no referencial world fixed)
                            rotatedCount++;
                            rotatedCountEl.textContent = rotatedCount.toString();

                            // registrar no log: origem e direção no referencial fixo do mundo (formato solicitado anteriormente)
                            const rayWorld = {
                                origin: originWF,
                                direction: { dx: dir_world[0], dy: dir_world[1], dz: dir_world[2] }
                            };

                            // push ray
                            raysLog.push(rayWorld);

                            // atualizar contador cumulativo de raios 3D registrados
                            raysCount++;
                            raysCountEl.textContent = raysCount.toString();

                            // também acumular para triangulação
                            pendingRaysForTriang.push(rayWorld);

                            // atualizar lastAcceptedCameraPos
                            lastAcceptedCameraPos = camPosCurrent;
                        } else {
                            // se não aceito: não empilha nos raios para triangulação nem incrementa raysCount/rotatedCount
                            // (a detecção do ponto rosa e contagem de pinkDirCount já foi incrementada)
                        }

                        // quando tivermos número suficiente de raios (definido pelo usuário), triangular
                        if (nRaysRequired && pendingRaysForTriang.length >= nRaysRequired) {
                            const subset = pendingRaysForTriang.slice(0, nRaysRequired);

                            // evitar triangulações com raios quase paralelos
                            if (!raysSufficientlyAngular(subset, MIN_PARALLEL_ANGLE_DEG)) {
                                // Se os raios são quase paralelos, descartamos o primeiro da fila e aguardamos mais raios
                                pendingRaysForTriang = pendingRaysForTriang.slice(1);
                            } else {
                                const tri = triangulateRaysWorld(subset);
                                // se triangulação bem-sucedida, armazenar e atualizar contador
                                if (tri) {
                                    // === aplicar translação para que a origem calibrada seja (0,0,0) ===
                                    let triTranslated = tri;

                                    if (isCalibrated && originCalX !== null && originCalY !== null && calibrationZ_mm && pixelPerMM_locked) {
                                        // focal length (pixels) at calibration
                                        const f_cal = pixelPerMM_locked * calibrationZ_mm;
                                        const cx_cal = canvas.width / 2;
                                        const cy_cal = canvas.height / 2;

                                        // origem em coordenadas de câmera (mm) no instante da calibração
                                        const originCamX = (originCalX - cx_cal) / f_cal * calibrationZ_mm;
                                        const originCamY = (originCalY - cy_cal) / f_cal * calibrationZ_mm;
                                        const originCamZ = calibrationZ_mm;

                                        // subtrair para que a origem calibrada vire (0,0,0)
                                        triTranslated = {
                                            x: tri.x - originCamX,
                                            y: tri.y - originCamY,
                                            z: tri.z - originCamZ
                                        };
                                    }

                                    triangulatedPoints.push(triTranslated);
                                    triangulatedCount++;
                                    triangulatedCountEl.textContent = triangulatedCount.toString();

                                    // registrar na nuvem de pontos durante a calibração
                                    if (isRecording) {
                                        pointCloud.push({ x: triTranslated.x, y: triTranslated.y, z: triTranslated.z });
                                    }

                                    // --- NOVO: destacar temporariamente o ponto triangulado no canvas (usar coordenadas do centroid vermelho atual, se disponível) ---
                                    if (typeof redCx === "number" && typeof redCy === "number") {
                                        highlights.push({ x: redCx, y: redCy, expiry: Date.now() + 500 }); // 500 ms
                                    }
                                }
                                // remover os raios usados (consumir a janela)
                                pendingRaysForTriang = pendingRaysForTriang.slice(nRaysRequired);
                            }
                        }
                    }
                }
            }
        }

        // desenhar highlights temporários (rosa claro) sobre o frame
        const now = Date.now();
        if (highlights.length > 0) {
            // filtrar expirados e desenhar
            const remaining = [];
            for (const h of highlights) {
                if (h.expiry > now) {
                    ctx.save();
                    ctx.globalAlpha = 0.9;
                    ctx.fillStyle = "rgba(255,182,193,0.85)"; // lightpink
                    ctx.beginPath();
                    ctx.arc(h.x, h.y, 8, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                    remaining.push(h);
                }
            }
            highlights = remaining;
        }

        // média das distâncias observadas (em pixels)
        let avgPx = null;
        if (nDist > 0) {
            avgPx = (distBlue + distGreen) / nDist;
            lastAvgPx = avgPx;
        } else {
            lastAvgPx = null;
        }

        // escala px/mm (assumindo que as distâncias medidas correspondem a 100 mm)
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
            // se calibrado, mostrar o valor travado
            scaleEl.textContent = (pixelPerMM_locked !== null) ? pixelPerMM_locked.toFixed(3) : "-";
            scaleLockEl.textContent = "travada";
        }

        // calcular +Z se calibrado
        let zCamera = null; // Z em mm no referencial da câmera (estimado)
        if (isCalibrated && lastAvgPx && lastAvgPx > 0 && calibration_px && calibrationZ_mm) {
            // relação inversa proporcional (tamanho projetado ~ 1/Z)
            zCamera = calibrationZ_mm * (calibration_px / lastAvgPx);
            zCameraEl.textContent = zCamera.toFixed(2);
            cameraZ_mm = zCamera;
        } else {
            zCameraEl.textContent = "-";
            cameraZ_mm = null;
        }

        // desenhar setas com comprimento correspondente a 100 mm usando escala atual/travada
        const effectivePixelPerMM = (isCalibrated && pixelPerMM_locked !== null) ? pixelPerMM_locked : pixelPerMM_current;

        // vars para endpoints em pixels (usadas para desenhar o plano)
        let exX = null, exY = null, eyX = null, eyY = null, cornerX = null, cornerY = null;

        if (cb && effectivePixelPerMM > 0) {
            const desiredPx = effectivePixelPerMM * 100;

            if (cbl) {
                let dx = bx - ox;
                let dy = by - oy;
                let norm = Math.hypot(dx, dy);
                if (norm > 0) {
                    exX = ox + (dx / norm) * desiredPx;
                    exY = oy + (dy / norm) * desiredPx;
                    drawArrow(ox, oy, exX, exY, "blue");
                }
            } 
            if (cgr) {
                let dx2 = gx - ox;
                let dy2 = gy - oy;
                let norm2 = Math.hypot(dx2, dy2);
                if (norm2 > 0) {
                    eyX = ox + (dx2 / norm2) * desiredPx;
                    eyY = oy + (dy2 / norm2) * desiredPx;
                    drawArrow(ox, oy, eyX, eyY, "green");
                }
            }
        } // desenhar o plano XY durante a calibragem (área azul claro cujos lados são as setas)
        if (isRecording && cb && exX !== null && eyX !== null) {
            cornerX = exX + eyX - ox;
            cornerY = exY + eyY - oy;

            ctx.save();
            ctx.fillStyle = 'rgba(173,216,230,0.35)'; // lightblue com transparência
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

        // calcular translação da câmera em +X e +Y após calibração (mantive sua lógica)
        if (isCalibrated && pixelPerMM_locked && originCalX !== null && originCalY !== null && currentOriginX !== null) {
            const delta_px_x = originCalX - currentOriginX; // positivo quando origem foi para a esquerda
            const delta_px_y = currentOriginY - originCalY; // positivo quando origem moved down

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

        // mostrar +Z transformado (se disponível)
        if (isCalibrated && cameraZ_mm !== null) {
            const camVecZ = [0, 0, cameraZ_mm];
            const R2 = getRotationMatrix(yaw, pitch, roll);
            const worldZVec = matMulVec(R2, camVecZ);
            zWorldEl.textContent = worldZVec[2].toFixed(2);
        } else {
            zWorldEl.textContent = "-";
        }

        // se em gravação de calibração, adicionar registro do frame atual no log
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

        // --- NOVO: desenhar mini visualização da nuvem (densidade) ---
        drawMiniPointCloud();
    }

    requestAnimationFrame(processFrame);
}

// desenha mini-visualização a partir de pointCloud (usa x,y em mm)
function drawMiniPointCloud() {
    const w = miniCanvas.width;
    const h = miniCanvas.height;
    // limpar
    miniCtx.clearRect(0, 0, w, h);
    // fundo escuro
    miniCtx.fillStyle = "#000";
    miniCtx.fillRect(0, 0, w, h);

    if (!pointCloud || pointCloud.length === 0) {
        // texto de ajuda
        miniCtx.fillStyle = "#666";
        miniCtx.font = "12px Arial";
        miniCtx.fillText("nenhum ponto", 8, 18);
        return;
    }

    // calcular bounding box em X e Y
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pointCloud) {
        if (typeof p.x !== "number" || typeof p.y !== "number") continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX) || !isFinite(minY)) {
        miniCtx.fillStyle = "#666";
        miniCtx.fillText("dados insuf.", 8, 18);
        return;
    }

    // pad small margin
    const pad = 8;
    let dx = maxX - minX;
    let dy = maxY - minY;
    if (dx < 1e-6) dx = 1;
    if (dy < 1e-6) dy = 1;

    // map point -> mini canvas coordinates (centered)
    for (const p of pointCloud) {
        if (typeof p.x !== "number" || typeof p.y !== "number") continue;
        const nx = (p.x - minX) / dx;
        const ny = (p.y - minY) / dy;
        // invert y so smaller y is top (optional)
        const sx = pad + nx * (w - pad * 2);
        const sy = pad + (1 - ny) * (h - pad * 2);
        // draw small rectangle for density
        miniCtx.fillStyle = "rgba(255,182,193,0.9)"; // lightpink-ish for visibility
        miniCtx.fillRect(Math.round(sx) - 1, Math.round(sy) - 1, 2, 2);
    }

    // optional border
    miniCtx.strokeStyle = "rgba(255,255,255,0.04)";
    miniCtx.strokeRect(0.5, 0.5, w-1, h-1);
}
