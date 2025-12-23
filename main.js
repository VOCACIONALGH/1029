/* main.js
Atualizado: durante a calibragem, cada pixel preto define um "raio 3D" (um por pixel) usando a aproximação pinhole.
O número de raios com direção definida é contado por frame e exibido na tela em tempo real.
Nenhuma outra funcionalidade foi alterada.
*/


const scanBtn = document.getElementById("scanBtn");
const calibrateBtn = document.getElementById("calibrateBtn");


const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");


const redCountDisplay = document.getElementById("redCount");
const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");
const scaleEl = document.getElementById("scaleValue");
const zEl = document.getElementById("zValue");
const xEl = document.getElementById("xValue");
const yEl = document.getElementById("yValue");
const raysEl = document.getElementById("raysValue");


const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");


const ARROW_LENGTH_MM = 100;


// calibration / locking state
let baseZmm = 0;
let lockedScale = 0; // px per mm locked at calibration
let basePixelDistance = 0; // calibrated arrow length in px (ARROW_LENGTH_MM * lockedScale)
let baseOriginScreen = null; // {x,y} of origin in screen coords at calibration
let isCalibrated = false;


}
