#!/usr/bin/env node
import { runConfigurationOperation } from "./configuration.mjs";
import { withConsumableProtectedInputs } from "./consumable-input.mjs";

const operation = process.argv[2];
if (process.argv.length !== 3 || operation === undefined) {
  throw new Error("One configuration operation is required");
}

try {
  await withConsumableProtectedInputs(
    [
      {
        label: "Registry credential rotation input",
        maximumBytes: 64 * 1024,
        name: "registryInput",
        path:
          operation === "rotate-registry" ? process.env.CAPSTONE_REGISTRY_ROTATION_FILE : undefined,
      },
      {
        label: "Runtime secret rotation input",
        maximumBytes: 64 * 1024,
        name: "secretInput",
        path:
          operation === "rotate-runtime-secrets"
            ? process.env.CAPSTONE_RUNTIME_SECRET_ROTATION_FILE
            : undefined,
      },
    ],
    async ({ registryInput, secretInput }) =>
      runConfigurationOperation(operation, { registryInput, secretInput }),
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error", outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
}
