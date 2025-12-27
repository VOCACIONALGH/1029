const scanBtn = document.getElementById('scanBtn');
const video = document.getElementById('camera');

const blackSlider = document.getElementById('blackSlider');
const blackValue = document.getElementById('blackValue');

// valor de calibração do preto (tons mais claros ↔ mais escuros)
let blackThreshold = Number(blackSlider.value);

blackValue.textContent = blackThreshold;

blackSlider.addEventListener('input', () => {
  blackThreshold = Number(blackSlider.value);
  blackValue.textContent = blackThreshold;
});

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
