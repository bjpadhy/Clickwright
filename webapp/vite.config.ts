import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // backend HTTP/SSE server (thin layer around the agents)
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
