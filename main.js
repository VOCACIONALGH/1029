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
