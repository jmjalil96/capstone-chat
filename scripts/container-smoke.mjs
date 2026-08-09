import { spawnSync } from "node:child_process";

const [image, revision] = process.argv.slice(2).filter((argument) => argument !== "--");
const databaseUrl = process.env.DATABASE_URL;
const portValue = process.env.CAPSTONE_CONTAINER_SMOKE_PORT ?? "3099";
const port = Number(portValue);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function databaseUrlForContainer(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid loopback PostgreSQL URL");
  }
  assert(
    parsed.protocol === "postgresql:" || parsed.protocol === "postgres:",
    "DATABASE_URL must use PostgreSQL",
  );
  assert(
    ["127.0.0.1", "localhost"].includes(parsed.hostname),
    "The automated container smoke accepts only a loopback test database",
  );
  parsed.hostname = "host.docker.internal";
  return parsed.toString();
}

assert(
  image !== undefined && /^[a-z0-9][a-z0-9./:_-]{0,255}$/u.test(image),
  "A safe image tag is required",
);
assert(
  revision !== undefined && /^[0-9a-f]{40}$/u.test(revision),
  "A full lowercase revision is required",
);
assert(
  databaseUrl !== undefined && databaseUrl.length > 0,
  "DATABASE_URL is required for the container smoke",
);
assert(
  Number.isInteger(port) && port >= 1024 && port <= 65_535,
  "CAPSTONE_CONTAINER_SMOKE_PORT must be a non-privileged port",
);

const containerName = `capstone-chat-smoke-${process.pid}`;
const baseUrl = `http://127.0.0.1:${port}`;
const containerDatabaseUrl = databaseUrlForContainer(databaseUrl);
const bootstrap = `
  import { loadConfig } from "./apps/api/dist/config.js";
  import { installShutdownHandlers, startServer } from "./apps/api/dist/start.js";
  const base = loadConfig(process.env);
  const config = Object.freeze({ ...base, webAssetsDirectory: "/app/apps/web/dist" });
  const application = await startServer(config);
  installShutdownHandlers(application);
  await new Promise(() => {});
`;

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

async function response(path) {
  return fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
}

async function waitForReadiness() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const candidate = await response("/api/health/ready");
      if (candidate.status === 200) {
        return candidate;
      }
    } catch {
      // Startup is expected to refuse connections briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The built container did not become ready within 30 seconds");
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
  docker(
    [
      "run",
      "--detach",
      "--init",
      "--name",
      containerName,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--publish",
      `127.0.0.1:${port}:${port}`,
      "--env",
      "DATABASE_URL",
      "--env",
      "NODE_ENV=test",
      "--env",
      "HOST=0.0.0.0",
      "--env",
      `PORT=${port}`,
      "--env",
      `PUBLIC_ORIGIN=${baseUrl}`,
      "--env",
      "BETTER_AUTH_SECRET=capstone-chat-container-smoke-auth-secret",
      "--env",
      "MODEL_GATEWAY=fake",
      "--env",
      "EMAIL_DELIVERY=fake",
      "--env",
      "LOG_LEVEL=silent",
      "--env",
      `DEPLOYMENT_REVISION=${revision}`,
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "--eval",
      bootstrap,
    ],
    {
      env: { ...process.env, DATABASE_URL: containerDatabaseUrl },
    },
  );
  containerStarted = true;

  const readiness = await waitForReadiness();
  assert(readiness.headers.get("cache-control") === "no-store", "readiness must not be cached");
  assert((await readiness.json()).status === "ready", "readiness response is not ready");

  const shell = await response("/");
  const shellBody = await shell.text();
  assert(shell.status === 200, "SPA root did not return 200");
  assert(shell.headers.get("cache-control") === "no-cache", "index.html must not be cached");
  assert(shell.headers.get("content-type")?.startsWith("text/html"), "SPA root is not HTML");
  assertSecurityHeaders(shell);

  const navigation = await response("/conversations/container-smoke");
  assert(navigation.status === 200, "SPA navigation did not return the application shell");
  assert(
    navigation.headers.get("cache-control") === "no-cache",
    "SPA navigation must not be cached",
  );
  assert((await navigation.text()) === shellBody, "SPA navigation returned different HTML");

  const scriptPath = /<script[^>]+src="([^"]+\.js)"/u.exec(shellBody)?.[1];
  assert(scriptPath !== undefined, "index.html does not reference an emitted JavaScript asset");
  const asset = await response(scriptPath);
  assert(asset.status === 200, "fingerprinted JavaScript asset did not return 200");
  assert(
    asset.headers.get("cache-control") === "public, max-age=31536000, immutable",
    "fingerprinted JavaScript must be immutable",
  );
  assert(
    asset.headers.get("content-type")?.includes("javascript"),
    "JavaScript MIME type is incorrect",
  );
  assertSecurityHeaders(asset);

  const unknownApi = await response("/api/container-smoke-unknown");
  assert(unknownApi.status === 404, "unknown API route did not return 404");
  assert(
    unknownApi.headers.get("cache-control") === "no-store",
    "unknown API route must not be cached",
  );
  assert(
    (await unknownApi.json()).code === "NOT_FOUND",
    "unknown API route did not return the stable error",
  );

  const missingFile = await response("/container-smoke-missing.js");
  assert(missingFile.status === 404, "missing static file did not return 404");
  assert(
    !missingFile.headers.get("content-type")?.startsWith("text/html"),
    "missing static file incorrectly returned the SPA shell",
  );

  const buildMetadata = await response("/.vite/manifest.json");
  assert(buildMetadata.status === 404, "private build metadata was publicly served");
  assert(
    !buildMetadata.headers.get("content-type")?.startsWith("text/html"),
    "private build metadata incorrectly returned the SPA shell",
  );

  process.stdout.write(`Built container smoke passed for ${image} at ${revision}.\n`);
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
