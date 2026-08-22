import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDatabasePattern = /^capstone_dev_[a-f0-9]{12}_(?:fake|openrouter)$/u;
const profiles = new Set(["fake", "openrouter"]);
const defaultAdminEmail = "admin@example.test";
const maximumAttestationBytes = 32 * 1_024;
const defaultPortLeaseFolder = join(tmpdir(), "capstone-chat-development-ports-v1");
const incompletePortLeaseLifetimeMs = 30_000;
const composeArguments = Object.freeze([
  "compose",
  "--file",
  resolve(repositoryRoot, "compose.yaml"),
  "--project-name",
  "capstone-chat",
]);

function developmentError(message) {
  const error = new Error(message);
  error.name = "DevelopmentEnvironmentError";
  return error;
}

export function databaseNameFor(worktreePath, profile) {
  if (!profiles.has(profile)) {
    throw developmentError("Development profile must be fake or openrouter");
  }
  const digest = createHash("sha256").update(resolve(worktreePath)).digest("hex").slice(0, 12);
  return `capstone_dev_${digest}_${profile}`;
}

export function assertLocalDatabaseName(databaseName) {
  if (!localDatabasePattern.test(databaseName)) {
    throw developmentError("Refusing to operate on a database outside the managed local boundary");
  }
  return databaseName;
}

function integerPort(value, fallback, name) {
  const source = value?.trim() || String(fallback);
  if (!/^\d+$/u.test(source)) {
    throw developmentError(`${name} must be an integer from 1 to 65535`);
  }
  const port = Number(source);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw developmentError(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

async function reservePort(port) {
  return new Promise((resolveReservation, rejectReservation) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectReservation);
    server.listen({ host: "127.0.0.1", port }, () => resolveReservation(server));
  });
}

async function releaseReservation(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

function processIsAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function portIsAvailable(port) {
  let server;
  try {
    server = await reservePort(port);
  } catch {
    return false;
  }
  await releaseReservation(server);
  return true;
}

async function reclaimStalePortLease(leasePath, port) {
  let contents;
  let metadata;
  try {
    [contents, metadata] = await Promise.all([readFile(leasePath, "utf8"), stat(leasePath)]);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  let owner = null;
  try {
    owner = JSON.parse(contents);
  } catch {
    // A newly created lease can be observed before its metadata write completes.
  }
  if (
    owner !== null &&
    typeof owner === "object" &&
    Number.isSafeInteger(owner.processId) &&
    typeof owner.token === "string" &&
    owner.token.length > 0
  ) {
    if (processIsAlive(owner.processId)) {
      return false;
    }
  } else if (Date.now() - metadata.mtimeMs < incompletePortLeaseLifetimeMs) {
    return false;
  }
  if (!(await portIsAvailable(port))) {
    return false;
  }
  try {
    await rm(leasePath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function acquirePortLease(port, leaseFolder) {
  await mkdir(leaseFolder, { mode: 0o700, recursive: true });
  const leasePath = join(leaseFolder, `port-${port}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    let handle;
    let created = false;
    try {
      handle = await open(leasePath, "wx", 0o600);
      created = true;
      await handle.writeFile(JSON.stringify({ processId: process.pid, token }), "utf8");
      await handle.close();
      handle = undefined;
      return Object.freeze({ leasePath, token });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (created) {
        await rm(leasePath, { force: true });
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (attempt === 0 && (await reclaimStalePortLease(leasePath, port))) {
        continue;
      }
      return null;
    }
  }
  return null;
}

async function releasePortLease(lease) {
  let contents;
  try {
    contents = await readFile(lease.leasePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(contents);
  } catch {
    return;
  }
  if (owner?.token === lease.token) {
    await rm(lease.leasePath, { force: true });
  }
}

export async function acquireDevelopmentPort(
  explicitValue,
  candidates,
  name,
  leaseFolder = defaultPortLeaseFolder,
) {
  const explicit = explicitValue?.trim() ? integerPort(explicitValue, 0, name) : null;
  const ports = explicit === null ? candidates : [explicit];
  for (const port of ports) {
    const lease = await acquirePortLease(port, leaseFolder);
    if (lease === null) {
      continue;
    }
    let server;
    try {
      server = await reservePort(port);
    } catch {
      await releasePortLease(lease);
      if (explicit !== null) {
        throw developmentError(`${name} selects a port that is already in use`);
      }
      continue;
    }
    let reservationReleased = false;
    let leaseReleased = false;
    const releaseHeldReservation = async () => {
      if (!reservationReleased) {
        reservationReleased = true;
        await releaseReservation(server);
      }
    };
    const release = async () => {
      await releaseHeldReservation();
      if (!leaseReleased) {
        leaseReleased = true;
        await releasePortLease(lease);
      }
    };
    return Object.freeze({ port, release, releaseReservation: releaseHeldReservation });
  }
  if (explicit !== null) {
    throw developmentError(`${name} selects a port reserved by another development process`);
  }
  throw developmentError(`${name} has no available port in its managed range`);
}

export function parseComposePort(value, expectedPort) {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(value.trim());
  if (match === null || Number(match[1]) !== expectedPort) {
    throw developmentError("PostgreSQL is not exposed through the expected loopback-only port");
  }
  return expectedPort;
}

export function assertLocalDockerEndpoint(value) {
  const endpoint = value.trim();
  if (!/^(?:unix|npipe):\/\//u.test(endpoint)) {
    throw developmentError("Managed development requires a local Docker engine");
  }
  return endpoint;
}

export function parseComposeService(value, expectedPort) {
  let parsed;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    throw developmentError("Managed PostgreSQL service metadata is invalid");
  }
  const services = Array.isArray(parsed) ? parsed : [parsed];
  const service = services[0];
  const publishers = service?.Publishers;
  if (
    services.length !== 1 ||
    service?.Project !== "capstone-chat" ||
    service?.Service !== "postgres" ||
    service?.Image !== "postgres:18.4-alpine" ||
    service?.State !== "running" ||
    service?.Health !== "healthy" ||
    !Array.isArray(publishers) ||
    publishers.length !== 1 ||
    publishers[0]?.URL !== "127.0.0.1" ||
    publishers[0]?.TargetPort !== 5432 ||
    publishers[0]?.PublishedPort !== expectedPort ||
    publishers[0]?.Protocol !== "tcp"
  ) {
    throw developmentError("PostgreSQL does not match the managed local Compose service");
  }
  return Object.freeze({
    image: service.Image,
    project: service.Project,
    service: service.Service,
  });
}

export function parseDevelopmentArguments(values) {
  const [command, ...rawArguments] = values;
  const argumentsList = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  if (command === "fake") {
    if (argumentsList.length !== 0) {
      throw developmentError("The fake development profile accepts no arguments");
    }
    return Object.freeze({ command, privacyAttestationPath: null });
  }
  if (command === "openrouter") {
    if (argumentsList.length === 0) {
      return Object.freeze({ command, privacyAttestationPath: null });
    }
    if (
      argumentsList.length !== 2 ||
      argumentsList[0] !== "--privacy-attestation" ||
      !argumentsList[1]
    ) {
      throw developmentError("OpenRouter accepts only --privacy-attestation /absolute/path.json");
    }
    return Object.freeze({ command, privacyAttestationPath: argumentsList[1] });
  }
  if (command === "reset") {
    let profile = null;
    let confirmed = false;
    for (let index = 0; index < argumentsList.length; index += 1) {
      const argument = argumentsList[index];
      if (argument === "--confirm-local-data-loss" && !confirmed) {
        confirmed = true;
        continue;
      }
      if (argument === "--profile" && profile === null) {
        profile = argumentsList[index + 1] ?? null;
        index += 1;
        continue;
      }
      throw developmentError("Reset accepts only --profile and --confirm-local-data-loss");
    }
    if (!profiles.has(profile)) {
      throw developmentError("Reset requires --profile fake or --profile openrouter");
    }
    if (!confirmed) {
      throw developmentError("Reset requires --confirm-local-data-loss");
    }
    return Object.freeze({ command, profile });
  }
  throw developmentError("Development command must be fake, openrouter, or reset");
}

function sanitizedEnvironment(source, options) {
  const environment = {
    ...source,
    BETTER_AUTH_SECRET: "capstone-chat-local-auth-secret-not-for-production-use",
    CAPSTONE_BOOTSTRAP_DATABASE_URL: "",
    CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL: "",
    CAPSTONE_ENVIRONMENT: "development",
    CAPSTONE_INITIALIZATION_DOCUMENT: "",
    CAPSTONE_INITIALIZATION_SCHEMA_VERSION: "",
    CAPSTONE_SECRET_FILE: "",
    CAPSTONE_STAGING_EMAIL_RECIPIENTS: "",
    CAPSTONE_WEB_PORT: String(options.webPort),
    DATABASE_URL: options.databaseUrl,
    DEPLOYMENT_REVISION: "development",
    EMAIL_DELIVERY: "fake",
    EMAIL_FROM: "",
    HOST: "127.0.0.1",
    MODEL_GATEWAY: options.profile === "fake" ? "fake" : "openrouter",
    NODE_ENV: "development",
    OPENROUTER_API_KEY: options.profile === "fake" ? "" : (source.OPENROUTER_API_KEY?.trim() ?? ""),
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
    PORT: String(options.apiPort),
    PUBLIC_ORIGIN: `http://127.0.0.1:${options.webPort}`,
    RESEND_API_KEY: "",
  };
  return Object.fromEntries(Object.entries(environment).filter((entry) => entry[1] !== undefined));
}

export function buildDevelopmentEnvironment(source, options) {
  const environment = sanitizedEnvironment(source, options);
  if (options.profile === "openrouter" && !environment.OPENROUTER_API_KEY?.trim()) {
    throw developmentError("dev:openrouter requires a dedicated development OPENROUTER_API_KEY");
  }
  return Object.freeze(environment);
}

export function requiresOpenRouterBootstrap(policyCount, privacyAttestationPath) {
  if (!Number.isSafeInteger(policyCount) || policyCount < 0) {
    throw developmentError("Stored model policy state is invalid");
  }
  if (policyCount === 0 && privacyAttestationPath === null) {
    throw developmentError(
      "First OpenRouter setup requires --privacy-attestation /absolute/path.json",
    );
  }
  return policyCount === 0;
}

async function loadSourceEnvironment() {
  let fileValues = {};
  try {
    fileValues = parseEnv(await readFile(resolve(repositoryRoot, ".env"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return Object.freeze({ ...fileValues, ...process.env });
}

export function runProcess(command, argumentsList, options = {}) {
  const capture = options.capture === true;
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, argumentsList, {
      cwd: repositoryRoot,
      env: options.environment ?? process.env,
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    const stdout = [];
    const stderr = [];
    let inputError;
    let spawnError;
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdin?.once("error", (error) => {
      inputError = error;
    });
    child.once("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (spawnError !== undefined) {
        rejectProcess(spawnError);
        return;
      }
      if (inputError !== undefined) {
        rejectProcess(developmentError(`${options.label ?? command} input failed`));
        return;
      }
      if (code !== 0) {
        rejectProcess(
          developmentError(
            `${options.label ?? command} failed${signal === null ? "" : ` after ${signal}`}${
              capture && errorOutput.trim() ? ": command reported an error" : ""
            }`,
          ),
        );
        return;
      }
      resolveProcess(output);
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

function composeCommand(...argumentsList) {
  return [...composeArguments, ...argumentsList];
}

async function verifyLocalDocker(source) {
  if (source.DOCKER_HOST?.trim()) {
    throw developmentError("Managed development does not accept a DOCKER_HOST override");
  }
  const context = await runProcess("docker", ["context", "show"], {
    capture: true,
    environment: source,
    label: "Local Docker context verification",
  });
  const contextName = context.trim();
  if (!contextName || /[\r\n]/u.test(contextName)) {
    throw developmentError("Local Docker context is invalid");
  }
  const endpoint = await runProcess(
    "docker",
    ["context", "inspect", "--format", '{{ (index .Endpoints "docker").Host }}', contextName],
    {
      capture: true,
      environment: source,
      label: "Local Docker endpoint verification",
    },
  );
  assertLocalDockerEndpoint(endpoint);
}

async function verifyLoopbackConnection(port) {
  await new Promise((resolveConnection, rejectConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const reject = () => {
      socket.destroy();
      rejectConnection(developmentError("PostgreSQL loopback connection failed"));
    };
    socket.setTimeout(2_000, reject);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection();
    });
  });
}

async function startAndVerifyPostgres(source) {
  await verifyLocalDocker(source);
  const postgresPort = integerPort(source.CAPSTONE_POSTGRES_PORT, 5432, "CAPSTONE_POSTGRES_PORT");
  const composeEnvironment = { ...source, CAPSTONE_POSTGRES_PORT: String(postgresPort) };
  await runProcess("docker", composeCommand("up", "-d", "--wait", "postgres"), {
    environment: composeEnvironment,
    label: "Local PostgreSQL startup",
  });
  const service = await runProcess("docker", composeCommand("ps", "--format", "json", "postgres"), {
    capture: true,
    environment: composeEnvironment,
    label: "Local PostgreSQL service verification",
  });
  parseComposeService(service, postgresPort);
  const publishedPort = await runProcess("docker", composeCommand("port", "postgres", "5432"), {
    capture: true,
    environment: composeEnvironment,
    label: "Local PostgreSQL port verification",
  });
  parseComposePort(publishedPort, postgresPort);
  await verifyLoopbackConnection(postgresPort);
  const identity = await runProcess(
    "docker",
    composeCommand(
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "capstone",
      "--dbname",
      "postgres",
      "--no-align",
      "--tuples-only",
      "--quiet",
      "--command",
      "SELECT current_user || ':' || current_setting('server_version_num')",
    ),
    {
      capture: true,
      environment: composeEnvironment,
      label: "Local PostgreSQL identity verification",
    },
  );
  if (!/^capstone:18\d{4}$/u.test(identity.trim())) {
    throw developmentError("PostgreSQL does not match the managed local server identity");
  }
  return Object.freeze({ composeEnvironment, postgresPort });
}

function databaseUrl(databaseName, postgresPort) {
  const url = new URL("postgresql://capstone:capstone@127.0.0.1");
  url.port = String(postgresPort);
  url.pathname = `/${assertLocalDatabaseName(databaseName)}`;
  return url.toString();
}

async function psql(databaseName, statement, environment) {
  assertLocalDatabaseName(databaseName);
  return runProcess(
    "docker",
    composeCommand(
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "capstone",
      "--dbname",
      databaseName,
      "--no-align",
      "--tuples-only",
      "--quiet",
      "--command",
      statement,
    ),
    { capture: true, environment, label: "Managed local database query" },
  );
}

async function databaseExists(databaseName, environment) {
  const result = await runProcess(
    "docker",
    composeCommand(
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "capstone",
      "--dbname",
      "postgres",
      "--no-align",
      "--tuples-only",
      "--quiet",
      "--command",
      `SELECT 1 FROM pg_database WHERE datname = '${assertLocalDatabaseName(databaseName)}'`,
    ),
    { capture: true, environment, label: "Managed local database lookup" },
  );
  return result.trim() === "1";
}

async function ensureDatabase(databaseName, environment) {
  if (await databaseExists(databaseName, environment)) {
    return;
  }
  await runProcess(
    "docker",
    composeCommand("exec", "-T", "postgres", "createdb", "--username", "capstone", databaseName),
    { capture: true, environment, label: "Managed local database creation" },
  );
}

async function resetDatabase(databaseName, environment) {
  await runProcess(
    "docker",
    composeCommand(
      "exec",
      "-T",
      "postgres",
      "dropdb",
      "--username",
      "capstone",
      "--force",
      "--if-exists",
      databaseName,
    ),
    { capture: true, environment, label: "Managed local database reset" },
  );
  await runProcess(
    "docker",
    composeCommand("exec", "-T", "postgres", "createdb", "--username", "capstone", databaseName),
    { capture: true, environment, label: "Managed local database recreation" },
  );
}

async function modelPolicyCount(databaseName, environment) {
  const result = await psql(
    databaseName,
    "SELECT count(*)::integer FROM public.workspace_cost_policies",
    environment,
  );
  const count = Number(result.trim());
  if (!Number.isSafeInteger(count) || count < 0) {
    throw developmentError("Stored model policy state is invalid");
  }
  return count;
}

async function readPrivacyAttestation(filePath) {
  if (!isAbsolute(filePath)) {
    throw developmentError("Privacy attestation path must be absolute");
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumAttestationBytes) {
    throw developmentError("Privacy attestation must be a nonempty file of at most 32768 bytes");
  }
  const contents = await readFile(filePath);
  if (contents.length < 1 || contents.length > maximumAttestationBytes) {
    contents.fill(0);
    throw developmentError("Privacy attestation must be a nonempty file of at most 32768 bytes");
  }
  return contents;
}

const modelBootstrapArguments = [
  "model-policy:bootstrap",
  "--workspace",
  "capstone",
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
];

async function bootstrapLocalState(profile, input, databaseName, environment, composeEnvironment) {
  await runProcess(
    "pnpm",
    [
      "identity:bootstrap",
      "--workspace",
      "capstone",
      "--name",
      "Capstone",
      "--email",
      environment.CAPSTONE_DEV_ADMIN_EMAIL,
    ],
    { environment, label: "Local identity bootstrap" },
  );
  const policyCount = await modelPolicyCount(databaseName, composeEnvironment);
  if (policyCount === 0) {
    const mode = profile === "fake" ? "simulated" : "openrouter";
    let attestation = null;
    if (profile === "openrouter") {
      requiresOpenRouterBootstrap(policyCount, input.privacyAttestationPath);
      attestation = await readPrivacyAttestation(input.privacyAttestationPath);
    }
    try {
      await runProcess(
        "pnpm",
        [
          ...modelBootstrapArguments,
          "--mode",
          mode,
          ...(attestation === null ? [] : ["--privacy-attestation", "-"]),
        ],
        { environment, input: attestation ?? undefined, label: "Local model policy bootstrap" },
      );
    } finally {
      attestation?.fill(0);
    }
  } else if (profile === "openrouter" && input.privacyAttestationPath !== null) {
    const attestation = await readPrivacyAttestation(input.privacyAttestationPath);
    try {
      await runProcess(
        "pnpm",
        ["model-policy:attest", "--workspace", "capstone", "--privacy-attestation", "-"],
        { environment, input: attestation, label: "Local privacy attestation renewal" },
      );
    } finally {
      attestation.fill(0);
    }
  }
  await runProcess(
    "pnpm",
    ["model-policy:verify", "--mode", profile === "fake" ? "simulated" : "openrouter"],
    { environment, label: "Local model policy verification" },
  );
}

export function installTerminationForwarding(child, signalSource = process) {
  let forwarded = false;
  const forward = (signal) => {
    if (!forwarded && child.exitCode === null && child.signalCode === null) {
      forwarded = true;
      child.kill(signal);
    }
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  signalSource.once("SIGINT", interrupt);
  signalSource.once("SIGTERM", terminate);
  return Object.freeze({
    get forwarded() {
      return forwarded;
    },
    remove() {
      signalSource.removeListener("SIGINT", interrupt);
      signalSource.removeListener("SIGTERM", terminate);
    },
  });
}

async function superviseDevelopmentServers(environment, webPort, portReservations) {
  await Promise.all(portReservations.map((reservation) => reservation.releaseReservation()));
  const child = spawn(
    "pnpm",
    ["--parallel", "--filter", "@capstone/api", "--filter", "@capstone/web", "run", "dev"],
    { cwd: repositoryRoot, env: environment, stdio: "inherit" },
  );
  const forwarding = installTerminationForwarding(child);
  process.stdout.write(`\nCapstone Chat: http://127.0.0.1:${webPort}\n`);
  process.stdout.write(`Registro local: http://127.0.0.1:${webPort}/sign-up\n`);
  process.stdout.write(`Buzón local: http://127.0.0.1:${webPort}/api/dev/mailbox\n\n`);
  await new Promise((resolveChild, rejectChild) => {
    child.once("error", (error) => {
      forwarding.remove();
      rejectChild(error);
    });
    child.once("exit", (code) => {
      forwarding.remove();
      if (code !== 0 && !forwarding.forwarded) {
        rejectChild(developmentError("Development servers exited unexpectedly"));
        return;
      }
      resolveChild();
    });
  });
}

async function runDevelopment(input, source) {
  const profile = input.command;
  const worktreePath = await realpath(repositoryRoot);
  const databaseName = databaseNameFor(worktreePath, profile);
  const postgres = await startAndVerifyPostgres(source);
  await ensureDatabase(databaseName, postgres.composeEnvironment);
  const apiReservation = await acquireDevelopmentPort(
    source.CAPSTONE_API_PORT,
    Array.from({ length: 30 }, (_, index) => 3000 + index),
    "CAPSTONE_API_PORT",
  );
  let webReservation;
  try {
    webReservation = await acquireDevelopmentPort(
      source.CAPSTONE_WEB_PORT,
      Array.from({ length: 27 }, (_, index) => 5173 + index),
      "CAPSTONE_WEB_PORT",
    );
  } catch (error) {
    await apiReservation.release();
    throw error;
  }
  const reservations = [apiReservation, webReservation];
  try {
    const apiPort = apiReservation.port;
    const webPort = webReservation.port;
    const adminEmail = source.CAPSTONE_DEV_ADMIN_EMAIL?.trim() || defaultAdminEmail;
    const environment = buildDevelopmentEnvironment(
      { ...source, CAPSTONE_DEV_ADMIN_EMAIL: adminEmail },
      {
        apiPort,
        databaseUrl: databaseUrl(databaseName, postgres.postgresPort),
        profile,
        webPort,
      },
    );
    await runProcess("pnpm", ["--filter", "@capstone/protocol", "build"], {
      environment,
      label: "Protocol build",
    });
    try {
      await runProcess("pnpm", ["db:migrate"], { environment, label: "Verified migration" });
    } catch (error) {
      process.stderr.write(
        `Migration failed. Preflight rejection applies no DDL; post-apply verification may follow committed migrations. No automatic repair or deletion ran. To discard only this local profile, run:\n` +
          `pnpm dev:reset -- --profile ${profile} --confirm-local-data-loss\n`,
      );
      throw error;
    }
    await bootstrapLocalState(
      profile,
      input,
      databaseName,
      environment,
      postgres.composeEnvironment,
    );
    await superviseDevelopmentServers(environment, webPort, reservations);
  } finally {
    await Promise.all(reservations.map((reservation) => reservation.release()));
  }
}

async function runReset(input, source) {
  const worktreePath = await realpath(repositoryRoot);
  const databaseName = databaseNameFor(worktreePath, input.profile);
  assertLocalDatabaseName(databaseName);
  const postgres = await startAndVerifyPostgres(source);
  await resetDatabase(databaseName, postgres.composeEnvironment);
  process.stdout.write(`Reset the isolated ${input.profile} development database.\n`);
}

async function main() {
  const input = parseDevelopmentArguments(process.argv.slice(2));
  const source = await loadSourceEnvironment();
  if (input.command === "reset") {
    await runReset(input, source);
    return;
  }
  await runDevelopment(input, source);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const known = error instanceof Error && error.name === "DevelopmentEnvironmentError";
    process.stderr.write(
      `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", ...(known ? { message: error.message } : {}), outcome: "failed" })}\n`,
    );
    process.exitCode = 1;
  });
}
