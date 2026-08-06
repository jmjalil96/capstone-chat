import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }

  return port;
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, ["CAPSTONE_WEB_", "PORT"]);
  const apiPort = readPort(environment.PORT, 3000, "PORT");

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: readPort(environment.CAPSTONE_WEB_PORT, 5173, "CAPSTONE_WEB_PORT"),
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
        },
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
  };
});
