import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProvisioningTransition,
  assertSafeRollbackHistory,
  classifyDeploymentSpec,
  liveFingerprint,
  readContract,
  readProtectedJson,
  renderSpec,
  validateApp,
  validateContract,
  validateLiveApp,
  writeProtectedJson,
} from "./contract.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const encrypted = (name) => `EV[1:${name.repeat(8)}]`;

function credentials(...components) {
  return {
    components: Object.fromEntries(
      components.map((component) => [
        component,
        { registry_credentials: `${component}:fixture-read-token-value` },
      ]),
    ),
    schema: 1,
  };
}

function secrets(declarations) {
  return {
    components: Object.fromEntries(
      Object.entries(declarations).map(([component, keys]) => [
        component,
        Object.fromEntries(
          keys.map((key) => [
            key,
            key === "OTEL_EXPORTER_OTLP_ENDPOINT"
              ? "https://otlp.nr-data.net"
              : `fixture-${key.toLowerCase()}-value`,
          ]),
        ),
      ]),
    ),
    schema: 1,
  };
}

function encryptSpec(spec) {
  const result = structuredClone(spec);
  for (const component of [...(result.services ?? []), ...(result.jobs ?? [])]) {
    component.image.registry_credentials = encrypted(`${component.name}-registry`);
    for (const env of component.envs ?? []) {
      if (env.type === "SECRET") {
        env.value = encrypted(`${component.name}-${env.key}`);
      }
    }
  }
  return result;
}

function liveFixture() {
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const spec = encryptSpec(
    renderSpec({
      contract,
      digest,
      generalInput: {
        components: {
          "capstone-chat": { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net" },
        },
        schema: 1,
      },
      generalMode: "introduce",
      liveApp: {
        default_ingress: "https://capstone-chat-fixture.ondigitalocean.app",
        spec: {},
      },
      registryInput: credentials("capstone-chat", "capstone-migrate"),
      registryMode: "introduce",
      revision,
      secretInput: secrets({
        "capstone-chat": contract.service.environment.secret_keys,
        "capstone-migrate": contract.job.environment.secret_keys,
      }),
      secretMode: "introduce",
    }),
  );
  spec.domains.push({
    domain: "capstone-chat-fixture.ondigitalocean.app",
    type: "DEFAULT",
  });
  return {
    active_deployment: { id: "deployment-fixture-active" },
    dedicated_ips: [
      { ip: "192.0.2.10", status: "ASSIGNED" },
      { ip: "192.0.2.11", status: "ASSIGNED" },
    ],
    default_ingress: "https://capstone-chat-fixture.ondigitalocean.app",
    id: "app-fixture-production",
    in_progress_deployment: null,
    spec,
    updated_at: "2026-08-11T00:00:00Z",
  };
}

for (const [name, mode] of [
  ["app.contract.yaml", "live"],
  ["bootstrap.contract.yaml", "bootstrap"],
  ["egress.contract.yaml", "egress"],
  ["domain.contract.yaml", "domain"],
  ["initialization.contract.yaml", "initialization"],
  ["rehearsal.contract.yaml", "rehearsal"],
  ["rehearsal-bootstrap.contract.yaml", "rehearsal-bootstrap"],
  ["rehearsal-domain.contract.yaml", "rehearsal-domain"],
  ["rehearsal-egress.contract.yaml", "rehearsal-egress"],
  ["rehearsal-initialization.contract.yaml", "rehearsal-initialization"],
]) {
  const contents = readFileSync(path.join(directory, name), "utf8");
  assert.doesNotMatch(contents, /digest|registry_credentials|DEPLOYMENT_REVISION|sha256:/u);
  assert.equal(readContract(path.join(directory, name), mode).mode, mode);
}

for (const [source, target] of [
  [undefined, "bootstrap"],
  ["bootstrap", "egress"],
  ["egress", "domain"],
  ["domain", "initialization"],
  ["initialization", "live"],
  ["domain", "live"],
  ["live", "live"],
  [undefined, "rehearsal-bootstrap"],
  ["rehearsal-bootstrap", "rehearsal-egress"],
  ["rehearsal-egress", "rehearsal-domain"],
  ["rehearsal-domain", "rehearsal-initialization"],
  ["rehearsal-initialization", "rehearsal"],
  ["rehearsal", "rehearsal"],
]) {
  assert.doesNotThrow(() => assertProvisioningTransition(source, target));
}
for (const [source, target] of [
  ["bootstrap", "initialization"],
  ["bootstrap", "domain"],
  ["egress", "initialization"],
  ["initialization", "domain"],
  ["live", "initialization"],
  ["rehearsal-bootstrap", "rehearsal-domain"],
  ["rehearsal-egress", "rehearsal-initialization"],
  ["rehearsal-initialization", "rehearsal-domain"],
]) {
  assert.throws(() => assertProvisioningTransition(source, target), /cannot transition/u);
}

{
  const contract = readContract(path.join(directory, "bootstrap.contract.yaml"), "bootstrap");
  const spec = renderSpec({
    contract,
    digest,
    registryInput: credentials("capstone-chat"),
    registryMode: "introduce",
    revision,
  });
  assert.equal(spec.services.length, 1);
  assert.equal(spec.services[0].run_command, "node apps/api/dist/entrypoint.js egress-bootstrap");
  assert.deepEqual(spec.services[0].health_check, {
    failure_threshold: 3,
    http_path: "/api/health/ready",
    initial_delay_seconds: 5,
    period_seconds: 10,
    port: 3000,
    success_threshold: 2,
    timeout_seconds: 3,
  });
  assert.deepEqual(spec.services[0].liveness_health_check, {
    failure_threshold: 18,
    http_path: "/api/health/live",
    initial_delay_seconds: 15,
    period_seconds: 10,
    port: 3000,
    success_threshold: 1,
    timeout_seconds: 3,
  });
  assert.deepEqual(
    {
      registry: spec.services[0].image.registry,
      registry_type: spec.services[0].image.registry_type,
      repository: spec.services[0].image.repository,
    },
    { registry: "jmjalil96", registry_type: "GHCR", repository: "capstone-chat" },
  );
  assert.deepEqual(
    spec.services[0].envs.filter((entry) => entry.type === "SECRET"),
    [],
  );
  assert.equal(spec.egress, undefined);
  assert.equal(spec.domains, undefined);
  assert.equal(spec.jobs, undefined);
  const fetchedSpec = encryptSpec(spec);
  fetchedSpec.domains = [{ domain: "capstone-chat-fixture.ondigitalocean.app", type: "DEFAULT" }];
  assert.doesNotThrow(() =>
    validateApp({
      app: {
        active_deployment: { id: "bootstrap-active" },
        default_ingress: "https://capstone-chat-fixture.ondigitalocean.app",
        id: "bootstrap-app",
        in_progress_deployment: null,
        spec: fetchedSpec,
        updated_at: "2026-08-11T00:00:00Z",
      },
      contract,
      digest,
    }),
  );
}

{
  const bootstrap = readContract(path.join(directory, "bootstrap.contract.yaml"), "bootstrap");
  const egress = readContract(path.join(directory, "egress.contract.yaml"), "egress");
  const domain = readContract(path.join(directory, "domain.contract.yaml"), "domain");
  const initialization = readContract(
    path.join(directory, "initialization.contract.yaml"),
    "initialization",
  );
  const bootstrapSpec = encryptSpec(
    renderSpec({
      contract: bootstrap,
      digest,
      registryInput: credentials("capstone-chat"),
      registryMode: "introduce",
      revision,
    }),
  );
  const bootstrapApp = {
    default_ingress: "https://capstone-chat-fixture.ondigitalocean.app",
    spec: {
      ...bootstrapSpec,
      domains: [{ domain: "capstone-chat-fixture.ondigitalocean.app", type: "DEFAULT" }],
    },
  };
  const egressSpec = renderSpec({
    contract: egress,
    digest,
    liveApp: bootstrapApp,
    revision,
  });
  assert.equal(egressSpec.egress.type, "DEDICATED_IP");
  assert.equal(egressSpec.domains, undefined);
  assert.equal(egressSpec.jobs, undefined);
  assert.equal(egressSpec.ingress.rules.length, 1);
  assert.equal(egressSpec.ingress.rules[0].component.name, "capstone-chat");
  const egressFetchedSpec = structuredClone(egressSpec);
  egressFetchedSpec.domains = [
    { domain: "capstone-chat-fixture.ondigitalocean.app", type: "DEFAULT" },
  ];
  const egressApp = {
    active_deployment: { id: "egress-active" },
    dedicated_ips: [
      { ip: "192.0.2.10", status: "ASSIGNED" },
      { ip: "192.0.2.11", status: "ASSIGNED" },
    ],
    default_ingress: "https://capstone-chat-fixture.ondigitalocean.app",
    id: "egress-app",
    in_progress_deployment: null,
    spec: egressFetchedSpec,
    updated_at: "2026-08-11T00:00:01Z",
  };
  assert.doesNotThrow(() => validateApp({ app: egressApp, contract: egress, digest }));

  const domainSpec = renderSpec({
    contract: domain,
    digest,
    liveApp: egressApp,
    revision,
  });
  assert.equal(domainSpec.egress.type, "DEDICATED_IP");
  assert.equal(domainSpec.domains[0].domain, "chat.capstone.com.ec");
  assert.equal(domainSpec.jobs, undefined);
  assert.equal(domainSpec.ingress.rules[0].redirect.authority, "chat.capstone.com.ec");
  for (const invalidDefaultIngress of [
    "capstone-chat-fixture.ondigitalocean.app",
    "http://capstone-chat-fixture.ondigitalocean.app",
    "https://user@capstone-chat-fixture.ondigitalocean.app",
    "https://capstone-chat-fixture.ondigitalocean.app/path",
    "https://capstone-chat-fixture.ondigitalocean.app?query=yes",
    "https://example.com",
    "https://different-fixture.ondigitalocean.app",
  ]) {
    assert.throws(
      () =>
        renderSpec({
          contract: domain,
          digest,
          liveApp: { ...egressApp, default_ingress: invalidDefaultIngress },
          revision,
        }),
      /DEFAULT (?:ingress is invalid|domain disagrees)/u,
    );
  }
  const domainFetchedSpec = structuredClone(domainSpec);
  domainFetchedSpec.domains.push({
    domain: "capstone-chat-fixture.ondigitalocean.app",
    type: "DEFAULT",
  });
  const domainApp = {
    ...egressApp,
    active_deployment: { id: "domain-active" },
    id: "domain-app",
    spec: domainFetchedSpec,
    updated_at: "2026-08-11T00:00:02Z",
  };
  assert.doesNotThrow(() => validateApp({ app: domainApp, contract: domain, digest }));

  const spec = renderSpec({
    contract: initialization,
    digest,
    liveApp: domainApp,
    registryInput: credentials("capstone-initialize"),
    registryMode: "introduce",
    revision,
    secretInput: secrets({
      "capstone-initialize": initialization.job.environment.secret_keys,
    }),
    secretMode: "introduce",
  });
  assert.equal(spec.egress.type, "DEDICATED_IP");
  assert.equal(spec.jobs[0].name, "capstone-initialize");
  assert.match(spec.services[0].image.registry_credentials, /^EV\[/u);
  assert.doesNotMatch(JSON.stringify(spec.services[0].envs), /BETTER_AUTH_SECRET/u);
  assert.doesNotMatch(JSON.stringify(spec.jobs[0].envs), /BETTER_AUTH_SECRET|RESEND_API_KEY|OTEL/u);
  const initializationFetchedSpec = encryptSpec(spec);
  initializationFetchedSpec.domains.push({
    domain: "capstone-chat-fixture.ondigitalocean.app",
    type: "DEFAULT",
  });
  assert.doesNotThrow(() =>
    validateApp({
      app: {
        ...domainApp,
        active_deployment: { id: "initialization-active" },
        id: "initialization-app",
        spec: initializationFetchedSpec,
        updated_at: "2026-08-11T00:00:03Z",
      },
      contract: initialization,
      digest,
    }),
  );

  const boundarySecrets = secrets({
    "capstone-initialize": initialization.job.environment.secret_keys,
  });
  boundarySecrets.components["capstone-initialize"].CAPSTONE_INITIALIZATION_DOCUMENT = "x".repeat(
    32 * 1024,
  );
  assert.doesNotThrow(() =>
    renderSpec({
      contract: initialization,
      digest,
      liveApp: domainApp,
      registryInput: credentials("capstone-initialize"),
      registryMode: "introduce",
      revision,
      secretInput: boundarySecrets,
      secretMode: "introduce",
    }),
  );
  boundarySecrets.components["capstone-initialize"].CAPSTONE_INITIALIZATION_DOCUMENT += "x";
  assert.throws(
    () =>
      renderSpec({
        contract: initialization,
        digest,
        liveApp: domainApp,
        registryInput: credentials("capstone-initialize"),
        registryMode: "introduce",
        revision,
        secretInput: boundarySecrets,
        secretMode: "introduce",
      }),
    /CAPSTONE_INITIALIZATION_DOCUMENT is invalid/u,
  );
}

{
  const app = liveFixture();
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const validated = validateLiveApp({ app, appId: app.id, contract, digest });
  assert.deepEqual(validated.dedicatedIps, ["192.0.2.10", "192.0.2.11"]);
  assert.equal(validated.fingerprint, liveFingerprint(app));
  const endpoint = app.spec.services[0].envs.find(
    (entry) => entry.key === "OTEL_EXPORTER_OTLP_ENDPOINT",
  );
  assert.deepEqual(endpoint, {
    key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    scope: "RUN_TIME",
    type: "GENERAL",
    value: "https://otlp.nr-data.net",
  });
  const invalidEndpoint = structuredClone(app);
  invalidEndpoint.spec.services[0].envs.find(
    (entry) => entry.key === "OTEL_EXPORTER_OTLP_ENDPOINT",
  ).value = "https://telemetry.example.com";
  assert.throws(
    () => validateLiveApp({ app: invalidEndpoint, appId: app.id, contract, digest }),
    /OTEL_EXPORTER_OTLP_ENDPOINT is invalid/u,
  );

  const egressDrift = structuredClone(app);
  delete egressDrift.spec.egress;
  assert.throws(
    () => validateLiveApp({ app: egressDrift, appId: app.id, contract, digest }),
    /Live App contract/u,
  );

  const secretDrift = structuredClone(app);
  secretDrift.spec.services[0].envs.find((entry) => entry.type === "SECRET").value = "plaintext";
  assert.throws(
    () => validateLiveApp({ app: secretDrift, appId: app.id, contract, digest }),
    /not encrypted/u,
  );

  const topologyDrift = structuredClone(app);
  topologyDrift.spec.workers = [{ name: "unexpected" }];
  assert.throws(
    () => validateLiveApp({ app: topologyDrift, appId: app.id, contract, digest }),
    /prohibited workers/u,
  );

  const changed = structuredClone(app);
  changed.dedicated_ips[0].ip = "192.0.2.12";
  assert.notEqual(liveFingerprint(changed), liveFingerprint(app));
}

{
  const rehearsal = readContract(path.join(directory, "rehearsal.contract.yaml"), "rehearsal");
  const spec = renderSpec({
    contract: rehearsal,
    digest,
    generalInput: {
      components: {
        "capstone-chat": { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net" },
      },
      schema: 1,
    },
    generalMode: "introduce",
    liveApp: {
      default_ingress: "https://capstone-chat-fixture.ondigitalocean.app",
      spec: {},
    },
    registryInput: credentials("capstone-chat", "capstone-migrate"),
    registryMode: "introduce",
    revision,
    secretInput: secrets({
      "capstone-chat": rehearsal.service.environment.secret_keys,
      "capstone-migrate": rehearsal.job.environment.secret_keys,
    }),
    secretMode: "introduce",
  });
  assert.equal(spec.services[0].alerts.length, 4);
  assert.deepEqual(
    spec.services[0].envs.map((entry) => entry.key).sort(),
    [
      ...Object.keys(rehearsal.service.environment.general),
      ...rehearsal.service.environment.general_keys,
      ...rehearsal.service.environment.secret_keys,
    ].sort(),
  );
  assert.deepEqual(
    spec.jobs[0].envs.map((entry) => entry.key).sort(),
    [
      ...Object.keys(rehearsal.job.environment.general),
      ...rehearsal.job.environment.secret_keys,
    ].sort(),
  );
  assert.doesNotMatch(
    JSON.stringify(spec),
    /OPENROUTER_API_KEY|RESEND_API_KEY|CAPSTONE_INITIALIZATION_DOCUMENT/u,
  );
  assert.equal(classifyDeploymentSpec(spec), "steady-rehearsal");
  const safeHistory = Array.from({ length: 10 }, (_, index) => ({
    created_at: new Date(Date.UTC(2026, 7, 11, 1, 0, index)).toISOString(),
    id: `rehearsal-deployment-${index}`,
    phase: index === 9 ? "ACTIVE" : "SUPERSEDED",
    spec,
  }));
  assert.equal(
    assertSafeRollbackHistory(safeHistory, { expectedClassification: "steady-rehearsal" }).length,
    10,
  );
  assert.throws(() => assertSafeRollbackHistory(safeHistory), /Unsafe bootstrap history/u);
}

{
  const app = liveFixture();
  const liveSpec = structuredClone(app.spec);
  const unsafeSpec = structuredClone(liveSpec);
  delete unsafeSpec.egress;
  const initializationSpec = structuredClone(liveSpec);
  initializationSpec.jobs[0].name = "capstone-initialize";
  const rehearsalInitializationSpec = structuredClone(liveSpec);
  rehearsalInitializationSpec.jobs[0].name = "capstone-rehearsal-initialize";
  const healthOnlySpec = structuredClone(liveSpec);
  healthOnlySpec.services[0].run_command = "node apps/api/dist/entrypoint.js egress-bootstrap";
  delete healthOnlySpec.jobs;
  assert.equal(classifyDeploymentSpec(unsafeSpec), "unsafe-pre-egress");
  assert.equal(classifyDeploymentSpec(initializationSpec), "unsafe-initialization");
  assert.equal(classifyDeploymentSpec(rehearsalInitializationSpec), "unsafe-initialization");
  assert.equal(classifyDeploymentSpec(healthOnlySpec), "unsafe-bootstrap");
  assert.equal(classifyDeploymentSpec(liveSpec), "steady");
  const safeHistory = Array.from({ length: 10 }, (_, index) => ({
    created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, index)).toISOString(),
    id: `deployment-${index}`,
    phase: index === 9 ? "ACTIVE" : "SUPERSEDED",
    spec: liveSpec,
  }));
  assert.equal(assertSafeRollbackHistory(safeHistory.toReversed()).length, 10);
  assert.throws(
    () =>
      assertSafeRollbackHistory([
        {
          created_at: "2026-08-11T00:00:10.000Z",
          id: "unsafe",
          phase: "ACTIVE",
          spec: unsafeSpec,
        },
        ...Array.from({ length: 9 }, (_, index) => ({
          created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, index)).toISOString(),
          id: `safe-${index}`,
          phase: "SUPERSEDED",
          spec: liveSpec,
        })),
      ]),
    /Unsafe bootstrap history/u,
  );
  assert.throws(
    () =>
      assertSafeRollbackHistory([
        ...safeHistory.slice(0, 9),
        { ...safeHistory[9], created_at: safeHistory[8].created_at },
      ]),
    /order is ambiguous/u,
  );
  assert.throws(
    () =>
      assertSafeRollbackHistory([
        { ...safeHistory[0], created_at: "not-a-date" },
        ...safeHistory.slice(1),
      ]),
    /timestamp is invalid/u,
  );
}

{
  const altered = structuredClone(readContract(path.join(directory, "app.contract.yaml"), "live"));
  altered.service.instance_count = 2;
  assert.throws(() => validateContract(altered, "live"), /service changed/u);
}

{
  const temporary = mkdtempSync(path.join(os.tmpdir(), "capstone-app-contract-"));
  try {
    const protectedPath = path.join(temporary, "protected.json");
    writeProtectedJson(protectedPath, { schema: 1 });
    assert.deepEqual(readProtectedJson(protectedPath, "fixture"), { schema: 1 });
    chmodSync(protectedPath, 0o644);
    assert.throws(() => readProtectedJson(protectedPath, "fixture"), /mode must be 0600/u);

    const unsafePath = path.join(temporary, "unsafe.json");
    writeFileSync(unsafePath, "{}\n", { encoding: "utf8", mode: 0o600 });
    assert.throws(() => writeProtectedJson(unsafePath, {}), /EEXIST/u);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

process.stdout.write("App Platform contract fixtures passed.\n");
