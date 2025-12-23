const scanBtn = document.getElementById("scanBtn");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const redCountDisplay = document.getElementById("redCount");
const pitchEl = document.getElementById("pitch");
const yawEl = document.getElementById("yaw");
const rollEl = document.getElementById("roll");
const scaleEl = document.getElementById("scaleValue");

const redThresholdSlider = document.getElementById("redThreshold");
const blueThresholdSlider = document.getElementById("blueThreshold");
const greenThresholdSlider = document.getElementById("greenThreshold");

const ARROW_LENGTH_MM = 100;

scanBtn.addEventListener("click", async () => {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try { await DeviceOrientationEvent.requestPermission(); } catch {}
    }

    window.addEventListener("deviceorientation", (e) => {
        pitchEl.textContent = (e.beta ?? 0).toFixed(1);
        yawEl.textContent = (e.alpha ?? 0).toFixed(1);
        rollEl.textContent = (e.gamma ?? 0).toFixed(1);
    });

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
    const rN=r/255,gN=g/255,bN=b/255;
    const max=Math.max(rN,gN,bN),min=Math.min(rN,gN,bN);
    const d=max-min;
    let h=0;
    if(d){
        if(max===rN) h=((gN-bN)/d)%6;
        else if(max===gN) h=(bN-rN)/d+2;
        else h=(rN-gN)/d+4;
        h*=60;if(h<0)h+=360;
    }
    return {h,s:max?d/max:0,v:max};
}

function sliderToHueTolerance(v){
    return 5+((v-50)/(255-50))*55;
}

function hueDistance(a,b){
    let d=Math.abs(a-b);
    return d>180?360-d:d;
}

function drawArrowFromCenter(cx, cy, dx, dy, lengthPx, color) {
    const mag = Math.hypot(dx, dy);
    if (!mag) return;

    const ux = dx / mag;
    const uy = dy / mag;

    const x2 = cx + ux * lengthPx;
    const y2 = cy + uy * lengthPx;

    const headLen = 12;
    const angle = Math.atan2(y2 - cy, x2 - cx);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6),
               y2 - headLen * Math.sin(angle - Math.PI/6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6),
               y2 - headLen * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fill();
}

function processFrame(){
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const img=ctx.getImageData(0,0,canvas.width,canvas.height);
    const d=img.data;

    const rTol=sliderToHueTolerance(redThresholdSlider.value);
    const bTol=sliderToHueTolerance(blueThresholdSlider.value);
    const gTol=sliderToHueTolerance(greenThresholdSlider.value);

    let rC=0,rX=0,rY=0;
    let bC=0,bX=0,bY=0;
    let gC=0,gX=0,gY=0;

    for(let i=0;i<d.length;i+=4){
        const {h,s,v}=rgbToHsv(d[i],d[i+1],d[i+2]);
        if(s<0.35||v<0.12) continue;
        const p=i/4,x=p%canvas.width,y=(p/canvas.width)|0;

        if(hueDistance(h,0)<=rTol){
            rC++;rX+=x;rY+=y;
            d[i]=255;d[i+1]=165;d[i+2]=0;
        } else if(hueDistance(h,230)<=bTol){
            bC++;bX+=x;bY+=y;
            d[i]=255;d[i+1]=255;d[i+2]=255;
        } else if(hueDistance(h,120)<=gTol){
            gC++;gX+=x;gY+=y;
            d[i]=160;d[i+1]=32;d[i+2]=240;
        }
    }

    ctx.putImageData(img,0,0);

    let r,b,g;
    if(rC){r={x:rX/rC,y:rY/rC};ctx.fillStyle="red";ctx.beginPath();ctx.arc(r.x,r.y,6,0,Math.PI*2);ctx.fill();}
    if(bC){b={x:bX/bC,y:bY/bC};ctx.fillStyle="blue";ctx.beginPath();ctx.arc(b.x,b.y,6,0,Math.PI*2);ctx.fill();}
    if(gC){g={x:gX/gC,y:gY/gC};ctx.fillStyle="green";ctx.beginPath();ctx.arc(g.x,g.y,6,0,Math.PI*2);ctx.fill();}

    if(r&&b){
        const distPx=Math.hypot(b.x-r.x,b.y-r.y);
        const pxPerMm=distPx/ARROW_LENGTH_MM;
        scaleEl.textContent=pxPerMm.toFixed(3);
        drawArrowFromCenter(r.x,r.y,b.x-r.x,b.y-r.y,ARROW_LENGTH_MM*pxPerMm,"blue");
    }

    if(r&&g){
        const distPx=Math.hypot(g.x-r.x,g.y-r.y);
        const pxPerMm=distPx/ARROW_LENGTH_MM;
        drawArrowFromCenter(r.x,r.y,g.x-r.x,g.y-r.y,ARROW_LENGTH_MM*pxPerMm,"green");
    }

    redCountDisplay.textContent=`Pixels vermelhos: ${rC}`;
    requestAnimationFrame(processFrame);
}
