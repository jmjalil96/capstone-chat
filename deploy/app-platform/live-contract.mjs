#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProvisioningTransition,
  assertSafeRollbackHistory,
  DIGEST_PATTERN,
  liveFingerprint,
  REVISION_PATTERN,
  readContract,
  readProtectedJson,
  renderSpec,
  validateApp,
  writeProtectedJson,
} from "./contract.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  const [operation, ...rest] = values;
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
  return { operation, options };
}

function required(options, name, pattern) {
  const value = options[name];
  if (typeof value !== "string" || (pattern !== undefined && !pattern.test(value))) {
    fail(`--${name} is invalid`);
  }
  return value;
}

function optionalProtectedJson(options, name, label) {
  const value = options[name];
  return value === undefined ? undefined : readProtectedJson(value, label);
}

function contractPath(mode, explicit) {
  if (explicit !== undefined) {
    return explicit;
  }
  const names = {
    bootstrap: "bootstrap.contract.yaml",
    domain: "domain.contract.yaml",
    egress: "egress.contract.yaml",
    initialization: "initialization.contract.yaml",
    live: "app.contract.yaml",
    rehearsal: "rehearsal.contract.yaml",
    "rehearsal-bootstrap": "rehearsal-bootstrap.contract.yaml",
    "rehearsal-domain": "rehearsal-domain.contract.yaml",
    "rehearsal-egress": "rehearsal-egress.contract.yaml",
    "rehearsal-initialization": "rehearsal-initialization.contract.yaml",
  };
  const name = names[mode];
  if (name === undefined) {
    fail("--mode is invalid");
  }
  return path.join(scriptDirectory, name);
}

function assertOnly(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      fail(`Unexpected --${key} argument`);
    }
  }
}

function runRender(options) {
  assertOnly(options, [
    "contract",
    "digest",
    "general-input-file",
    "general-mode",
    "live-file",
    "mode",
    "output",
    "registry-input-file",
    "registry-mode",
    "revision",
    "secret-input-file",
    "secret-mode",
    "source-mode",
  ]);
  const mode = required(
    options,
    "mode",
    /^(?:bootstrap|egress|domain|initialization|live|rehearsal(?:-bootstrap|-domain|-egress|-initialization)?)$/u,
  );
  const contract = readContract(contractPath(mode, options.contract), mode);
  const digest = required(options, "digest", DIGEST_PATTERN);
  const revision = required(options, "revision", REVISION_PATTERN);
  const output = required(options, "output");
  const liveApp = optionalProtectedJson(options, "live-file", "Live App input");
  const sourceMode = options["source-mode"];
  assertProvisioningTransition(sourceMode, mode);
  if (["bootstrap", "rehearsal-bootstrap"].includes(mode)) {
    if (liveApp !== undefined) {
      fail("Bootstrap does not accept an existing Live App input");
    }
  } else {
    if (liveApp === undefined) {
      fail("A fetched Live App input is required for this transition");
    }
    const sourceContract = readContract(contractPath(sourceMode), sourceMode);
    validateApp({ app: liveApp, contract: sourceContract, digest });
  }
  const spec = renderSpec({
    contract,
    digest,
    generalInput: optionalProtectedJson(options, "general-input-file", "Runtime general input"),
    generalMode: options["general-mode"] ?? "preserve",
    liveApp,
    registryInput: optionalProtectedJson(
      options,
      "registry-input-file",
      "Registry credential input",
    ),
    registryMode: options["registry-mode"] ?? "preserve",
    revision,
    secretInput: optionalProtectedJson(options, "secret-input-file", "Runtime secret input"),
    secretMode: options["secret-mode"] ?? "preserve",
  });
  writeProtectedJson(output, { spec });
  return { digest, mode, operation: "render", revision, schema: 1 };
}

function runValidate(options) {
  assertOnly(options, ["app-id", "contract", "digest", "history-file", "live-file", "mode"]);
  const mode = options.mode ?? "live";
  const contract = readContract(contractPath(mode, options.contract), mode);
  const live = readProtectedJson(required(options, "live-file"), "Live App input");
  const result = validateApp({
    app: live,
    appId: options["app-id"],
    contract,
    digest: required(options, "digest", DIGEST_PATTERN),
  });
  if (options["history-file"] !== undefined) {
    if (mode !== "live") {
      fail("Rollback history is valid only for the live contract");
    }
    const history = readProtectedJson(options["history-file"], "Deployment history input");
    assertSafeRollbackHistory(history.deployments);
  }
  return { ...result, operation: "validate", schema: 1 };
}

function runFingerprint(options) {
  assertOnly(options, ["live-file"]);
  const live = readProtectedJson(required(options, "live-file"), "Live App input");
  return { fingerprint: liveFingerprint(live), operation: "fingerprint", schema: 1 };
}

try {
  const { operation, options } = parseArguments(process.argv.slice(2));
  let result;
  if (operation === "render") {
    result = runRender(options);
  } else if (operation === "validate") {
    result = runValidate(options);
  } else if (operation === "fingerprint") {
    result = runFingerprint(options);
  } else {
    fail("App contract operation is invalid");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error", outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
}
