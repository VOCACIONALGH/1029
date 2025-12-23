export function initUI(button, startCallback) {
    button.addEventListener("click", () => {
        document.getElementById("scannerContainer").style.display = "flex";
        button.style.display = "none";
        startCallback();
    });
}
