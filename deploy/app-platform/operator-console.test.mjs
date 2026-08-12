import assert from "node:assert/strict";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readContract, renderSpec } from "./contract.mjs";
import {
  buildConsoleInput,
  readOperatorDocument,
  runExecSession,
  runOperatorConsole,
  validateConsoleResult,
} from "./operator-console.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = "jmjalil96/capstone-chat";
const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const deploymentId = "deployment-configured-active";
const revision = "1".repeat(40);
const digest = `sha256:${"2".repeat(64)}`;
const defaultHostname = "capstone-chat-fixture.ondigitalocean.app";
const contract = readContract(path.join(directory, "app.contract.yaml"), "live");

function liveApp() {
  const spec = renderSpec({
    contract,
    digest,
    generalInput: {
      components: { "capstone-chat": { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net" } },
      schema: 1,
    },
    generalMode: "introduce",
    liveApp: { default_ingress: `https://${defaultHostname}`, spec: {} },
    registryInput: {
      components: {
        "capstone-chat": { registry_credentials: "fixture:registry-token-value" },
        "capstone-migrate": { registry_credentials: "fixture:registry-token-value" },
      },
      schema: 1,
    },
    registryMode: "introduce",
    revision,
    secretInput: {
      components: {
        "capstone-chat": Object.fromEntries(
          contract.service.environment.secret_keys.map((key) => [
            key,
            key === "OTEL_EXPORTER_OTLP_ENDPOINT"
              ? "https://otlp.nr-data.net"
              : `fixture-${key}-value`,
          ]),
        ),
        "capstone-migrate": Object.fromEntries(
          contract.job.environment.secret_keys.map((key) => [key, `fixture-${key}-value`]),
        ),
      },
      schema: 1,
    },
    secretMode: "introduce",
  });
  for (const component of [...spec.services, ...spec.jobs]) {
    component.image.registry_credentials = `EV[1:${component.name.repeat(8)}]`;
    for (const entry of component.envs) {
      if (entry.type === "SECRET") entry.value = `EV[1:${entry.key.repeat(3)}]`;
    }
  }
  spec.domains.push({ domain: defaultHostname, type: "DEFAULT" });
  return {
    active_deployment: { id: deploymentId },
    dedicated_ips: [
      { ip: "192.0.2.10", status: "ASSIGNED" },
      { ip: "192.0.2.11", status: "ASSIGNED" },
    ],
    default_ingress: `https://${defaultHostname}`,
    id: appId,
    in_progress_deployment: null,
    spec,
    updated_at: "2026-08-11T00:00:00Z",
  };
}

const document = Buffer.from('{"schema":1,"private":"fixture"}\n', "utf8");
const consoleInput = buildConsoleInput({ document, operation: "invite-initial", revision });
const consoleText = consoleInput.toString("utf8");
assert.match(consoleText, /test "\$\(id -u\)" = 1000/u);
assert.match(consoleText, /DEPLOYMENT_REVISION/u);
assert.match(
  Buffer.from(consoleText.match(/printf '%s' '([^']+)' \| base64 -d/u)[1], "base64").toString(
    "utf8",
  ),
  /production_initialization/u,
);
assert.match(consoleText, /CAPSTONE_OPERATOR_DOCUMENT/u);
assert.doesNotMatch(consoleText, /"private":"fixture"/u);
assert.doesNotMatch(consoleText, /printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d \| node apps/u);
assert.ok(
  consoleText.split("\n").every((line) => Buffer.byteLength(line, "utf8") <= 2_048),
  "Console input exceeded the reviewed canonical-TTY line bound",
);
const maximumConsoleInput = buildConsoleInput({
  document: Buffer.alloc(32 * 1024, 0x61),
  operation: "invite-initial",
  revision,
});
assert.ok(
  maximumConsoleInput
    .toString("utf8")
    .split("\n")
    .every((line) => Buffer.byteLength(line, "utf8") <= 2_048),
  "Maximum operator document produced an unsafe canonical-TTY line",
);
maximumConsoleInput.fill(0);

assert.deepEqual(await readOperatorDocument(Readable.from([document])), document);
await assert.rejects(
  readOperatorDocument(Readable.from([Buffer.alloc(32 * 1024 + 1)])),
  /exceeds 32 KiB/u,
);
await assert.rejects(readOperatorDocument(Readable.from([Buffer.from([0xff])])), /not UTF-8/u);

validateConsoleResult("invite-initial", {
  command: "invite-initial",
  outcome: "sent",
  retrySafe: true,
});
validateConsoleResult(
  "privacy-attest",
  { command: "attest", repeated: false, workspace: "capstone" },
  "capstone",
);
assert.throws(
  () => validateConsoleResult("invite-initial", { command: "invite-initial" }),
  /schema changed/u,
);
assert.throws(
  () =>
    validateConsoleResult(
      "privacy-attest",
      { command: "invite-initial", outcome: "sent", retrySafe: true },
      "capstone",
    ),
  /schema changed/u,
);

function fixture({ instances, mutateSecondApp = false } = {}) {
  const app = liveApp();
  let appReads = 0;
  let requestedExec;
  return {
    digitalOceanClient: {
      getApp: async () => {
        appReads += 1;
        return structuredClone(
          mutateSecondApp && appReads === 2
            ? { ...app, active_deployment: { id: "deployment-drifted" } }
            : app,
        );
      },
      getHealth: async () => ({
        components: [
          {
            name: "capstone-chat",
            replicas_desired: 1,
            replicas_ready: 1,
            state: "HEALTHY",
          },
        ],
      }),
      listInstances: async () =>
        instances ?? [
          {
            component_name: "capstone-chat",
            component_type: "SERVICE",
            instance_name: "capstone-chat-12345678",
          },
        ],
      getExecUrl: async (...argumentsValue) => {
        requestedExec = argumentsValue;
        return "wss://exec.digitalocean.invalid/session?token=fixture-token";
      },
    },
    githubClient: {
      getMainHead: async () => revision,
      listAcceptedReleases: async () => [
        {
          digest,
          digitalOceanAppId: appId,
          digitalOceanDeploymentId: "deployment-original-release",
          revision,
        },
      ],
    },
    get requestedExec() {
      return requestedExec;
    },
  };
}

function successfulWebSocketFactory(sent) {
  return () => {
    const listeners = new Map();
    const socket = {
      addEventListener(name, listener) {
        listeners.set(name, listener);
      },
      close() {
        queueMicrotask(() => listeners.get("close")({ code: 1000 }));
      },
      send(value) {
        sent.push(JSON.parse(value));
        if (sent.length === 1) {
          queueMicrotask(() =>
            listeners.get("message")({
              data: JSON.stringify({ data: "setup echoed\r\nCAPSTONE_CONSOLE_READY\r\n" }),
            }),
          );
        } else {
          queueMicrotask(() => {
            listeners.get("message")({
              data: JSON.stringify({
                data: 'CAPSTONE_OPERATOR_OUTPUT_BEGIN\r\n{"command":"invite-initial","outcome":"sent","retrySafe":true}\r\nCAPSTONE_OPERATOR_EXIT:0\r\n',
              }),
            });
            listeners.get("close")({ code: 1000 });
          });
        }
      },
    };
    queueMicrotask(() => listeners.get("open")());
    return socket;
  };
}

{
  const sent = [];
  const input = Buffer.from("private-input", "utf8");
  const result = await runExecSession({
    input,
    url: "wss://exec.digitalocean.invalid/session?token=fixture-token",
    webSocketFactory: successfulWebSocketFactory(sent),
  });
  assert.equal(result.command, "invite-initial");
  assert.match(sent[0].data, /stty -echo && PS1=''/u);
  assert.doesNotMatch(sent[0].data, /private-input/u);
  assert.equal(sent[1].data, "private-input");
  assert.deepEqual(input, Buffer.alloc("private-input".length));
}

{
  const input = Buffer.from("private-input", "utf8");
  await assert.rejects(
    runExecSession({
      input,
      url: "wss://proxy-apps-prod-ric-001.ondigitalocean.app/?token=fixture-token",
      webSocketFactory: () => {
        throw new Error("fixture constructor failure");
      },
    }),
    /constructor failure/u,
  );
  assert.deepEqual(input, Buffer.alloc("private-input".length));
}

{
  const sent = [];
  const socketFactory = () => {
    const listeners = new Map();
    const socket = {
      addEventListener(name, listener) {
        listeners.set(name, listener);
      },
      close() {},
      send(value) {
        sent.push(JSON.parse(value));
        queueMicrotask(() => listeners.get("close")({ code: 1000 }));
      },
    };
    queueMicrotask(() => listeners.get("open")());
    return socket;
  };
  await assert.rejects(
    runExecSession({
      input: Buffer.from("private-input", "utf8"),
      url: "wss://proxy-apps-prod-ric-001.ondigitalocean.app/?token=fixture-token",
      webSocketFactory: socketFactory,
    }),
    /handshake failed/u,
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].data, /stty -echo &&/u);
  assert.doesNotMatch(sent[0].data, /private-input/u);
}

{
  const sent = [];
  const failingFactory = successfulWebSocketFactory(sent);
  const factory = (url) => {
    const socket = failingFactory(url);
    const originalAdd = socket.addEventListener;
    socket.addEventListener = (name, listener) => {
      if (name !== "message") {
        originalAdd.call(socket, name, listener);
        return;
      }
      originalAdd.call(socket, name, (event) => {
        const parsed = JSON.parse(event.data);
        if (parsed.data.includes("CAPSTONE_OPERATOR_OUTPUT_BEGIN")) {
          listener({ data: JSON.stringify({ data: "remote command failed\r\n" }) });
        } else {
          listener(event);
        }
      });
    };
    return socket;
  };
  await assert.rejects(
    runExecSession({
      input: Buffer.from("private-input", "utf8"),
      url: "wss://proxy-apps-prod-ric-001.ondigitalocean.app/?token=fixture-token",
      webSocketFactory: factory,
    }),
    /result is invalid/u,
  );
}

{
  const clients = fixture();
  const result = await runOperatorConsole("invite-initial", {
    ...clients,
    document: Buffer.from(document),
    environment: {
      DIGITALOCEAN_APP_ID: appId,
      DIGITALOCEAN_CONSOLE_TOKEN: "fixture-console-token-value-long-enough",
      CAPSTONE_TOOL_REVISION: revision,
      GITHUB_REPOSITORY: repository,
      GITHUB_TOKEN: "fixture-github-token-value-long-enough",
    },
    readiness: async (value) => assert.equal(value, revision),
    webSocketFactory: successfulWebSocketFactory([]),
  });
  assert.equal(result.deploymentId, deploymentId);
  assert.deepEqual(clients.requestedExec, [
    appId,
    deploymentId,
    "capstone-chat",
    "capstone-chat-12345678",
  ]);
}

await assert.rejects(
  runOperatorConsole("invite-initial", {
    ...fixture({ instances: [] }),
    document: Buffer.from(document),
    environment: {
      DIGITALOCEAN_APP_ID: appId,
      DIGITALOCEAN_CONSOLE_TOKEN: "fixture-console-token-value-long-enough",
      CAPSTONE_TOOL_REVISION: revision,
      GITHUB_REPOSITORY: repository,
      GITHUB_TOKEN: "fixture-github-token-value-long-enough",
    },
    readiness: async () => undefined,
    webSocketFactory: successfulWebSocketFactory([]),
  }),
  /exactly one/u,
);

await assert.rejects(
  runOperatorConsole("invite-initial", {
    ...fixture({ mutateSecondApp: true }),
    document: Buffer.from(document),
    environment: {
      DIGITALOCEAN_APP_ID: appId,
      DIGITALOCEAN_CONSOLE_TOKEN: "fixture-console-token-value-long-enough",
      CAPSTONE_TOOL_REVISION: revision,
      GITHUB_REPOSITORY: repository,
      GITHUB_TOKEN: "fixture-github-token-value-long-enough",
    },
    readiness: async () => undefined,
    webSocketFactory: successfulWebSocketFactory([]),
  }),
  /authority changed/u,
);

process.stdout.write("App Platform operator console fixtures passed.\n");
