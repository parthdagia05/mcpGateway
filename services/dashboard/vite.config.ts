import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development (npm run dev) the API calls go to the gateway running in k3d, so the dashboard
// and its API share one origin just like in the cluster (where Ingress routes /api to the gateway).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: "http://dashboard.localtest.me", changeOrigin: true } },
  },
});
