const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const redCountDisplay = document.getElementById("redCount");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
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

function hueDistance(a, b) {
    let d = Math.abs(a - b);
    return d > 180 ? 360 - d : d;
}

// desenha seta do ponto (x1,y1) → (x2,y2)
function drawArrow(x1, y1, x2, y2, color) {
    const headLen = 12;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
        x2 - headLen * Math.cos(angle - Math.PI / 6),
        y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
        x2 - headLen * Math.cos(angle + Math.PI / 6),
        y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
}

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    const redTol = sliderToHueTolerance(redThresholdSlider.value);
    const blueTol = sliderToHueTolerance(blueThresholdSlider.value);
    const greenTol = sliderToHueTolerance(greenThresholdSlider.value);

    const minS = 0.35;
    const minV = 0.12;

    let rCount = 0, rX = 0, rY = 0;
    let bCount = 0, bX = 0, bY = 0;
    let gCount = 0, gX = 0, gY = 0;

    for (let i = 0; i < data.length; i += 4) {
        const { h, s, v } = rgbToHsv(data[i], data[i+1], data[i+2]);
        if (s < minS || v < minV) continue;

        const idx = i / 4;
        const x = idx % canvas.width;
        const y = Math.floor(idx / canvas.width);

        if (hueDistance(h, 0) <= redTol) {
            rCount++; rX += x; rY += y;
            data[i]=255; data[i+1]=165; data[i+2]=0;
        } else if (hueDistance(h, 230) <= blueTol) {
            bCount++; bX += x; bY += y;
            data[i]=255; data[i+1]=255; data[i+2]=255;
        } else if (hueDistance(h, 120) <= greenTol) {
            gCount++; gX += x; gY += y;
            data[i]=160; data[i+1]=32; data[i+2]=240;
        }
    }

    ctx.putImageData(imageData, 0, 0);

    let rC, bC, gC;

    if (rCount > 0) {
        rC = { x: rX / rCount, y: rY / rCount };
        ctx.fillStyle = "red";
        ctx.beginPath();
        ctx.arc(rC.x, rC.y, 6, 0, Math.PI * 2);
        ctx.fill();
    }

    if (bCount > 0) {
        bC = { x: bX / bCount, y: bY / bCount };
        ctx.fillStyle = "blue";
        ctx.beginPath();
        ctx.arc(bC.x, bC.y, 6, 0, Math.PI * 2);
        ctx.fill();
    }

    if (gCount > 0) {
        gC = { x: gX / gCount, y: gY / gCount };
        ctx.fillStyle = "green";
        ctx.beginPath();
        ctx.arc(gC.x, gC.y, 6, 0, Math.PI * 2);
        ctx.fill();
    }

    // ➡️ vetor +X (vermelho → azul)
    if (rC && bC) drawArrow(rC.x, rC.y, bC.x, bC.y, "blue");

    // ⬆️ vetor +Y (vermelho → verde)
    if (rC && gC) drawArrow(rC.x, rC.y, gC.x, gC.y, "green");

    redCountDisplay.textContent = `Pixels vermelhos: ${rCount}`;
    requestAnimationFrame(processFrame);
}
