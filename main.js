const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const thresholdSlider = document.getElementById("blackThreshold");

scanBtn.addEventListener("click", async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: { exact: "environment" }
        },
        audio: false
    });

    video.srcObject = stream;

    video.onloadedmetadata = () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        processFrame();
    };
});

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;
    const threshold = parseInt(thresholdSlider.value, 10);

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        if (r < threshold && g < threshold && b < threshold) {
            data[i] = 255;
            data[i + 1] = 165;
            data[i + 2] = 0;
        }
    }

    ctx.putImageData(frame, 0, 0);
    requestAnimationFrame(processFrame);
}
