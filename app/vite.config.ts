import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("../", import.meta.url)), "PORT");
  const port = process.env.PORT || env.PORT || "3000";
  return {
    plugins: [react()],
    server: { proxy: { "/api": `http://localhost:${port}` } },
  };
});
