// js/ui.js
export function initUI(button, startCallback) {
    const container = document.getElementById("scannerContainer");

    button.addEventListener("click", () => {
        // ativa a divisão de tela (usa a classe .active definida no CSS)
        container.classList.add("active");
        // esconde o botão conforme pedido
        button.style.display = "none";
        // inicia a câmera (módulo scanner)
        startCallback();
    });
}
