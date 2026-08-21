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

const [imageArgument, revision] = process.argv.slice(2).filter((argument) => argument !== "--");
const image = validateImage(imageArgument, "A safe image tag is required");
assert(
  revision !== undefined && /^[0-9a-f]{40}$/u.test(revision),
  "A full lowercase revision is required",
);
const port = validatePort(
  process.env.CAPSTONE_CONTAINER_SMOKE_PORT ?? "3099",
  "CAPSTONE_CONTAINER_SMOKE_PORT",
);
const databaseUrl = loopbackDatabaseUrl(
  process.env.DATABASE_URL,
  "DATABASE_URL",
  "The automated container smoke",
);

const containerName = `capstone-chat-smoke-${process.pid}`;
const entrypointContainerName = `capstone-chat-entrypoint-smoke-${process.pid}`;
const baseUrl = `http://127.0.0.1:${port}`;
const testEnvironment = Object.freeze({ DATABASE_URL: undefined, NODE_ENV: "test" });
const processEnvironment = { ...process.env, DATABASE_URL: databaseUrl };
const applicationBootstrap = `
  import { loadConfig } from "./apps/api/dist/config.js";
  import { installShutdownHandlers, startServer } from "./apps/api/dist/start.js";
  const base = loadConfig(process.env);
  const config = Object.freeze({ ...base, webAssetsDirectory: "/app/apps/web/dist" });
  const application = await startServer(config);
  installShutdownHandlers(application);
  await new Promise(() => {});
`;

function runTestOperator(command, environment = {}) {
  runContainer({
    image,
    remove: true,
    hostDatabase: true,
    environment: { ...testEnvironment, ...environment },
    entrypoint: "node",
    command: ["apps/api/dist/entrypoint.js", ...command],
    processEnvironment,
  });
}

async function waitForInternalHealth(path, expectedStatus) {
  const probe = `
    const response = await fetch("http://127.0.0.1:3000${path}");
    const body = await response.json();
    if (
      response.status !== 200 ||
      response.headers.get("x-capstone-revision") !== ${JSON.stringify(revision)} ||
      body.status !== ${JSON.stringify(expectedStatus)}
    ) process.exit(1);
  `;
  await waitUntil(() => {
    docker(["exec", entrypointContainerName, "node", "--input-type=module", "--eval", probe]);
    return true;
  }, `The image entrypoint did not serve ${path} within 30 seconds`);
}

async function response(path) {
  return fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
}

function assertSecurityHeaders(response_) {
  assert(
    response_.headers.get("content-security-policy")?.includes("default-src 'self'"),
    "CSP header is missing",
  );
  assert(
    response_.headers.get("x-content-type-options") === "nosniff",
    "nosniff header is missing",
  );
  assert(response_.headers.get("referrer-policy") === "no-referrer", "referrer policy is missing");
  assert(response_.headers.has("permissions-policy"), "permissions policy is missing");
}

let containerStarted = false;
try {
  runContainer({
    image,
    name: entrypointContainerName,
    detach: true,
    environment: {
      CAPSTONE_ENVIRONMENT: "production",
      HOST: "0.0.0.0",
      NODE_ENV: "production",
      PORT: "3000",
      DEPLOYMENT_REVISION: revision,
    },
    entrypoint: "node",
    command: ["apps/api/dist/entrypoint.js", "health-bootstrap"],
  });
  await waitForInternalHealth("/api/health/ready", "ready");
  docker([
    "exec",
    entrypointContainerName,
    "node",
    "--input-type=module",
    "--eval",
    `const response = await fetch("http://127.0.0.1:3000/api/session"); if (response.status !== 404) process.exit(1);`,
  ]);
  forceRemove(entrypointContainerName);

  runTestOperator(["migrate"]);
  runTestOperator(
    [
      "identity",
      "bootstrap",
      "--workspace",
      "container-smoke",
      "--name",
      "Capstone container smoke",
      "--email",
      "administrator@container-smoke.test",
      "--invitation-delivery",
      "disabled",
    ],
    { EMAIL_DELIVERY: "disabled" },
  );
  runTestOperator([
    "model",
    "bootstrap",
    "--mode",
    "simulated",
    "--workspace",
    "container-smoke",
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
  ]);

  runContainer({
    image,
    name: entrypointContainerName,
    detach: true,
    hostDatabase: true,
    environment: {
      ...testEnvironment,
      HOST: "127.0.0.1",
      PORT: "3000",
      PUBLIC_ORIGIN: "http://localhost:3000",
      EMAIL_DELIVERY: "fake",
      MODEL_GATEWAY: "fake",
      LOG_LEVEL: "silent",
      DEPLOYMENT_REVISION: revision,
    },
    processEnvironment,
  });
  // The image's unmodified default command must pass deployment's authority readiness gate.
  await waitForInternalHealth("/api/health/ready", "ready");
  forceRemove(entrypointContainerName);

  runContainer({
    image,
    name: containerName,
    detach: true,
    hostDatabase: true,
    publish: `127.0.0.1:${port}:${port}`,
    environment: {
      ...testEnvironment,
      HOST: "0.0.0.0",
      PORT: String(port),
      PUBLIC_ORIGIN: baseUrl,
      BETTER_AUTH_SECRET: "capstone-chat-container-smoke-auth-secret",
      MODEL_GATEWAY: "fake",
      EMAIL_DELIVERY: "fake",
      LOG_LEVEL: "silent",
      DEPLOYMENT_REVISION: revision,
    },
    entrypoint: "node",
    command: ["--input-type=module", "--eval", applicationBootstrap],
    processEnvironment,
  });
  containerStarted = true;

  let readiness;
  await waitUntil(async () => {
    readiness = await response("/api/health/ready");
    return readiness.status === 200;
  }, "The built container did not become ready within 30 seconds");
  assert(readiness.headers.get("cache-control") === "no-store", "readiness must not be cached");
  assert(
    readiness.headers.get("x-capstone-revision") === revision,
    "readiness revision does not match the image",
  );
  assert((await readiness.json()).status === "ready", "readiness response is not ready");

  const shell = await response("/");
  const shellBody = await shell.text();
  assert(shell.status === 200, "SPA root did not return 200");
  assert(shell.headers.get("cache-control") === "no-cache", "index.html must not be cached");
  assert(shell.headers.get("content-type")?.startsWith("text/html"), "SPA root is not HTML");
  assertSecurityHeaders(shell);

  const scriptPath = /<script[^>]+src="([^"]+\.js)"/u.exec(shellBody)?.[1];
  assert(scriptPath !== undefined, "index.html does not reference an emitted JavaScript asset");
  const asset = await response(scriptPath);
  assert(asset.status === 200, "fingerprinted JavaScript asset did not return 200");
  assert(
    asset.headers.get("cache-control") === "public, max-age=31536000, immutable",
    "fingerprinted JavaScript must be immutable",
  );
  assert(asset.headers.get("content-type")?.includes("javascript"), "JavaScript MIME is incorrect");
  assertSecurityHeaders(asset);

  const unknownApi = await response("/api/container-smoke-unknown");
  assert(unknownApi.status === 404, "unknown API route did not return 404");
  assert(unknownApi.headers.get("cache-control") === "no-store", "unknown API must not be cached");
  assert((await unknownApi.json()).code === "NOT_FOUND", "unknown API returned the wrong error");

  process.stdout.write(`Built container smoke passed for ${image} at ${revision}.\n`);
} catch (error) {
  if (containerStarted) printContainerLogs(containerName);
  throw error;
} finally {
  forceRemove(containerName, entrypointContainerName);
}
