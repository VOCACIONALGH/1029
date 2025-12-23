const scanBtn = document.getElementById('scanBtn');
const video = document.getElementById('video');
const statusText = document.getElementById('status');

let stream = null;

scanBtn.addEventListener('click', async () => {
    if (stream) return;

    try {
        statusText.textContent = "Abrindo câmera traseira...";

        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: "environment" }
            },
            audio: false
        });

        video.srcObject = stream;
        statusText.textContent = "Câmera ativa";

    } catch (err) {
        console.error(err);
        statusText.textContent = "Erro ao acessar a câmera";
    }
});
