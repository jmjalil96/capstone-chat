import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const environmentFile = fileURLToPath(new URL("../../../.env", import.meta.url));

export function loadEnvironmentFile(): void {
  loadDotenv({ path: environmentFile, quiet: true });
}
