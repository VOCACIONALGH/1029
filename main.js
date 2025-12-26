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
const scaleLockEl = document.getElementById("scaleLock");

const zCameraEl = document.getElementById("zCamera");
const zWorldEl = document.getElementById("zWorld");

const xCameraEl = document.getElementById("xCamera");
const yCameraEl = document.getElementById("yCamera");

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
    // Se ainda não calibrado, tenta iniciar a calibração (travar escala e pedir +Z)
    if (!isCalibrated) {
        if (!lastAvgPx || lastAvgPx <= 0) {
            alert("Impossível calibrar: não foi detectada distância entre origem e pontos. Certifique-se de que origem e pontos existam na cena.");
            return;
        }
        if (currentOriginX === null || currentOriginY === null) {
            alert("Impossível calibrar: origem (ponto branco) não detectada no momento.");
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

        // inicializar câmera: considerada sob a origem no momento da calibração
        cameraX_mm = 0;
        cameraY_mm = 0;
        cameraZ_mm = calibrationZ_mm;

        // iniciar gravação dos frames de calibração
        isRecording = true;
        calibrationLog = [];
        calibrationStartTime = Date.now();

        // atualizar UI
        zCameraEl.textContent = cameraZ_mm.toFixed(2);
        xCameraEl.textContent = cameraX_mm.toFixed(2);
        yCameraEl.textContent = cameraY_mm.toFixed(2);

        return;
    }

    // Se já estava calibrado e a gravação está ativa, ao clicar novamente finalizamos e baixamos o JSON
    if (isCalibrated && isRecording) {
        isRecording = false;

        // preparar objeto para exportar
        const exportObj = {
            meta: {
                calibration_px: calibration_px,
                calibrationZ_mm: calibrationZ_mm,
                pixelPerMM_locked: pixelPerMM_locked,
                originCalX: originCalX,
                originCalY: originCalY,
                calibrationStart: calibrationStartTime,
                calibrationEnd: Date.now(),
                frames: calibrationLog.length
            },
            frames: calibrationLog
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

        // manter isCalibrated = true (escala travada) mas gravação parada
        return;
    }

    // Se isCalibrated true mas isRecording false (calibração já finalizada), re-click não re-inicia automaticamente
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

// converter RGB para HSV
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

        if (cb > 0) {
            ox = sbx / cb;
            oy = sby / cb;
            ctx.fillStyle = "white";
            ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();

            // atualizar posição atual da origem global
            currentOriginX = ox;
            currentOriginY = oy;
        } else {
            currentOriginX = null;
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
        }

        // desenhar o plano XY durante a calibragem (área azul claro cujos lados são as setas)
        // condição: estamos gravando (isRecording) e temos origem + ambos vetores calculados
        if (isRecording && cb && exX !== null && eyX !== null) {
            // corner = ex + ey - origin  (pixel coordinates)
            cornerX = exX + eyX - ox;
            cornerY = exY + eyY - oy;

            // preencher o paralelogramo origin -> ex -> corner -> ey
            ctx.save();
            ctx.fillStyle = 'rgba(173,216,230,0.35)'; // lightblue com transparência
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(exX, exY);
            ctx.lineTo(cornerX, cornerY);
            ctx.lineTo(eyX, eyY);
            ctx.closePath();
            ctx.fill();

            // opcional: borda leve
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

        // calcular translação da câmera em +X e +Y após calibração
        if (isCalibrated && pixelPerMM_locked && originCalX !== null && originCalY !== null && currentOriginX !== null) {
            // deslocamento da origem na imagem desde a calibração (em pixels)
            // convenção pedida:
            // - mais para baixo => maior +Y positivo -> use (currentY - originCalY)
            // - mais para a esquerda => maior +X positivo -> use (originCalX - currentX)
            const delta_px_x = originCalX - currentOriginX; // positivo quando origem foi para a esquerda
            const delta_px_y = currentOriginY - originCalY; // positivo quando origem moved down

            // converter para mm usando escala travada
            const dx_mm_image = delta_px_x / pixelPerMM_locked;
            const dy_mm_image = delta_px_y / pixelPerMM_locked;

            // vetor em coordenadas da câmera/imagem (x right, y down, z forward)
            const camVec = [dx_mm_image, dy_mm_image, 0]; // XY translation

            // transformar pelo R (Yaw,Pitch,Roll)
            const R = getRotationMatrix(yaw, pitch, roll);
            const worldVec = matMulVec(R, camVec);

            // atualizar posição da câmera no referencial do mundo (inicial 0,0)
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
    }

    requestAnimationFrame(processFrame);
}
