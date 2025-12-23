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

    let rSumX = 0, rSumY = 0;
    let bSumX = 0, bSumY = 0, bCount = 0;
    let gSumX = 0, gSumY = 0, gCount = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const { h, s, v } = rgbToHsv(r, g, b);
        if (s < minS || v < minV) continue;

        const pixelIndex = i / 4;
        const x = pixelIndex % canvas.width;
        const y = Math.floor(pixelIndex / canvas.width);

        // 🔴 VERMELHO
        if (h <= hueTol || h >= 360 - hueTol) {
            redPixels++;
            rSumX += x;
            rSumY += y;

            data[i]     = 255;
            data[i + 1] = 165;
            data[i + 2] = 0;
        }

        // 🔵 AZUL (≈ 200–260°)
        else if (h >= 200 && h <= 260) {
            bCount++;
            bSumX += x;
            bSumY += y;

            data[i]     = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
        }

        // 🟢 VERDE (≈ 90–150°)
        else if (h >= 90 && h <= 150) {
            gCount++;
            gSumX += x;
            gSumY += y;

            data[i]     = 160;
            data[i + 1] = 32;
            data[i + 2] = 240;
        }
    }

    ctx.putImageData(imageData, 0, 0);

    // 🔴 ponto vermelho
    if (redPixels > 0) {
        ctx.beginPath();
        ctx.arc(rSumX / redPixels, rSumY / redPixels, 6, 0, Math.PI * 2);
        ctx.fillStyle = "red";
        ctx.fill();
    }

    // 🔵 ponto azul
    if (bCount > 0) {
        ctx.beginPath();
        ctx.arc(bSumX / bCount, bSumY / bCount, 6, 0, Math.PI * 2);
        ctx.fillStyle = "blue";
        ctx.fill();
    }

    // 🟢 ponto verde
    if (gCount > 0) {
        ctx.beginPath();
        ctx.arc(gSumX / gCount, gSumY / gCount, 6, 0, Math.PI * 2);
        ctx.fillStyle = "green";
        ctx.fill();
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${redPixels}`;

    requestAnimationFrame(processFrame);
}
