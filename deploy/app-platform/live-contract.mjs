#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION_PATTERN, readContract, readProtectedJson, validateApp } from "./contract.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));

function required(options, name, pattern) {
  const value = options[name];
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`--${name} is invalid`);
  }
  return value;
}

function parseArguments(values) {
  const [operation, ...rest] = values;
  if (operation !== "validate" || rest.length % 2 !== 0) {
    throw new Error("App contract arguments are invalid");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("App contract arguments are invalid");
    }
    const name = key.slice(2);
    if (options[name] !== undefined) {
      throw new Error("App contract argument is duplicated");
    }
    options[name] = value;
  }
  for (const key of Object.keys(options)) {
    if (!["app-id", "common", "environment", "live-file", "overlay", "revision"].includes(key)) {
      throw new Error(`Unexpected --${key} argument`);
    }
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const environment = required(options, "environment", /^(?:staging|production)$/u);
  const contract = readContract(
    options.common ?? path.join(directory, "common.contract.yaml"),
    options.overlay ?? path.join(directory, `${environment}.contract.yaml`),
    environment,
  );
  const result = validateApp({
    app: readProtectedJson(required(options, "live-file"), "Live App input"),
    appId: options["app-id"],
    contract,
    expectedRevision: required(options, "revision", REVISION_PATTERN),
  });
  process.stdout.write(`${JSON.stringify({ ...result, operation: "validate", schema: 1 })}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error", outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
}
