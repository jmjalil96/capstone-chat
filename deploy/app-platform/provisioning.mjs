import { fileURLToPath } from "node:url";
import {
  assertProvisioningTransition,
  DIGEST_PATTERN,
  REVISION_PATTERN,
  readContract,
  renderSpec,
  validateApp,
} from "./contract.mjs";
import { createGitHubClient } from "./github-api.mjs";
import { guardedSpecMutation } from "./mutate-app.mjs";
import { createDigitalOceanClient, waitForDeployment } from "./provider-api.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const MODES = new Set([
  "bootstrap",
  "domain",
  "egress",
  "initialization",
  "live",
  "rehearsal",
  "rehearsal-bootstrap",
  "rehearsal-domain",
  "rehearsal-egress",
  "rehearsal-initialization",
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function required(environment, key, pattern) {
  const value = environment[key];
  assert(typeof value === "string" && value.length > 0, `${key} is required`);
  if (pattern !== undefined) assert(pattern.test(value), `${key} is invalid`);
  return value;
}

function contract(mode) {
  const names = {
    bootstrap: "bootstrap.contract.yaml",
    domain: "domain.contract.yaml",
    egress: "egress.contract.yaml",
    initialization: "initialization.contract.yaml",
    live: "app.contract.yaml",
    rehearsal: "rehearsal.contract.yaml",
    "rehearsal-bootstrap": "rehearsal-bootstrap.contract.yaml",
    "rehearsal-domain": "rehearsal-domain.contract.yaml",
    "rehearsal-egress": "rehearsal-egress.contract.yaml",
    "rehearsal-initialization": "rehearsal-initialization.contract.yaml",
  };
  return readContract(`${directory}${names[mode]}`, mode);
}

async function authority(environment, github) {
  const toolRevision = required(environment, "CAPSTONE_TOOL_REVISION", REVISION_PATTERN);
  const imageRevision = required(environment, "CAPSTONE_IMAGE_REVISION", REVISION_PATTERN);
  assert(toolRevision === imageRevision, "Provisioning tooling and image revisions differ");
  assert(
    (await github.getMainHead()) === toolRevision,
    "Running provisioning tooling is not protected main HEAD",
  );
  await github.requireSuccessfulCi(imageRevision);
  const digest = required(environment, "CAPSTONE_IMAGE_DIGEST", DIGEST_PATTERN);
  assert(
    (await github.getContainerDigestForRevision(imageRevision)) === digest,
    "Provisioning digest is not the immutable CI-published revision artifact",
  );
  return imageRevision;
}

function evidence(app, deploymentId, mode, operation, digest, revision) {
  return {
    appId: app.id,
    dedicatedIps: (app.dedicated_ips ?? [])
      .map((entry) => entry.ip)
      .filter((value) => typeof value === "string")
      .toSorted(),
    deploymentId,
    digest,
    mode,
    operation,
    revision,
    schema: 1,
  };
}

function expectedEgress(environment, sourceMode) {
  if (sourceMode.endsWith("bootstrap")) return undefined;
  const value = required(environment, "CAPSTONE_EXPECTED_EGRESS_IPV4S");
  const addresses = value.split(",").toSorted();
  assert(
    addresses.length === 2 &&
      new Set(addresses).size === 2 &&
      addresses.every(
        (address) =>
          /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(address) &&
          address.split(".").every((part) => Number(part) <= 255),
      ),
    "CAPSTONE_EXPECTED_EGRESS_IPV4S is invalid",
  );
  return addresses;
}

function assertExpectedEgress(app, expected) {
  if (expected === undefined) return;
  const observed = (app.dedicated_ips ?? []).map((entry) => entry?.ip).toSorted();
  assert(
    JSON.stringify(observed) === JSON.stringify(expected),
    "Dedicated egress addresses differ from the frozen provisioning authority",
  );
}

export async function createBootstrapApp({
  digitalOceanClient,
  environment = process.env,
  fetchImplementation = fetch,
  githubClient,
  generalInput,
  output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
  registryInput,
  secretInput,
  waitOptions,
  mode = "bootstrap",
} = {}) {
  assert(["bootstrap", "rehearsal-bootstrap"].includes(mode), "Bootstrap mode is invalid");
  const token = required(environment, "DIGITALOCEAN_TOKEN");
  const githubToken = required(environment, "GITHUB_TOKEN");
  const repository = required(environment, "GITHUB_REPOSITORY").toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Provisioning repository changed");
  const digest = required(environment, "CAPSTONE_IMAGE_DIGEST", DIGEST_PATTERN);
  const digitalOcean =
    digitalOceanClient ?? createDigitalOceanClient({ fetchImplementation, token });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  const revision = await authority(environment, github);
  const bootstrap = contract(mode);
  const existing = (await digitalOcean.listApps()).filter(
    (candidate) => candidate?.spec?.name === bootstrap.name,
  );
  assert(existing.length <= 1, "Multiple production-named Apps exist");
  if (existing.length === 1) {
    const app = await digitalOcean.getApp(existing[0].id);
    validateApp({ app, appId: app.id, contract: bootstrap, digest });
    const result = evidence(
      app,
      app.active_deployment.id,
      mode,
      `${mode}-already-created`,
      digest,
      revision,
    );
    output(result);
    return result;
  }
  const spec = renderSpec({
    contract: bootstrap,
    digest,
    generalInput,
    generalMode: generalInput === undefined ? "preserve" : "introduce",
    registryInput,
    registryMode: "introduce",
    revision,
    secretInput,
    secretMode: secretInput === undefined ? "preserve" : "introduce",
  });
  assert((await github.getMainHead()) === revision, "Protected main moved before App creation");
  assert(
    !(await digitalOcean.listApps()).some((candidate) => candidate?.spec?.name === bootstrap.name),
    "Production-named App appeared before creation",
  );
  const created = await digitalOcean.createApp(spec);
  await waitForDeployment(digitalOcean, created.app.id, created.deploymentId, waitOptions);
  const app = await digitalOcean.getApp(created.app.id);
  validateApp({ app, appId: created.app.id, contract: bootstrap, digest });
  const result = evidence(app, created.deploymentId, mode, `${mode}-created`, digest, revision);
  output(result);
  return result;
}

export async function advanceProvisioningStage(
  sourceMode,
  targetMode,
  {
    digitalOceanClient,
    environment = process.env,
    fetchImplementation = fetch,
    generalInput,
    githubClient,
    output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    registryInput,
    secretInput,
    waitOptions,
  } = {},
) {
  assert(MODES.has(sourceMode) && MODES.has(targetMode), "Provisioning mode is invalid");
  assert(
    sourceMode.startsWith("rehearsal") === targetMode.startsWith("rehearsal"),
    "Production and rehearsal provisioning modes cannot mix",
  );
  assertProvisioningTransition(sourceMode, targetMode);
  const appId = required(environment, "DIGITALOCEAN_APP_ID");
  const baseDeploymentId = required(environment, "CAPSTONE_PROVISIONING_BASE_DEPLOYMENT_ID");
  const token = required(environment, "DIGITALOCEAN_TOKEN");
  const githubToken = required(environment, "GITHUB_TOKEN");
  const repository = required(environment, "GITHUB_REPOSITORY").toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Provisioning repository changed");
  const digest = required(environment, "CAPSTONE_IMAGE_DIGEST", DIGEST_PATTERN);
  const digitalOcean =
    digitalOceanClient ?? createDigitalOceanClient({ fetchImplementation, token });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  const revision = await authority(environment, github);
  const sourceContract = contract(sourceMode);
  const targetContract = contract(targetMode);
  const expectedAddresses = expectedEgress(environment, sourceMode);
  const observed = await digitalOcean.getApp(appId);
  assertExpectedEgress(observed, expectedAddresses);
  if (observed.active_deployment?.id !== baseDeploymentId) {
    validateApp({ app: observed, appId, contract: targetContract, digest });
    assertExpectedEgress(observed, expectedAddresses);
    const successful = (await digitalOcean.listDeployments(appId))
      .filter((deployment) => ["ACTIVE", "SUPERSEDED"].includes(deployment?.phase))
      .toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    assert(
      successful[0]?.id === observed.active_deployment?.id &&
        successful[1]?.id === baseDeploymentId,
      "Provisioning target is not the immediate reviewed-base successor",
    );
    let predecessor = successful[1];
    if (predecessor.spec === undefined) {
      predecessor = await digitalOcean.getDeployment(appId, baseDeploymentId);
    }
    validateApp({
      app: {
        ...observed,
        active_deployment: { id: baseDeploymentId },
        dedicated_ips: sourceMode.endsWith("bootstrap") ? undefined : observed.dedicated_ips,
        spec: predecessor.spec,
      },
      appId,
      contract: sourceContract,
      digest,
    });
    assert(
      (await github.getMainHead()) === revision,
      "Running provisioning tooling is not protected main HEAD",
    );
    const result = evidence(
      observed,
      observed.active_deployment.id,
      targetMode,
      "stage-already-applied",
      digest,
      revision,
    );
    output(result);
    return result;
  }
  const mutation = await guardedSpecMutation({
    appId,
    beforeSubmit: async () => {
      assert(
        (await github.getMainHead()) === revision,
        "Running provisioning tooling is not protected main HEAD",
      );
    },
    buildExpectedSpec: async (app) => {
      assert(
        app.active_deployment?.id === baseDeploymentId,
        "Active deployment differs from the reviewed provisioning base",
      );
      validateApp({ app, appId, contract: sourceContract, digest });
      assertExpectedEgress(app, expectedAddresses);
      return renderSpec({
        contract: targetContract,
        digest,
        generalInput,
        generalMode: generalInput === undefined ? "preserve" : "introduce",
        liveApp: app,
        registryInput,
        registryMode: registryInput === undefined ? "preserve" : "introduce",
        revision,
        secretInput,
        secretMode: secretInput === undefined ? "preserve" : "introduce",
      });
    },
    client: digitalOcean,
    validateFinal: async ({ finalApp }) => {
      validateApp({ app: finalApp, appId, contract: targetContract, digest });
      assertExpectedEgress(finalApp, expectedAddresses);
    },
    waitOptions,
  });
  const app = await digitalOcean.getApp(appId);
  const result = evidence(
    app,
    mutation.deploymentId,
    targetMode,
    "stage-advanced",
    digest,
    revision,
  );
  output(result);
  return result;
}
