// main.js — inclui botão Download para baixar a nuvem de pontos triangulada (arquivo .json)
const scanBtn = document.getElementById('scanBtn');
const calibrateBtn = document.getElementById('calibrateBtn');
const downloadBtn = document.getElementById('downloadBtn'); // novo botão
const confirmPointBtn = document.getElementById('confirmPointBtn'); // novo botão confirmar ponto
const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const miniCanvas = document.getElementById('miniCloud');
const miniCtx = miniCanvas.getContext('2d');

const scaleValue = document.getElementById('scaleValue');
const scaleLockedLabel = document.getElementById('scaleLockedLabel');

const blackSlider = document.getElementById('blackSlider');
const blueSlider  = document.getElementById('blueSlider');
const greenSlider = document.getElementById('greenSlider');
// NOVO: slider para calibrar vermelho
const redSlider   = document.getElementById('redSlider');
// NOVO: slider para estabilidade
const stabilitySlider = document.getElementById('stabilitySlider');
// NOVO: slider para margem ignorada
const marginSlider = document.getElementById('marginSlider');

const blackValue = document.getElementById('blackValue');
const blueValue  = document.getElementById('blueValue');
const greenValue = document.getElementById('greenValue');
// NOVO: display do valor do vermelho
const redValue   = document.getElementById('redValue');
// NOVO: display do valor de estabilidade
const stabilityValue = document.getElementById('stabilityValue');
// NOVO: display do valor da margem
const marginValue = document.getElementById('marginValue');

const pitchSpan = document.getElementById('pitchValue');
const yawSpan   = document.getElementById('yawValue');
const rollSpan  = document.getElementById('rollValue');

const zSpan = document.getElementById('zValue');
const xSpan = document.getElementById('xValue');
const ySpan = document.getElementById('yValue');

const raysCountSpan = document.getElementById('raysCount');
const pinkDirectedCountSpan = document.getElementById('pinkDirectedCount');
const rotatedCountSpan = document.getElementById('rotatedCount');
const acceptedCountSpan = document.getElementById('acceptedCount');
const registered3DCountSpan = document.getElementById('registered3DCount');
const triangulatedCountSpan = document.getElementById('triangulatedCount');
const pinkStateSpan = document.getElementById('pinkState');

// realtime quality UI
const realtimeQualityBlock = document.getElementById('realtimeQuality');
const realtimeQualityLabel = document.getElementById('realtimeQualityLabel');
const realtimeQualityBarFill = document.getElementById('realtimeQualityBarFill');

// elementos da nova UI de distância entre pares
const pairInfoSpan = document.getElementById('pairInfo');
const dxValSpan = document.getElementById('dxVal');
const dyValSpan = document.getElementById('dyVal');
const dzValSpan = document.getElementById('dzVal');
const dMagValSpan = document.getElementById('dMagVal');

// elementos da nova UI de qualidade (último ponto)
const qualityBlock = document.getElementById('qualityBlock');
const qualityLabel = document.getElementById('qualityLabel');
const qualityNumRays = document.getElementById('qualityNumRays');
const qualityMeanDist = document.getElementById('qualityMeanDist');
const qualityMaxAngle = document.getElementById('qualityMaxAngle');
const qualitySpread = document.getElementById('qualitySpread');

let blackThreshold = Number(blackSlider.value);
let blueThreshold  = Number(blueSlider.value);
let greenThreshold = Number(greenSlider.value);
// NOVO: threshold para vermelho
let redThreshold   = Number(redSlider.value);

// NOVO: estabilidade (n últimas posições para média)
let stabilityFrames = Number(stabilitySlider.value);
stabilityValue.textContent = String(stabilityFrames);

// NOVO: margem ignorada (percentual do menor lado)
let marginPercent = Number(marginSlider.value);
marginValue.textContent = `${marginPercent}%`;

// Históricos para média (origem = preto/orange, azul, verde). Não incluir ponto rosa.
const blackHistory = []; // origin history
const blueHistory = [];  // +X
const greenHistory = []; // +Y

blackValue.textContent = blackThreshold;
blueValue.textContent  = blueThreshold;
greenValue.textContent = greenThreshold;
redValue.textContent   = redThreshold;

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
// NOVO: listener do slider vermelho
redSlider.addEventListener('input', () => {
  redThreshold = Number(redSlider.value);
  redValue.textContent = redThreshold;
});
// NOVO: listener do slider de estabilidade
stabilitySlider.addEventListener('input', () => {
  stabilityFrames = Number(stabilitySlider.value);
  stabilityValue.textContent = String(stabilityFrames);
  // trim existing histories to new length
  while (blackHistory.length > stabilityFrames) blackHistory.shift();
  while (blueHistory.length > stabilityFrames) blueHistory.shift();
  while (greenHistory.length > stabilityFrames) greenHistory.shift();
});
// NOVO: listener do slider de margem
marginSlider.addEventListener('input', () => {
  marginPercent = Number(marginSlider.value);
  marginValue.textContent = `${marginPercent}%`;
});

let orientationListenerAdded = false;
let lastOrientation = { alpha: null, beta: null, gamma: null };

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

// helper for histories (NOVO)
function pushHistory(histArr, pt) {
  if (!pt) return;
  histArr.push({ x: pt.x, y: pt.y });
  while (histArr.length > stabilityFrames) histArr.shift();
}
function averageHistory(histArr) {
  if (!histArr || histArr.length === 0) return null;
  let sx = 0, sy = 0;
  for (const p of histArr) { sx += p.x; sy += p.y; }
  return { x: sx / histArr.length, y: sy / histArr.length };
}// --- Quality computation helper (kept) ---
// subset: array of registered rays { origin:{x,y,z}, direction:{dx,dy,dz}, pixel:{x,y} }
// X: triangulated point {x,y,z}
function computePointQuality(subset, X) {
  if (!subset || subset.length === 0 || !X) return null;
  const n = subset.length;
  // normalize directions and compute distances from X to each ray
  const dists = [];
  const dirs = [];
  const origins = [];
  for (let i=0;i<n;i++) {
    const r = subset[i];
    const o = [r.origin.x, r.origin.y, r.origin.z];
    const d = [r.direction.dx, r.direction.dy, r.direction.dz];
    const ld = Math.hypot(d[0],d[1],d[2]);
    let dn = ld > 1e-9 ? [d[0]/ld, d[1]/ld, d[2]/ld] : [0,0,0];
    dirs.push(dn);
    origins.push(o);
    // distance point-to-line: || ( (X - o) x dn ) ||
    const vx = [X.x - o[0], X.y - o[1], X.z - o[2]];
    const cx = [
      vx[1]*dn[2] - vx[2]*dn[1],
      vx[2]*dn[0] - vx[0]*dn[2],
      vx[0]*dn[1] - vx[1]*dn[0]
    ];
    const dist = Math.hypot(cx[0], cx[1], cx[2]);
    dists.push(dist);
  }
  // mean distance
  const meanDist = dists.reduce((a,b)=>a+b,0)/dists.length;

  // pairwise angles (in degrees) - find maximum angle between any pair
  let maxAngleRad = 0;
  for (let i=0;i<n;i++) {
    for (let j=i+1;j<n;j++) {
      const a = dirs[i], b = dirs[j];
      const dot = Math.max(-1, Math.min(1, a[0]*b[0] + a[1]*b[1] + a[2]*b[2]));
      const ang = Math.acos(dot);
      if (ang > maxAngleRad) maxAngleRad = ang;
    }
  }
  const maxAngleDeg = maxAngleRad * 180 / Math.PI;

  // spread of origins: compute centroid and average distance to centroid
  let cx=0, cy=0, cz=0;
  for (const o of origins) { cx += o[0]; cy += o[1]; cz += o[2]; }
  cx /= origins.length; cy /= origins.length; cz /= origins.length;
  let sumd=0;
  for (const o of origins) sumd += Math.hypot(o[0]-cx, o[1]-cy, o[2]-cz);
  const spread = sumd / origins.length;

  // Decide level (thresholds chosen conservatively)
  let level = "Baixa";
  if (n >= 4 && meanDist <= 2.0 && maxAngleDeg >= 20 && spread >= 12) level = "Alta";
  else if (n >= 3 && meanDist <= 5.0 && maxAngleDeg >= 8 && spread >= 6) level = "Média";
  else level = "Baixa";

  return {
    level,
    meanDist: Number(meanDist.toFixed(4)),
    maxAngleDeg: Number(maxAngleDeg.toFixed(2)),
    spread: Number(spread.toFixed(4)),
    numRays: n
  };
}

// --- helper that estimates quality from rays even without triangulated X ---
// tries triangulation first; if fails, uses heuristic from directions/origins
function estimateQualityFromRays(rays) {
  if (!rays || rays.length === 0) return { level: "Insuficiente", score: 0, details: null };

  // try triangulation
  try {
    const raysForTri = rays.map(r => ({
      origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z },
      direction: { dx: r.direction.dx, dy: r.direction.dy, dz: r.direction.dz }
    }));
    const X = triangulateFromRays(raysForTri);
    if (X) {
      const q = computePointQuality(raysForTri, X);
      if (q) {
        // compute a score 0..100 combining numRays, angle and spread and inverse meanDist
        const nScore = Math.min(1, q.numRays / 6); // upto 6 rays
        const angleScore = Math.min(1, q.maxAngleDeg / 60);
        const spreadScore = Math.min(1, q.spread / 30);
        const distScore = Math.max(0, 1 - (q.meanDist / 10)); // best when <=0
        const score = Math.round(100 * (0.25*nScore + 0.3*angleScore + 0.25*spreadScore + 0.2*distScore));
        return { level: q.level, score, details: q };
      }
    }
  } catch (e) {
    // ignore
  }

  // fallback heuristic (no triangulation or X not available)
  // compute number of rays, max pair angle between directions and spread of origins
  const n = rays.length;
  const dirs = [];
  const origins = [];
  for (const r of rays) {
    const d = [r.direction.dx, r.direction.dy, r.direction.dz];
    const ld = Math.hypot(d[0],d[1],d[2]);
    dirs.push(ld > 1e-9 ? [d[0]/ld, d[1]/ld, d[2]/ld] : [0,0,0]);
    origins.push([r.origin.x, r.origin.y, r.origin.z]);
  }
  // max angle
  let maxAngRad = 0;
  for (let i=0;i<dirs.length;i++) for (let j=i+1;j<dirs.length;j++) {
    const a = dirs[i], b = dirs[j];
    const dot = Math.max(-1, Math.min(1, a[0]*b[0] + a[1]*b[1] + a[2]*b[2]));
    const ang = Math.acos(dot);
    if (ang > maxAngRad) maxAngRad = ang;
  }
  const maxAngleDeg = maxAngRad * 180 / Math.PI;
  // spread
  let cx=0, cy=0, cz=0;
  for (const o of origins) { cx += o[0]; cy += o[1]; cz += o[2]; }
  cx /= origins.length; cy /= origins.length; cz /= origins.length;
  let sumd = 0;
  for (const o of origins) sumd += Math.hypot(o[0]-cx, o[1]-cy, o[2]-cz);
  const spread = sumd / origins.length;

  // decide level heuristically (conservative without meanDist)
  let level = "Baixa";
  if (n >= 4 && maxAngleDeg >= 20 && spread >= 12) level = "Alta";
  else if (n >= 3 && maxAngleDeg >= 8 && spread >= 6) level = "Média";
  else level = "Baixa";

  // score composition
  const nScore = Math.min(1, n / 6);
  const angleScore = Math.min(1, maxAngleDeg / 60);
  const spreadScore = Math.min(1, spread / 30);
  const score = Math.round(100 * (0.5*nScore + 0.35*angleScore + 0.15*spreadScore));

  return { level, score, details: { numRays: n, maxAngleDeg: Number(maxAngleDeg.toFixed(2)), spread: Number(spread.toFixed(4)) } };
}

// --- helper math functions (kept) ---
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

// small matrix inverse (triangulation)
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
}function triangulateFromRays(rays) {
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

// parameters & state (kept)
const DEFAULT_MIN_CAMERA_MOVE_MM = 5;
const PARALLEL_ANGLE_DEG = 5;
const PARALLEL_ANGLE_RAD = PARALLEL_ANGLE_DEG * Math.PI / 180;
const STABLE_FRAMES_FOR_ARM = 3;

let currentScalePxPerMm = null;
let scaleLocked = false;
let lockedScalePxPerMm = null;
let isRecordingCalibration = false;
let calibrationFrames = [];
let calibration = null;
let lastDetectedPoints = null;
let lastTransformedMatrix = null;

// point state machine (kept)
const PINK_STATE = {
  IDLE: "IDLE",
  ARMED: "ARMED",
  CAPTURING: "CAPTURING",
  TRIANGULATING: "TRIANGULATING",
  LOCKED: "LOCKED"
};
let pinkState = PINK_STATE.IDLE;
let pinkStableCounter = 0;
let pinkLockedPixel = null;

function setPinkState(s) {
  pinkState = s;
  pinkStateSpan.textContent = s;
  // show/hide realtime quality block depending on state
  if (s === PINK_STATE.CAPTURING) {
    realtimeQualityBlock.style.display = "block";
  } else {
    realtimeQualityBlock.style.display = "none";
    // reset bar
    realtimeQualityBarFill.style.width = "0%";
    realtimeQualityBarFill.classList.remove('q-low','q-medium','q-high');
    realtimeQualityBarFill.classList.add('q-none');
    realtimeQualityLabel.textContent = "--";
  }
}

// selection state for mini-cloud pair clicks
let selectedMiniIndices = []; // up to 2 indices

function clearMiniSelection() {
  selectedMiniIndices = [];
  updatePairDistanceDisplay();
}
function setMiniSelection(firstIdx, secondIdx) {
  selectedMiniIndices = [];
  if (typeof firstIdx === 'number') selectedMiniIndices.push(firstIdx);
  if (typeof secondIdx === 'number') selectedMiniIndices.push(secondIdx);
  updatePairDistanceDisplay();
}

function updatePairDistanceDisplay() {
  if (!calibration || !calibration.triangulatedPoints || calibration.triangulatedPoints.length === 0) {
    pairInfoSpan.textContent = "nenhum";
    dxValSpan.textContent = "--";
    dyValSpan.textContent = "--";
    dzValSpan.textContent = "--";
    dMagValSpan.textContent = "--";
    return;
  }
  if (selectedMiniIndices.length === 0) {
    pairInfoSpan.textContent = "nenhum";
    dxValSpan.textContent = "--";
    dyValSpan.textContent = "--";
    dzValSpan.textContent = "--";
    dMagValSpan.textContent = "--";
  } else if (selectedMiniIndices.length === 1) {
    const a = calibration.triangulatedPoints[selectedMiniIndices[0]];
    pairInfoSpan.textContent = `1: idx ${selectedMiniIndices[0]}`;
    dxValSpan.textContent = "--";
    dyValSpan.textContent = "--";
    dzValSpan.textContent = "--";
    dMagValSpan.textContent = "--";
  } else if (selectedMiniIndices.length === 2) {
    const a = calibration.triangulatedPoints[selectedMiniIndices[0]];
    const b = calibration.triangulatedPoints[selectedMiniIndices[1]];
    if (!a || !b) {
      pairInfoSpan.textContent = "nenhum";
      dxValSpan.textContent = "--";
      dyValSpan.textContent = "--";
      dzValSpan.textContent = "--";
      dMagValSpan.textContent = "--";
      return;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const mag = Math.hypot(dx, dy, dz);
    pairInfoSpan.textContent = `idx ${selectedMiniIndices[0]} ↔ idx ${selectedMiniIndices[1]}`;
    dxValSpan.textContent = dx.toFixed(4);
    dyValSpan.textContent = dy.toFixed(4);
    dzValSpan.textContent = dz.toFixed(4);
    dMagValSpan.textContent = mag.toFixed(4);
  }
}

// start camera
scanBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: "environment" } },
      audio: false
    });
    video.srcObject = stream;
    video.style.display = "block";
    canvas.style.display = "block";
    miniCanvas.style.display = "block";
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
}); // Download button handler: baixa apenas a nuvem de pontos triangulados (JSON)
downloadBtn.addEventListener('click', () => {
  if (!calibration) {
    alert("Nenhum dado de calibração disponível para download.");
    return;
  }
  // export ideal points (sampleSets) or triangulatedPoints if present
  const cloud = {
    sampleSets: (calibration.sampleSets || []).map(s => ({
      x: s.point.x, y: s.point.y, z: s.point.z,
      samples: s.samplesCount,
      dispersion: s.dispersion
    })),
    currentSamples: (calibration.currentSamples || []).map(p => ({ x: p.x, y: p.y, z: p.z })),
    triangulatedVisible: (calibration.triangulatedPoints || []).map(p => ({ x: p.x, y: p.y, z: p.z }))
  };
  const blob = new Blob([JSON.stringify(cloud, null, 2)], { type: "application/json" });
  const fname = `pointcloud-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
});

// calibrate button: starts/stops calibration (mantida), agora mostra/hide botão Download e Confirmar Ponto
calibrateBtn.addEventListener('click', () => {
  if (isRecordingCalibration) {
    // finalizar calibração (mantida)
    isRecordingCalibration = false;
    calibrateBtn.textContent = "Calibrar";
    // monta json completo (mantido)
    const data = {
      recordedAt: new Date().toISOString(),
      frames: calibrationFrames.slice(),
      rays: (calibration && calibration.rays) ? calibration.rays.slice() : [],
      registeredRays: (calibration && calibration.registeredRays) ? calibration.registeredRays.slice() : [],
      triangulatedPoints: (calibration && calibration.triangulatedPoints) ? calibration.triangulatedPoints.slice() : [],
      sampleSets: (calibration && calibration.sampleSets) ? calibration.sampleSets.slice() : [],
      currentSamples: (calibration && calibration.currentSamples) ? calibration.currentSamples.slice() : []
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const fname = `calibration-recording-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);

    // esconde botão Download e Confirmar
    downloadBtn.style.display = "none";
    confirmPointBtn.style.display = "none";

    // limpeza de buffers (mantida)
    calibrationFrames = [];
    if (calibration) {
      calibration.rays = [];
      calibration.registeredRays = [];
      calibration.triangulatedPoints = [];
      calibration.acceptedRays = [];
      calibration.currentPoint = null;
      calibration.lastAcceptedPos = null;
      calibration.lastAcceptedDir = null;
      // também limpar amostragem sequencial
      calibration.currentSamples = [];
      calibration.sampleSets = [];
      calibration.collectionDone = false;
    }
    raysCountSpan.textContent = "0";
    pinkDirectedCountSpan.textContent = "0";
    rotatedCountSpan.textContent = "0";
    acceptedCountSpan.textContent = "0";
    registered3DCountSpan.textContent = "0";
    triangulatedCountSpan.textContent = "0";
    setPinkState(PINK_STATE.IDLE);
    pinkStableCounter = 0;
    pinkLockedPixel = null;

    // limpa seleção mini-cloud
    clearMiniSelection();

    alert("Calibração finalizada. Arquivo .json gerado e download iniciado.");
    return;
  }

  // iniciar calibração (mantida)
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

  const inputMinMove = prompt(`Informe MIN_CAMERA_MOVE_MM (mm). Padrão ${DEFAULT_MIN_CAMERA_MOVE_MM} mm:`);
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
    triangulatedPoints: [], // will be used as visible set (confirmed ideal points + current samples)
    numRaysNeeded,
    currentPoint: null,
    // novos campos para média sequencial:
    currentSamples: [], // amostras coletadas para o ponto atual (cada item: {x,y,z,pixel:{x,y}})
    sampleSets: [],     // pontos ideais confirmados (cada item: { point:{x,y,z}, pixel:{x,y}, samplesCount, dispersion })
    collectionDone: false // true quando já houver 2 pontos ideais confirmados
  };

  // mostra botão Download e Confirmar enquanto calibração ativa
  downloadBtn.style.display = "inline-block";
  confirmPointBtn.style.display = "inline-block";

  setPinkState(PINK_STATE.IDLE);
  pinkStableCounter = 0;
  pinkLockedPixel = null;

  isRecordingCalibration = true;
  calibrationFrames = [];
  calibrateBtn.textContent = "Finalizar Calib.";
  raysCountSpan.textContent = "0";
  pinkDirectedCountSpan.textContent = "0";
  rotatedCountSpan.textContent = "0";
  acceptedCountSpan.textContent = "0";
  registered3DCountSpan.textContent = "0";
  triangulatedCountSpan.textContent = "0";

  // limpa seleção mini-cloud ao iniciar uma nova calibração
  clearMiniSelection();

  alert(`Calibração iniciada.\nMIN_CAMERA_MOVE_MM = ${minMoveVal} mm.\nRaios necessários para triangulação = ${numRaysNeeded}.\nClique em 'Finalizar Calib.' para encerrar e baixar o .json.\nUse 'Confirmar Ponto' para consolidar o conjunto atual de amostras em um ponto ideal.`);
});

// Confirmar Ponto: calcula centroide das amostras atuais, avalia dispersão e substitui amostras por ponto ideal
confirmPointBtn.addEventListener('click', () => {
  if (!calibration) { alert("Calibração não iniciada."); return; }
  if (!isRecordingCalibration) { alert("Confirmar Ponto só disponível durante calibração."); return; }

  const samples = calibration.currentSamples || [];
  if (!samples || samples.length === 0) {
    alert("Nenhuma amostra disponível para confirmar.");
    return;
  }

  // calcula centroide
  let sx = 0, sy = 0, sz = 0;
  for (const s of samples) { sx += s.x; sy += s.y; sz += s.z; }
  const cx = sx / samples.length;
  const cy = sy / samples.length;
  const cz = sz / samples.length;

  // média do pixel (para exibição)
  let spx = 0, spy = 0;
  for (const s of samples) { if (s.pixel) { spx += s.pixel.x; spy += s.pixel.y; } }
  const avgPixel = (samples[0] && samples[0].pixel) ? { x: spx / samples.length, y: spy / samples.length } : null;

  // dispersão: média das distâncias amostra->centroide
  let sumd = 0;
  for (const s of samples) {
    const dx = s.x - cx, dy = s.y - cy, dz = s.z - cz;
    sumd += Math.hypot(dx, dy, dz);
  }
  const meanDist = (samples.length > 0) ? sumd / samples.length : 0;

  // cria ponto ideal (sampleSet)
  const ideal = {
    point: { x: Number(cx), y: Number(cy), z: Number(cz) },
    pixel: avgPixel ? { x: Number(avgPixel.x), y: Number(avgPixel.y) } : null,
    samplesCount: samples.length,
    dispersion: Number(meanDist.toFixed(6)),
    timestamp: new Date().toISOString()
  };

  // adiciona aos sampleSets e limpa currentSamples para começar nova coleta
  calibration.sampleSets.push(ideal);
  calibration.currentSamples = [];

  // atualizar triangulatedPoints visível: substitui amostras pelo(s) pontos ideais confirmados
  calibration.triangulatedPoints = calibration.sampleSets.map(s => {
    return { x: s.point.x, y: s.point.y, z: s.point.z, pixel: s.pixel || null, samplesCount: s.samplesCount, dispersion: s.dispersion };
  });

  // atualizar UI
  triangulatedCountSpan.textContent = String(calibration.triangulatedPoints.length);
  drawTriangulatedMarkers();
  drawMiniCloud();

  // se já temos 2 pontos ideais, considerar a coleta finalizada (não acumular mais)
  if (calibration.sampleSets.length >= 2) {
    calibration.collectionDone = true;
    alert("Dois pontos ideais confirmados. Coleta de amostras encerrada para preservar exatamente dois pontos ideais.");
  } else {
    alert(`Ponto confirmado: centroide (${ideal.point.x.toFixed(4)}, ${ideal.point.y.toFixed(4)}, ${ideal.point.z.toFixed(4)}), dispersion=${ideal.dispersion} mm. Coleta reiniciada para próximo ponto.`);
  }
});

// processFrame (mantido) — agora com suavização (média móvel) para origem/azul/verde (sem incluir ponto rosa)
// E também ignora pixels nas bordas conforme marginPercent e pinta a área sombreada.
function processFrame() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  // compute margin in pixels (uniform around): percentage of the smaller canvas dimension
  const minDim = Math.min(canvas.width, canvas.height);
  const marginPx = Math.round((marginPercent / 100) * minDim);
  const leftMargin = marginPx;
  const rightMargin = canvas.width - marginPx;
  const topMargin = marginPx;
  const bottomMargin = canvas.height - marginPx;

  let sumBlackX = 0, sumBlackY = 0, countBlack = 0;
  let sumBlueX  = 0, sumBlueY  = 0, countBlue  = 0;
  let sumGreenX = 0, sumGreenY = 0, countGreen = 0;
  let sumRedX   = 0, sumRedY   = 0, countRed   = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const p = i / 4;
    const x = p % canvas.width;
    const y = Math.floor(p / canvas.width);

    // IGNORE border pixels
    if (x < leftMargin || x >= rightMargin || y < topMargin || y >= bottomMargin) {
      continue; // leave original pixel values (do not modify), and do not include in detection counts
    }

    if (r < blackThreshold && g < blackThreshold && b < blackThreshold) {
      data[i]=255; data[i+1]=165; data[i+2]=0;
      sumBlackX += x; sumBlackY += y; countBlack++;
    } else if (b > blueThreshold && r < blueThreshold && g < blueThreshold) {
      data[i]=255; data[i+1]=255; data[i+2]=255;
      sumBlueX += x; sumBlueY += y; countBlue++;
    } else if (g > greenThreshold && r < greenThreshold && b < greenThreshold) {
      data[i]=128; data[i+1]=0; data[i+2]=128;
      sumGreenX += x; sumGreenY += y; countGreen++;
    } else if (r > redThreshold && g < redThreshold && b < redThreshold) {
      // usa o redThreshold configurado pelo usuário (ponto rosa continua sem suavização)
      sumRedX += x; sumRedY += y; countRed++;
    }
  }

  ctx.putImageData(frame, 0, 0);// draw shaded margins (so user sees ignored borders) — painted over the image but under markers
  if (marginPx > 0) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    // top
    if (topMargin > 0) ctx.fillRect(0, 0, canvas.width, topMargin);
    // bottom
    if (bottomMargin < canvas.height) ctx.fillRect(0, bottomMargin, canvas.width, canvas.height - bottomMargin);
    // left
    if (leftMargin > 0) ctx.fillRect(0, topMargin, leftMargin, bottomMargin - topMargin);
    // right
    if (rightMargin < canvas.width) ctx.fillRect(rightMargin, topMargin, canvas.width - rightMargin, bottomMargin - topMargin);
    ctx.restore();
  }

  // raw centroids for this frame
  const rawOrigin = (countBlack) ? { x: sumBlackX / countBlack, y: sumBlackY / countBlack } : null;
  const rawBlue   = (countBlue)  ? { x: sumBlueX  / countBlue,  y: sumBlueY  / countBlue } : null;
  const rawGreen  = (countGreen) ? { x: sumGreenX / countGreen, y: sumGreenY / countGreen } : null;
  const rawRed    = (countRed)   ? { x: sumRedX / countRed, y: sumRedY / countRed, count: countRed } : null;

  // push to histories (only when detected this frame). NOTE: pink/red is NOT included.
  if (rawOrigin) pushHistory(blackHistory, rawOrigin);
  if (rawBlue)   pushHistory(blueHistory, rawBlue);
  if (rawGreen)  pushHistory(greenHistory, rawGreen);

  // compute smoothed positions (average of histories). If history empty => null
  const originSmoothed = averageHistory(blackHistory);
  const blueSmoothed   = averageHistory(blueHistory);
  const greenSmoothed  = averageHistory(greenHistory);

  // use smoothed points as current points (pink/red remains raw)
  let origin = originSmoothed ? { x: originSmoothed.x, y: originSmoothed.y } : null;
  let bluePt = blueSmoothed   ? { x: blueSmoothed.x,  y: blueSmoothed.y }  : null;
  let greenPt = greenSmoothed ? { x: greenSmoothed.x, y: greenSmoothed.y } : null;
  let redPt = rawRed ? { x: rawRed.x, y: rawRed.y, count: rawRed.count } : null;

  // draw on canvas: origin/blue/green from smoothed positions (markers drawn AFTER shaded margins so they remain visible)
  if (origin) drawPoint(origin.x, origin.y, "#FFFFFF");
  if (bluePt) drawPoint(bluePt.x, bluePt.y, "#0000FF");
  if (greenPt) drawPoint(greenPt.x, greenPt.y, "#00FF00");
  if (origin && bluePt) drawArrow(origin.x, origin.y, bluePt.x, bluePt.y, "#0000FF");
  if (origin && greenPt) drawArrow(origin.x, origin.y, greenPt.x, greenPt.y, "#00FF00");

  // pink/red point: keep previous behaviour (no smoothing; allow it to disappear/reappear)
  if (redPt) drawPoint(redPt.x, redPt.y, "#FF69B4");
  lastDetectedPoints = { origin, bluePt, greenPt, redPt };

  // scale (uses origin & bluePt smoothed)
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

  // draw plane (if calibration active and smoothed positions available)
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

  // cam Z, X, Y (kept) — uses smoothed origin/blue for calculations
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
  } else { zSpan.textContent = "--"; }

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

  // state machine for pink point (kept; pink not smoothed)
  const pinkDetected = !!(lastDetectedPoints && lastDetectedPoints.redPt);
  if (pinkState === PINK_STATE.IDLE) {
    if (pinkDetected) {
      pinkStableCounter = 1;
      setPinkState(PINK_STATE.ARMED);
    } else {
      pinkStableCounter = 0;
    }
  } else if (pinkState === PINK_STATE.ARMED) {
    if (pinkDetected) {
      pinkStableCounter++;
      if (pinkStableCounter >= STABLE_FRAMES_FOR_ARM) {
        pinkLockedPixel = { x: lastDetectedPoints.redPt.x, y: lastDetectedPoints.redPt.y };
        if (calibration) {
          calibration.currentPoint = {
            lockedPixel: { ...pinkLockedPixel },
            registeredRays: [],
            acceptedRays: [],
            lastAcceptedPos: null,
            lastAcceptedDir: null,
            triangulated: false
          };
        }
        setPinkState(PINK_STATE.CAPTURING);
      }
    } else {
      pinkStableCounter = 0;
      setPinkState(PINK_STATE.IDLE);
    }
  } else if (pinkState === PINK_STATE.CAPTURING) {
    if (!pinkDetected) {
      pinkStableCounter = 0;
      pinkLockedPixel = null;
      if (calibration && calibration.currentPoint) calibration.currentPoint = null;
      setPinkState(PINK_STATE.IDLE);
    }
  } else if (pinkState === PINK_STATE.TRIANGULATING) {
    // handled during triangulation
  } else if (pinkState === PINK_STATE.LOCKED) {
    if (!pinkDetected) {
      pinkStableCounter = 0;
      pinkLockedPixel = null;
      if (calibration && calibration.currentPoint) calibration.currentPoint = null;
      setPinkState(PINK_STATE.IDLE);
    }
  } // update realtime quality indicator while CAPTURING
  if (pinkState === PINK_STATE.CAPTURING && calibration && calibration.currentPoint) {
    const cp = calibration.currentPoint;
    const rays = cp.registeredRays || [];
    if (!rays || rays.length === 0) {
      realtimeQualityLabel.textContent = "Insuficiente";
      realtimeQualityBarFill.style.width = "6%";
      realtimeQualityBarFill.classList.remove('q-low','q-medium','q-high');
      realtimeQualityBarFill.classList.add('q-none');
    } else {
      // estimate quality
      const est = estimateQualityFromRays(rays);
      // update label
      realtimeQualityLabel.textContent = est.level === "Insuficiente" ? "Insuficiente" : est.level;
      // set color class
      realtimeQualityBarFill.classList.remove('q-none','q-low','q-medium','q-high');
      if (est.level === "Alta") realtimeQualityBarFill.classList.add('q-high');
      else if (est.level === "Média" || est.level === "Média".toLowerCase()) realtimeQualityBarFill.classList.add('q-medium');
      else realtimeQualityBarFill.classList.add('q-low');
      // set width by score (0..100)
      const sc = Math.max(0, Math.min(100, (typeof est.score === 'number' ? est.score : 10)));
      realtimeQualityBarFill.style.width = `${sc}%`;
    }
    realtimeQualityBlock.style.display = "block";
  } else {
    // hide handled in setPinkState, but ensure fill reset
    // setPinkState will hide; keep safe fallback here
    if (realtimeQualityBlock.style.display !== "none" && pinkState !== PINK_STATE.CAPTURING) {
      realtimeQualityBlock.style.display = "none";
    }
  }

  // recording + capturing logic (mantido) — may produce rays and triangulate points
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

    if (pinkState === PINK_STATE.CAPTURING && lastDetectedPoints && lastDetectedPoints.redPt && calibration && calibration.lockedScalePxPerMm) {
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
        accepted: false,
        pixel: { x: px, y: py }
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

      let accepted = false;
      const minMove = (calibration && calibration.minCameraMoveMm != null) ? calibration.minCameraMoveMm : DEFAULT_MIN_CAMERA_MOVE_MM;
      const cp = calibration.currentPoint;
      if (originWorld && cp) {
        if (cp.lastAcceptedPos == null) {
          accepted = true;
        } else {
          const dx = originWorld[0] - cp.lastAcceptedPos[0];
          const dy = originWorld[1] - cp.lastAcceptedPos[1];
          const dz = originWorld[2] - cp.lastAcceptedPos[2];
          const dist = Math.hypot(dx, dy, dz);
          let notParallel = true;
          if (cp.lastAcceptedDir) {
            const a = cp.lastAcceptedDir;
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
          if (dist >= minMove && notParallel) accepted = true;
        }
      } else {
        accepted = false;
      }

      if (accepted && cp) {
        rayEntry.accepted = true;
        cp.acceptedRays.push(rayEntry);
        cp.lastAcceptedPos = originWorld ? [originWorld[0], originWorld[1], originWorld[2]] : null;
        cp.lastAcceptedDir = [dirWorld[0], dirWorld[1], dirWorld[2]];
        if (rayEntry.dir_rotated && originWorld) {
          const reg = {
            origin: { x: originWorld[0], y: originWorld[1], z: originWorld[2] },
            direction: { dx: rayEntry.dir_rotated[0], dy: rayEntry.dir_rotated[1], dz: rayEntry.dir_rotated[2] },
            pixel: { x: rayEntry.pixel.x, y: rayEntry.pixel.y }
          };
          cp.registeredRays.push(reg);
          calibration.registeredRays.push(reg);
          registered3DCountSpan.textContent = String((calibration.registeredRays || []).length);
        }
        acceptedCountSpan.textContent = String((cp.acceptedRays || []).length);
      } else {
        rayEntry.accepted = false;
      }

      // triangulation attempt if enough rays
      if (cp && cp.registeredRays.length >= calibration.numRaysNeeded && !cp.triangulated) {
        setPinkState(PINK_STATE.TRIANGULATING);
        const subset = cp.registeredRays.slice(-calibration.numRaysNeeded);
        const raysForTri = subset.map(r => ({
          origin: { x: r.origin.x, y: r.origin.y, z: r.origin.z },
          direction: { dx: r.direction.dx, dy: r.direction.dy, dz: r.direction.dz },
          pixel: { x: r.pixel.x, y: r.pixel.y }
        }));
        const X = triangulateFromRays(raysForTri);
        if (X) {
          // average pixel for display
          let avgX = 0, avgY = 0;
          for (const r of subset) { avgX += (r.pixel && r.pixel.x) || 0; avgY += (r.pixel && r.pixel.y) || 0; }
          avgX /= subset.length; avgY /= subset.length;
          const tri = { x: X.x, y: X.y, z: X.z, pixel: { x: avgX, y: avgY } };

          // --- NOVO: compute quality metrics for this triangulated point ---
          const quality = computePointQuality(raysForTri, tri);
          tri.quality = quality;

          // ----- AQUI: em vez de empurrar direto para triangulatedPoints, acumulamos em currentSamples -----
          if (calibration && !calibration.collectionDone) {
            // armazenar amostra para o ponto atual
            calibration.currentSamples.push({ x: tri.x, y: tri.y, z: tri.z, pixel: tri.pixel, quality: tri.quality });
            // atualizar a "visão" (triangulatedPoints) para incluir sampleSets (confirmados) + currentSamples (amostras correntes)
            calibration.triangulatedPoints = calibration.sampleSets.map(s => {
              return { x: s.point.x, y: s.point.y, z: s.point.z, pixel: s.pixel || null, samplesCount: s.samplesCount, dispersion: s.dispersion };
            }).concat(calibration.currentSamples.map(s => ({ x: s.x, y: s.y, z: s.z, pixel: s.pixel || null })));
          } else {
            // se a coleta estiver finalizada (>=2 pontos ideais), não acumular mais amostras
            // neste caso apenas atualizamos triangulatedPoints (já deve conter os sampleSets)
            calibration.triangulatedPoints = calibration.sampleSets.map(s => {
              return { x: s.point.x, y: s.point.y, z: s.point.z, pixel: s.pixel || null, samplesCount: s.samplesCount, dispersion: s.dispersion };
            });
          }

          // store tri também para registro geral (mantido)
          calibration.triangulatedPoints = calibration.triangulatedPoints || [];
          // update UI with quality message (kept)
          if (quality) {
            qualityBlock.style.display = "block";
            qualityNumRays.textContent = quality.numRays;
            qualityMeanDist.textContent = quality.meanDist;
            qualityMaxAngle.textContent = quality.maxAngleDeg;
            qualitySpread.textContent = quality.spread;

            // set label and color class
            qualityLabel.textContent = quality.level;
            qualityLabel.classList.remove('quality-high','quality-medium','quality-low');
            if (quality.level === "Alta") qualityLabel.classList.add('quality-high');
            else if (quality.level === "Média") qualityLabel.classList.add('quality-medium');
            else qualityLabel.classList.add('quality-low');

            clearTimeout(qualityBlock._hideTO);
            qualityBlock._hideTO = setTimeout(() => {
              qualityBlock.style.display = "none";
            }, 8000);
          }

          // atualizar contadores
          triangulatedCountSpan.textContent = String(calibration.triangulatedPoints.length);
          cp.triangulated = true;
          drawTriangulatedMarkers();
          drawMiniCloud();
          setPinkState(PINK_STATE.LOCKED);
        } else {
          setPinkState(PINK_STATE.CAPTURING);
        }
      }
    }
  } // draw persistent triangulated markers and mini cloud
  drawTriangulatedMarkers();
  drawMiniCloud();

  requestAnimationFrame(processFrame);
}

// draw triangulated markers (dark pink) — persistent
function drawTriangulatedMarkers() {
  if (!calibration || !calibration.triangulatedPoints) return;
  for (const p of calibration.triangulatedPoints) {
    if (p.pixel && Number.isFinite(p.pixel.x) && Number.isFinite(p.pixel.y)) {
      ctx.beginPath();
      ctx.fillStyle = "#8B1455"; // dark pink
      ctx.strokeStyle = "#FF99C8";
      ctx.lineWidth = 1;
      ctx.arc(p.pixel.x, p.pixel.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

// mini cloud drawing (keeps showing triangulatedPoints)
// agora também destaca pontos selecionados e desenha linha entre o par
function drawMiniCloud() {
  miniCtx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
  miniCtx.fillStyle = "rgba(0,0,0,0.02)";
  miniCtx.fillRect(0,0,miniCanvas.width,miniCanvas.height);

  if (!calibration || !calibration.triangulatedPoints || calibration.triangulatedPoints.length === 0) {
    miniCtx.fillStyle = "rgba(255,255,255,0.4)";
    miniCtx.font = "12px system-ui, Arial";
    miniCtx.fillText("Nuvem de pontos (vazia)", 10, 18);
    updatePairDistanceDisplay();
    return;
  }

  const pts = calibration.triangulatedPoints;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!isFinite(p.x) || !isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return;
  if (Math.abs(maxX - minX) < 1e-6) { minX -= 1; maxX += 1; }
  if (Math.abs(maxY - minY) < 1e-6) { minY -= 1; maxY += 1; }

  const pad = 6;
  const w = miniCanvas.width - pad*2;
  const h = miniCanvas.height - pad*2;

  miniCtx.strokeStyle = "rgba(255,255,255,0.06)";
  miniCtx.lineWidth = 1;
  miniCtx.beginPath();
  for (let i=1;i<=3;i++) {
    const gx = pad + (w/4)*i;
    miniCtx.moveTo(gx, pad);
    miniCtx.lineTo(gx, pad + h);
    const gy = pad + (h/4)*i;
    miniCtx.moveTo(pad, gy);
    miniCtx.lineTo(pad + w, gy);
  }
  miniCtx.stroke();

  // draw points, detect selected indices and draw differently
  for (let idx = 0; idx < pts.length; idx++) {
    const p = pts[idx];
    if (!isFinite(p.x) || !isFinite(p.y)) continue;
    const sx = pad + ((p.x - minX) / (maxX - minX)) * w;
    const sy = pad + (1 - (p.y - minY) / (maxY - minY)) * h;

    // if this point is selected, draw highlight larger
    const isSelected = selectedMiniIndices.indexOf(idx) !== -1;
    if (isSelected) {
      miniCtx.beginPath();
      miniCtx.fillStyle = "#FF99C8";
      miniCtx.arc(sx, sy, 5, 0, Math.PI*2);
      miniCtx.fill();
      miniCtx.strokeStyle = "#FFFFFF";
      miniCtx.lineWidth = 1;
      miniCtx.stroke();
    } else {
      miniCtx.beginPath();
      miniCtx.fillStyle = "#8B1455";
      miniCtx.arc(sx, sy, 3, 0, Math.PI*2);
      miniCtx.fill();
    }
  }

  // if two selected, draw a connecting line
  if (selectedMiniIndices.length === 2) {
    const a = pts[selectedMiniIndices[0]];
    const b = pts[selectedMiniIndices[1]];
    if (a && b && isFinite(a.x) && isFinite(a.y) && isFinite(b.x) && isFinite(b.y)) {
      const ax = pad + ((a.x - minX) / (maxX - minX)) * w;
      const ay = pad + (1 - (a.y - minY) / (maxY - minY)) * h;
      const bx = pad + ((b.x - minX) / (maxX - minX)) * w;
      const by = pad + (1 - (b.y - minY) / (maxY - minY)) * h;
      miniCtx.beginPath();
      miniCtx.strokeStyle = "rgba(255,153,200,0.9)";
      miniCtx.lineWidth = 2;
      miniCtx.moveTo(ax, ay);
      miniCtx.lineTo(bx, by);
      miniCtx.stroke();
    }
  }

  miniCtx.strokeStyle = "rgba(255,255,255,0.12)";
  miniCtx.lineWidth = 1;
  miniCtx.strokeRect(0.5,0.5,miniCanvas.width-1,miniCanvas.height-1);

  updatePairDistanceDisplay();
}

// enable clicking on mini canvas to select points (pair)
miniCanvas.addEventListener('click', (ev) => {
  if (!calibration || !calibration.triangulatedPoints || calibration.triangulatedPoints.length === 0) return;

  const rect = miniCanvas.getBoundingClientRect();
  // account for CSS scaling
  const scaleX = miniCanvas.width / rect.width;
  const scaleY = miniCanvas.height / rect.height;
  const cx = (ev.clientX - rect.left) * scaleX;
  const cy = (ev.clientY - rect.top) * scaleY;

  // same mapping used in drawMiniCloud
  const pts = calibration.triangulatedPoints;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (!isFinite(p.x) || !isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return;
  if (Math.abs(maxX - minX) < 1e-6) { minX -= 1; maxX += 1; }
  if (Math.abs(maxY - minY) < 1e-6) { minY -= 1; maxY += 1; }

  const pad = 6;
  const w = miniCanvas.width - pad*2;
  const h = miniCanvas.height - pad*2;

  // convert click position to world coords in same system used for plotting
  const worldX = minX + ((cx - pad) / w) * (maxX - minX);
  const worldY = minY + (1 - ( (cy - pad) / h )) * (maxY - minY);

  // find nearest point index in XY plane
  let nearestIdx = -1;
  let bestDistSq = Infinity;
  for (let i=0;i<pts.length;i++) {
    const p = pts[i];
    if (!isFinite(p.x) || !isFinite(p.y)) continue;
    const dx = p.x - worldX;
    const dy = p.y - worldY;
    const dsq = dx*dx + dy*dy;
    if (dsq < bestDistSq) {
      bestDistSq = dsq;
      nearestIdx = i;
    }
  }

  if (nearestIdx === -1) return;

  // threshold: if click is too far from nearest (in mini-canvas pixels), ignore
  const nearestP = pts[nearestIdx];
  const sx = pad + ((nearestP.x - minX) / (maxX - minX)) * w;
  const sy = pad + (1 - (nearestP.y - minY) / (maxY - minY)) * h;
  const dxPix = sx - cx;
  const dyPix = sy - cy;
  const distPix = Math.hypot(dxPix, dyPix);
  const CLICK_THRESHOLD_PIX = 12; // pixels
  if (distPix > CLICK_THRESHOLD_PIX) {
    // click not close enough to any point -> clear selection
    clearMiniSelection();
    drawMiniCloud();
    return;
  }

  // selection logic:
  if (selectedMiniIndices.length === 0) {
    setMiniSelection(nearestIdx);
  } else if (selectedMiniIndices.length === 1) {
    if (selectedMiniIndices[0] === nearestIdx) {
      // deselect
      clearMiniSelection();
    } else {
      setMiniSelection(selectedMiniIndices[0], nearestIdx);
    }
  } else {
    // already had two -> start new selection with clicked
    setMiniSelection(nearestIdx);
  }

  drawMiniCloud();
});

// small drawing helpers (kept)
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
