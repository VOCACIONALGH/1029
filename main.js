// main.js — inclui atualização da Posição 3D atual do ponto rosa na UI,
// aplica critério de convergência por norma do deslocamento entre triangulações consecutivas,
// e adiciona definição sequencial de pontos rosas (desaparecimento ↔ surgimento) durante a calibração.

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

// ZXY UI + contadores + triangulated pos spans
const zSpan = document.getElementById('zValue');
const xSpan = document.getElementById('xValue');
const ySpan = document.getElementById('yValue');

const raysCountSpan = document.getElementById('raysCount');
const pinkDirectedCountSpan = document.getElementById('pinkDirectedCount');
const rotatedCountSpan = document.getElementById('rotatedCount');
const acceptedCountSpan = document.getElementById('acceptedCount');
const registered3DCountSpan = document.getElementById('registered3DCount');
const triangulatedCountSpan = document.getElementById('triangulatedCount');

// NOVOS: elementos para exibir a posição 3D atual do ponto rosa
const triXSpan = document.getElementById('triX');
const triYSpan = document.getElementById('triY');
const triZSpan = document.getElementById('triZ');

// NOVOS: elementos para exibir o último ponto rosa definido (desaparecimento/surgimento)
const lastDefXSpan = document.getElementById('lastDefX');
const lastDefYSpan = document.getElementById('lastDefY');
const lastDefZSpan = document.getElementById('lastDefZ');
const lastDefTypeSpan = document.getElementById('lastDefType');
const lastDefCountSpan = document.getElementById('lastDefCount');

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

let currentScalePxPerMm = null;
let scaleLocked = false;
let lockedScalePxPerMm = null;

let isRecordingCalibration = false;
let calibrationFrames = [];

let calibration = null;

// Convergence threshold (norma do deslocamento em mm).
// Ajuste este valor conforme necessário.
const CONVERGENCE_NORM_MM = 2.0; // padrão: 2 mm

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

// rotation matrix and helpers
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
function cross(a,b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0]
  ];
}
function norm(v) {
  const l = Math.hypot(v[0],v[1],v[2]);
  if (l === 0 || !isFinite(l)) return [0,0,0];
  return [v[0]/l, v[1]/l, v[2]/l];
}
function transpose3(M) {
  return [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]]
  ];
}
function mul3x3Vec(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
  ];
}
function buildHomogeneousMatrix(R, t) {
  return [
    [R[0][0], R[0][1], R[0][2], t[0]],
    [R[1][0], R[1][1], R[1][2], t[1]],
    [R[2][0], R[2][1], R[2][2], t[2]],
    [0, 0, 0, 1]
  ];
}
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

// small matrix inverse for 3x3 using adjugate (returns null if near-singular)
function invert3x3(M) {
  const a=M[0][0], b=M[0][1], c=M[0][2];
  const d=M[1][0], e=M[1][1], f=M[1][2];
  const g=M[2][0], h=M[2][1], i=M[2][2];
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
  if (!isFinite(det) || Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  return [
    [A*invDet, D*invDet, G*invDet],
    [B*invDet, E*invDet, H*invDet],
    [C*invDet, F*invDet, I*invDet]
  ];
}

// triangulate from multiple rays (rays: array of { origin:{x,y,z}, direction:{dx,dy,dz} })
function triangulateFromRays(rays) {
  if (!rays || rays.length === 0) return null;
  let A = [[0,0,0],[0,0,0],[0,0,0]];
  let b = [0,0,0];
  for (const r of rays) {
    const o = [r.origin.x, r.origin.y, r.origin.z];
    const d = [r.direction.dx, r.direction.dy, r.direction.dz];
    const dn = Math.hypot(d[0],d[1],d[2]);
    if (dn <= 1e-9) return null;
    const dd = [d[0]/dn, d[1]/dn, d[2]/dn];
    const P = [
      [1 - dd[0]*dd[0],   -dd[0]*dd[1],   -dd[0]*dd[2]],
      [-dd[1]*dd[0],   1 - dd[1]*dd[1],   -dd[1]*dd[2]],
      [-dd[2]*dd[0],     -dd[2]*dd[1], 1 - dd[2]*dd[2]]
    ];
    for (let row=0; row<3; row++) for (let col=0; col<3; col++) A[row][col] += P[row][col];
    const Po = [
      P[0][0]*o[0] + P[0][1]*o[1] + P[0][2]*o[2],
      P[1][0]*o[0] + P[1][1]*o[1] + P[1][2]*o[2],
      P[2][0]*o[0] + P[2][1]*o[1] + P[2][2]*o[2]
    ];
    b[0] += Po[0]; b[1] += Po[1]; b[2] += Po[2];
  }
  const Ainv = invert3x3(A);
  if (!Ainv) return null;
  const X = [
    Ainv[0][0]*b[0] + Ainv[0][1]*b[1] + Ainv[0][2]*b[2],
    Ainv[1][0]*b[0] + Ainv[1][1]*b[1] + Ainv[1][2]*b[2],
    Ainv[2][0]*b[0] + Ainv[2][1]*b[1] + Ainv[2][2]*b[2]
  ];
  return { x: X[0], y: X[1], z: X[2] };
}

// parameters for acceptance (kept behavior)
const DEFAULT_MIN_CAMERA_MOVE_MM = 5;
const PARALLEL_ANGLE_DEG = 5;
const PARALLEL_ANGLE_RAD = PARALLEL_ANGLE_DEG * Math.PI / 180;

let lastDetectedPoints = null;
let lastTransformedMatrix = null;

calibrateBtn.addEventListener('click', () => {
  if (isRecordingCalibration) {
    // finalize: include triangulatedPoints in JSON too
    isRecordingCalibration = false;
    calibrateBtn.textContent = "Calibrar";
    const data = {
      recordedAt: new Date().toISOString(),
      frames: calibrationFrames.slice(),
      rays: (calibration && calibration.rays) ? calibration.rays.slice() : [],
      registeredRays: (calibration && calibration.registeredRays) ? calibration.registeredRays.slice() : [],
      triangulatedPoints: (calibration && calibration.triangulatedPoints) ? calibration.triangulatedPoints.slice() : [],
      definedPinkPoints: (calibration && calibration.definedPinkPoints) ? calibration.definedPinkPoints.slice() : []
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const fname = `calibration-recording-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);

    // cleanup UI counters and buffers
    calibrationFrames = [];
    if (calibration) {
      calibration.rays = [];
      calibration.registeredRays = [];
      calibration.triangulatedPoints = [];
      calibration.acceptedRays = [];
      calibration.lastAcceptedPos = null;
      calibration.lastAcceptedDir = null;
      calibration.lastTriangulatedPoint = null;
      calibration.definedPinkPoints = [];
      calibration.pinkVisiblePrev = false;
      calibration.lastSeenPinkPixel = null;
      calibration.lastDefined = null;
    }
    raysCountSpan.textContent = "0";
    pinkDirectedCountSpan.textContent = "0";
    rotatedCountSpan.textContent = "0";
    acceptedCountSpan.textContent = "0";
    registered3DCountSpan.textContent = "0";
    triangulatedCountSpan.textContent = "0";
    // reset displayed triangulated position
    triXSpan.textContent = "--";
    triYSpan.textContent = "--";
    triZSpan.textContent = "--";
    // reset last defined UI
    lastDefXSpan.textContent = "--";
    lastDefYSpan.textContent = "--";
    lastDefZSpan.textContent = "--";
    lastDefTypeSpan.textContent = "--";
    lastDefCountSpan.textContent = "0";

    alert("Calibração finalizada. Arquivo .json gerado e download iniciado.");
    return;
  }

  // starting calibration: require scale determined
  if (!currentScalePxPerMm) {
    alert("Escala ainda não determinada — mostre os marcadores +X e +Y para que a escala seja calculada primeiro.");
    return;
  }

  scaleLocked = true;
  lockedScalePxPerMm = currentScalePxPerMm;
  scaleLockedLabel.style.display = "inline";

  const inputZ = prompt("Informe o valor atual de +Z (mm) — somente números, ex.: 120.5");
  if (inputZ === null) {
    scaleLocked = false;
    lockedScalePxPerMm = null;
    scaleLockedLabel.style.display = "none";
    return;
  }
  const zCal = parseFloat(inputZ);
  if (Number.isNaN(zCal) || zCal <= 0) {
    alert("Valor inválido. A calibração foi cancelada.");
    scaleLocked = false;
    lockedScalePxPerMm = null;
    scaleLockedLabel.style.display = "none";
    return;
  }

  const inputMinMove = prompt(`Informe MIN_CAMERA_MOVE_MM (mm) — valor mínimo de movimento da câmera para aceitar novo raio. Padrão ${DEFAULT_MIN_CAMERA_MOVE_MM} mm:`);
  let minMoveVal = DEFAULT_MIN_CAMERA_MOVE_MM;
  if (inputMinMove !== null) {
    const v = parseFloat(inputMinMove);
    if (!Number.isNaN(v) && v >= 0) minMoveVal = v;
  }

  const inputNumRays = prompt("Informe a quantidade de raios necessária para triangular o ponto rosa (inteiro >=2). Padrão 3:");
  let numRaysNeeded = 3;
  if (inputNumRays !== null) {
    const n = parseInt(inputNumRays, 10);
    if (!Number.isNaN(n) && n >= 2) numRaysNeeded = n;
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

  const dx_mm = (bluePt.x - origin.x) / lockedScalePxPerMm;
  const dy_mm = (bluePt.y - origin.y) / lockedScalePxPerMm;
  const vCam = [dx_mm, dy_mm, 0];

  const Rcal = rotationMatrixFromAlphaBetaGamma(orient.alpha, orient.beta, orient.gamma);
  const vWorldCal = applyMat3(Rcal, vCam);
  const worldLenCal = Math.hypot(vWorldCal[0], vWorldCal[1], vWorldCal[2]);

  const dxg_mm = (greenPt.x - origin.x) / lockedScalePxPerMm;
  const dyg_mm = (greenPt.y - origin.y) / lockedScalePxPerMm;
  const vCamG = [dxg_mm, dyg_mm, 0];
  const vWorldG = applyMat3(Rcal, vCamG);

  const tCal = [0, 0, zCal];
  const camMatrixCal = buildHomogeneousMatrix(Rcal, tCal);
  const invCamMatrixCal = inverseRigid4x4(camMatrixCal);

  const xAxis = norm(vWorldCal);
  const tempY = vWorldG;
  let zAxis = norm(cross(xAxis, tempY));
  if (Math.hypot(zAxis[0],zAxis[1],zAxis[2]) < 1e-6) {
    const camForward = applyMat3(Rcal, [0,0,1]);
    zAxis = norm(camForward);
  }
  const yAxis = norm(cross(zAxis, xAxis));

  const basisMatrix = [
    [xAxis[0], yAxis[0], zAxis[0]],
    [xAxis[1], yAxis[1], zAxis[1]],
    [xAxis[2], yAxis[2], zAxis[2]]
  ];
  const basisMatrixT = transpose3(basisMatrix);

  calibration = {
    lockedScalePxPerMm,
    lenPxCal,
    orientationCal: orient,
    worldLenCal,
    zCalMm: zCal,
    originPixelCal: { x: origin.x, y: origin.y },
    camMatrixCal,
    invCamMatrixCal,
    rays: [],
    basisMatrix,
    basisMatrixT,
    minCameraMoveMm: minMoveVal,
    acceptedRays: [],
    lastAcceptedPos: null,
    lastAcceptedDir: null,
    registeredRays: [],
    triangulatedPoints: [],
    lastTriangulatedPoint: null, // guarda última triangulação aceita
    numRaysNeeded,
    // novos campos para definição de pontos rosas
    definedPinkPoints: [],
    pinkVisiblePrev: Boolean(lastDetectedPoints && lastDetectedPoints.redPt),
    lastSeenPinkPixel: lastDetectedPoints && lastDetectedPoints.redPt ? { x: lastDetectedPoints.redPt.x, y: lastDetectedPoints.redPt.y } : null,
    lastDefined: null
  };

  isRecordingCalibration = true;
  calibrationFrames = [];
  calibrateBtn.textContent = "Finalizar Calib.";
  raysCountSpan.textContent = "0";
  pinkDirectedCountSpan.textContent = "0";
  rotatedCountSpan.textContent = "0";
  acceptedCountSpan.textContent = "0";
  registered3DCountSpan.textContent = "0";
  triangulatedCountSpan.textContent = "0";

  // reset displayed triangulated position at start
  triXSpan.textContent = "--";
  triYSpan.textContent = "--";
  triZSpan.textContent = "--";

  // reset last defined UI
  lastDefXSpan.textContent = "--";
  lastDefYSpan.textContent = "--";
  lastDefZSpan.textContent = "--";
  lastDefTypeSpan.textContent = "--";
  lastDefCountSpan.textContent = "0";

  alert(`Calibração iniciada.\nMIN_CAMERA_MOVE_MM = ${minMoveVal} mm.\nRaios necessários para triangulação = ${numRaysNeeded}.\nClique em 'Finalizar Calib.' para encerrar e baixar o .json.`);
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
    const r = data[i], g = data[i+1], b = data[i+2];
    const p = i / 4;
    const x = p % canvas.width;
    const y = Math.floor(p / canvas.width);

    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      data[i]=255; data[i+1]=165; data[i+2]=0;
      sumBlackX += x; sumBlackY += y; countBlack++;
    } else if (b > blueThreshold && r < blueThreshold && g < blueThreshold) {
      data[i]=255; data[i+1]=255; data[i+2]=255;
      sumBlueX += x; sumBlueY += y; countBlue++;
    } else if (g > greenThreshold && r < greenThreshold && b < greenThreshold) {
      data[i]=128; data[i+1]=0; data[i+2]=128;
      sumGreenX += x; sumGreenY += y; countGreen++;
    } else if (r > 150 && g < 100 && b < 100) {
      sumRedX += x; sumRedY += y; countRed++;
    }
  }

  ctx.putImageData(frame, 0, 0);

  let origin = null, bluePt = null, greenPt = null, redPt = null;
  if (countBlack) origin = { x: sumBlackX / countBlack, y: sumBlackY / countBlack };
  if (countBlue)  bluePt = { x: sumBlueX / countBlue, y: sumBlueY / countBlue };
  if (countGreen) greenPt = { x: sumGreenX / countGreen, y: sumGreenY / countGreen };
  if (countRed)   redPt = { x: sumRedX / countRed, y: sumRedY / countRed, count: countRed, cx: sumRedX/countRed, cy: sumRedY/countRed };

  if (countRed) drawPoint(redPt.x, redPt.y, "#FF69B4");
  lastDetectedPoints = { origin, bluePt, greenPt, redPt };

  // escala
  if (origin && bluePt) {
    const dx = bluePt.x - origin.x, dy = bluePt.y - origin.y;
    const lenPx = Math.hypot(dx,dy);
    if (!scaleLocked) {
      currentScalePxPerMm = lenPx / 100;
      scaleValue.textContent = currentScalePxPerMm.toFixed(3);
    } else {
      currentScalePxPerMm = lockedScalePxPerMm;
      scaleValue.textContent = lockedScalePxPerMm.toFixed(3);
    }
  } else {
    if (!scaleLocked) { scaleValue.textContent="--"; currentScalePxPerMm=null; }
    else scaleValue.textContent = lockedScalePxPerMm.toFixed(3);
  }

  // plano XY
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

  if (origin) drawPoint(origin.x, origin.y, "#FFFFFF");
  if (bluePt) drawPoint(bluePt.x, bluePt.y, "#0000FF");
  if (greenPt) drawPoint(greenPt.x, greenPt.y, "#00FF00");
  if (origin && bluePt) drawArrow(origin.x, origin.y, bluePt.x, bluePt.y, "#0000FF");
  if (origin && greenPt) drawArrow(origin.x, origin.y, greenPt.x, greenPt.y, "#00FF00");

  // +Z
  let camZ_mm = NaN;
  if (calibration && origin && calibration.lockedScalePxPerMm) {
    if (origin && lastDetectedPoints.bluePt) {
      const blueNow = lastDetectedPoints.bluePt;
      const dx_px_now = blueNow.x - origin.x, dy_px_now = blueNow.y - origin.y;
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
      } else { zSpan.textContent = "--"; camZ_mm = NaN; }
    } else { zSpan.textContent = "--"; }
  } else { zSpan.textContent="--"; }

  // cam X Y
  let camX_mm = NaN, camY_mm = NaN;
  if (calibration && calibration.lockedScalePxPerMm && calibration.originPixelCal && origin) {
    const originCalPx = calibration.originPixelCal;
    const dx_px = origin.x - originCalPx.x, dy_px = origin.y - originCalPx.y;
    const dx_mm = dx_px / calibration.lockedScalePxPerMm, dy_mm = dy_px / calibration.lockedScalePxPerMm;
    const vCamForXY = [-dx_mm, dy_mm, 0];
    const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
    const vWorld = applyMat3(Rnow, vCamForXY);
    camX_mm = vWorld[0]; camY_mm = vWorld[1];
    xSpan.textContent = camX_mm.toFixed(2);
    ySpan.textContent = camY_mm.toFixed(2);
  } else { xSpan.textContent="--"; ySpan.textContent="--"; }

  // pose transform (kept)
  if (calibration && calibration.camMatrixCal && calibration.invCamMatrixCal) {
    const camZval = (zSpan.textContent !== "--") ? parseFloat(zSpan.textContent) : NaN;
    if (!Number.isNaN(camX_mm) && !Number.isNaN(camY_mm) && !Number.isNaN(camZval)) {
      const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
      const tNow = [camX_mm, camY_mm, camZval];
      const TcamNow = buildHomogeneousMatrix(Rnow, tNow);
      const Ttrans = multiply4x4(calibration.invCamMatrixCal, TcamNow);
      lastTransformedMatrix = Ttrans;
    } else lastTransformedMatrix = null;
  } else lastTransformedMatrix = null;

  // recording/calibration logic
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

    // ---------- NOVA LÓGICA: definição sequencial de pontos rosas ----------
    // Detectar transições visible -> not visible (desaparecimento) e not visible -> visible (surgimento)
    const currentPinkVisible = Boolean(lastDetectedPoints && lastDetectedPoints.redPt);
    // atualizar lastSeenPinkPixel quando visível
    if (currentPinkVisible) {
      calibration.lastSeenPinkPixel = { x: lastDetectedPoints.redPt.x, y: lastDetectedPoints.redPt.y };
    }

    // somente durante calibração: processar transições
    if (calibration) {
      const prev = Boolean(calibration.pinkVisiblePrev);
      if (prev && !currentPinkVisible) {
        // Evento: desaparecimento -> define um ponto rosa (usa última posição conhecida)
        const px = calibration.lastSeenPinkPixel ? calibration.lastSeenPinkPixel.x : null;
        const py = calibration.lastSeenPinkPixel ? calibration.lastSeenPinkPixel.y : null;
        const defined = {
          type: "desaparecimento",
          timestamp: ts,
          pixel: (px != null && py != null) ? { x: px, y: py } : null,
          triangulated3D: calibration.lastTriangulatedPoint ? { x: calibration.lastTriangulatedPoint.x, y: calibration.lastTriangulatedPoint.y, z: calibration.lastTriangulatedPoint.z } : null
        };
        calibration.definedPinkPoints.push(defined);
        calibration.lastDefined = defined;
        // atualizar UI: prioriza coordenadas 3D trianguladas se disponíveis, senão mostra mm (relativo à origem) se possível, senão px
        updateLastDefinedUI(defined);
      } else if (!prev && currentPinkVisible) {
        // Evento: surgimento -> define um ponto rosa (usa posição atual)
        const px = lastDetectedPoints.redPt.x;
        const py = lastDetectedPoints.redPt.y;
        const defined = {
          type: "surgimento",
          timestamp: ts,
          pixel: { x: px, y: py },
          triangulated3D: calibration.lastTriangulatedPoint ? { x: calibration.lastTriangulatedPoint.x, y: calibration.lastTriangulatedPoint.y, z: calibration.lastTriangulatedPoint.z } : null
        };
        calibration.definedPinkPoints.push(defined);
        calibration.lastDefined = defined;
        updateLastDefinedUI(defined);
      }
      // atualizar estado anterior
      calibration.pinkVisiblePrev = currentPinkVisible;
    }
    // -------------------------------------------------------------------

    // process pink point: generate ray (pinhole), rotate, register, possibly accept, and attempt triangulation
    if (lastDetectedPoints && lastDetectedPoints.redPt && calibration && calibration.lockedScalePxPerMm) {
      const px = lastDetectedPoints.redPt.x;
      const py = lastDetectedPoints.redPt.y;
      const cx = canvas.width / 2, cy = canvas.height / 2;

      let f_px = Math.max(canvas.width, canvas.height);
      try {
        if (calibration && calibration.lenPxCal && calibration.worldLenCal && calibration.zCalMm) {
          if (calibration.worldLenCal > 1e-6) {
            f_px = (calibration.lenPxCal * calibration.zCalMm) / calibration.worldLenCal;
            if (!isFinite(f_px) || f_px <= 1e-3) f_px = Math.max(canvas.width, canvas.height);
          }
        }
      } catch (e) { f_px = Math.max(canvas.width, canvas.height); }

      const x_norm = (px - cx) / f_px;
      const y_norm = (py - cy) / f_px;
      let dirCam = [x_norm, y_norm, 1.0];
      const lenDirCam = Math.hypot(dirCam[0], dirCam[1], dirCam[2]);
      if (lenDirCam <= 0) { requestAnimationFrame(processFrame); return; }
      dirCam = [dirCam[0]/lenDirCam, dirCam[1]/lenDirCam, dirCam[2]/lenDirCam];

      const Rnow = rotationMatrixFromAlphaBetaGamma(lastOrientation.alpha, lastOrientation.beta, lastOrientation.gamma);
      const dirWorld = applyMat3(Rnow, dirCam);

      const originWorld = (Number.isFinite(camX_mm) && Number.isFinite(camY_mm) && Number.isFinite(camZ_mm))
        ? [Number(camX_mm.toFixed(4)), Number(camY_mm.toFixed(4)), Number(camZ_mm.toFixed(4))] : null;

      const rayEntry = {
        timestamp: ts,
        origin: originWorld,
        dir_world: [Number(dirWorld[0].toFixed(6)), Number(dirWorld[1].toFixed(6)), Number(dirWorld[2].toFixed(6))],
        dir_rotated: null,
        accepted: false
      };

      calibration.rays.push(rayEntry);
      raysCountSpan.textContent = String(calibration.rays.length);
      pinkDirectedCountSpan.textContent = String(calibration.rays.length);

      if (calibration && calibration.basisMatrixT) {
        const dirRot = mul3x3Vec(calibration.basisMatrixT, dirWorld);
        const dirRotNorm = norm(dirRot);
        rayEntry.dir_rotated = [Number(dirRotNorm[0].toFixed(6)), Number(dirRotNorm[1].toFixed(6)), Number(dirRotNorm[2].toFixed(6))];
        rotatedCountSpan.textContent = String(calibration.rays.filter(r => r.dir_rotated !== null).length);
      }

      // acceptance logic (keeps original behavior)
      let accepted = false;
      const minMove = (calibration && calibration.minCameraMoveMm != null) ? calibration.minCameraMoveMm : DEFAULT_MIN_CAMERA_MOVE_MM;
      if (originWorld && calibration.lastAcceptedPos == null) {
        accepted = true;
      } else if (originWorld && calibration.lastAcceptedPos != null) {
        const dx = originWorld[0] - calibration.lastAcceptedPos[0];
        const dy = originWorld[1] - calibration.lastAcceptedPos[1];
        const dz = originWorld[2] - calibration.lastAcceptedPos[2];
        const dist = Math.hypot(dx, dy, dz);
        let notParallel = true;
        if (calibration.lastAcceptedDir) {
          const a = calibration.lastAcceptedDir;
          const b = dirWorld;
          const dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
          const la = Math.hypot(a[0],a[1],a[2]);
          const lb = Math.hypot(b[0],b[1],b[2]);
          if (la > 1e-9 && lb > 1e-9) {
            const cosang = Math.max(-1, Math.min(1, dot / (la*lb)));
            const ang = Math.acos(cosang);
            if (ang < PARALLEL_ANGLE_RAD) notParallel = false;
          }
        }
        if (dist >= minMove && notParallel) accepted = true; else accepted = false;
      } else accepted = false;

      if (accepted) {
        rayEntry.accepted = true;
        calibration.acceptedRays.push(rayEntry);
        calibration.lastAcceptedPos = originWorld ? [originWorld[0], originWorld[1], originWorld[2]] : null;
        calibration.lastAcceptedDir = [dirWorld[0], dirWorld[1], dirWorld[2]];
        acceptedCountSpan.textContent = String(calibration.acceptedRays.length);
      } else {
        rayEntry.accepted = false;
        acceptedCountSpan.textContent = String(calibration.acceptedRays.length);
      }

      // register a 3D ray in world fixed (only one per pink/frame)
      if (originWorld && rayEntry.dir_rotated && calibration) {
        const dr = rayEntry.dir_rotated;
        const reg = {
          origin: { x: originWorld[0], y: originWorld[1], z: originWorld[2] },
          direction: { dx: Number(dr[0]), dy: Number(dr[1]), dz: Number(dr[2]) }
        };
        calibration.registeredRays.push(reg);
        registered3DCountSpan.textContent = String(calibration.registeredRays.length);
      }

      // attempt triangulation when we have at least calibration.numRaysNeeded registeredRays
      if (calibration && calibration.registeredRays && calibration.registeredRays.length >= calibration.numRaysNeeded) {
        const startIndex = calibration.registeredRays.length - calibration.numRaysNeeded;
        const subset = calibration.registeredRays.slice(startIndex, startIndex + calibration.numRaysNeeded);
        const raysForTri = subset.map(r => ({
          origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z },
          direction: { dx: r.direction.dx, dy: r.direction.dy, dz: r.direction.dz }
        }));
        const X = triangulateFromRays(raysForTri);
        if (X) {
          // Aplica critério de convergência pela norma do deslocamento (em mm)
          let acceptTriangulation = false;
          const lastTri = calibration.lastTriangulatedPoint;
          if (!lastTri) {
            // primeira triangulação aceita automaticamente
            acceptTriangulation = true;
          } else {
            const dx = X.x - lastTri.x;
            const dy = X.y - lastTri.y;
            const dz = X.z - lastTri.z;
            const disp = Math.hypot(dx, dy, dz);
            if (disp <= CONVERGENCE_NORM_MM) acceptTriangulation = true;
            else acceptTriangulation = false;
          }

          if (acceptTriangulation) {
            calibration.triangulatedPoints.push({ x: X.x, y: X.y, z: X.z, usedRaysStartIndex: startIndex });
            calibration.lastTriangulatedPoint = { x: X.x, y: X.y, z: X.z };
            triangulatedCountSpan.textContent = String(calibration.triangulatedPoints.length);
            // atualizar posição 3D atual na tela (mostrando o último triangulado)
            triXSpan.textContent = Number(X.x).toFixed(3);
            triYSpan.textContent = Number(X.y).toFixed(3);
            triZSpan.textContent = Number(X.z).toFixed(3);
          } else {
            // triangulação rejeitada por não convergência: não atualiza contadores nem triX/triY/triZ
            // mantém última triangulação aceita visível
          }
        } else {
          // triangulation failed (ill-conditioned) — do not update current 3D position
        }
      }
    }
  }

  requestAnimationFrame(processFrame);
}

// Atualiza UI do último ponto definido (prioriza triangulação 3D, senão mm relativo à originPixelCal, senão px)
function updateLastDefinedUI(defined) {
  const idx = calibration.definedPinkPoints.length;
  lastDefCountSpan.textContent = String(idx);
  lastDefTypeSpan.textContent = defined.type || "--";

  if (defined.triangulated3D) {
    lastDefXSpan.textContent = Number(defined.triangulated3D.x).toFixed(3);
    lastDefYSpan.textContent = Number(defined.triangulated3D.y).toFixed(3);
    lastDefZSpan.textContent = Number(defined.triangulated3D.z).toFixed(3);
  } else if (defined.pixel && calibration && calibration.originPixelCal && calibration.lockedScalePxPerMm) {
    // converter pixel -> mm relativo à originPixelCal (apenas para exibição)
    const dx_px = defined.pixel.x - calibration.originPixelCal.x;
    const dy_px = defined.pixel.y - calibration.originPixelCal.y;
    const x_mm = dx_px / calibration.lockedScalePxPerMm;
    const y_mm = dy_px / calibration.lockedScalePxPerMm;
    // Z desconhecido (mostramos --)
    lastDefXSpan.textContent = Number(x_mm).toFixed(3);
    lastDefYSpan.textContent = Number(y_mm).toFixed(3);
    lastDefZSpan.textContent = "--";
  } else if (defined.pixel) {
    lastDefXSpan.textContent = Math.round(defined.pixel.x);
    lastDefYSpan.textContent = Math.round(defined.pixel.y);
    lastDefZSpan.textContent = "--";
  } else {
    lastDefXSpan.textContent = "--";
    lastDefYSpan.textContent = "--";
    lastDefZSpan.textContent = "--";
  }
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
  ctx.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
