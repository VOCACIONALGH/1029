export async function startScanner() {
    const video = document.getElementById("cameraFeed");
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: "environment" } },
            audio: false
        });
        video.srcObject = stream;
    } catch (err) {
        console.error("Erro ao acessar câmera:", err);
    }
}
