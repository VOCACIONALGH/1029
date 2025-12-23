const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const redCountDisplay = document.getElementById("redCount");
const redThresholdSlider = document.getElementById("redThreshold");

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

function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    let s = max === 0 ? 0 : d / max;
    let v = max;

    if (d !== 0) {
        switch (max) {
            case r:
                h = ((g - b) / d) % 6;
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }

    return { h, s, v };
}

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    const hueThreshold = Number(redThresholdSlider.value);
    let redPixels = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const { h, s, v } = rgbToHsv(r, g, b);

        if (
            (h <= hueThreshold || h >= 360 - hueThreshold) &&
            s > 0.5 &&
            v > 0.2
        ) {
            redPixels++;

            data[i]     = 255; // R
            data[i + 1] = 165; // G
            data[i + 2] = 0;   // B (laranja)
        }
    }

    ctx.putImageData(imageData, 0, 0);
    redCountDisplay.textContent = `Pixels vermelhos: ${redPixels}`;

    requestAnimationFrame(processFrame);
}
