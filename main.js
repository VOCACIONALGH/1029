const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const blackSlider = document.getElementById("blackThreshold");
const blueSlider = document.getElementById("blueThreshold");
const greenSlider = document.getElementById("greenThreshold");

const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");

let pitch = 0;
let yaw = 0;
let roll = 0;

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

    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission === "granted") {
                window.addEventListener("deviceorientation", onOrientation);
            }
        } catch {}
    } else {
        window.addEventListener("deviceorientation", onOrientation);
    }
});

function onOrientation(e) {
    pitch = e.beta || 0;   // X
    yaw   = e.alpha || 0;  // Z
    roll  = e.gamma || 0;  // Y

    pitchEl.textContent = pitch.toFixed(1);
    yawEl.textContent   = yaw.toFixed(1);
    rollEl.textContent  = roll.toFixed(1);
}

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

function drawArrow(x1, y1, x2, y2, color) {
    const head = 10;
    const a = Math.atan2(y2 - y1, x2 - x1);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(a - Math.PI / 6), y2 - head * Math.sin(a - Math.PI / 6));
    ctx.lineTo(x2 - head * Math.cos(a + Math.PI / 6), y2 - head * Math.sin(a + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
}

function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;

    const vBlack = blackSlider.value / 100;
    const sBlue = blueSlider.value / 100;
    const sGreen = greenSlider.value / 100;

    let sbx = 0, sby = 0, cb = 0;
    let blx = 0, bly = 0, cbl = 0;
    let grx = 0, gry = 0, cgr = 0;

    for (let i = 0; i < data.length; i += 4) {
        const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);

        const idx = i / 4;
        const x = idx % canvas.width;
        const y = Math.floor(idx / canvas.width);

        if (hsv.v < vBlack) {
            data[i] = 255; data[i + 1] = 165; data[i + 2] = 0;
            sbx += x; sby += y; cb++;
        } else if (hsv.h >= 200 && hsv.h <= 260 && hsv.s > sBlue) {
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            blx += x; bly += y; cbl++;
        } else if (hsv.h >= 90 && hsv.h <= 150 && hsv.s > sGreen) {
            data[i] = 128; data[i + 1] = 0; data[i + 2] = 128;
            grx += x; gry += y; cgr++;
        }
    }

    ctx.putImageData(frame, 0, 0);

    let ox, oy, bx, by, gx, gy;

    if (cb) {
        ox = sbx / cb; oy = sby / cb;
        ctx.fillStyle = "white";
        ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();
    }
    if (cbl) {
        bx = blx / cbl; by = bly / cbl;
        ctx.fillStyle = "blue";
        ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill();
    }
    if (cgr) {
        gx = grx / cgr; gy = gry / cgr;
        ctx.fillStyle = "green";
        ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.fill();
    }

    if (cb && cbl) drawArrow(ox, oy, bx, by, "blue");
    if (cb && cgr) drawArrow(ox, oy, gx, gy, "green");

    requestAnimationFrame(processFrame);
}
