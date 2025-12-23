export const elements = {
  video: document.getElementById("camera"),
  scanBtn: document.getElementById("scanBtn"),
  canvas: document.getElementById("frame"),
  pixelInfo: document.getElementById("pixelInfo")
};

export const ctx = elements.canvas.getContext("2d");
