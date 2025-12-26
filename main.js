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
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }

    return { h, s, v };
}

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;
    const vThreshold = parseInt(thresholdSlider.value, 10) / 100;

    let sumBlackX = 0, sumBlackY = 0, countBlack = 0;
    let sumBlueX = 0, sumBlueY = 0, countBlue = 0;
    let sumGreenX = 0, sumGreenY = 0, countGreen = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const hsv = rgbToHsv(r, g, b);

        const pixelIndex = i / 4;
        const x = pixelIndex % canvas.width;
        const y = Math.floor(pixelIndex / canvas.width);

        // PRETO → LARANJA
        if (hsv.v < vThreshold) {
            data[i] = 255;
            data[i + 1] = 165;
            data[i + 2] = 0;

            sumBlackX += x;
            sumBlackY += y;
            countBlack++;
        }

        // AZUL → BRANCO
        else if (hsv.h >= 200 && hsv.h <= 260 && hsv.s > 0.4) {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;

            sumBlueX += x;
            sumBlueY += y;
            countBlue++;
        }

        // VERDE → ROXO
        else if (hsv.h >= 90 && hsv.h <= 150 && hsv.s > 0.4) {
            data[i] = 128;
            data[i + 1] = 0;
            data[i + 2] = 128;

            sumGreenX += x;
            sumGreenY += y;
            countGreen++;
        }
    }

    ctx.putImageData(frame, 0, 0);

    // ORIGEM (preto)
    if (countBlack > 0) {
        ctx.fillStyle = "white";
        ctx.beginPath();
        ctx.arc(sumBlackX / countBlack, sumBlackY / countBlack, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // PONTO AZUL
    if (countBlue > 0) {
        ctx.fillStyle = "blue";
        ctx.beginPath();
        ctx.arc(sumBlueX / countBlue, sumBlueY / countBlue, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // PONTO VERDE
    if (countGreen > 0) {
        ctx.fillStyle = "green";
        ctx.beginPath();
        ctx.arc(sumGreenX / countGreen, sumGreenY / countGreen, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    requestAnimationFrame(processFrame);
}
