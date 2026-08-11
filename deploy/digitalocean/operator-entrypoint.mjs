import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const requestPath = "/run/capstone-operator/request.json";
const inputPath = "/run/capstone-operator/input.json";
const recoveryApplicationPath = "/run/capstone-secrets/recovery-application.json";
const apiEntrypointPath = "/app/apps/api/dist/entrypoint.js";

function fail() {
  throw new Error("Operator request is invalid");
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail();
  }
}

function boundedString(value, maximum) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    fail();
  }
  return value;
}

function readRequest() {
  let descriptor;
  try {
    descriptor = openSync(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.uid !== 0 ||
      (status.mode & 0o777) !== 0o440 ||
      status.size < 2 ||
      status.size > 16 * 1024
    ) {
      fail();
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      fail();
    }
    exactKeys(parsed, ["input", "operation", "schema"]);
    if (
      parsed.schema !== 1 ||
      parsed.input === null ||
      Array.isArray(parsed.input) ||
      typeof parsed.input !== "object"
    ) {
      fail();
    }
    return parsed;
  } catch {
    fail();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function identityArguments(operation, input) {
  if (operation === "identity-bootstrap") {
    exactKeys(input, ["email", "name", "workspace"]);
    return [
      "bootstrap",
      "--workspace",
      boundedString(input.workspace, 63),
      "--name",
      boundedString(input.name, 120),
      "--email",
      boundedString(input.email, 254),
    ];
  }
  if (operation === "identity-approve") {
    exactKeys(input, ["email", "role", "workspace"]);
    const role = boundedString(input.role, 6);
    if (role !== "admin" && role !== "member") {
      fail();
    }
    return [
      "approve",
      "--workspace",
      boundedString(input.workspace, 63),
      "--email",
      boundedString(input.email, 254),
      "--role",
      role,
    ];
  }
  exactKeys(input, ["email", "workspace"]);
  return [
    "deactivate",
    "--workspace",
    boundedString(input.workspace, 63),
    "--email",
    boundedString(input.email, 254),
  ];
}

function modelArguments(operation, input) {
  if (operation === "model-catalog-refresh") {
    exactKeys(input, []);
    return ["refresh"];
  }
  exactKeys(
    input,
    operation === "model-policy-initialize" ? ["digest", "revision", "workspace"] : ["workspace"],
  );
  if (operation === "model-policy-initialize") {
    const revision = boundedString(input.revision, 40);
    const digest = boundedString(input.digest, 71);
    if (!/^[0-9a-f]{40}$/u.test(revision) || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      fail();
    }
  }
  const workspace = boundedString(input.workspace, 63);
  if (operation === "model-policy-attest") {
    return ["attest", "--workspace", workspace, "--privacy-attestation", inputPath];
  }
  return [
    "bootstrap",
    "--mode",
    "openrouter",
    "--workspace",
    workspace,
    "--monthly-budget-usd",
    "100",
    "--fast-max-output",
    "4096",
    "--balanced-max-output",
    "8192",
    "--pro-max-output",
    "16384",
    "--employee-generation-limit",
    "2",
    "--reservation-margin-bps",
    "2000",
    "--privacy-attestation",
    inputPath,
  ];
}

function recoveryMarkerArguments(operation, input) {
  if (operation === "recovery-marker-list") {
    exactKeys(input, []);
    return ["list"];
  }
  if (operation === "recovery-marker-create") {
    exactKeys(input, ["kind"]);
    const kind = boundedString(input.kind, 4);
    if (kind !== "pre" && kind !== "post") {
      fail();
    }
    return ["create", "--kind", kind];
  }
  exactKeys(input, ["id"]);
  return ["delete", "--id", boundedString(input.id, 36)];
}

const request = readRequest();
let target;
let commandArguments;

if (
  request.operation === "identity-bootstrap" ||
  request.operation === "identity-approve" ||
  request.operation === "identity-deactivate"
) {
  target = "identity";
  commandArguments = identityArguments(request.operation, request.input);
} else if (
  request.operation === "model-catalog-refresh" ||
  request.operation === "model-policy-attest" ||
  request.operation === "model-policy-bootstrap" ||
  request.operation === "model-policy-initialize"
) {
  target = "model";
  commandArguments = modelArguments(request.operation, request.input);
} else if (
  request.operation === "recovery-marker-create" ||
  request.operation === "recovery-marker-list" ||
  request.operation === "recovery-marker-delete"
) {
  target = "recovery-marker";
  commandArguments = recoveryMarkerArguments(request.operation, request.input);
} else if (request.operation === "recovery-prepare") {
  exactKeys(request.input, []);
  target = "recovery-prepare";
  commandArguments = ["--application-secret-file", recoveryApplicationPath];
} else {
  fail();
}

process.argv = ["node", apiEntrypointPath, target, ...commandArguments];
await import(pathToFileURL(apiEntrypointPath).href);
