import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // The Instrumentation screen talks to the real backend (backend/API.md).
      // `/api/runs/:id/events` is SSE — buffering must stay off.
      "/api": {
        target: process.env["BACKEND_URL"] ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
})
