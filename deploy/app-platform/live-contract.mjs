#!/usr/bin/env node
import { parseArgs } from "node:util";
import { REVISION_PATTERN, readContract, readProtectedJson, validateApp } from "./contract.mjs";

function required(options, name, pattern) {
  const value = options[name];
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`--${name} is invalid`);
  }
  return value;
}

function parseArguments(values) {
  const parsed = parseArgs({
    allowPositionals: true,
    args: values,
    options: {
      "app-id": { type: "string" },
      environment: { type: "string" },
      "live-file": { type: "string" },
      revision: { type: "string" },
    },
    strict: true,
    tokens: true,
  });
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "validate") {
    throw new Error("App contract arguments are invalid");
  }
  const names = parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (new Set(names).size !== names.length) {
    throw new Error("App contract argument is duplicated");
  }
  return parsed.values;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const environment = required(options, "environment", /^(?:staging|production)$/u);
  const contract = readContract(environment);
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
