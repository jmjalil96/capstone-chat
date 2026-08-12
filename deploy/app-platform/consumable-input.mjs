import { rmSync } from "node:fs";
import { readProtectedJson } from "./contract.mjs";

export async function withConsumableProtectedInputs(definitions, operation) {
  const consumedPaths = [];
  const inputs = {};
  try {
    for (const definition of definitions) {
      const inputPath = definition.path;
      if (inputPath === undefined) {
        inputs[definition.name] = undefined;
        continue;
      }
      consumedPaths.push(inputPath);
      const value = readProtectedJson(inputPath, definition.label, definition.maximumBytes);
      inputs[definition.name] = value;
    }
    return await operation(inputs);
  } finally {
    for (const inputPath of consumedPaths) {
      rmSync(inputPath, { force: true });
    }
  }
}
