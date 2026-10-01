console.log("============================================");
console.log("MAIN.TSX LOADED - Preact is running!");
console.log("============================================");

import { render } from "preact";
import "./index.css";
import "./app.css"; // <-- Import the new styles
import { App } from "./app.tsx";

console.log("Imports complete, about to render...");

try {
  render(<App />, document.getElementById("app")!);
  console.log("App rendered successfully!");
} catch (error) {
  console.error("Failed to render App:", error);
}
