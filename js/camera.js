// camera.js - responsabilidade: controlar acesso à câmera
export async function startCamera(videoEl) {
  if (!videoEl) throw new Error("Elemento de vídeo não informado");
  const constraints = { video: { facingMode: "environment" }, audio: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = stream;
  // play pode rejeitar se não houver interação; esperar é seguro aqui
  await videoEl.play().catch(()=>{ /* ignore auto-play rejections */ });
  return stream;
}

export function stopCamera(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}
