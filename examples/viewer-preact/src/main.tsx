console.log("============================================");
console.log("MAIN.TSX LOADED - Preact is running!");
console.log("============================================");

// The viewer's font, served with the viewer itself: no page load asks a
// third party (Google Fonts) for it. Quicksand is under the SIL Open Font
// License; its notice ships beside the viewer (public/quicksand-OFL.txt).
import "@fontsource/quicksand/400.css";
import "@fontsource/quicksand/500.css";
import "@fontsource/quicksand/600.css";
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
