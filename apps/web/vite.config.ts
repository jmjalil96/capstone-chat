import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const brandIcons = fileURLToPath(new URL("../../packages/brand/assets/icons", import.meta.url));
const bundleEvidenceFile = ".vite/capstone-bundle-evidence.json";

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }

  return port;
}

interface ViteEnvironment {
  readonly CAPSTONE_WEB_PORT?: string;
  readonly DEPLOYMENT_REVISION?: string;
  readonly PORT?: string;
  readonly RENDER_GIT_COMMIT?: string;
}

function deploymentRevision(environment: ViteEnvironment): string {
  const value = environment.RENDER_GIT_COMMIT?.trim() || environment.DEPLOYMENT_REVISION?.trim();
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
    ? value
    : "unknown";
}

function repositoryModule(moduleId: string): string | null {
  const cleanId = moduleId.replace(/\?.*$/u, "").replaceAll("\0", "");
  if (!path.isAbsolute(cleanId)) {
    return null;
  }
  const relative = path.relative(repositoryRoot, cleanId).split(path.sep).join("/");
  if (
    relative.startsWith("../") ||
    relative === ".." ||
    relative.startsWith("node_modules/") ||
    relative.includes("/node_modules/")
  ) {
    return null;
  }
  return relative;
}

function bundleEvidencePlugin(): Plugin {
  return {
    apply: "build",
    name: "capstone-bundle-evidence",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((entry) => entry.type === "chunk")
        .map((chunk) => ({
          dynamicImports: [...chunk.dynamicImports].sort(),
          file: chunk.fileName,
          imports: [...chunk.imports].sort(),
          isDynamicEntry: chunk.isDynamicEntry,
          isEntry: chunk.isEntry,
          modules: Object.keys(chunk.modules)
            .map(repositoryModule)
            .filter((module): module is string => module !== null)
            .sort(),
        }))
        .sort((left, right) => left.file.localeCompare(right.file));

      this.emitFile({
        fileName: bundleEvidenceFile,
        source: `${JSON.stringify({ chunks, schemaVersion: 1 }, null, 2)}\n`,
        type: "asset",
      });
    },
  };
}

export function createViteConfig(environment: ViteEnvironment): UserConfig {
  const apiPort = readPort(environment.PORT, 3000, "PORT");

  return {
    define: {
      "import.meta.env.VITE_DEPLOYMENT_REVISION": JSON.stringify(deploymentRevision(environment)),
    },
    build: {
      manifest: true,
    },
    plugins: [react(), bundleEvidencePlugin()],
    publicDir: brandIcons,
    server: {
      host: "localhost",
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
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
        },
      },
      strictPort: true,
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, [
    "CAPSTONE_WEB_",
    "DEPLOYMENT_REVISION",
    "PORT",
    "RENDER_GIT_COMMIT",
  ]);
  return createViteConfig(environment);
});
