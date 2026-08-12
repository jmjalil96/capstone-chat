import { spawnSync } from "node:child_process";

const [image] = process.argv.slice(2).filter((argument) => argument !== "--");
const databaseUrl = process.env.CAPSTONE_LOAD_DATABASE_URL;
const authSecret = process.env.CAPSTONE_LOAD_AUTH_SECRET;
const portValue = process.env.CAPSTONE_LOAD_PORT ?? "3015";
const port = Number(portValue);
const candidateCpu = "1";
const candidateMemory = "1g";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function containerDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CAPSTONE_LOAD_DATABASE_URL must be a valid loopback PostgreSQL URL");
  }
  assert(
    parsed.protocol === "postgresql:" || parsed.protocol === "postgres:",
    "CAPSTONE_LOAD_DATABASE_URL must use PostgreSQL",
  );
  assert(
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost",
    "The container rehearsal accepts only a loopback disposable database",
  );
  parsed.hostname = "host.docker.internal";
  return parsed.toString();
}

assert(
  image !== undefined && /^[a-z0-9][a-z0-9./:_-]{0,255}$/u.test(image),
  "A safe built-image tag is required",
);
assert(
  databaseUrl !== undefined && databaseUrl.length > 0,
  "CAPSTONE_LOAD_DATABASE_URL is required",
);
assert(
  authSecret !== undefined && authSecret.length >= 32,
  "CAPSTONE_LOAD_AUTH_SECRET must contain at least 32 characters",
);
assert(
  Number.isInteger(port) && port >= 1024 && port <= 65_535,
  "CAPSTONE_LOAD_PORT must be a non-privileged port",
);

const containerName = `capstone-chat-load-${process.pid}`;
const baseUrl = `http://127.0.0.1:${port}`;
const targetDatabaseUrl = containerDatabaseUrl(databaseUrl);

function docker(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "docker command failed";
    throw new Error(detail);
  }
  return result.stdout.trim();
}

function cleanup() {
  spawnSync("docker", ["rm", "--force", containerName], { encoding: "utf8" });
}

async function waitForReadiness() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health/ready`, {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // The built process is expected to refuse connections briefly during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The constrained load container did not become ready within 30 seconds");
}

let containerStarted = false;
try {
  docker(
    [
      "run",
      "--detach",
      "--init",
      "--name",
      containerName,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--cpus",
      candidateCpu,
      "--memory",
      candidateMemory,
      "--memory-swap",
      candidateMemory,
      "--pids-limit",
      "256",
      "--publish",
      `127.0.0.1:${port}:${port}`,
      "--env",
      "DATABASE_URL",
      "--env",
      "BETTER_AUTH_SECRET",
      "--env",
      "NODE_ENV=test",
      "--env",
      "HOST=0.0.0.0",
      "--env",
      "CLIENT_ADDRESS_SOURCE=socket",
      "--env",
      `PORT=${port}`,
      "--env",
      `PUBLIC_ORIGIN=${baseUrl}`,
      "--env",
      "MODEL_GATEWAY=openrouter",
      "--env",
      "OPENROUTER_API_KEY=load-rehearsal-placeholder",
      "--env",
      "EMAIL_DELIVERY=fake",
      "--env",
      "LOG_LEVEL=warn",
      "--env",
      "DEPLOYMENT_REVISION=phase8-container-load",
      "--entrypoint",
      "node",
      image,
      "--expose-gc",
      "apps/api/dist/load/load-server.js",
      "--confirm-isolated-load-rehearsal",
    ],
    {
      env: {
        ...process.env,
        BETTER_AUTH_SECRET: authSecret,
        DATABASE_URL: targetDatabaseUrl,
      },
    },
  );
  containerStarted = true;
  const limits = docker([
    "inspect",
    "--format",
    "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.Config.User}}",
    containerName,
  ]);
  assert(
    limits === "1000000000 1073741824 1073741824 256 node",
    "Docker did not apply the selected App Platform candidate limits",
  );
  await waitForReadiness();

  const rehearsal = spawnSync(
    "pnpm",
    [
      "--filter",
      "@capstone/api",
      "load:test",
      "--target",
      baseUrl,
      "--waves",
      "5",
      "--confirm-isolated-database",
      "--confirm-non-production",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CAPSTONE_LOAD_AUTH_SECRET: authSecret },
      timeout: 10 * 60 * 1_000,
    },
  );
  if (rehearsal.stdout.length > 0) {
    process.stdout.write(rehearsal.stdout);
  }
  if (rehearsal.stderr.length > 0) {
    process.stderr.write(rehearsal.stderr);
  }
  if (rehearsal.status !== 0) {
    throw new Error("The constrained built-container load rehearsal failed");
  }
  process.stdout.write(
    `Built-container load rehearsal passed at ${candidateCpu} CPU and ${candidateMemory} RAM.\n`,
  );
} catch (error) {
  if (containerStarted) {
    const logs = spawnSync("docker", ["logs", "--tail", "100", containerName], {
      encoding: "utf8",
    });
    if (logs.status === 0 && logs.stdout.trim().length > 0) {
      process.stderr.write(`${logs.stdout.trim()}\n`);
    }
  }
  throw error;
} finally {
  if (containerStarted) {
    cleanup();
  }
}
