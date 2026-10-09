import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI builds into dist/web, which the app server serves. In development, Vite proxies Ogdoad's
// APIs to a running app server (3101), which in turn reaches the Ogdoad server and Horos.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3101", "/horos": "http://127.0.0.1:3101", "/ogdoad": "http://127.0.0.1:3101" },
  },
});
