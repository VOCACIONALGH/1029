// main.js - entrada
import { setupUI } from "./ui.js";
import { registerServiceWorker } from "./sw-register.js";

document.addEventListener("DOMContentLoaded", () => {
  setupUI();
  registerServiceWorker();
});
