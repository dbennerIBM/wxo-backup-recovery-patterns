import { defineConfig } from "vite";
import webExtension from "@samrum/vite-plugin-web-extension";
import { readFileSync } from "fs";

const manifest = JSON.parse(readFileSync("./manifest.json", "utf-8"));

export default defineConfig({
  plugins: [
    webExtension({
      manifest,
    }),
  ],
  build: {
    // Ensure service workers are bundled as IIFE-compatible modules
    // (vite-plugin-web-extension handles this internally, but we make it explicit)
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
