// main.js (atualizado: aplica rotação 3x3 aos vetores pinhole para o referencial fixo da calibração)
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

// ZXY UI + Raios count + contagem vetores rotacionados
const zSpan = document.getElementById('zValue');
const xSpan = document.getElementById('xValue');
const ySpan = document.getElementById('yValue');
const raysCountSpan = document.getElementById('raysCount');
const pinkDirectedCountSpan = document.getElementById('pinkDirectedCount');
const rotatedCountSpan = document.getElementById('rotatedCount');

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
// calibration will contain (entre outros):
// { lockedScalePxPerMm, lenPxCal, orientationCal: {alpha,beta,gamma}, worldLenCal,
//   zCalMm, originPixelCal, camMatrixCal, invCamMatrixCal, rays: [], rotatedRays: [] }

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
// Input angles in degrees; function converts to radians internally.
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

// Calibrar (toggle) - primeiro clique inicializa calibração e gravação, segundo finaliza e baixa .json
calibrateBtn.addEventListener('click', () => {
  if (isRecordingCalibration) {
    // finalizar gravação
    isRecordingCalibration = false;
    calibrateBtn.textContent = "Calibrar";
    const data = {
      recordedAt: new Date().toISOString(),
      frames: calibrationFrames.slice(),
      rays: (calibration && calibration.rays) ? calibration.rays.slice() : [],
      rotatedRays: (calibration && calibration.rotatedRays) ? calibration.rotatedRays.slice() : []
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const fname = `calibration-recording-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    // limpa buffers e UI contadores relacionados
    calibrationFrames = [];
    if (calibration) {
      calibration.rays = [];
      calibration.rotatedRays = [];
    }
    raysCountSpan.textContent = "0";
    pinkDirectedCountSpan.textContent = "0";
    rotatedCountSpan.textContent = "0";
    alert("Calibração finalizada. Arquivo .json gerado e download iniciado.");
    return;
  }

  // iniciar calibração
  if (!currentScalePxPerMm) {
    alert("Escala ainda não determinada — mostre os marcadores +X e +Y para que a escala seja calculada primeiro.");
    return;
  }

  scaleLocked = true;
  lockedScalePxPerMm = currentScalePxPerMm;
  scaleLockedLabel.style.display = "inline";

  const input = prompt("Informe o valor atual de +Z (mm) — somente números, ex.: 120.5");
  if (input === null) {
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
    rays: [],           // raios definidos (anterior)
    rotatedRays: []     // raios após rotação para referencial fixo
  };

  // inicia gravação dos frames da calibração
  isRecordingCalibration = true;
  calibrationFrames = [];
  calibrateBtn.textContent = "Finalizar Calib.";
  raysCountSpan.textContent = "0";
  pinkDirectedCountSpan.textContent = "0";
  rotatedCountSpan.textContent = "0";
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
  }

  if (countBlue) {
    bluePt = { x: sumBlueX / countBlue, y: sumBlueY / countBlue };
  }

  if (countGreen) {
    greenPt = { x: sumGreenX / countGreen, y: sumGreenY / countGreen };
  }

  if (countRed) {
    redPt = { x: sumRedX / countRed, y: sumRedY / countRed };
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

  // desenha plano XY se aplicável (mantido)
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
    ctx.fillStyle = 'rgba(173,216,230,0.35)';
    ctx.fill();
    ctx.restore();
  }

  // desenha pontos e setas (mantido)
  if (origin) drawPoint(origin.x, origin.y, "#FFFFFF");
  if (bluePt) drawPoint(bluePt.x, bluePt.y, "#0000FF");
  if (greenPt) drawPoint(greenPt.x, greenPt.y, "#00FF00");
  if (origin && bluePt) drawArrow(origin.x, origin.y, bluePt.x, bluePt.y, "#0000FF");
  if (origin && greenPt) drawArrow(origin.x, origin.y, greenPt.x, greenPt.y, "#00FF00");

  // cálculo de +Z (mantido)
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
    } else {
      lastTransformedMatrix = null;
    }
  } else {
    lastTransformedMatrix = null;
  }

  // gravação por frame (mantido) + criação de raios e direção pinhole
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

    // se houver ponto rosa, definimos direção pinhole (como antes) e o raio
    if (lastDetectedPoints && lastDetectedPoints.redPt && calibration && calibration.lockedScalePxPerMm) {
      const px = lastDetectedPoints.redPt.x;
      const py = lastDetectedPoints.redPt.y;

      // principal point approximated as image center
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // estimate focal length in pixels using calibration if possible (heuristic)
      let f_px = Math.max(canvas.width, canvas.height);
      try {
        if (calibration && calibration.lenPxCal && calibration.worldLenCal && calibration.zCalMm) {
          if (calibration.worldLenCal > 1e-6) {
            f_px = (calibration.lenPxCal * calibration.zCalMm) / calibration.worldLenCal;
            if (!isFinite(f_px) || f_px <= 1e-3) f_px = Math.max(canvas.width, canvas.height);
          }
        }
      } catch (e) {
        f_px = Math.max(canvas.width, canvas.height);
      }

      // pinhole normalized coordinates
      const x_norm = (px - cx) / f_px;
      const y_norm = (py - cy) / f_px;

      // camera direction (pinhole model)
      let dirCam = [x_norm, y_norm, 1.0];
      let lenDir = Math.hypot(dirCam[0], dirCam[1], dirCam[2]);
      if (lenDir > 0) {
        dirCam = [dirCam[0]/lenDir, dirCam[1]/lenDir, dirCam[2]/lenDir];

        // transforma direção da câmera para "world" usando orientação atual (como antes)
        const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
        const dirWorld = applyMat3(Rnow, dirCam);

        // registra o raio original (mantendo origem = câmera, direção = dirWorld)
        const originWorld = (Number.isFinite(camX_mm) && Number.isFinite(camY_mm) && Number.isFinite(camZ_mm))
          ? [Number(camX_mm.toFixed(4)), Number(camY_mm.toFixed(4)), Number(camZ_mm.toFixed(4))]
          : null;

        const rayEntry = {
          timestamp: ts,
          origin: originWorld,
          dir_world: [Number(dirWorld[0].toFixed(6)), Number(dirWorld[1].toFixed(6)), Number(dirWorld[2].toFixed(6))]
        };

        calibration.rays.push(rayEntry);
        raysCountSpan.textContent = String(calibration.rays.length);
        pinkDirectedCountSpan.textContent = String(calibration.rays.length);
      }

      // --- NOVO: rotacionar o vetor pinhole para o referencial fixo da calibração
      // Aplicamos a matriz de rotação 3x3 derivada de calibration.orientationCal (graus -> radianos,
      // feito internamente por rotationMatrixFromAlphaBetaGamma) ao vetor em coordenadas da câmera (dirCam),
      // e mantemos o vetor normalizado.
      if (calibration && calibration.orientationCal) {
        // recupera direção em camera coords (dirCam normalizado)
        // (usamos o dirCam já normalizado acima)
        let dirCamForRotation = [dirCam[0], dirCam[1], dirCam[2]];

        // monta matriz de rotação do referencial fixo (usando a orientação da calibração)
        const orientCal = calibration.orientationCal;
        const Rfixed = rotationMatrixFromAlphaBetaGamma(orientCal.alpha, orientCal.beta, orientCal.gamma);

        // aplica Rfixed ao dirCam
        let dirRotated = applyMat3(Rfixed, dirCamForRotation);

        // normaliza
        const lr = Math.hypot(dirRotated[0], dirRotated[1], dirRotated[2]);
        if (lr > 0) {
          dirRotated = [dirRotated[0]/lr, dirRotated[1]/lr, dirRotated[2]/lr];

          // guarda no array de rotatedRays (origem continua sendo a câmera)
          const rotatedEntry = {
            timestamp: ts,
            origin: originWorld,
            dir_rotated: [Number(dirRotated[0].toFixed(6)), Number(dirRotated[1].toFixed(6)), Number(dirRotated[2].toFixed(6))]
          };

          calibration.rotatedRays.push(rotatedEntry);

          // atualiza contador na UI
          rotatedCountSpan.textContent = String(calibration.rotatedRays.length);
        }
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
