import { elements, ctx } from "./estrutura.js";
import { contarPixelsVermelhos } from "./geometria.js";

let stream = null;

elements.scanBtn.addEventListener("click", async () => {
  if (stream) return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: "environment" }
      },
      audio: false
    });

    elements.video.srcObject = stream;
    processarVideo();

  } catch (err) {
    alert("Erro ao acessar a câmera traseira");
    console.error(err);
  }
});

function processarVideo() {
  requestAnimationFrame(processarVideo);

  if (elements.video.videoWidth === 0) return;

  elements.canvas.width = elements.video.videoWidth;
  elements.canvas.height = elements.video.videoHeight;

  ctx.drawImage(elements.video, 0, 0);

  const imageData = ctx.getImageData(
    0, 0,
    elements.canvas.width,
    elements.canvas.height
  );

  const vermelhos = contarPixelsVermelhos(imageData);

  elements.pixelInfo.textContent =
    `Pixels vermelhos: ${vermelhos}`;
}
