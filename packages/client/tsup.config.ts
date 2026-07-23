import { defineConfig } from "tsup";

// Two entry points -> two subpath exports (see package.json "exports"):
//   index        -> "@glass/client"        (DOM-free transport core)
//   viewer/index -> "@glass/client/viewer" (vanilla-DOM viewer)
// Both are emitted as ESM + CJS with type declarations.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "viewer/index": "src/viewer/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
