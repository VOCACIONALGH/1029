const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const redCountDisplay = document.getElementById("redCount");

scanBtn.addEventListener("click", async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: { exact: "environment" }
        },
        audio: false
    });

    video.srcObject = stream;

    video.addEventListener("loadedmetadata", () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        requestAnimationFrame(processFrame);
    });
});

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    let redPixels = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        if (r > 150 && g < 80 && b < 80) {
            // contabiliza
            redPixels++;

            // transforma vermelho → laranja
            data[i]     = 255; // R
            data[i + 1] = 165; // G
            data[i + 2] = 0;   // B
        }
    }

    ctx.putImageData(imageData, 0, 0);

    redCountDisplay.textContent = `Pixels vermelhos: ${redPixels}`;

    requestAnimationFrame(processFrame);
}
