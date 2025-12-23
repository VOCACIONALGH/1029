const scanButton = document.getElementById('scanButton');
const video = document.getElementById('camera');

scanButton.addEventListener('click', async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { exact: "environment" } },
    audio: false
  });

  video.srcObject = stream;
});
