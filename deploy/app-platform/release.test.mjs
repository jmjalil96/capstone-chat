import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readContract, renderSpec } from "./contract.mjs";
import {
  adoptInitialBaseline,
  patchImageDigest,
  reconcileLiveRelease,
  runReleaseOperation,
  waitForPublicReadiness,
} from "./release.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = "jmjalil96/capstone-chat";
const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const oldRevision = "1".repeat(40);
const candidateRevision = "2".repeat(40);
const movedRevision = "3".repeat(40);
const oldDigest = `sha256:${"1".repeat(64)}`;
const candidateDigest = `sha256:${"2".repeat(64)}`;
const defaultHostname = "capstone-chat-fixture.ondigitalocean.app";
const oldDeploymentId = "deployment-old";
const candidateDeploymentId = "deployment-candidate";
const contract = readContract(path.join(directory, "app.contract.yaml"), "live");

function environment(revision, digest, toolRevision = candidateRevision) {
  return {
    CAPSTONE_IMAGE_DIGEST: digest,
    CAPSTONE_IMAGE_REVISION: revision,
    CAPSTONE_TOOL_REVISION: toolRevision,
    DIGITALOCEAN_APP_ID: appId,
    DIGITALOCEAN_TOKEN: "fixture-digitalocean-token-value-long-enough",
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: "fixture-github-token-value-long-enough",
  };
}

function encryptSpec(spec) {
  const result = structuredClone(spec);
  for (const component of [...(result.services ?? []), ...(result.jobs ?? [])]) {
    component.image.registry_credentials = `EV[1:${component.name.repeat(8)}]`;
    for (const entry of component.envs ?? []) {
      if (entry.type === "SECRET") {
        entry.value = `EV[1:${entry.key.repeat(3)}]`;
      }
    }
  }
  return result;
}

function liveSpec(digest) {
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
      liveApp: { default_ingress: `https://${defaultHostname}`, spec: {} },
      registryInput: {
        components: {
          "capstone-chat": { registry_credentials: "fixture:registry-token-value" },
          "capstone-migrate": { registry_credentials: "fixture:registry-token-value" },
        },
        schema: 1,
      },
      registryMode: "introduce",
      revision: candidateRevision,
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
  );
  spec.domains.push({ domain: defaultHostname, type: "DEFAULT" });
  return spec;
}

function app(spec, deploymentId, updatedAt = "2026-08-11T00:00:00Z") {
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

function history(spec, activeDeploymentId = oldDeploymentId) {
  return Array.from({ length: 10 }, (_, index) => ({
    created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, 20 - index)).toISOString(),
    id: index === 0 ? activeDeploymentId : `deployment-safe-${index}`,
    phase: index === 0 ? "ACTIVE" : "SUPERSEDED",
    spec,
  }));
}

function reconciliationHistory(candidateSpec, predecessorSpec) {
  return [
    {
      created_at: "2026-08-11T00:00:20Z",
      id: candidateDeploymentId,
      phase: "ACTIVE",
      spec: candidateSpec,
    },
    {
      created_at: "2026-08-11T00:00:19Z",
      id: oldDeploymentId,
      phase: "SUPERSEDED",
      spec: predecessorSpec,
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, 18 - index)).toISOString(),
      id: `deployment-safe-${index}`,
      phase: "SUPERSEDED",
      spec: predecessorSpec,
    })),
  ];
}

function acceptedRelease({
  digest = oldDigest,
  digitalOceanDeploymentId = oldDeploymentId,
  githubDeploymentId = 40,
  previousDigest = "",
  previousRevision = "",
  revision = oldRevision,
  operation = "deploy",
} = {}) {
  return {
    ciRunId: githubDeploymentId,
    ciWorkflowUrl: `https://github.com/${repository}/actions/runs/${githubDeploymentId}`,
    createdAt: `2026-08-11T00:00:${String(githubDeploymentId).padStart(2, "0")}Z`,
    deploymentId: githubDeploymentId,
    digest,
    digitalOceanAppId: appId,
    digitalOceanDeploymentId,
    image: `ghcr.io/${repository}@${digest}`,
    operation,
    previousDigest,
    previousRevision,
    revision,
    schema: 2,
    type: "release",
  };
}

function githubFixture({
  createSuccessfulRelease,
  mainHeads = [candidateRevision],
  releaseLists,
} = {}) {
  let mainReads = 0;
  let releaseReads = 0;
  const created = [];
  const lists = releaseLists ?? [[acceptedRelease()]];
  return {
    assertStrictForward: async (active, candidate) => {
      assert.equal(
        (active === oldRevision && candidate === candidateRevision) ||
          (active === candidateRevision && candidate === movedRevision),
        true,
      );
    },
    createSuccessfulRelease: async (payload) => {
      created.push(payload);
      if (createSuccessfulRelease !== undefined) {
        return createSuccessfulRelease(payload);
      }
      return 99;
    },
    created,
    getMainHead: async () => {
      const value = mainHeads[Math.min(mainReads, mainHeads.length - 1)];
      mainReads += 1;
      return value;
    },
    listAcceptedReleases: async () => {
      const value = lists[Math.min(releaseReads, lists.length - 1)];
      releaseReads += 1;
      return structuredClone(value);
    },
    requireSuccessfulCi: async (revision) => ({
      id: 42,
      url: `https://github.com/${repository}/actions/runs/42`,
      revision,
    }),
  };
}

function digitalOceanFixture({
  apps,
  deployments,
  expectedUpdateSpec,
  updatedDeploymentId = candidateDeploymentId,
}) {
  let appReads = 0;
  return {
    createDeployment: async () => {
      throw new Error("Unexpected deployment creation");
    },
    getApp: async () => {
      const value = apps[Math.min(appReads, apps.length - 1)];
      appReads += 1;
      return structuredClone(value);
    },
    getDeployment: async (_appId, deploymentId) => ({ id: deploymentId, phase: "ACTIVE" }),
    listDeployments: async () => structuredClone(deployments),
    updateApp: async (_appId, spec) => {
      assert.deepEqual(spec, expectedUpdateSpec);
      return { deploymentId: updatedDeploymentId };
    },
  };
}

const predecessorSpec = liveSpec(oldDigest);
const forwardSpec = patchImageDigest(predecessorSpec, candidateDigest);
const predecessorApp = app(predecessorSpec, oldDeploymentId);
const forwardApp = app(forwardSpec, candidateDeploymentId, "2026-08-11T00:01:00Z");

{
  const github = githubFixture();
  const digitalOcean = digitalOceanFixture({
    apps: [predecessorApp, predecessorApp, predecessorApp, forwardApp],
    deployments: history(predecessorSpec),
    expectedUpdateSpec: forwardSpec,
  });
  const result = await runReleaseOperation("deploy", {
    digitalOceanClient: digitalOcean,
    environment: environment(candidateRevision, candidateDigest),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  });
  assert.equal(result.operation, "deploy");
  assert.equal(github.created[0].operation, "deploy");
  assert.equal(github.created[0].previousRevision, oldRevision);
}

{
  const currentRelease = acceptedRelease({
    digest: candidateDigest,
    digitalOceanDeploymentId: candidateDeploymentId,
    githubDeploymentId: 41,
    previousDigest: oldDigest,
    previousRevision: oldRevision,
    revision: candidateRevision,
  });
  const github = githubFixture({
    mainHeads: [candidateRevision],
    releaseLists: [[currentRelease, acceptedRelease()]],
  });
  const rollbackDeploymentId = "deployment-rollback";
  const rolledBack = app(predecessorSpec, rollbackDeploymentId, "2026-08-11T00:02:00Z");
  const digitalOcean = digitalOceanFixture({
    apps: [forwardApp, forwardApp, forwardApp, rolledBack],
    deployments: history(forwardSpec, candidateDeploymentId),
    expectedUpdateSpec: predecessorSpec,
    updatedDeploymentId: rollbackDeploymentId,
  });
  const result = await runReleaseOperation("rollback", {
    digitalOceanClient: digitalOcean,
    environment: environment(oldRevision, oldDigest),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  });
  assert.equal(result.operation, "rollback");
  assert.equal(github.created[0].operation, "rollback");
  assert.equal(github.created[0].previousRevision, candidateRevision);
}

{
  const github = githubFixture({ releaseLists: [[], []] });
  const digitalOcean = digitalOceanFixture({
    apps: [forwardApp, forwardApp],
    deployments: history(forwardSpec, candidateDeploymentId),
  });
  const result = await adoptInitialBaseline({
    digitalOceanClient: digitalOcean,
    environment: environment(candidateRevision, candidateDigest),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  });
  assert.equal(result.operation, "initial-baseline");
  assert.equal(github.created[0].operation, "initial");
  assert.equal(github.created[0].previousRevision, "");
}

{
  let releases = [];
  const exactInitial = acceptedRelease({
    digest: candidateDigest,
    digitalOceanDeploymentId: candidateDeploymentId,
    githubDeploymentId: 44,
    operation: "initial",
    revision: candidateRevision,
  });
  const github = githubFixture({
    createSuccessfulRelease: async () => {
      releases = [exactInitial];
      throw new Error("fixture ambiguous initial GitHub response");
    },
  });
  github.listAcceptedReleases = async () => structuredClone(releases);
  const options = {
    digitalOceanClient: digitalOceanFixture({
      apps: [forwardApp],
      deployments: history(forwardSpec, candidateDeploymentId),
    }),
    environment: environment(candidateRevision, candidateDigest),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  };
  await assert.rejects(adoptInitialBaseline(options), /ambiguous initial/u);
  const repeated = await adoptInitialBaseline(options);
  assert.equal(repeated.operation, "initial-baseline-already-recorded");
  assert.equal(repeated.githubDeploymentId, 44);
}

{
  let waits = 0;
  const responses = [
    new Response(JSON.stringify({ database: "up", status: "ready" }), {
      headers: { "x-capstone-revision": oldRevision },
      status: 200,
    }),
    new Response("unavailable", { status: 503 }),
    new Response(JSON.stringify({ database: "up", status: "ready" }), {
      headers: { "x-capstone-revision": candidateRevision },
      status: 200,
    }),
  ];
  await waitForPublicReadiness(candidateRevision, {
    fetchImplementation: async () => responses.shift(),
    intervalMs: 0,
    maximumAttempts: 3,
    wait: async () => {
      waits += 1;
    },
  });
  assert.equal(waits, 2);
  await assert.rejects(
    waitForPublicReadiness(candidateRevision, {
      fetchImplementation: async () =>
        new Response(JSON.stringify({ database: "up", status: "ready" }), {
          headers: { "x-capstone-revision": oldRevision },
          status: 200,
        }),
      intervalMs: 0,
      maximumAttempts: 2,
      wait: async () => undefined,
    }),
    /did not converge/u,
  );
}

{
  const github = githubFixture();
  const digitalOcean = digitalOceanFixture({
    apps: [predecessorApp, predecessorApp, predecessorApp, forwardApp],
    deployments: history(predecessorSpec),
    expectedUpdateSpec: forwardSpec,
  });
  await assert.rejects(
    runReleaseOperation("deploy", {
      digitalOceanClient: digitalOcean,
      environment: environment(candidateRevision, candidateDigest),
      githubClient: github,
      output: () => undefined,
      readiness: async () => {
        throw new Error("fixture readiness deadline");
      },
    }),
    /fixture readiness deadline/u,
  );
  assert.equal(github.created.length, 0);

  const reconciliationGithub = githubFixture({
    releaseLists: [[acceptedRelease()], [acceptedRelease()]],
  });
  const reconciliationAppHistory = reconciliationHistory(forwardSpec, predecessorSpec);
  const reconciliationDigitalOcean = digitalOceanFixture({
    apps: [forwardApp, forwardApp],
    deployments: reconciliationAppHistory,
  });
  const reconciled = await reconcileLiveRelease({
    digitalOceanClient: reconciliationDigitalOcean,
    environment: environment(candidateRevision, candidateDigest),
    githubClient: reconciliationGithub,
    output: () => undefined,
    readiness: async () => undefined,
  });
  assert.equal(reconciled.operation, "reconcile-deploy");
  assert.equal(reconciliationGithub.created[0].operation, "deploy");
}

{
  let releases = [acceptedRelease()];
  const candidateRelease = acceptedRelease({
    digest: candidateDigest,
    digitalOceanDeploymentId: candidateDeploymentId,
    githubDeploymentId: 43,
    previousDigest: oldDigest,
    previousRevision: oldRevision,
    revision: candidateRevision,
  });
  const github = githubFixture({
    createSuccessfulRelease: async () => {
      releases = [candidateRelease, acceptedRelease()];
      throw new Error("fixture ambiguous GitHub response");
    },
    releaseLists: new Proxy([], {
      get: (_target, property) => (property === "length" ? 1 : releases),
    }),
  });
  github.listAcceptedReleases = async () => structuredClone(releases);
  const options = {
    digitalOceanClient: digitalOceanFixture({
      apps: [forwardApp],
      deployments: reconciliationHistory(forwardSpec, predecessorSpec),
    }),
    environment: environment(candidateRevision, candidateDigest),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  };
  await assert.rejects(reconcileLiveRelease(options), /ambiguous GitHub response/u);
  const repeated = await reconcileLiveRelease(options);
  assert.equal(repeated.operation, "reconcile-already-recorded");
  assert.equal(repeated.githubDeploymentId, 43);
}

for (const [label, github, apps, expected] of [
  [
    "main",
    githubFixture({
      mainHeads: [candidateRevision, movedRevision],
      releaseLists: [[acceptedRelease()], [acceptedRelease()]],
    }),
    [forwardApp, forwardApp],
    /(?:Protected main moved|not protected main HEAD)/u,
  ],
  [
    "spec",
    githubFixture({ releaseLists: [[acceptedRelease()], [acceptedRelease()]] }),
    [forwardApp, { ...forwardApp, updated_at: "2026-08-11T00:03:00Z" }],
    /Live App changed/u,
  ],
]) {
  await assert.rejects(
    reconcileLiveRelease({
      digitalOceanClient: digitalOceanFixture({
        apps,
        deployments: reconciliationHistory(forwardSpec, predecessorSpec),
      }),
      environment: environment(candidateRevision, candidateDigest),
      githubClient: github,
      output: () => undefined,
      readiness: async () => undefined,
    }),
    expected,
    label,
  );
}

{
  const divergentSpec = structuredClone(forwardSpec);
  divergentSpec.services[0].envs.find((entry) => entry.type === "SECRET").value =
    "EV[1:divergent-secret-ciphertext]";
  const divergentApp = app(divergentSpec, candidateDeploymentId, "2026-08-11T00:04:00Z");
  await assert.rejects(
    reconcileLiveRelease({
      digitalOceanClient: digitalOceanFixture({
        apps: [divergentApp],
        deployments: reconciliationHistory(divergentSpec, predecessorSpec),
      }),
      environment: environment(candidateRevision, candidateDigest),
      githubClient: githubFixture({ releaseLists: [[acceptedRelease()]] }),
      output: () => undefined,
      readiness: async () => undefined,
    }),
    /more than the image digest/u,
  );
}

{
  const configuredPredecessor = structuredClone(predecessorSpec);
  configuredPredecessor.services[0].envs.find((entry) => entry.key === "RESEND_API_KEY").value =
    "EV[1:reviewed-config-rotation-ciphertext]";
  const configuredCandidate = patchImageDigest(configuredPredecessor, candidateDigest);
  const configuredCandidateApp = app(
    configuredCandidate,
    candidateDeploymentId,
    "2026-08-11T00:05:00Z",
  );
  const configuredHistory = reconciliationHistory(configuredCandidate, configuredPredecessor);
  configuredHistory[2] = {
    created_at: "2026-08-11T00:00:18Z",
    id: oldDeploymentId,
    phase: "SUPERSEDED",
    spec: predecessorSpec,
  };
  const github = githubFixture({ releaseLists: [[acceptedRelease()], [acceptedRelease()]] });
  const reconciled = await reconcileLiveRelease({
    digitalOceanClient: digitalOceanFixture({
      apps: [configuredCandidateApp, configuredCandidateApp],
      deployments: configuredHistory,
    }),
    environment: environment(candidateRevision, candidateDigest),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  });
  assert.equal(reconciled.operation, "reconcile-deploy");
  assert.equal(github.created[0].previousDigest, oldDigest);
}

{
  const github = githubFixture({
    mainHeads: [movedRevision],
    releaseLists: [[acceptedRelease()], [acceptedRelease()]],
  });
  const reconciled = await reconcileLiveRelease({
    digitalOceanClient: digitalOceanFixture({
      apps: [forwardApp, forwardApp],
      deployments: reconciliationHistory(forwardSpec, predecessorSpec),
    }),
    environment: environment(candidateRevision, candidateDigest, movedRevision),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  });
  assert.equal(reconciled.operation, "reconcile-deploy");
  assert.equal(github.created[0].revision, candidateRevision);
}

{
  const restartDeploymentId = "deployment-candidate-restart";
  const restartedApp = app(forwardSpec, restartDeploymentId, "2026-08-11T00:06:00Z");
  const restartHistory = [
    {
      created_at: "2026-08-11T00:00:21Z",
      id: restartDeploymentId,
      phase: "ACTIVE",
      spec: forwardSpec,
    },
    {
      created_at: "2026-08-11T00:00:20Z",
      id: candidateDeploymentId,
      phase: "SUPERSEDED",
      spec: forwardSpec,
    },
    {
      created_at: "2026-08-11T00:00:19Z",
      id: oldDeploymentId,
      phase: "SUPERSEDED",
      spec: predecessorSpec,
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, 18 - index)).toISOString(),
      id: `deployment-restart-safe-${index}`,
      phase: "SUPERSEDED",
      spec: predecessorSpec,
    })),
  ];
  const github = githubFixture({ releaseLists: [[acceptedRelease()], [acceptedRelease()]] });
  const reconciled = await reconcileLiveRelease({
    digitalOceanClient: digitalOceanFixture({
      apps: [restartedApp, restartedApp],
      deployments: restartHistory,
    }),
    environment: environment(candidateRevision, candidateDigest),
    githubClient: github,
    output: () => undefined,
    readiness: async () => undefined,
  });
  assert.equal(reconciled.digitalOceanDeploymentId, restartDeploymentId);
}

process.stdout.write("App Platform release authority fixtures passed.\n");
