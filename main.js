// (Arquivo main.js completo atualizado)
const scanBtn = document.getElementById('scanBtn');
const calibrateBtn = document.getElementById('calibrateBtn');
const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const scaleValue = document.getElementById('scaleValue');
const scaleLockedLabel = document.getElementById('scaleLockedLabel');

const blackSlider = document.getElementById('blackSlider');
const blueSlider  = document.getElementById('blueSlider');
const greenSlider = document.getElementById('greenSlider');

const blackValue = document.getElementById('blackValue');
const blueValue  = document.getElementById('blueValue');
const greenValue = document.getElementById('greenValue');

// orientação UI
const pitchSpan = document.getElementById('pitchValue');
const yawSpan   = document.getElementById('yawValue');
const rollSpan  = document.getElementById('rollValue');

// ZXY UI + Raios count
const zSpan = document.getElementById('zValue');
const xSpan = document.getElementById('xValue');
const ySpan = document.getElementById('yValue');
const raysCountSpan = document.getElementById('raysCount');

let blackThreshold = Number(blackSlider.value);
let blueThreshold  = Number(blueSlider.value);
let greenThreshold = Number(greenSlider.value);

blackValue.textContent = blackThreshold;
blueValue.textContent  = blueThreshold;
greenValue.textContent = greenThreshold;

blackSlider.addEventListener('input', () => {
  blackThreshold = Number(blackSlider.value);
  blackValue.textContent = blackThreshold;
});

blueSlider.addEventListener('input', () => {
  blueThreshold = Number(blueSlider.value);
  blueValue.textContent = blueThreshold;
});

greenSlider.addEventListener('input', () => {
  greenThreshold = Number(greenSlider.value);
  greenValue.textContent = greenThreshold;
});

let orientationListenerAdded = false;

let currentScalePxPerMm = null; // atual (pode ser travada)
let scaleLocked = false;
let lockedScalePxPerMm = null;

// gravação durante calibração
let isRecordingCalibration = false;
let calibrationFrames = []; // array de frames gravados durante calibração

// calibração para +Z e origem
let calibration = null; 
// calibration will contain:
// { lockedScalePxPerMm, lenPxCal, orientationCal: {alpha,beta,gamma}, worldLenCal, zCalMm, originPixelCal, camMatrixCal, invCamMatrixCal, rays: [] }

scanBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: "environment" } },
      audio: false
    });

    video.srcObject = stream;
    video.style.display = "block";
    canvas.style.display = "block";
    scanBtn.style.display = "none";

    // permission for deviceorientation on iOS (gesture)
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().catch(()=>{}).then(() => {
          addOrientationListenerOnce();
        });
      } else {
        addOrientationListenerOnce();
      }
    } catch (e) {
      addOrientationListenerOnce();
    }

    video.addEventListener('loadedmetadata', () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      processFrame();
    });

  } catch (err) {
    alert("Não foi possível acessar a câmera traseira.");
  }
});

function addOrientationListenerOnce() {
  if (orientationListenerAdded) return;
  orientationListenerAdded = true;

  if (window.DeviceOrientationEvent) {
    window.addEventListener('deviceorientation', handleOrientation, true);
  } else {
    pitchSpan.textContent = "--";
    yawSpan.textContent = "--";
    rollSpan.textContent = "--";
  }
}

let lastOrientation = { alpha: null, beta: null, gamma: null };

function handleOrientation(event) {
  const alpha = event.alpha;
  const beta = event.beta;
  const gamma = event.gamma;

  lastOrientation.alpha = alpha;
  lastOrientation.beta = beta;
  lastOrientation.gamma = gamma;

  yawSpan.textContent = (alpha != null) ? alpha.toFixed(2) : "--";
  pitchSpan.textContent = (beta  != null) ? beta.toFixed(2)  : "--";
  rollSpan.textContent = (gamma != null) ? gamma.toFixed(2) : "--";
}

// Rotation matrix builder (convenção usada anteriormente)
function rotationMatrixFromAlphaBetaGamma(alphaDeg, betaDeg, gammaDeg) {
  const a = (alphaDeg || 0) * Math.PI / 180;
  const b = (betaDeg  || 0) * Math.PI / 180;
  const g = (gammaDeg || 0) * Math.PI / 180;

  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);

  const Rz = [
    [ca, -sa, 0],
    [sa,  ca, 0],
    [0 ,   0, 1]
  ];
  const Rx = [
    [1, 0 ,  0],
    [0, cb, -sb],
    [0, sb,  cb]
  ];
  const Ry = [
    [cg, 0, sg],
    [0 , 1, 0 ],
    [-sg,0, cg]
  ];

  function mul(A,B) {
    const C = [];
    for (let i=0;i<3;i++) {
      C[i]=[];
      for (let j=0;j<3;j++) {
        let s=0;
        for (let k=0;k<3;k++) s += A[i][k]*B[k][j];
        C[i][j]=s;
      }
    }
    return C;
  }

  return mul(mul(Rz,Rx),Ry);
}

function applyMat3(mat, vec) {
  return [
    mat[0][0]*vec[0] + mat[0][1]*vec[1] + mat[0][2]*vec[2],
    mat[1][0]*vec[0] + mat[1][1]*vec[1] + mat[1][2]*vec[2],
    mat[2][0]*vec[0] + mat[2][1]*vec[1] + mat[2][2]*vec[2]
  ];
}

// Matriz homogênea 4x4 para R(3x3) e t(3)
function buildHomogeneousMatrix(R, t) {
  return [
    [R[0][0], R[0][1], R[0][2], t[0]],
    [R[1][0], R[1][1], R[1][2], t[1]],
    [R[2][0], R[2][1], R[2][2], t[2]],
    [0, 0, 0, 1]
  ];
}

// Inversa de uma transformação rígida 4x4 (R,t) -> (R^T, -R^T t)
function inverseRigid4x4(T) {
  const R = [
    [T[0][0], T[0][1], T[0][2]],
    [T[1][0], T[1][1], T[1][2]],
    [T[2][0], T[2][1], T[2][2]]
  ];
  const t = [T[0][3], T[1][3], T[2][3]];
  const Rt = [
    [R[0][0], R[1][0], R[2][0]],
    [R[0][1], R[1][1], R[2][1]],
    [R[0][2], R[1][2], R[2][2]]
  ];
  const nt0 = -(Rt[0][0]*t[0] + Rt[0][1]*t[1] + Rt[0][2]*t[2]);
  const nt1 = -(Rt[1][0]*t[0] + Rt[1][1]*t[1] + Rt[1][2]*t[2]);
  const nt2 = -(Rt[2][0]*t[0] + Rt[2][1]*t[1] + Rt[2][2]*t[2]);
  return [
    [Rt[0][0], Rt[0][1], Rt[0][2], nt0],
    [Rt[1][0], Rt[1][1], Rt[1][2], nt1],
    [Rt[2][0], Rt[2][1], Rt[2][2], nt2],
    [0,0,0,1]
  ];
}

function multiply4x4(A,B) {
  const C = [];
  for (let i=0;i<4;i++) {
    C[i]=[];
    for (let j=0;j<4;j++) {
      let s=0;
      for (let k=0;k<4;k++) s += A[i][k]*B[k][j];
      C[i][j]=s;
    }
  }
  return C;
}

// Últimas posições detectadas
let lastDetectedPoints = null;

// Última matriz transformada calculada (camera atual referenciada ao mundo fixo)
let lastTransformedMatrix = null;

// Calibrar: botão toggles - primeiro clique realiza calibração e inicia gravação,
// segundo clique finaliza a gravação e faz download do .json
calibrateBtn.addEventListener('click', () => {
  // se já estamos gravando, então este clique finaliza a calibração e faz download
  if (isRecordingCalibration) {
    // finalizar gravação
    isRecordingCalibration = false;
    calibrateBtn.textContent = "Calibrar";
    // gera JSON e baixa (mantivemos comportamento anterior)
    const data = {
      recordedAt: new Date().toISOString(),
      frames: calibrationFrames.slice(),
      rays: (calibration && calibration.rays) ? calibration.rays.slice() : []
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const fname = `calibration-recording-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    // limpa buffer
    calibrationFrames = [];
    if (calibration && calibration.rays) calibration.rays = [];
    raysCountSpan.textContent = "0";
    alert("Calibração finalizada. Arquivo .json gerado e download iniciado.");
    return;
  }

  // não estamos gravando => faz a calibração inicial (mesma lógica anterior) e inicia gravação
  if (!currentScalePxPerMm) {
    alert("Escala ainda não determinada — mostre os marcadores +X e +Y para que a escala seja calculada primeiro.");
    return;
  }

  scaleLocked = true;
  lockedScalePxPerMm = currentScalePxPerMm;
  scaleLockedLabel.style.display = "inline";

  const input = prompt("Informe o valor atual de +Z (mm) — somente números, ex.: 120.5");
  if (input === null) {
    // usuário cancelou: desfaz lock
    scaleLocked = false;
    lockedScalePxPerMm = null;
    scaleLockedLabel.style.display = "none";
    return;
  }
  const zCal = parseFloat(input);
  if (Number.isNaN(zCal) || zCal <= 0) {
    alert("Valor inválido. A calibração foi cancelada.");
    scaleLocked = false;
    lockedScalePxPerMm = null;
    scaleLockedLabel.style.display = "none";
    return;
  }

  if (!lastDetectedPoints || !lastDetectedPoints.origin || !lastDetectedPoints.bluePt || !lastDetectedPoints.greenPt) {
    alert("Calibração falhou: origem, ponto azul e ponto verde devem estar detectados no momento.");
    scaleLocked = false;
    lockedScalePxPerMm = null;
    scaleLockedLabel.style.display = "none";
    return;
  }

  const origin = lastDetectedPoints.origin;
  const bluePt = lastDetectedPoints.bluePt;
  const greenPt = lastDetectedPoints.greenPt;
  const lenPxCal = Math.hypot(bluePt.x - origin.x, bluePt.y - origin.y);

  const orient = {
    alpha: lastOrientation.alpha,
    beta: lastOrientation.beta,
    gamma: lastOrientation.gamma
  };

  // Converte vetor azul para mm usando escala travada
  const dx_mm = (bluePt.x - origin.x) / lockedScalePxPerMm;
  const dy_mm = (bluePt.y - origin.y) / lockedScalePxPerMm;
  const vCam = [dx_mm, dy_mm, 0];

  const Rcal = rotationMatrixFromAlphaBetaGamma(orient.alpha, orient.beta, orient.gamma);
  const vWorldCal = applyMat3(Rcal, vCam);
  const worldLenCal = Math.hypot(vWorldCal[0], vWorldCal[1], vWorldCal[2]);

  // Monta matriz homogênea da câmera inicial no mundo fixo
  // posição da câmera no mundo no instante da calibração: (0,0,zCal) conforme premissa
  const tCal = [0, 0, zCal];
  const camMatrixCal = buildHomogeneousMatrix(Rcal, tCal);
  const invCamMatrixCal = inverseRigid4x4(camMatrixCal);

  calibration = {
    lockedScalePxPerMm,
    lenPxCal,
    orientationCal: orient,
    worldLenCal,
    zCalMm: zCal,
    originPixelCal: { x: origin.x, y: origin.y },
    camMatrixCal,
    invCamMatrixCal,
    rays: [] // inicia lista de raios definidos durante a calibração
  };

  // inicia gravação dos frames da calibração
  isRecordingCalibration = true;
  calibrationFrames = []; // limpa
  calibrateBtn.textContent = "Finalizar Calib.";
  raysCountSpan.textContent = "0";
  alert("Calibração iniciada e gravação de frames ativada. Clique em 'Finalizar Calib.' para encerrar e baixar o .json.");
});

function processFrame() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  let sumBlackX = 0, sumBlackY = 0, countBlack = 0;
  let sumBlueX  = 0, sumBlueY  = 0, countBlue  = 0;
  let sumGreenX = 0, sumGreenY = 0, countGreen = 0;
  let sumRedX   = 0, sumRedY   = 0, countRed   = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const p = i / 4;
    const x = p % canvas.width;
    const y = Math.floor(p / canvas.width);

    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      data[i] = 255; data[i+1] = 165; data[i+2] = 0;
      sumBlackX += x; sumBlackY += y; countBlack++;
    }
    else if (b > blueThreshold && r < blueThreshold && g < blueThreshold) {
      data[i] = 255; data[i+1] = 255; data[i+2] = 255;
      sumBlueX += x; sumBlueY += y; countBlue++;
    }
    else if (g > greenThreshold && r < greenThreshold && b < greenThreshold) {
      data[i] = 128; data[i+1] = 0; data[i+2] = 128;
      sumGreenX += x; sumGreenY += y; countGreen++;
    }
    else if (r > 150 && g < 100 && b < 100) {
      // detecta pixels vermelhos
      sumRedX += x; sumRedY += y; countRed++;
    }
  }

  ctx.putImageData(frame, 0, 0);

  let origin = null;
  let bluePt = null;
  let greenPt = null;
  let redPt = null;

  if (countBlack) {
    origin = { x: sumBlackX / countBlack, y: sumBlackY / countBlack };
    // drawPoint será chamado mais abaixo
  }

  if (countBlue) {
    bluePt = { x: sumBlueX / countBlue, y: sumBlueY / countBlue };
  }

  if (countGreen) {
    greenPt = { x: sumGreenX / countGreen, y: sumGreenY / countGreen };
  }

  if (countRed) {
    redPt = { x: sumRedX / countRed, y: sumRedY / countRed };
    // desenha ponto rosa no centro da área vermelha (como antes)
    drawPoint(redPt.x, redPt.y, "#FF69B4");
  }

  lastDetectedPoints = { origin, bluePt, greenPt, redPt };

  // cálculo da escala (px/mm) com base em vetor azul (len px corresponde a 100 mm)
  if (origin && bluePt) {
    const dx = bluePt.x - origin.x;
    const dy = bluePt.y - origin.y;
    const lenPx = Math.hypot(dx, dy);

    if (!scaleLocked) {
      currentScalePxPerMm = lenPx / 100; // px/mm
      scaleValue.textContent = currentScalePxPerMm.toFixed(3);
    } else {
      currentScalePxPerMm = lockedScalePxPerMm;
      scaleValue.textContent = lockedScalePxPerMm.toFixed(3);
    }
  } else {
    if (!scaleLocked) {
      scaleValue.textContent = "--";
      currentScalePxPerMm = null;
    } else {
      scaleValue.textContent = lockedScalePxPerMm.toFixed(3);
    }
  }

  // --- desenha o plano XY durante calibração (se aplicável)
  if (calibration && origin && bluePt && greenPt) {
    const cornerA = origin;
    const cornerB = bluePt;
    const cornerD = greenPt;
    const cornerC = { x: bluePt.x + (greenPt.x - origin.x), y: bluePt.y + (greenPt.y - origin.y) };

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cornerA.x, cornerA.y);
    ctx.lineTo(cornerB.x, cornerB.y);
    ctx.lineTo(cornerC.x, cornerC.y);
    ctx.lineTo(cornerD.x, cornerD.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(173,216,230,0.35)'; // lightblue semi-transparent
    ctx.fill();
    ctx.restore();
  }

  // desenha pontos e setas como antes (sobre o preenchimento)
  if (origin) drawPoint(origin.x, origin.y, "#FFFFFF");
  if (bluePt) drawPoint(bluePt.x, bluePt.y, "#0000FF");
  if (greenPt) drawPoint(greenPt.x, greenPt.y, "#00FF00");
  if (origin && bluePt) drawArrow(origin.x, origin.y, bluePt.x, bluePt.y, "#0000FF");
  if (origin && greenPt) drawArrow(origin.x, origin.y, greenPt.x, greenPt.y, "#00FF00");

  // Cálculo de +Z (mantido)
  let camZ_mm = NaN;
  if (calibration && origin && calibration.lockedScalePxPerMm) {
    if (origin && lastDetectedPoints.bluePt) {
      const blueNow = lastDetectedPoints.bluePt;
      const dx_px_now = blueNow.x - origin.x;
      const dy_px_now = blueNow.y - origin.y;

      const dx_mm_now = dx_px_now / calibration.lockedScalePxPerMm;
      const dy_mm_now = dy_px_now / calibration.lockedScalePxPerMm;
      const vCamNow = [dx_mm_now, dy_mm_now, 0];

      const orientNow = lastOrientation;
      const Rnow = rotationMatrixFromAlphaBetaGamma(orientNow.alpha, orientNow.beta, orientNow.gamma);
      const vWorldNow = applyMat3(Rnow, vCamNow);
      const worldLenNow = Math.hypot(vWorldNow[0], vWorldNow[1], vWorldNow[2]);

      if (worldLenNow > 1e-6 && calibration.worldLenCal > 1e-6) {
        camZ_mm = calibration.zCalMm * (calibration.worldLenCal / worldLenNow);
        zSpan.textContent = camZ_mm.toFixed(2);
      } else {
        zSpan.textContent = "--";
        camZ_mm = NaN;
      }
    } else {
      zSpan.textContent = "--";
    }
  } else {
    zSpan.textContent = "--";
  }

  // cálculo da translação da câmera em +X e +Y (mantido)
  let camX_mm = NaN, camY_mm = NaN;
  if (calibration && calibration.lockedScalePxPerMm && calibration.originPixelCal && origin) {
    const originCalPx = calibration.originPixelCal;
    const dx_px = origin.x - originCalPx.x;
    const dy_px = origin.y - originCalPx.y;

    const dx_mm = dx_px / calibration.lockedScalePxPerMm;
    const dy_mm = dy_px / calibration.lockedScalePxPerMm;

    // convenção: vCam = [-dx_mm, dy_mm, 0]
    const vCamForXY = [-dx_mm, dy_mm, 0];

    const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
    const vWorld = applyMat3(Rnow, vCamForXY);

    camX_mm = vWorld[0];
    camY_mm = vWorld[1];

    xSpan.textContent = camX_mm.toFixed(2);
    ySpan.textContent = camY_mm.toFixed(2);
  } else {
    xSpan.textContent = "--";
    ySpan.textContent = "--";
  }

  // montagem da matriz homogênea da pose atual da câmera e transformação para o referencial do mundo fixo (mantido)
  if (calibration && calibration.camMatrixCal && calibration.invCamMatrixCal) {
    const camZval = (zSpan.textContent !== "--") ? parseFloat(zSpan.textContent) : NaN;
    if (!Number.isNaN(camX_mm) && !Number.isNaN(camY_mm) && !Number.isNaN(camZval)) {
      const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
      const tNow = [camX_mm, camY_mm, camZval];

      const TcamNow = buildHomogeneousMatrix(Rnow, tNow);
      const Ttrans = multiply4x4(calibration.invCamMatrixCal, TcamNow);
      lastTransformedMatrix = Ttrans;
      console.log("Tcamera_now_in_world_fixed (4x4):", Ttrans);
    } else {
      lastTransformedMatrix = null;
    }
  } else {
    lastTransformedMatrix = null;
  }

  // se estamos gravando a calibração, registremos os valores deste frame (mantido)
  if (isRecordingCalibration) {
    const ts = new Date().toISOString();
    const pitch = (lastOrientation.beta != null) ? lastOrientation.beta : null;
    const yaw = (lastOrientation.alpha != null) ? lastOrientation.alpha : null;
    const roll = (lastOrientation.gamma != null) ? lastOrientation.gamma : null;

    const rec = {
      timestamp: ts,
      x_mm: Number.isFinite(camX_mm) ? Number(camX_mm.toFixed(4)) : null,
      y_mm: Number.isFinite(camY_mm) ? Number(camY_mm.toFixed(4)) : null,
      z_mm: Number.isFinite(camZ_mm) ? Number(camZ_mm.toFixed(4)) : null,
      pitch_deg: (pitch != null) ? Number(pitch.toFixed(4)) : null,
      yaw_deg: (yaw != null) ? Number(yaw.toFixed(4)) : null,
      roll_deg: (roll != null) ? Number(roll.toFixed(4)) : null
    };

    calibrationFrames.push(rec);

    // --- NOVO: se houver ponto rosa neste frame, definimos um raio 3D saindo da câmera
    if (lastDetectedPoints && lastDetectedPoints.redPt && calibration && calibration.lockedScalePxPerMm) {
      // use escala travada da calibração
      const scale = calibration.lockedScalePxPerMm;

      // coordenadas do ponto rosa em pixels
      const px = lastDetectedPoints.redPt.x;
      const py = lastDetectedPoints.redPt.y;

      // coordenadas relativas ao centro da imagem (origem da câmera no plano da imagem)
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const ux_px = px - cx;
      const uy_px = py - cy;

      // converte para mm usando escala (px/mm)
      const ux_mm = ux_px / scale;
      const uy_mm = uy_px / scale;

      // define direcção no referencial da câmera (z = 1 arbitrary unit in front of camera)
      let dirCam = [ux_mm, uy_mm, 1.0];

      // normaliza direção
      const len = Math.hypot(dirCam[0], dirCam[1], dirCam[2]);
      if (len > 0) {
        dirCam = [dirCam[0]/len, dirCam[1]/len, dirCam[2]/len];

        // transforma direção para o referencial do mundo usando a rotação atual
        const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
        const dirWorld = applyMat3(Rnow, dirCam);

        // origem do raio = posição da câmera no mundo (camX_mm, camY_mm, camZ_mm)
        // camX_mm/camY_mm/camZ_mm podem ser NaN se não calculados; só armazenamos se forem finitos
        const originWorld = (Number.isFinite(camX_mm) && Number.isFinite(camY_mm) && Number.isFinite(camZ_mm))
          ? [Number(camX_mm.toFixed(4)), Number(camY_mm.toFixed(4)), Number(camZ_mm.toFixed(4))]
          : null;

        // adiciona o raio à lista de calibração
        const rayEntry = {
          timestamp: ts,
          origin: originWorld, // pode ser null se não conhecido
          dir_world: [Number(dirWorld[0].toFixed(6)), Number(dirWorld[1].toFixed(6)), Number(dirWorld[2].toFixed(6))]
        };

        calibration.rays.push(rayEntry);
        raysCountSpan.textContent = String(calibration.rays.length);
      }
    }
  }

  requestAnimationFrame(processFrame);
}

function drawPoint(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawArrow(x1, y1, x2, y2, color) {
  const headLength = 10;
  const angle = Math.atan2(y2 - y1, x2 - x1);

  ctx.strokeStyle = color;
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
  ctx.fillStyle = color;
  ctx.fill();
}
