import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireDevelopmentPort,
  assertLocalDatabaseName,
  assertLocalDockerEndpoint,
  buildDevelopmentEnvironment,
  databaseNameFor,
  installTerminationForwarding,
  parseComposePort,
  parseComposeService,
  parseDevelopmentArguments,
  requiresOpenRouterBootstrap,
  runProcess,
} from "./development.mjs";

test("derives stable isolated database names by worktree and profile", () => {
  const fake = databaseNameFor("/workspace/capstone", "fake");
  assert.equal(fake, databaseNameFor("/workspace/capstone", "fake"));
  assert.notEqual(fake, databaseNameFor("/workspace/capstone-copy", "fake"));
  assert.notEqual(fake, databaseNameFor("/workspace/capstone", "openrouter"));
  assert.match(fake, /^capstone_dev_[a-f0-9]{12}_fake$/u);
  assert.equal(assertLocalDatabaseName(fake), fake);
  assert.throws(() => assertLocalDatabaseName("capstone_chat"), /managed local boundary/u);
});

test("accepts only the documented development command shapes", () => {
  assert.deepEqual(parseDevelopmentArguments(["fake"]), {
    command: "fake",
    privacyAttestationPath: null,
  });
  assert.deepEqual(
    parseDevelopmentArguments(["openrouter", "--", "--privacy-attestation", "/tmp/privacy.json"]),
    { command: "openrouter", privacyAttestationPath: "/tmp/privacy.json" },
  );
  assert.deepEqual(
    parseDevelopmentArguments([
      "reset",
      "--",
      "--profile",
      "openrouter",
      "--confirm-local-data-loss",
    ]),
    { command: "reset", profile: "openrouter" },
  );
  assert.throws(
    () => parseDevelopmentArguments(["reset", "--profile", "fake"]),
    /confirm-local-data-loss/u,
  );
  assert.throws(() => parseDevelopmentArguments(["fake", "--unsafe"]), /accepts no arguments/u);
});

test("constructs a provider-free fake environment from conflicting input", () => {
  const environment = buildDevelopmentEnvironment(
    {
      CAPSTONE_SECRET_FILE: "/tmp/recovery.env",
      EMAIL_DELIVERY: "resend",
      MODEL_GATEWAY: "openrouter",
      OPENROUTER_API_KEY: "secret-provider-key",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
      RESEND_API_KEY: "secret-email-key",
    },
    {
      apiPort: 3004,
      databaseUrl: "postgresql://local.invalid/database",
      profile: "fake",
      webPort: 5177,
    },
  );

  assert.equal(environment.CAPSTONE_ENVIRONMENT, "development");
  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.DATABASE_URL, "postgresql://local.invalid/database");
  assert.equal(environment.MODEL_GATEWAY, "fake");
  assert.equal(environment.EMAIL_DELIVERY, "fake");
  assert.equal(environment.OPENROUTER_API_KEY, "");
  assert.equal(environment.RESEND_API_KEY, "");
  assert.equal(environment.OTEL_EXPORTER_OTLP_ENDPOINT, "");
  assert.equal(environment.CAPSTONE_SECRET_FILE, "");
  assert.equal(environment.PORT, "3004");
  assert.equal(environment.CAPSTONE_WEB_PORT, "5177");
  assert.equal(environment.PUBLIC_ORIGIN, "http://127.0.0.1:5177");
});

test("waits for captured pipes to close after the direct child exits", async () => {
  const delayedWriter = `setTimeout(() => process.stdout.write("late-output"), 100)`;
  const parent = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["--eval", ${JSON.stringify(delayedWriter)}], {
      stdio: ["ignore", 1, 2],
    });
    child.unref();
  `;

  assert.equal(
    await runProcess(process.execPath, ["--eval", parent], { capture: true }),
    "late-output",
  );
});

test("handles an early child stdin closure as a normal development failure", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["--eval", "process.stdin.destroy(); process.exit(0)"], {
      input: Buffer.alloc(8 * 1_024 * 1_024),
      label: "Attestation probe",
    }),
    /Attestation probe input failed/u,
  );
});

test("requires a dedicated key only for the OpenRouter profile", () => {
  assert.throws(
    () =>
      buildDevelopmentEnvironment(
        {},
        {
          apiPort: 3000,
          databaseUrl: "postgresql://local.invalid/database",
          profile: "openrouter",
          webPort: 5173,
        },
      ),
    /dedicated development OPENROUTER_API_KEY/u,
  );
  const environment = buildDevelopmentEnvironment(
    { OPENROUTER_API_KEY: "development-only-key" },
    {
      apiPort: 3000,
      databaseUrl: "postgresql://local.invalid/database",
      profile: "openrouter",
      webPort: 5173,
    },
  );
  assert.equal(environment.MODEL_GATEWAY, "openrouter");
  assert.equal(environment.OPENROUTER_API_KEY, "development-only-key");
});

test("requires an attestation only for first-time OpenRouter bootstrap", () => {
  assert.equal(requiresOpenRouterBootstrap(0, "/tmp/privacy.json"), true);
  assert.equal(requiresOpenRouterBootstrap(1, null), false);
  assert.throws(() => requiresOpenRouterBootstrap(0, null), /First OpenRouter setup/u);
  assert.throws(() => requiresOpenRouterBootstrap(-1, null), /policy state is invalid/u);
});

test("validates the exact loopback compose port", () => {
  assert.equal(parseComposePort("127.0.0.1:5434\n", 5434), 5434);
  assert.throws(() => parseComposePort("0.0.0.0:5434", 5434), /loopback-only/u);
  assert.throws(() => parseComposePort("127.0.0.1:5435", 5434), /loopback-only/u);
});

test("accepts only the fixed local Compose PostgreSQL service", () => {
  const expected = JSON.stringify({
    Health: "healthy",
    Image: "postgres:18.4-alpine",
    Project: "capstone-chat",
    Publishers: [{ Protocol: "tcp", PublishedPort: 5434, TargetPort: 5432, URL: "127.0.0.1" }],
    Service: "postgres",
    State: "running",
  });
  assert.deepEqual(parseComposeService(expected, 5434), {
    image: "postgres:18.4-alpine",
    project: "capstone-chat",
    service: "postgres",
  });
  assert.equal(
    assertLocalDockerEndpoint("unix:///var/run/docker.sock\n"),
    "unix:///var/run/docker.sock",
  );
  assert.throws(() => assertLocalDockerEndpoint("tcp://remote.example:2376"), /local Docker/u);
  assert.throws(
    () => parseComposeService(expected.replace("capstone-chat", "other-project"), 5434),
    /managed local Compose service/u,
  );
  assert.throws(
    () => parseComposeService(expected.replace('"URL":"127.0.0.1"', '"URL":"0.0.0.0"'), 5434),
    /managed local Compose service/u,
  );
});

test("fails on an occupied explicit port and selects a free candidate", async () => {
  const leaseFolder = await mkdtemp(join(tmpdir(), "capstone-port-test-"));
  const server = createServer();
  await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  await assert.rejects(
    acquireDevelopmentPort(String(port), [port], "CAPSTONE_API_PORT", leaseFolder),
    /already in use/u,
  );
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  const reservation = await acquireDevelopmentPort(
    undefined,
    [port],
    "CAPSTONE_API_PORT",
    leaseFolder,
  );
  assert.equal(reservation.port, port);
  const competingServer = createServer();
  await assert.rejects(
    new Promise((resolve, reject) => {
      competingServer.once("error", reject);
      competingServer.listen({ host: "127.0.0.1", port }, resolve);
    }),
    /EADDRINUSE/u,
  );
  await reservation.release();
  await rm(leaseFolder, { force: true, recursive: true });
});

function acquirePortInChild(leaseFolder, candidates) {
  const moduleUrl = new URL("./development.mjs", import.meta.url).href;
  const program = `
    import { acquireDevelopmentPort } from ${JSON.stringify(moduleUrl)};
    const reservation = await acquireDevelopmentPort(
      undefined,
      ${JSON.stringify(candidates)},
      "CAPSTONE_API_PORT",
      ${JSON.stringify(leaseFolder)},
    );
    process.stdout.write(String(reservation.port));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await reservation.release();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Port lease child failed: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolve(Number(Buffer.concat(stdout).toString("utf8")));
    });
  });
}

test("leases automatic ports atomically across development processes", async () => {
  const leaseFolder = await mkdtemp(join(tmpdir(), "capstone-port-concurrency-test-"));
  const candidates = Array.from({ length: 30 }, (_, index) => 31_000 + index);
  try {
    const [first, second] = await Promise.all([
      acquirePortInChild(leaseFolder, candidates),
      acquirePortInChild(leaseFolder, candidates),
    ]);
    assert.ok(candidates.includes(first));
    assert.ok(candidates.includes(second));
    assert.notEqual(first, second);
  } finally {
    await rm(leaseFolder, { force: true, recursive: true });
  }
});

test("forwards the first termination signal and removes both listeners", () => {
  const signalSource = new EventEmitter();
  const received = [];
  const child = {
    exitCode: null,
    kill(signal) {
      received.push(signal);
    },
    signalCode: null,
  };
  const forwarding = installTerminationForwarding(child, signalSource);

  signalSource.emit("SIGINT");
  signalSource.emit("SIGTERM");

  assert.deepEqual(received, ["SIGINT"]);
  assert.equal(forwarding.forwarded, true);
  forwarding.remove();
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});
