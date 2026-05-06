import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));

export default defineConfig({
  plugins: [react()],
  root: path.join(__dirname, "src"),
  publicDir: path.join(__dirname, "public"),
  base: "./",
  build: {
    outDir: path.join(__dirname, "dist/web"),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    strictPort: true
  },
  /** Derleme anındaki package.json sürümü (tarayıcı önizleme; Electron’da app.getVersion ile aynı kaynak) */
  define: {
    __KOBI_PACKAGE_VERSION__: JSON.stringify(pkg.version)
  }
});
