import { fileURLToPath } from "node:url";
import {
  assertSafeRollbackHistory,
  DIGEST_PATTERN,
  liveFingerprint,
  REVISION_PATTERN,
  readContract,
  validateApp,
  validateLiveApp,
} from "./contract.mjs";
import { createGitHubClient } from "./github-api.mjs";
import {
  assertDigestOnlyPatch,
  guardedSpecMutation,
  guardedUnchangedRedeployment,
} from "./mutate-app.mjs";
import { createDigitalOceanClient } from "./provider-api.mjs";

const repositoryDirectory = fileURLToPath(new URL(".", import.meta.url));

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function requiredEnvironment(environment, key, pattern) {
  const value = environment[key];
  assert(typeof value === "string" && value.length > 0, `${key} is required`);
  if (pattern !== undefined) {
    assert(pattern.test(value), `${key} is invalid`);
  }
  return value;
}

function toolRevision(environment) {
  return requiredEnvironment(environment, "CAPSTONE_TOOL_REVISION", REVISION_PATTERN);
}

async function assertCurrentTooling(github, environment) {
  assert(
    (await github.getMainHead()) === toolRevision(environment),
    "Running deployment tooling is not protected main HEAD",
  );
}

export function imageDigestFromSpec(spec, repository) {
  const [registry, imageRepository, ...unexpected] = repository.split("/");
  assert(
    registry !== undefined && imageRepository !== undefined && unexpected.length === 0,
    "Image repository authority is invalid",
  );
  const components = [...(spec?.services ?? []), ...(spec?.jobs ?? [])];
  assert(components.length === 2, "Steady App must have exactly two image-bearing components");
  const digests = new Set();
  for (const component of components) {
    const image = component?.image;
    assert(image?.registry_type === "GHCR", "Live image registry type changed");
    assert(image?.registry === registry, "Live image registry owner changed");
    assert(image?.repository === imageRepository, "Live image repository changed");
    assert(
      typeof image?.digest === "string" && DIGEST_PATTERN.test(image.digest),
      "Live image digest is invalid",
    );
    assert(
      image.tag === undefined && image.deploy_on_push === undefined,
      "Mutable image selection is prohibited",
    );
    digests.add(image.digest);
  }
  assert(digests.size === 1, "Service and migration job digests differ");
  return [...digests][0];
}

export function patchImageDigest(spec, digest) {
  assert(DIGEST_PATTERN.test(digest), "Candidate image digest is invalid");
  const patched = structuredClone(spec);
  for (const collection of [patched.services, patched.jobs]) {
    for (const component of collection ?? []) {
      component.image.digest = digest;
      delete component.image.tag;
      delete component.image.deploy_on_push;
    }
  }
  assertDigestOnlyPatch(spec, patched, digest);
  return patched;
}

export async function waitForPublicReadiness(
  revision,
  {
    fetchImplementation = fetch,
    intervalMs = 2_000,
    maximumAttempts = 30,
    origin = "https://chat.capstone.com.ec",
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  assert(REVISION_PATTERN.test(revision), "Public readiness revision is invalid");
  assert(
    Number.isSafeInteger(maximumAttempts) && maximumAttempts >= 1 && maximumAttempts <= 60,
    "Public readiness attempt bound is invalid",
  );
  assert(
    ["https://chat.capstone.com.ec", "https://rehearsal.chat.capstone.com.ec"].includes(origin),
    "Public readiness origin is invalid",
  );
  assert(
    Number.isSafeInteger(intervalMs) && intervalMs >= 0 && intervalMs <= 10_000,
    "Public readiness interval is invalid",
  );
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const response = await fetchImplementation(`${origin}/api/health/ready`, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 200 && response.headers.get("x-capstone-revision") === revision) {
        const body = await response.json();
        if (body?.status === "ready" && body?.database === "up") {
          return;
        }
      }
    } catch {
      // A rollout can expose an old edge response briefly; only the bounded deadline is terminal.
    }
    if (attempt + 1 < maximumAttempts) {
      await wait(intervalMs);
    }
  }
  fail("Public readiness did not converge to the exact release");
}

function releasePayload({
  activeRelease,
  appId,
  candidateDigest,
  candidateRevision,
  ci,
  deploymentId,
  operation,
  repository,
}) {
  return {
    ciRunId: ci.id,
    ciWorkflowUrl: ci.url,
    digest: candidateDigest,
    digitalOceanAppId: appId,
    digitalOceanDeploymentId: deploymentId,
    image: `ghcr.io/${repository}@${candidateDigest}`,
    operation,
    previousDigest: activeRelease?.digest ?? "",
    previousRevision: activeRelease?.revision ?? "",
    revision: candidateRevision,
    schema: 2,
    type: "release",
  };
}

export async function adoptInitialBaseline({
  digitalOceanClient,
  environment = process.env,
  fetchImplementation = fetch,
  githubClient,
  output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
  readiness,
  readinessOptions,
} = {}) {
  const appId = requiredEnvironment(environment, "DIGITALOCEAN_APP_ID");
  const digitalOceanToken = requiredEnvironment(environment, "DIGITALOCEAN_TOKEN");
  const githubToken = requiredEnvironment(environment, "GITHUB_TOKEN");
  const repository = requiredEnvironment(
    environment,
    "GITHUB_REPOSITORY",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  ).toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Deployment repository changed");
  const revision = requiredEnvironment(environment, "CAPSTONE_IMAGE_REVISION", REVISION_PATTERN);
  const digest = requiredEnvironment(environment, "CAPSTONE_IMAGE_DIGEST", DIGEST_PATTERN);
  const contract = readContract(`${repositoryDirectory}app.contract.yaml`, "live");
  const digitalOcean =
    digitalOceanClient ??
    createDigitalOceanClient({ fetchImplementation, token: digitalOceanToken });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  const verifyReadiness =
    readiness ??
    ((targetRevision) =>
      waitForPublicReadiness(targetRevision, { fetchImplementation, ...readinessOptions }));
  await assertCurrentTooling(github, environment);
  assert((await github.getMainHead()) === revision, "Initial baseline is not protected main HEAD");
  const ci = await github.requireSuccessfulCi(revision);
  const initialReleases = await github.listAcceptedReleases();

  const initial = await digitalOcean.getApp(appId);
  assertSafeRollbackHistory(await digitalOcean.listDeployments(appId));
  validateLiveApp({ app: initial, appId, contract, digest });
  assert(
    imageDigestFromSpec(initial.spec, repository) === digest,
    "Initial baseline digest changed",
  );
  assert(
    typeof initial.active_deployment?.id === "string",
    "Initial baseline has no active deployment",
  );
  await verifyReadiness(revision);
  const fingerprint = liveFingerprint(initial);

  if (initialReleases.length > 0) {
    const existing = initialReleases[0];
    assert(
      initialReleases.length === 1 &&
        existing.operation === "initial" &&
        existing.digitalOceanAppId === appId &&
        existing.digitalOceanDeploymentId === initial.active_deployment.id &&
        existing.digest === digest &&
        existing.revision === revision &&
        existing.previousDigest === "" &&
        existing.previousRevision === "",
      "Accepted release baseline does not match the exact initial App",
    );
    await assertCurrentTooling(github, environment);
    const immediate = await digitalOcean.getApp(appId);
    assert(
      liveFingerprint(immediate) === fingerprint,
      "Live App changed during baseline reconciliation",
    );
    assert(
      acceptedReleaseAuthority(await github.listAcceptedReleases()) ===
        acceptedReleaseAuthority(initialReleases),
      "Accepted release authority changed during baseline reconciliation",
    );
    const evidence = {
      appId,
      digest,
      digitalOceanDeploymentId: initial.active_deployment.id,
      githubDeploymentId: existing.deploymentId,
      operation: "initial-baseline-already-recorded",
      revision,
      schema: 1,
    };
    output(evidence);
    return evidence;
  }

  assert(
    (await github.getMainHead()) === revision,
    "Protected main HEAD moved before baseline adoption",
  );
  await assertCurrentTooling(github, environment);
  const immediate = await digitalOcean.getApp(appId);
  assert(liveFingerprint(immediate) === fingerprint, "Live App changed before baseline adoption");
  assert(
    (await github.listAcceptedReleases()).length === 0,
    "Accepted release authority changed before baseline adoption",
  );
  const githubDeploymentId = await github.createSuccessfulRelease(
    releasePayload({
      activeRelease: undefined,
      appId,
      candidateDigest: digest,
      candidateRevision: revision,
      ci,
      deploymentId: initial.active_deployment.id,
      operation: "initial",
      repository,
    }),
  );
  const evidence = {
    appId,
    digest,
    digitalOceanDeploymentId: initial.active_deployment.id,
    githubDeploymentId,
    operation: "initial-baseline",
    revision,
    schema: 1,
  };
  output(evidence);
  return evidence;
}

function assertActiveRelease(app, activeRelease, appId, repository) {
  assert(activeRelease !== undefined, "No accepted active production release exists");
  assert(activeRelease.digitalOceanAppId === appId, "Accepted release targets a different App");
  const activeDigest = imageDigestFromSpec(app.spec, repository);
  assert(
    activeDigest === activeRelease.digest,
    "Live App digest differs from accepted release authority",
  );
  return activeDigest;
}

function acceptedReleaseAuthority(releases) {
  return JSON.stringify(
    releases.map((release) => ({
      createdAt: release.createdAt,
      deploymentId: release.deploymentId,
      digest: release.digest,
      digitalOceanAppId: release.digitalOceanAppId,
      digitalOceanDeploymentId: release.digitalOceanDeploymentId,
      operation: release.operation,
      previousDigest: release.previousDigest,
      previousRevision: release.previousRevision,
      revision: release.revision,
    })),
  );
}

function exactRecordedCandidate(release, app, appId, digest, revision) {
  return (
    release?.digitalOceanAppId === appId &&
    release?.digitalOceanDeploymentId === app.active_deployment?.id &&
    release?.digest === digest &&
    release?.revision === revision
  );
}

export async function runReleaseOperation(
  operation,
  {
    digitalOceanClient,
    environment = process.env,
    fetchImplementation = fetch,
    githubClient,
    output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    readiness,
    readinessOptions,
  } = {},
) {
  assert(["deploy", "rollback"].includes(operation), "Release operation is invalid");
  const appId = requiredEnvironment(environment, "DIGITALOCEAN_APP_ID");
  const digitalOceanToken = requiredEnvironment(environment, "DIGITALOCEAN_TOKEN");
  const githubToken = requiredEnvironment(environment, "GITHUB_TOKEN");
  const repository = requiredEnvironment(
    environment,
    "GITHUB_REPOSITORY",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  ).toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Deployment repository changed");
  const requestedDigest = requiredEnvironment(environment, "CAPSTONE_IMAGE_DIGEST", DIGEST_PATTERN);
  const requestedRevision = requiredEnvironment(
    environment,
    "CAPSTONE_IMAGE_REVISION",
    REVISION_PATTERN,
  );
  const contract = readContract(`${repositoryDirectory}app.contract.yaml`, "live");
  const digitalOcean =
    digitalOceanClient ??
    createDigitalOceanClient({ fetchImplementation, token: digitalOceanToken });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  const verifyReadiness =
    readiness ??
    ((targetRevision) =>
      waitForPublicReadiness(targetRevision, { fetchImplementation, ...readinessOptions }));
  await assertCurrentTooling(github, environment);

  const initialApp = await digitalOcean.getApp(appId);
  const history = await digitalOcean.listDeployments(appId);
  assertSafeRollbackHistory(history);
  const releases = await github.listAcceptedReleases();
  const activeRelease = releases[0];
  const activeDigest = assertActiveRelease(initialApp, activeRelease, appId, repository);
  validateLiveApp({ app: initialApp, appId, contract, digest: activeDigest });

  let candidateDigest = requestedDigest;
  let candidateRevision = requestedRevision;
  if (operation === "deploy") {
    const mainHead = await github.getMainHead();
    assert(candidateRevision === mainHead, "Normal deployment revision is not protected main HEAD");
    await github.assertStrictForward(activeRelease.revision, candidateRevision);
  } else {
    candidateDigest = activeRelease.previousDigest;
    candidateRevision = activeRelease.previousRevision;
    assert(
      requestedDigest === candidateDigest && requestedRevision === candidateRevision,
      "Rollback input is not the immediately previous compatible release",
    );
    assert(
      releases.some(
        (release) => release.digest === candidateDigest && release.revision === candidateRevision,
      ),
      "Rollback predecessor has no accepted release evidence",
    );
  }
  assert(candidateDigest !== activeDigest, "Release candidate is already active");
  const ci = await github.requireSuccessfulCi(candidateRevision);

  const mutation = await guardedSpecMutation({
    appId,
    beforeSubmit: async () => {
      await assertCurrentTooling(github, environment);
      if (operation === "deploy") {
        assert(
          (await github.getMainHead()) === candidateRevision,
          "Protected main HEAD moved before submission",
        );
      }
    },
    buildExpectedSpec: async (app) => {
      assertActiveRelease(app, activeRelease, appId, repository);
      validateLiveApp({ app, appId, contract, digest: activeDigest });
      return patchImageDigest(app.spec, candidateDigest);
    },
    client: digitalOcean,
    validateFinal: async ({ finalApp }) => {
      validateLiveApp({ app: finalApp, appId, contract, digest: candidateDigest });
      await verifyReadiness(candidateRevision);
    },
  });
  const githubDeploymentId = await github.createSuccessfulRelease(
    releasePayload({
      activeRelease,
      appId,
      candidateDigest,
      candidateRevision,
      ci,
      deploymentId: mutation.deploymentId,
      operation,
      repository,
    }),
  );
  const evidence = {
    appId,
    digest: candidateDigest,
    digitalOceanDeploymentId: mutation.deploymentId,
    githubDeploymentId,
    operation,
    revision: candidateRevision,
    schema: 1,
  };
  output(evidence);
  return evidence;
}

export async function reconcileLiveRelease({
  digitalOceanClient,
  environment = process.env,
  fetchImplementation = fetch,
  githubClient,
  output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
  readiness,
  readinessOptions,
} = {}) {
  const appId = requiredEnvironment(environment, "DIGITALOCEAN_APP_ID");
  const digitalOceanToken = requiredEnvironment(environment, "DIGITALOCEAN_TOKEN");
  const githubToken = requiredEnvironment(environment, "GITHUB_TOKEN");
  const repository = requiredEnvironment(
    environment,
    "GITHUB_REPOSITORY",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  ).toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Deployment repository changed");
  const candidateDigest = requiredEnvironment(environment, "CAPSTONE_IMAGE_DIGEST", DIGEST_PATTERN);
  const candidateRevision = requiredEnvironment(
    environment,
    "CAPSTONE_IMAGE_REVISION",
    REVISION_PATTERN,
  );
  const digitalOcean =
    digitalOceanClient ??
    createDigitalOceanClient({ fetchImplementation, token: digitalOceanToken });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  const verifyReadiness =
    readiness ??
    ((targetRevision) =>
      waitForPublicReadiness(targetRevision, { fetchImplementation, ...readinessOptions }));
  const contract = readContract(`${repositoryDirectory}app.contract.yaml`, "live");

  const mainHead = await github.getMainHead();
  assert(
    mainHead === toolRevision(environment),
    "Running deployment tooling is not protected main HEAD",
  );
  const releases = await github.listAcceptedReleases();
  const activeRelease = releases[0];
  assert(activeRelease !== undefined, "No accepted release authority exists for reconciliation");
  assert(activeRelease.digitalOceanAppId === appId, "Accepted release targets a different App");
  const initialAuthority = acceptedReleaseAuthority(releases);
  const liveApp = await digitalOcean.getApp(appId);
  const history = await digitalOcean.listDeployments(appId);
  assertSafeRollbackHistory(history);
  validateLiveApp({ app: liveApp, appId, contract, digest: candidateDigest });
  assert(
    imageDigestFromSpec(liveApp.spec, repository) === candidateDigest,
    "Live App does not match the requested reconciliation digest",
  );
  assert(
    typeof liveApp.active_deployment?.id === "string",
    "Live App has no active deployment to reconcile",
  );
  const fingerprint = liveFingerprint(liveApp);
  const ci = await github.requireSuccessfulCi(candidateRevision);
  await verifyReadiness(candidateRevision);

  if (exactRecordedCandidate(activeRelease, liveApp, appId, candidateDigest, candidateRevision)) {
    assert((await github.getMainHead()) === mainHead, "Protected main moved during reconciliation");
    assert(
      liveFingerprint(await digitalOcean.getApp(appId)) === fingerprint,
      "Live App changed during reconciliation",
    );
    const evidence = {
      appId,
      digest: candidateDigest,
      digitalOceanDeploymentId: liveApp.active_deployment.id,
      githubDeploymentId: activeRelease.deploymentId,
      operation: "reconcile-already-recorded",
      revision: candidateRevision,
      schema: 1,
    };
    output(evidence);
    return evidence;
  }

  let releaseOperation;
  let forwardCandidate = false;
  try {
    await github.assertStrictForward(activeRelease.revision, candidateRevision);
    if (candidateRevision !== mainHead) {
      await github.assertStrictForward(candidateRevision, mainHead);
    }
    forwardCandidate = true;
  } catch {
    forwardCandidate = false;
  }
  if (forwardCandidate) {
    releaseOperation = "deploy";
  } else {
    assert(
      activeRelease.previousRevision === candidateRevision &&
        activeRelease.previousDigest === candidateDigest &&
        releases.some(
          (release) => release.revision === candidateRevision && release.digest === candidateDigest,
        ),
      "Live candidate is neither protected-main forward progress nor the accepted predecessor",
    );
    releaseOperation = "rollback";
  }

  const successfulHistory = history
    .filter((deployment) => ["ACTIVE", "SUPERSEDED"].includes(deployment?.phase))
    .toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  assert(
    successfulHistory[0]?.id === liveApp.active_deployment.id,
    "Live candidate is not the newest successful provider deployment",
  );
  let previousDeployment;
  for (const deployment of successfulHistory.slice(1)) {
    let candidate = deployment;
    if (candidate.spec === undefined) {
      candidate = await digitalOcean.getDeployment(appId, candidate.id);
    }
    const deploymentDigest = imageDigestFromSpec(candidate.spec, repository);
    if (deploymentDigest === candidateDigest) {
      assert(
        JSON.stringify(candidate.spec) === JSON.stringify(liveApp.spec),
        "Same-digest provider restart changed the live specification",
      );
      continue;
    }
    previousDeployment = candidate;
    break;
  }
  assert(
    previousDeployment !== undefined,
    "Live candidate has no accepted-digest provider predecessor",
  );
  assert(
    imageDigestFromSpec(previousDeployment.spec, repository) === activeRelease.digest,
    "Accepted predecessor image authority changed",
  );
  validateLiveApp({
    app: {
      ...liveApp,
      active_deployment: { id: previousDeployment.id },
      in_progress_deployment: null,
      spec: previousDeployment.spec,
    },
    appId,
    contract,
    digest: activeRelease.digest,
  });
  assertDigestOnlyPatch(previousDeployment.spec, liveApp.spec, candidateDigest);

  const immediateReleases = await github.listAcceptedReleases();
  await assertCurrentTooling(github, environment);
  assert((await github.getMainHead()) === mainHead, "Protected main moved during reconciliation");
  const immediateApp = await digitalOcean.getApp(appId);
  assert(liveFingerprint(immediateApp) === fingerprint, "Live App changed during reconciliation");
  if (
    exactRecordedCandidate(immediateReleases[0], liveApp, appId, candidateDigest, candidateRevision)
  ) {
    const evidence = {
      appId,
      digest: candidateDigest,
      digitalOceanDeploymentId: liveApp.active_deployment.id,
      githubDeploymentId: immediateReleases[0].deploymentId,
      operation: "reconcile-already-recorded",
      revision: candidateRevision,
      schema: 1,
    };
    output(evidence);
    return evidence;
  }
  assert(
    acceptedReleaseAuthority(immediateReleases) === initialAuthority,
    "Accepted release authority changed during reconciliation",
  );
  const githubDeploymentId = await github.createSuccessfulRelease(
    releasePayload({
      activeRelease,
      appId,
      candidateDigest,
      candidateRevision,
      ci,
      deploymentId: liveApp.active_deployment.id,
      operation: releaseOperation,
      repository,
    }),
  );
  const evidence = {
    appId,
    digest: candidateDigest,
    digitalOceanDeploymentId: liveApp.active_deployment.id,
    githubDeploymentId,
    operation: `reconcile-${releaseOperation}`,
    revision: candidateRevision,
    schema: 1,
  };
  output(evidence);
  return evidence;
}

export async function evictUnsafeHistory({
  digitalOceanClient,
  environment = process.env,
  fetchImplementation = fetch,
  githubClient,
  output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
  mode = "live",
  readiness,
  readinessOptions,
} = {}) {
  assert(["live", "rehearsal"].includes(mode), "History eviction mode is invalid");
  const appId = requiredEnvironment(environment, "DIGITALOCEAN_APP_ID");
  const digitalOceanToken = requiredEnvironment(environment, "DIGITALOCEAN_TOKEN");
  const githubToken = requiredEnvironment(environment, "GITHUB_TOKEN");
  const repository = requiredEnvironment(
    environment,
    "GITHUB_REPOSITORY",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  ).toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Deployment repository changed");
  const revision = requiredEnvironment(environment, "CAPSTONE_IMAGE_REVISION", REVISION_PATTERN);
  const digest = requiredEnvironment(environment, "CAPSTONE_IMAGE_DIGEST", DIGEST_PATTERN);
  const contract = readContract(
    `${repositoryDirectory}${mode === "live" ? "app" : "rehearsal"}.contract.yaml`,
    mode,
  );
  const expectedClassification = mode === "live" ? "steady" : "steady-rehearsal";
  const validateSteadyApp = ({ app }) => {
    if (mode === "live") {
      return validateLiveApp({ app, appId, contract, digest });
    }
    return validateApp({ app, contract, digest });
  };
  const digitalOcean =
    digitalOceanClient ??
    createDigitalOceanClient({ fetchImplementation, token: digitalOceanToken });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  const verifyReadiness =
    readiness ??
    ((targetRevision) =>
      waitForPublicReadiness(targetRevision, {
        fetchImplementation,
        origin:
          mode === "live"
            ? "https://chat.capstone.com.ec"
            : "https://rehearsal.chat.capstone.com.ec",
        ...readinessOptions,
      }));
  await assertCurrentTooling(github, environment);
  assert(
    (await github.getMainHead()) === revision,
    "History eviction revision is not protected main HEAD",
  );
  await github.requireSuccessfulCi(revision);
  const initial = await digitalOcean.getApp(appId);
  validateSteadyApp({ app: initial });

  let created = 0;
  for (; created < 10; created += 1) {
    const history = await digitalOcean.listDeployments(appId);
    try {
      assertSafeRollbackHistory(history, { expectedClassification });
      const evidence = {
        appId,
        digest,
        evictionsCreated: created,
        operation: "history-eviction",
        revision,
        schema: 1,
      };
      output(evidence);
      return evidence;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        ![
          "Ten successful rollbackable deployments are required",
          "Unsafe bootstrap history remains rollbackable",
        ].includes(error.message)
      ) {
        throw error;
      }
    }
    await guardedUnchangedRedeployment({
      appId,
      client: digitalOcean,
      validateFinal: async ({ finalApp }) => {
        validateSteadyApp({ app: finalApp });
        await verifyReadiness(revision);
      },
    });
  }
  assertSafeRollbackHistory(await digitalOcean.listDeployments(appId), {
    expectedClassification,
  });
  const evidence = {
    appId,
    digest,
    evictionsCreated: created,
    operation: "history-eviction",
    revision,
    schema: 1,
  };
  output(evidence);
  return evidence;
}
