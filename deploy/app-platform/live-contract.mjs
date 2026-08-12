#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION_PATTERN, readContract, readProtectedJson, validateApp } from "./contract.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = {
  bootstrap: "bootstrap.contract.yaml",
  live: "app.contract.yaml",
  rehearsal: "rehearsal.contract.yaml",
  "rehearsal-bootstrap": "rehearsal-bootstrap.contract.yaml",
};

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  const [operation, ...rest] = values;
  if (operation !== "validate") {
    fail("App contract operation must be validate");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("App contract arguments are invalid");
    }
    const name = key.slice(2);
    if (options[name] !== undefined) {
      fail("App contract argument is duplicated");
    }
    options[name] = value;
  }
  for (const key of Object.keys(options)) {
    if (!["app-id", "contract", "live-file", "mode", "revision"].includes(key)) {
      fail(`Unexpected --${key} argument`);
    }
  }
  return options;
}

function required(options, name, pattern) {
  const value = options[name];
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) {
    fail(`--${name} is invalid`);
  }
  return value;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const mode = required(options, "mode", /^(?:bootstrap|live|rehearsal|rehearsal-bootstrap)$/u);
  const contractName = CONTRACTS[mode];
  const contract = readContract(options.contract ?? path.join(directory, contractName), mode);
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
