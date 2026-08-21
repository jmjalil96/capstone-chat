import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadSecretEnvironment } from "./secret-environment.js";

const environmentFile = fileURLToPath(new URL("../../../.env", import.meta.url));

export function loadEnvironmentFile(): void {
  loadDotenv({ path: environmentFile, quiet: true });
}

export function loadRecoveryEnvironmentFile(): void {
  loadEnvironmentFile();
  loadSecretEnvironment(process.env);
}
