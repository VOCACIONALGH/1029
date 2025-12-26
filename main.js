const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const blackSlider = document.getElementById("blackThreshold");
const blueSlider = document.getElementById("blueThreshold");
const greenSlider = document.getElementById("greenThreshold");

const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");
const scaleEl = document.getElementById("scale");
const scaleStatusEl = document.getElementById("scaleStatus");
const zEl = document.getElementById("zValue");
const xEl = document.getElementById("xValue");
const yEl = document.getElementById("yValue");

let pitch = 0;
let yaw = 0;
let roll = 0;

let scaleLocked = false;
let lockedPixelPerMM = 0; // valor travado de px/mm
let calibK = null; // constante de calibração K = Z_calib * L_calib (mm * px)
let L_calib_px = 0;
let Z_calib_mm = 0;

// referência da origem na tela no momento da calibração (em pixels)
let refOriginX = null;
let refOriginY = null;

// últimos valores detectados por frame (para calibração & translação)
let lastOriginX = null;
let lastOriginY = null;
let lastDistBlue = 0;
let lastDistGreen = 0;
let lastPixelPerMM = 0;

// gravação durante a calibragem
let calibrating = false;
let recordedFrames = [];

// --- utilitários de rotação (Euler -> matriz) ---
function deg2rad(d) { return d * Math.PI / 180; }

// Monta matriz de rotação R = Rz(yaw) * Rx(pitch) * Ry(roll)
// Notas: usamos convensão similar ao deviceorientation: pitch = beta (rot X), yaw = alpha (rot Z), roll = gamma (rot Y)
function eulerToRotationMatrix(pitchDeg, yawDeg, rollDeg) {
    const p = deg2rad(pitchDeg);
    const y = deg2rad(yawDeg);
    const r = deg2rad(rollDeg);

    const Rx = [
        [1, 0, 0],
        [0, Math.cos(p), -Math.sin(p)],
        [0, Math.sin(p),  Math.cos(p)]
    ];

    const Ry = [
        [ Math.cos(r), 0, Math.sin(r)],
        [ 0,          1, 0],
        [-Math.sin(r), 0, Math.cos(r)]
    ];

    const Rz = [
        [Math.cos(y), -Math.sin(y), 0],
        [Math.sin(y),  Math.cos(y), 0],
        [0, 0, 1]
    ];

    // multiply Rz * Rx * Ry  (matrix multiplication)
    function mul(A, B) {
        const C = Array(A.length).fill(0).map(()=>Array(B[0].length).fill(0));
        for (let i=0;i<A.length;i++){
            for (let j=0;j<B[0].length;j++){
                for (let k=0;k<A[0].length;k++){
                    C[i][j] += A[i][k]*B[k][j];
                }
            }
        }
        return C;
    }

    const Rzx = mul(Rz, Rx);
    const R = mul(Rzx, Ry);
    return R; // 3x3
}

function matMulVec(M, v) {
    return [
        M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
        M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
        M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
    ];
}

// ------------------------------------------------------------------

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
    if (!calibrating) {
        // iniciar calibragem (comportamento existente) + iniciar gravação
        if (!lastPixelPerMM || lastPixelPerMM <= 0) {
            alert("Escala inválida no momento. Não é possível calibrar. Certifique-se de que há pontos detectados.");
            return;
        }

        lockedPixelPerMM = lastPixelPerMM;
        scaleLocked = true;
        scaleStatusEl.textContent = "(travada)";

        if (lastDistBlue > 0 && lastDistGreen > 0) {
            L_calib_px = (lastDistBlue + lastDistGreen) / 2;
        } else if (lastDistBlue > 0) {
            L_calib_px = lastDistBlue;
        } else if (lastDistGreen > 0) {
            L_calib_px = lastDistGreen;
        } else {
            alert("Não há distâncias válidas (azul/verde) para calibração. Posicione os marcadores corretamente antes de calibrar.");
            scaleLocked = false;
            lockedPixelPerMM = 0;
            scaleStatusEl.textContent = "";
            return;
        }

        if (lastOriginX == null || lastOriginY == null) {
            alert("Origem não detectada no momento. Posicione a origem antes de calibrar.");
            scaleLocked = false;
            lockedPixelPerMM = 0;
            scaleStatusEl.textContent = "";
            return;
        }
        refOriginX = lastOriginX;
        refOriginY = lastOriginY;

        const input = prompt("Informe o valor atual de +Z em mm (ex.: 200):", "200");
        if (input === null) {
            scaleLocked = false;
            lockedPixelPerMM = 0;
            scaleStatusEl.textContent = "";
            refOriginX = null;
            refOriginY = null;
            return;
        }
        const zVal = parseFloat(input);
        if (isNaN(zVal) || zVal <= 0) {
            alert("Valor de +Z inválido. Calibração cancelada.");
            scaleLocked = false;
            lockedPixelPerMM = 0;
            scaleStatusEl.textContent = "";
            refOriginX = null;
            refOriginY = null;
            return;
        }

        Z_calib_mm = zVal;
        calibK = Z_calib_mm * L_calib_px;

        // iniciar processo de gravação
        recordedFrames = [];
        calibrating = true;
        calibrateBtn.textContent = "FINALIZAR CALIBRAGEM";

        zEl.textContent = Z_calib_mm.toFixed(2);
        scaleEl.textContent = lockedPixelPerMM.toFixed(3);

    } else {
        // finalizar calibragem e disparar download JSON (comportamento existente)
        calibrating = false;
        calibrateBtn.textContent = "CALIBRAR";

        const now = new Date();
        const pad = (n) => n.toString().padStart(2, "0");
        const fname = `calibragem-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;

        const blob = new Blob([JSON.stringify(recordedFrames, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
            document.body.removeChild(a);
        }, 500);

        recordedFrames = [];
        alert("Calibração finalizada. Arquivo JSON gerado.");
    }
});

function onOrientation(e) {
    pitch = e.beta || 0;   // X
    yaw   = e.alpha || 0;  // Z
    roll  = e.gamma || 0;  // Y

    pitchEl.textContent = pitch.toFixed(1);
    yawEl.textContent   = yaw.toFixed(1);
    rollEl.textContent  = roll.toFixed(1);
}

// Função utilitária RGB -> HSV
function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
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

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;

    const vBlack = blackSlider.value / 100;
    const sBlue = blueSlider.value / 100;
    const sGreen = greenSlider.value / 100;

    let sbx = 0, sby = 0, cb = 0;
    let blx = 0, bly = 0, cbl = 0;
    let grx = 0, gry = 0, cgr = 0;

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
    }

    ctx.putImageData(frame, 0, 0);

    let ox, oy, bx, by, gx, gy;
    let distBlue = 0, distGreen = 0, nDist = 0;

    if (cb) {
        ox = sbx / cb; oy = sby / cb;
        ctx.fillStyle = "white";
        ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();
        lastOriginX = ox;
        lastOriginY = oy;
    } else {
        lastOriginX = null;
        lastOriginY = null;
    }
    if (cbl) {
        bx = blx / cbl; by = bly / cbl;
        ctx.fillStyle = "blue";
        ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
        if (cb) {
            distBlue = Math.hypot(bx - ox, by - oy);
            nDist++;
        }
    }
    if (cgr) {
        gx = grx / cgr; gy = gry / cgr;
        ctx.fillStyle = "green";
        ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.fill();
        if (cb) {
            distGreen = Math.hypot(gx - ox, gy - oy);
            nDist++;
        }
    }

    // atualizar variáveis last para possível calibração
    lastDistBlue = distBlue;
    lastDistGreen = distGreen;

    // Calcular escala px/mm usando a(s) distância(s) detectada(s) entre origem e pontos.
    let pixelPerMM = 0;
    if (nDist > 0) {
        const avgPx = (distBlue + distGreen) / nDist; // média das distâncias em pixels
        pixelPerMM = avgPx / 100; // px por mm
        lastPixelPerMM = pixelPerMM;
    }

    // Se a escala estiver travada, use o valor travado para exibir.
    if (scaleLocked && lockedPixelPerMM > 0) {
        scaleEl.textContent = lockedPixelPerMM.toFixed(3);
        scaleStatusEl.textContent = "(travada)";
    } else {
        if (pixelPerMM > 0) {
            scaleEl.textContent = pixelPerMM.toFixed(3);
            scaleStatusEl.textContent = "";
        } else {
            scaleEl.textContent = "-";
            scaleStatusEl.textContent = "";
        }
    }

    // Determinar pixelPerMM usado para desenhar setas (travado ou atual)
    const usedPixelPerMM = (scaleLocked && lockedPixelPerMM > 0) ? lockedPixelPerMM : pixelPerMM;

    // calcular e desenhar setas originais (direções). Guardar endpoints para pintura do plano.
    let blueEnd = null;
    let greenEnd = null;

    if (cb && usedPixelPerMM > 0) {
        const desiredPx = usedPixelPerMM * 100; // comprimento em pixels para 100 mm

        if (cbl) {
            // direção do azul
            let dx = bx - ox;
            let dy = by - oy;
            let norm = Math.hypot(dx, dy);
            if (norm > 0) {
                const ex = ox + (dx / norm) * desiredPx;
                const ey = oy + (dy / norm) * desiredPx;
                drawArrow(ox, oy, ex, ey, "blue");
                blueEnd = { x: ex, y: ey };
            }
        }

        if (cgr) {
            // direção do verde
            let dx2 = gx - ox;
            let dy2 = gy - oy;
            let norm2 = Math.hypot(dx2, dy2);
            if (norm2 > 0) {
                const ex2 = ox + (dx2 / norm2) * desiredPx;
                const ey2 = oy + (dy2 / norm2) * desiredPx;
                drawArrow(ox, oy, ex2, ey2, "green");
                greenEnd = { x: ex2, y: ey2 };
            }
        }
    }

    // --- NOVO: durante a calibragem, calcular o plano XY usando pose, origem e vetores,
    // e pintar o plano como um polígono azul-claro com lados sendo as setas ---
    if (calibrating && cb && blueEnd && greenEnd) {
        // canto 1: origem (ox,oy)
        // canto 2: azulEnd (blueEnd.x, blueEnd.y)
        // canto 3: blueEnd + (greenEnd - origin) = blueEnd + (gx-ox, gy-oy)
        const corner3x = blueEnd.x + (greenEnd.x - ox);
        const corner3y = blueEnd.y + (greenEnd.y - oy);
        // canto 4: greenEnd
        const corner4x = greenEnd.x;
        const corner4y = greenEnd.y;

        // desenhar polígono preenchido (azul claro)
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = 'lightblue';
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(blueEnd.x, blueEnd.y);
        ctx.lineTo(corner3x, corner3y);
        ctx.lineTo(greenEnd.x, greenEnd.y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // --- calcular o plano em coordenadas do mundo usando pose e vetores ---
        // Converter vetores de tela (px) para mm usando a escala travada (lockedPixelPerMM)
        // vx_cam_mm = (blueEnd - origin) / px_per_mm
        const vx_mm = {
            x: (blueEnd.x - ox) / ((usedPixelPerMM > 0) ? usedPixelPerMM : 1),
            y: (blueEnd.y - oy) / ((usedPixelPerMM > 0) ? usedPixelPerMM : 1),
            z: 0
        };
        const vy_mm = {
            x: (greenEnd.x - ox) / ((usedPixelPerMM > 0) ? usedPixelPerMM : 1),
            y: (greenEnd.y - oy) / ((usedPixelPerMM > 0) ? usedPixelPerMM : 1),
            z: 0
        };

        // Interpretamos o vetor (x positive → para a direita da tela, y positive → para baixo da tela)
        // como vetores no sistema de coordenadas da câmera (em mm). Agora aplicamos a rotação da câmera
        // (Euler pitch, yaw, roll) para obter vetores no sistema de coordenadas do mundo.
        const R = eulerToRotationMatrix(pitch, yaw, roll);

        // vetor mundo = R * vetor_camera
        const vx_world = matMulVec(R, [vx_mm.x, vx_mm.y, vx_mm.z]);
        const vy_world = matMulVec(R, [vy_mm.x, vy_mm.y, vy_mm.z]);

        // normal do plano = vx_world × vy_world
        const nx = vx_world[1]*vy_world[2] - vx_world[2]*vy_world[1];
        const ny = vx_world[2]*vy_world[0] - vx_world[0]*vy_world[2];
        const nz = vx_world[0]*vy_world[1] - vx_world[1]*vy_world[0];

        // normal unitário:
        const nnorm = Math.hypot(nx, ny, nz) || 1;
        const normalWorld = { x: nx/nnorm, y: ny/nnorm, z: nz/nnorm };

        // ponto no plano (world) — assumimos origem do plano como (0,0,0) no sistema de referência do objeto
        // (essa convenção segue a calibração onde a câmera estava acima da origem)
        const planePointWorld = { x: 0, y: 0, z: 0 };
        // plano em forma ax + by + cz + d = 0 -> d = -normal ⋅ point
        const planeD = -(normalWorld.x*planePointWorld.x + normalWorld.y*planePointWorld.y + normalWorld.z*planePointWorld.z);

        // note: os valores world acima são calculados conforme solicitado (pose + origem + vetores).
        // não alteram a UI; ficam disponíveis aqui caso queira exportar ou salvar depois.

        // (opcional) -- nada a mais salvo; continuamos a gravação como antes
    }

    // --- Calcular +Z atual a partir da calibração, se houver (Z = K / L) ---
    let Zcur = null;
    if (calibK !== null) {
        let Lcur = 0;
        let countL = 0;
        if (distBlue > 0) { Lcur += distBlue; countL++; }
        if (distGreen > 0) { Lcur += distGreen; countL++; }

        if (countL > 0 && Lcur > 0) {
            Lcur = Lcur / countL;
            Zcur = calibK / Lcur;
            zEl.textContent = Zcur.toFixed(2);
        } else {
            zEl.textContent = "-";
        }
    }

    // Calcular translação +X / +Y se possível
    let Xmm = null;
    let Ymm = null;
    if (calibK !== null && refOriginX !== null && refOriginY !== null && lastOriginX !== null && lastOriginY !== null && lockedPixelPerMM > 0) {
        const delta_px_x = refOriginX - lastOriginX;
        const delta_px_y = lastOriginY - refOriginY;

        Xmm = delta_px_x / lockedPixelPerMM;
        Ymm = delta_px_y / lockedPixelPerMM;

        xEl.textContent = Xmm.toFixed(2);
        yEl.textContent = Ymm.toFixed(2);
    } else {
        if (calibK === null) {
            xEl.textContent = "-";
            yEl.textContent = "-";
        } else {
            xEl.textContent = "-";
            yEl.textContent = "-";
        }
    }

    // se calibrando, gravar frame com os valores atuais (null quando não disponíveis)
    if (calibrating) {
        const entry = {
            t: Date.now(),
            x_mm: (Xmm !== null) ? Number(Xmm.toFixed(3)) : null,
            y_mm: (Ymm !== null) ? Number(Ymm.toFixed(3)) : null,
            z_mm: (Zcur !== null) ? Number(Zcur.toFixed(3)) : null,
            pitch: (typeof pitch === "number") ? Number(pitch.toFixed(3)) : null,
            yaw: (typeof yaw === "number") ? Number(yaw.toFixed(3)) : null,
            roll: (typeof roll === "number") ? Number(roll.toFixed(3)) : null
        };
        recordedFrames.push(entry);
    }

    requestAnimationFrame(processFrame);
}
