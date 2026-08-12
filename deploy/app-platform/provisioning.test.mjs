import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readContract, renderSpec } from "./contract.mjs";
import { advanceProvisioningStage, createBootstrapApp } from "./provisioning.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = "jmjalil96/capstone-chat";
const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const revision = "1".repeat(40);
const digest = `sha256:${"2".repeat(64)}`;
const deploymentId = "deployment-bootstrap";
const registryInput = {
  components: { "capstone-chat": { registry_credentials: "fixture:read-only-token" } },
  schema: 1,
};
const environment = {
  CAPSTONE_IMAGE_DIGEST: digest,
  CAPSTONE_IMAGE_REVISION: revision,
  CAPSTONE_PROVISIONING_BASE_DEPLOYMENT_ID: deploymentId,
  CAPSTONE_TOOL_REVISION: revision,
  DIGITALOCEAN_APP_ID: appId,
  DIGITALOCEAN_TOKEN: "fixture-digitalocean-token-value-long-enough",
  GITHUB_REPOSITORY: repository,
  GITHUB_TOKEN: "fixture-github-token-value-long-enough",
};
const github = {
  getContainerDigestForRevision: async () => digest,
  getMainHead: async () => revision,
  requireSuccessfulCi: async () => ({ id: 1, revision }),
};

function encrypted(spec) {
  const result = structuredClone(spec);
  for (const component of [...(result.services ?? []), ...(result.jobs ?? [])]) {
    component.image.registry_credentials = `EV[1:${component.name.repeat(8)}]`;
    for (const entry of component.envs ?? []) {
      if (entry.type === "SECRET") entry.value = `EV[1:${entry.key.repeat(3)}]`;
    }
  }
  return result;
}

function app(spec, activeDeploymentId, { egress = false } = {}) {
  return {
    active_deployment: { id: activeDeploymentId },
    ...(egress
      ? {
          dedicated_ips: [
            { ip: "192.0.2.10", status: "ASSIGNED" },
            { ip: "192.0.2.11", status: "ASSIGNED" },
          ],
        }
      : {}),
    default_ingress: "https://capstone-chat-fixture.ondigitalocean.app",
    id: appId,
    in_progress_deployment: null,
    spec: {
      ...encrypted(spec),
      domains: [{ domain: "capstone-chat-fixture.ondigitalocean.app", type: "DEFAULT" }],
    },
    updated_at: "2026-08-11T00:00:00Z",
  };
}

const bootstrapContract = readContract(
  path.join(directory, "bootstrap.contract.yaml"),
  "bootstrap",
);
const bootstrapSpec = renderSpec({
  contract: bootstrapContract,
  digest,
  registryInput,
  registryMode: "introduce",
  revision,
});
const bootstrapApp = app(bootstrapSpec, deploymentId);

{
  let createdSpec;
  let inventoryReads = 0;
  const digitalOcean = {
    createApp: async (spec) => {
      createdSpec = spec;
      return { app: { id: appId }, deploymentId };
    },
    getApp: async () => structuredClone(bootstrapApp),
    getDeployment: async () => ({ id: deploymentId, phase: "ACTIVE" }),
    listApps: async () => (inventoryReads++ === 0 ? [] : []),
  };
  const result = await createBootstrapApp({
    digitalOceanClient: digitalOcean,
    environment,
    githubClient: github,
    output: () => undefined,
    registryInput,
    waitOptions: { intervalMs: 0, maximumAttempts: 1 },
  });
  assert.deepEqual(createdSpec, bootstrapSpec);
  assert.equal(result.operation, "bootstrap-created");
}

{
  const result = await createBootstrapApp({
    digitalOceanClient: {
      getApp: async () => structuredClone(bootstrapApp),
      listApps: async () => [{ id: appId, spec: { name: bootstrapContract.name } }],
    },
    environment,
    githubClient: github,
    output: () => undefined,
    registryInput,
  });
  assert.equal(result.operation, "bootstrap-already-created");
}

{
  const targetDeploymentId = "deployment-egress";
  let finalApp;
  let reads = 0;
  const digitalOcean = {
    getApp: async () => {
      reads += 1;
      return structuredClone(reads <= 3 ? bootstrapApp : finalApp);
    },
    getDeployment: async () => ({ id: targetDeploymentId, phase: "ACTIVE" }),
    updateApp: async (_id, spec) => {
      finalApp = app(spec, targetDeploymentId, { egress: true });
      return { deploymentId: targetDeploymentId };
    },
  };
  const result = await advanceProvisioningStage("bootstrap", "egress", {
    digitalOceanClient: digitalOcean,
    environment,
    githubClient: github,
    output: () => undefined,
    waitOptions: { intervalMs: 0, maximumAttempts: 1 },
  });
  assert.equal(result.mode, "egress");
  assert.equal(result.deploymentId, targetDeploymentId);
  assert.deepEqual(result.dedicatedIps, ["192.0.2.10", "192.0.2.11"]);
}

await assert.rejects(
  advanceProvisioningStage("egress", "domain", {
    digitalOceanClient: { getApp: async () => ({ ...bootstrapApp, dedicated_ips: [] }) },
    environment: {
      ...environment,
      CAPSTONE_EXPECTED_EGRESS_IPV4S: "192.0.2.10,192.0.2.11",
    },
    githubClient: github,
    output: () => undefined,
  }),
  /frozen provisioning authority/u,
);

for (const invalidEgress of [
  "192.0.2.10,999.0.0.1",
  "192.0.2.10,192.168.001.1",
  "192.0.2.10, 192.0.2.11",
  "192.0.2.10,",
]) {
  await assert.rejects(
    advanceProvisioningStage("egress", "domain", {
      digitalOceanClient: { getApp: async () => ({}) },
      environment: { ...environment, CAPSTONE_EXPECTED_EGRESS_IPV4S: invalidEgress },
      githubClient: github,
      output: () => undefined,
    }),
    /CAPSTONE_EXPECTED_EGRESS_IPV4S is invalid/u,
  );
}

await assert.rejects(
  createBootstrapApp({
    digitalOceanClient: { listApps: async () => [] },
    environment,
    githubClient: {
      ...github,
      getContainerDigestForRevision: async () => `sha256:${"3".repeat(64)}`,
    },
    output: () => undefined,
    registryInput,
  }),
  /not the immutable CI-published revision artifact/u,
);

await assert.rejects(advanceProvisioningStage("bootstrap", "rehearsal-egress", {}), /cannot mix/u);

{
  const rehearsalBootstrap = readContract(
    path.join(directory, "rehearsal-bootstrap.contract.yaml"),
    "rehearsal-bootstrap",
  );
  let submitted;
  const rehearsalAppId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const rehearsalDeploymentId = "deployment-rehearsal-bootstrap";
  const rehearsalSpec = renderSpec({
    contract: rehearsalBootstrap,
    digest,
    registryInput,
    registryMode: "introduce",
    revision,
  });
  const rehearsalApp = {
    ...app(rehearsalSpec, rehearsalDeploymentId),
    id: rehearsalAppId,
  };
  const result = await createBootstrapApp({
    digitalOceanClient: {
      createApp: async (spec) => {
        submitted = spec;
        return { app: { id: rehearsalAppId }, deploymentId: rehearsalDeploymentId };
      },
      getApp: async () => structuredClone(rehearsalApp),
      getDeployment: async () => ({ id: rehearsalDeploymentId, phase: "ACTIVE" }),
      listApps: async () => [],
    },
    environment,
    githubClient: github,
    mode: "rehearsal-bootstrap",
    output: () => undefined,
    registryInput,
    waitOptions: { intervalMs: 0, maximumAttempts: 1 },
  });
  assert.deepEqual(submitted, rehearsalSpec);
  assert.equal(result.mode, "rehearsal-bootstrap");
}

{
  const targetDeploymentId = "deployment-egress";
  const egressContract = readContract(path.join(directory, "egress.contract.yaml"), "egress");
  const targetApp = app(
    renderSpec({ contract: egressContract, digest, liveApp: bootstrapApp, revision }),
    targetDeploymentId,
    { egress: true },
  );
  const result = await advanceProvisioningStage("bootstrap", "egress", {
    digitalOceanClient: {
      getApp: async () => structuredClone(targetApp),
      listDeployments: async () => [
        {
          created_at: "2026-08-11T00:00:01Z",
          id: targetDeploymentId,
          phase: "ACTIVE",
          spec: targetApp.spec,
        },
        {
          created_at: "2026-08-11T00:00:00Z",
          id: deploymentId,
          phase: "SUPERSEDED",
          spec: bootstrapApp.spec,
        },
      ],
    },
    environment,
    githubClient: github,
    output: () => undefined,
  });
  assert.equal(result.operation, "stage-already-applied");
  assert.equal(result.deploymentId, targetDeploymentId);
}

process.stdout.write("App Platform provisioning fixtures passed.\n");
