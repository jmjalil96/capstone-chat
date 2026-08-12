#!/usr/bin/env node
import { withConsumableProtectedInputs } from "./consumable-input.mjs";
import { advanceProvisioningStage, createBootstrapApp } from "./provisioning.mjs";

try {
  const [operation, sourceMode, targetMode] = process.argv.slice(2);
  await withConsumableProtectedInputs(
    [
      {
        label: "Runtime general input",
        name: "generalInput",
        path: process.env.CAPSTONE_GENERAL_INPUT_FILE,
      },
      {
        label: "Registry credential input",
        name: "registryInput",
        path: process.env.CAPSTONE_REGISTRY_INPUT_FILE,
      },
      {
        label: "Runtime secret input",
        name: "secretInput",
        path: process.env.CAPSTONE_SECRET_INPUT_FILE,
      },
    ],
    async (options) => {
      if (
        operation === "create-bootstrap" &&
        (sourceMode === undefined || sourceMode === "rehearsal-bootstrap") &&
        targetMode === undefined
      ) {
        await createBootstrapApp({ ...options, mode: sourceMode ?? "bootstrap" });
      } else if (operation === "advance" && sourceMode !== undefined && targetMode !== undefined) {
        await advanceProvisioningStage(sourceMode, targetMode, options);
      } else {
        throw new Error("Provisioning operation is invalid");
      }
    },
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error", outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
}
