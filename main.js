const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const redCountDisplay = document.getElementById("redCount");

const redThresholdSlider   = document.getElementById("redThreshold");
const blueThresholdSlider  = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

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

    const redTol   = sliderToHueTolerance(Number(redThresholdSlider.value));
    const blueTol  = sliderToHueTolerance(Number(blueThresholdSlider.value));
    const greenTol = sliderToHueTolerance(Number(greenThresholdSlider.value));

    const minS = 0.35;
    const minV = 0.12;

    let redCount = 0;
    let rX = 0, rY = 0;
    let bX = 0, bY = 0, bCount = 0;
    let gX = 0, gY = 0, gCount = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const { h, s, v } = rgbToHsv(r, g, b);
        if (s < minS || v < minV) continue;

        const idx = i / 4;
        const x = idx % canvas.width;
        const y = Math.floor(idx / canvas.width);

        // 🔴 vermelho (0°)
        if (h <= redTol || h >= 360 - redTol) {
            redCount++;
            rX += x; rY += y;

            data[i] = 255; data[i + 1] = 165; data[i + 2] = 0;
        }

        // 🔵 azul (≈ 230°)
        else if (Math.abs(h - 230) <= blueTol) {
            bCount++;
            bX += x; bY += y;

            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
        }

        // 🟢 verde (≈ 120°)
        else if (Math.abs(h - 120) <= greenTol) {
            gCount++;
            gX += x; gY += y;

            data[i] = 160; data[i + 1] = 32; data[i + 2] = 240;
        }
    }

    ctx.putImageData(imageData, 0, 0);

    if (redCount > 0) {
        ctx.beginPath();
        ctx.arc(rX / redCount, rY / redCount, 6, 0, Math.PI * 2);
        ctx.fillStyle = "red";
        ctx.fill();
    }

    if (bCount > 0) {
        ctx.beginPath();
        ctx.arc(bX / bCount, bY / bCount, 6, 0, Math.PI * 2);
        ctx.fillStyle = "blue";
        ctx.fill();
    }

    if (gCount > 0) {
        ctx.beginPath();
        ctx.arc(gX / gCount, gY / gCount, 6, 0, Math.PI * 2);
        ctx.fillStyle = "green";
        ctx.fill();
    }

    redCountDisplay.textContent = `Pixels vermelhos: ${redCount}`;

    requestAnimationFrame(processFrame);
}
