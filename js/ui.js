export function initUI(button, startCallback) {
    button.addEventListener("click", () => {
        const container = document.getElementById("scannerContainer");
        container.style.display = "flex";
        button.style.display = "none";

        const video = document.getElementById("cameraFeed");
        const black = document.getElementById("blackScreen");

        // Ajuste explícito para duas partes iguais
        video.style.height = "50%";
        black.style.height = "50%";

        startCallback();
    });
}
