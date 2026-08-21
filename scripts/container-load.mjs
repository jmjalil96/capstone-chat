import { spawnSync } from "node:child_process";
import {
  assert,
  docker,
  forceRemove,
  loopbackDatabaseUrl,
  printContainerLogs,
  runContainer,
  validateImage,
  validatePort,
  waitUntil,
} from "./container-tools.mjs";

const [imageArgument] = process.argv.slice(2).filter((argument) => argument !== "--");
const image = validateImage(imageArgument);
const port = validatePort(process.env.CAPSTONE_LOAD_PORT ?? "3015", "CAPSTONE_LOAD_PORT");
const authSecret = process.env.CAPSTONE_LOAD_AUTH_SECRET;
const databaseUrl = loopbackDatabaseUrl(
  process.env.CAPSTONE_LOAD_DATABASE_URL,
  "CAPSTONE_LOAD_DATABASE_URL",
  "The container load check",
);
assert(
  authSecret !== undefined && authSecret.length >= 32,
  "CAPSTONE_LOAD_AUTH_SECRET must contain at least 32 characters",
);

const containerName = `capstone-chat-load-${process.pid}`;
const baseUrl = `http://127.0.0.1:${port}`;
const limits = Object.freeze({ cpu: "1", memory: "512m", inspection: "1000000000 536870912" });
let containerStarted = false;

try {
  runContainer({
    image,
    name: containerName,
    detach: true,
    hostDatabase: true,
    publish: `127.0.0.1:${port}:${port}`,
    dockerArguments: [
      "--cpus",
      limits.cpu,
      "--memory",
      limits.memory,
      "--memory-swap",
      limits.memory,
      "--pids-limit",
      "256",
    ],
    environment: {
      DATABASE_URL: undefined,
      BETTER_AUTH_SECRET: undefined,
      NODE_ENV: "test",
      HOST: "0.0.0.0",
      PORT: String(port),
      PUBLIC_ORIGIN: baseUrl,
      MODEL_GATEWAY: "openrouter",
      OPENROUTER_API_KEY: "local-load-placeholder",
      EMAIL_DELIVERY: "fake",
      LOG_LEVEL: "warn",
      DEPLOYMENT_REVISION: "local-container-load",
    },
    entrypoint: "node",
    command: [
      "--expose-gc",
      "apps/api/dist/load/local-load-server.js",
      "--confirm-isolated-local-load",
    ],
    processEnvironment: {
      ...process.env,
      BETTER_AUTH_SECRET: authSecret,
      DATABASE_URL: databaseUrl,
    },
  });
  containerStarted = true;

  const appliedLimits = docker([
    "inspect",
    "--format",
    "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.Config.User}}",
    containerName,
  ]);
  assert(
    appliedLimits === `${limits.inspection} 536870912 256 node`,
    "Docker did not apply the selected App Platform candidate limits",
  );
  await waitUntil(async () => {
    const response = await fetch(`${baseUrl}/api/health/ready`, {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    return response.status === 200;
  }, "The constrained load container did not become ready within 30 seconds");

  const loadRun = spawnSync(
    "pnpm",
    [
      "--filter",
      "@capstone/api",
      "load:driver",
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
  process.stdout.write(loadRun.stdout ?? "");
  process.stderr.write(loadRun.stderr ?? "");
  assert(loadRun.status === 0, "The constrained built-container load check failed");
  process.stdout.write(
    `Built-container load check passed at ${limits.cpu} CPU and ${limits.memory} RAM.\n`,
  );
} catch (error) {
  if (containerStarted) printContainerLogs(containerName);
  throw error;
} finally {
  if (containerStarted) forceRemove(containerName);
}
