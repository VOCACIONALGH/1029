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

// ZXY UI
const zSpan = document.getElementById('zValue');
const xSpan = document.getElementById('xValue');
const ySpan = document.getElementById('yValue');

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

// calibração para +Z e origem
let calibration = null; 
// calibration will contain:
// { lockedScalePxPerMm, lenPxCal, orientationCal: {alpha,beta,gamma}, worldLenCal, zCalMm, originPixelCal, camMatrixCal, invCamMatrixCal }

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

// Calibrar: trava escala e pede valor +Z, guarda origem pixel do momento, monta matriz da câmera inicial e sua inversa
calibrateBtn.addEventListener('click', () => {
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
    invCamMatrixCal
  };

  alert("Calibração concluída.\nEscala travada e +Z informado.");
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

  if (countBlack) {
    origin = { x: sumBlackX / countBlack, y: sumBlackY / countBlack };
    // drawPoint will be called later (after plane)
  }

  if (countBlue) {
    bluePt = { x: sumBlueX / countBlue, y: sumBlueY / countBlue };
  }

  if (countGreen) {
    greenPt = { x: sumGreenX / countGreen, y: sumGreenY / countGreen };
  }

  if (countRed) {
    drawPoint(sumRedX / countRed, sumRedY / countRed, "#FF69B4");
  }

  lastDetectedPoints = { origin, bluePt, greenPt };

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

  // --- NOVO: se estamos calibrados (calibration existe) e temos origin, bluePt, greenPt,
  // desenhamos o plano XY definido pela origem e vetores.
  // Construímos os quatro cantos na tela: origin, bluePt, corner4 = bluePt + (greenPt - origin), greenPt.
  // Preenchimento azul-claro; depois redesenhamos pontos e setas por cima.
  if (calibration && origin && bluePt && greenPt) {
    const cornerA = origin;
    const cornerB = bluePt;
    const cornerD = greenPt;
    const cornerC = { x: bluePt.x + (greenPt.x - origin.x), y: bluePt.y + (greenPt.y - origin.y) };

    // fill light-blue with slight transparency
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
  if (origin) {
    drawPoint(origin.x, origin.y, "#FFFFFF");
  }

  if (bluePt) {
    drawPoint(bluePt.x, bluePt.y, "#0000FF");
  }

  if (greenPt) {
    drawPoint(greenPt.x, greenPt.y, "#00FF00");
  }

  // desenha setas (se origem e pts existirem)
  if (origin && bluePt) {
    drawArrow(origin.x, origin.y, bluePt.x, bluePt.y, "#0000FF");
  }
  if (origin && greenPt) {
    drawArrow(origin.x, origin.y, greenPt.x, greenPt.y, "#00FF00");
  }

  // Cálculo de +Z (mantido)
  if (calibration && origin && calibration.lockedScalePxPerMm) {
    if (origin && lastDetectedPoints.bluePt) {
      const blueNow = lastDetectedPoints.bluePt;
      const dx_px_now = blueNow.x - origin.x;
      const dy_px_now = blueNow.y - origin.y;
      const lenPxNow = Math.hypot(dx_px_now, dy_px_now);

      const dx_mm_now = dx_px_now / calibration.lockedScalePxPerMm;
      const dy_mm_now = dy_px_now / calibration.lockedScalePxPerMm;
      const vCamNow = [dx_mm_now, dy_mm_now, 0];

      const orientNow = lastOrientation;
      const Rnow = rotationMatrixFromAlphaBetaGamma(orientNow.alpha, orientNow.beta, orientNow.gamma);
      const vWorldNow = applyMat3(Rnow, vCamNow);
      const worldLenNow = Math.hypot(vWorldNow[0], vWorldNow[1], vWorldNow[2]);

      if (worldLenNow > 1e-6 && calibration.worldLenCal > 1e-6) {
        const zNow = calibration.zCalMm * (calibration.worldLenCal / worldLenNow);
        zSpan.textContent = zNow.toFixed(2);
      } else {
        zSpan.textContent = "--";
      }
    } else {
      zSpan.textContent = "--";
    }
  } else {
    zSpan.textContent = "--";
  }

  // cálculo da translação da câmera em +X e +Y (mantido)
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

    const camX_mm = vWorld[0];
    const camY_mm = vWorld[1];

    xSpan.textContent = camX_mm.toFixed(2);
    ySpan.textContent = camY_mm.toFixed(2);
  } else {
    xSpan.textContent = "--";
    ySpan.textContent = "--";
  }

  // --- NOVO: montagem da matriz homogênea da pose atual da câmera e transformação para o referencial do mundo fixo
  if (calibration && calibration.camMatrixCal && calibration.invCamMatrixCal) {
    const camX = (xSpan.textContent !== "--") ? parseFloat(xSpan.textContent) : NaN;
    const camY = (ySpan.textContent !== "--") ? parseFloat(ySpan.textContent) : NaN;
    const camZ = (zSpan.textContent !== "--") ? parseFloat(zSpan.textContent) : NaN;

    if (!Number.isNaN(camX) && !Number.isNaN(camY) && !Number.isNaN(camZ)) {
      const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
      const tNow = [camX, camY, camZ];

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
