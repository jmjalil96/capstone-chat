import { spawnSync } from "node:child_process";

const imagePattern = /^[a-z0-9][a-z0-9./:_-]{0,255}$/u;
const postgresProtocols = new Set(["postgres:", "postgresql:"]);

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateImage(image, message = "A safe built-image tag is required") {
  assert(image !== undefined && imagePattern.test(image), message);
  return image;
}

export function validatePort(value, variableName) {
  const port = Number(value);
  assert(
    Number.isInteger(port) && port >= 1024 && port <= 65_535,
    `${variableName} must be a non-privileged port`,
  );
  return port;
}

export function loopbackDatabaseUrl(value, variableName, purpose) {
  assert(value !== undefined && value.length > 0, `${variableName} is required`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid loopback PostgreSQL URL`);
  }
  assert(postgresProtocols.has(parsed.protocol), `${variableName} must use PostgreSQL`);
  assert(
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost",
    `${purpose} accepts only a loopback disposable database`,
  );
  parsed.hostname = "host.docker.internal";
  return parsed.toString();
}

export function docker(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "docker command failed";
    throw new Error(detail);
  }
  return result.stdout.trim();
}

export function runContainer({
  image,
  command = [],
  name,
  detach = false,
  remove = false,
  hostDatabase = false,
  publish,
  environment = {},
  entrypoint,
  dockerArguments = [],
  processEnvironment,
}) {
  const arguments_ = ["run"];
  if (detach) arguments_.push("--detach", "--init");
  if (remove) arguments_.push("--rm");
  if (name !== undefined) arguments_.push("--name", name);
  if (hostDatabase) arguments_.push("--add-host", "host.docker.internal:host-gateway");
  if (publish !== undefined) arguments_.push("--publish", publish);
  arguments_.push(...dockerArguments);
  for (const [key, value] of Object.entries(environment)) {
    arguments_.push("--env", value === undefined ? key : `${key}=${value}`);
  }
  if (entrypoint !== undefined) arguments_.push("--entrypoint", entrypoint);
  arguments_.push(image, ...command);
  return docker(
    arguments_,
    processEnvironment === undefined ? undefined : { env: processEnvironment },
  );
}

export function forceRemove(...containerNames) {
  for (const containerName of containerNames) {
    spawnSync("docker", ["rm", "--force", containerName], { encoding: "utf8" });
  }
}

export function printContainerLogs(containerName) {
  const logs = spawnSync("docker", ["logs", "--tail", "100", containerName], {
    encoding: "utf8",
  });
  if (logs.status === 0 && logs.stdout.trim().length > 0) {
    process.stderr.write(`${logs.stdout.trim()}\n`);
  }
}

export async function waitUntil(attempt, timeoutMessage) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (await attempt()) return;
    } catch {
      // Container startup is expected to fail probes briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(timeoutMessage);
}
