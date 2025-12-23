import { startScanner } from "./scanner.js";
import { initUI } from "./ui.js";

initUI(document.getElementById("btnStart"), startScanner);
