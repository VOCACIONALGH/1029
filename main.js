const scanBtn = document.getElementById('scanBtn');
const video = document.getElementById('camera');

scanBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: "environment" }
      },
      audio: false
    });

    video.srcObject = stream;
    video.style.display = "block";
    scanBtn.style.display = "none";

  } catch (err) {
    alert("Não foi possível acessar a câmera traseira.");
  }
});

/*
  Conversão RGB → HSV
  r, g, b no intervalo [0, 255]
  retorna h ∈ [0,360), s ∈ [0,1], v ∈ [0,1]
*/
function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  let s = 0;
  let v = max;

  if (delta !== 0) {
    s = delta / max;

    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }

    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s, v };
}
