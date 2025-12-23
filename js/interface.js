import { elements } from "./estrutura.js";

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

  } catch (err) {
    alert("Erro ao acessar a câmera traseira");
    console.error(err);
  }
});
