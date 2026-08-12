import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConfigurationOperation, validateOperationalApp } from "./configuration.mjs";
import { readContract, renderSpec } from "./contract.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = "jmjalil96/capstone-chat";
const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const revision = "1".repeat(40);
const digest = `sha256:${"2".repeat(64)}`;
const defaultHostname = "capstone-chat-fixture.ondigitalocean.app";
const contract = readContract(path.join(directory, "app.contract.yaml"), "live");

function encrypted(label) {
  return `EV[1:${label.repeat(8)}]`;
}

function encryptSubmittedSpec(spec, suffix) {
  const result = structuredClone(spec);
  for (const component of [...(result.services ?? []), ...(result.jobs ?? [])]) {
    if (!component.image.registry_credentials.startsWith("EV[")) {
      component.image.registry_credentials = encrypted(`${component.name}-registry-${suffix}`);
    }
    for (const entry of component.envs ?? []) {
      if (entry.type === "SECRET" && !entry.value.startsWith("EV[")) {
        entry.value = encrypted(`${component.name}-${entry.key}-${suffix}`);
      }
    }
  }
  result.domains = [...(result.domains ?? []), { domain: defaultHostname, type: "DEFAULT" }];
  return result;
}

function initialSpec() {
  return encryptSubmittedSpec(
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
    }),
    "initial",
  );
}

function app(spec, deploymentId = "deployment-active", updatedAt = "2026-08-11T00:00:00Z") {
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
    updated_at: updatedAt,
  };
}

function acceptedRelease() {
  return {
    createdAt: "2026-08-11T00:00:00Z",
    deploymentId: 41,
    digest,
    digitalOceanAppId: appId,
    digitalOceanDeploymentId: "deployment-active",
    operation: "deploy",
    revision,
  };
}

function history(spec) {
  return Array.from({ length: 10 }, (_, index) => ({
    created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, 20 - index)).toISOString(),
    id: index === 0 ? "deployment-active" : `deployment-safe-${index}`,
    phase: index === 0 ? "ACTIVE" : "SUPERSEDED",
    spec,
  }));
}

function environment(baseDeploymentId = "deployment-active") {
  return {
    CAPSTONE_CONFIGURATION_BASE_DEPLOYMENT_ID: baseDeploymentId,
    CAPSTONE_TOOL_REVISION: revision,
    DIGITALOCEAN_APP_ID: appId,
    DIGITALOCEAN_TOKEN: "fixture-digitalocean-token-value-long-enough",
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: "fixture-github-token-value-long-enough",
  };
}

async function exercise(operation, source, { baseDeploymentId, registryInput, secretInput } = {}) {
  let submitted;
  let final;
  let reads = 0;
  let readinessCalls = 0;
  const digitalOcean = {
    getApp: async () => {
      reads += 1;
      return structuredClone(reads <= 3 ? source : final);
    },
    getDeployment: async (_requestedAppId, deploymentId) => ({
      id: deploymentId,
      phase: "ACTIVE",
    }),
    listDeployments: async () => history(source.spec),
    updateApp: async (_requestedAppId, spec) => {
      submitted = structuredClone(spec);
      final = app(
        encryptSubmittedSpec(spec, operation),
        `deployment-${operation}`,
        "2026-08-11T00:01:00Z",
      );
      return { deploymentId: `deployment-${operation}` };
    },
  };
  const github = {
    getMainHead: async () => revision,
    listAcceptedReleases: async () => [acceptedRelease()],
  };
  const result = await runConfigurationOperation(operation, {
    digitalOceanClient: digitalOcean,
    environment: environment(baseDeploymentId ?? source.active_deployment.id),
    githubClient: github,
    output: () => undefined,
    readiness: async () => {
      readinessCalls += 1;
    },
    registryInput,
    secretInput,
  });
  return { final, readinessCalls, result, submitted };
}

const ready = app(initialSpec());

{
  const { final, readinessCalls } = await exercise("maintenance-enable", ready);
  assert.equal(
    validateOperationalApp({ app: final, appId, contract, digest, revision }),
    "attached-maintenance",
  );
  assert.equal(readinessCalls, 0);
}

const maintenance = structuredClone(ready);
maintenance.spec.maintenance.enabled = true;

{
  const { result, submitted } = await exercise("maintenance-enable", maintenance);
  assert.equal(result.operation, "maintenance-enable-already-applied");
  assert.equal(submitted, undefined);
}

await assert.rejects(
  exercise("maintenance-enable", ready, { baseDeploymentId: "deployment-stale" }),
  /reviewed configuration base/u,
);

{
  const { final, readinessCalls } = await exercise("maintenance-disable", maintenance);
  assert.equal(
    validateOperationalApp({ app: final, appId, contract, digest, revision }),
    "attached-ready",
  );
  assert.equal(readinessCalls, 1);
}

let detached;
{
  const result = await exercise("domain-detach", maintenance);
  detached = result.final;
  assert.equal(
    validateOperationalApp({ app: detached, appId, contract, digest, revision }),
    "detached-maintenance",
  );
  assert.equal(result.submitted.domains, undefined);
  assert.equal(result.readinessCalls, 0);
}

{
  const { final, readinessCalls } = await exercise("domain-attach", detached);
  assert.equal(
    validateOperationalApp({ app: final, appId, contract, digest, revision }),
    "attached-maintenance",
  );
  assert.equal(readinessCalls, 0);
}

{
  const secretInput = {
    components: {
      "capstone-chat": { RESEND_API_KEY: "fixture-resend-rotation-value" },
    },
    schema: 1,
  };
  const { final, readinessCalls, result, submitted } = await exercise(
    "rotate-runtime-secrets",
    ready,
    { secretInput },
  );
  assert.equal(result.rotatedValues, 1);
  assert.equal(readinessCalls, 1);
  assert.equal(
    submitted.services[0].envs.find((entry) => entry.key === "RESEND_API_KEY").value,
    "fixture-resend-rotation-value",
  );
  assert.match(
    final.spec.services[0].envs.find((entry) => entry.key === "RESEND_API_KEY").value,
    /^EV\[/u,
  );
}

{
  const registryInput = {
    components: {
      "capstone-chat": { registry_credentials: "fixture:new-registry-token-value" },
      "capstone-migrate": { registry_credentials: "fixture:new-registry-token-value" },
    },
    schema: 1,
  };
  const { readinessCalls, result, submitted } = await exercise("rotate-registry", ready, {
    registryInput,
  });
  assert.equal(result.rotatedValues, 2);
  assert.equal(readinessCalls, 1);
  assert.equal(
    submitted.services[0].image.registry_credentials,
    "fixture:new-registry-token-value",
  );
  assert.equal(submitted.jobs[0].image.registry_credentials, "fixture:new-registry-token-value");
}

await assert.rejects(
  exercise("rotate-runtime-secrets", ready, {
    secretInput: { components: {}, schema: 1 },
  }),
  /at least one/u,
);
await assert.rejects(exercise("rotate-runtime-secrets", detached), /input is required/u);
await assert.rejects(exercise("rotate-registry", detached), /domain is detached/u);

process.stdout.write("App Platform configuration fixtures passed.\n");
