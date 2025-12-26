const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const blackSlider = document.getElementById("blackThreshold");
const blueSlider = document.getElementById("blueThreshold");
const greenSlider = document.getElementById("greenThreshold");

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

    const vBlack = parseInt(blackSlider.value, 10) / 100;
    const sBlue = parseInt(blueSlider.value, 10) / 100;
    const sGreen = parseInt(greenSlider.value, 10) / 100;

    let sbx = 0, sby = 0, cb = 0;
    let blx = 0, bly = 0, cbl = 0;
    let grx = 0, gry = 0, cgr = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const hsv = rgbToHsv(r, g, b);

        const idx = i / 4;
        const x = idx % canvas.width;
        const y = Math.floor(idx / canvas.width);

        // PRETO → LARANJA
        if (hsv.v < vBlack) {
            data[i] = 255;
            data[i + 1] = 165;
            data[i + 2] = 0;

            sbx += x;
            sby += y;
            cb++;
        }

        // AZUL → BRANCO
        else if (hsv.h >= 200 && hsv.h <= 260 && hsv.s > sBlue) {
            data[i] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;

            blx += x;
            bly += y;
            cbl++;
        }

        // VERDE → ROXO
        else if (hsv.h >= 90 && hsv.h <= 150 && hsv.s > sGreen) {
            data[i] = 128;
            data[i + 1] = 0;
            data[i + 2] = 128;

            grx += x;
            gry += y;
            cgr++;
        }
    }

    ctx.putImageData(frame, 0, 0);

    if (cb > 0) {
        ctx.fillStyle = "white";
        ctx.beginPath();
        ctx.arc(sbx / cb, sby / cb, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    if (cbl > 0) {
        ctx.fillStyle = "blue";
        ctx.beginPath();
        ctx.arc(blx / cbl, bly / cbl, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    if (cgr > 0) {
        ctx.fillStyle = "green";
        ctx.beginPath();
        ctx.arc(grx / cgr, gry / cgr, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    requestAnimationFrame(processFrame);
}
