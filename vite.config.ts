import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // 减小 JS 体积
    target: "es2021",
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: true,    // 去掉 console.log
        drop_debugger: true,
        passes: 2,
      },
    },
    rollupOptions: {
      output: {
        // 拆分大依赖
        manualChunks: {
          react: ["react", "react-dom"],
          tauri: ["@tauri-apps/api", "@tauri-apps/plugin-shell"],
          icons: ["lucide-react"],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
}));
