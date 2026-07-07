import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        background: path.resolve(__dirname, "src/background.ts"),
        content: path.resolve(__dirname, "src/content.ts")
      },
      output: {
        entryFileNames: "[name].js"
      }
    }
  },
  publicDir: "public"
});