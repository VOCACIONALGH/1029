const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const redCountDisplay = document.getElementById("redCount");
const redThresholdSlider = document.getElementById("redThreshold");

scanBtn.addEventListener("click", async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: "environment" } },
        audio: false
    });

    video.srcObject = stream;

    video.addEventListener("loadedmetadata", () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        requestAnimationFrame(processFrame);
    }, { once: true });
});

function rgbToHsv(r, g, b) {
    const rN = r / 255, gN = g / 255, bN = b / 255;
    const max = Math.max(rN, gN, bN);
    const min = Math.min(rN, gN, bN);
    const d = max - min;

    let h = 0;
    if (d !== 0) {
        if (max === rN) h = ((gN - bN) / d) % 6;
        else if (max === gN) h = (bN - rN) / d + 2;
        else h = (rN - gN) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }

    const s = max === 0 ? 0 : d / max;
    const v = max;

    return { h, s, v };
}

function sliderToHueTolerance(v) {
    return 5 + ((v - 50) / (255 - 50)) * 55;
}

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    const hueTol = sliderToHueTolerance(Number(redThresholdSlider.value));
    const minS = 0.35;
    const minV = 0.12;

    let redPixels = 0;

    // acumuladores para o centro
    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const { h, s, v } = rgbToHsv(r, g, b);

        const isRedHue = (h <= hueTol) || (h >= 360 - hueTol);

        if (isRedHue && s >= minS && v >= minV) {
            redPixels++;

            const pixelIndex = i / 4;
            const x = pixelIndex % canvas.width;
            const y = Math.floor(pixelIndex / canvas.width);

            sumX += x;
            sumY += y;

            data[i]     = 255;
            data[i + 1] = 165;
            data[i + 2] = 0;
        }
    }

    ctx.putImageData(imageData, 0, 0);

    // desenha ponto de origem no centro dos pixels vermelhos
    if (redPixels > 0) {
        const cx = sumX / redPixels;
        const cy = sumY / redPixels;

        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "red";
        ctx.fill();
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${redPixels}`;

    requestAnimationFrame(processFrame);
}
