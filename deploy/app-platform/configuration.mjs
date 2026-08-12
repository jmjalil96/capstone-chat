import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  assertSafeRollbackHistory,
  DIGEST_PATTERN,
  ENCRYPTED_VALUE_PATTERN,
  liveSemanticSpec,
  REVISION_PATTERN,
  readContract,
  renderSpec,
  validateLiveApp,
} from "./contract.mjs";
import { createGitHubClient } from "./github-api.mjs";
import { guardedSpecMutation } from "./mutate-app.mjs";
import { createDigitalOceanClient } from "./provider-api.mjs";
import { imageDigestFromSpec, waitForPublicReadiness } from "./release.mjs";

const repositoryDirectory = fileURLToPath(new URL(".", import.meta.url));
const OPERATIONS = new Set([
  "domain-attach",
  "domain-detach",
  "maintenance-disable",
  "maintenance-enable",
  "rotate-registry",
  "rotate-runtime-secrets",
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function requiredEnvironment(environment, key) {
  const value = environment[key];
  assert(typeof value === "string" && value.length > 0, `${key} is required`);
  return value;
}

function acceptedAuthority(releases) {
  return JSON.stringify(
    releases.map((release) => ({
      createdAt: release.createdAt,
      deploymentId: release.deploymentId,
      digest: release.digest,
      digitalOceanAppId: release.digitalOceanAppId,
      digitalOceanDeploymentId: release.digitalOceanDeploymentId,
      operation: release.operation,
      revision: release.revision,
    })),
  );
}

function maintenanceEnabled(spec) {
  assert(
    spec?.maintenance !== null &&
      typeof spec?.maintenance === "object" &&
      !Array.isArray(spec.maintenance) &&
      Object.keys(spec.maintenance).length === 1 &&
      typeof spec.maintenance.enabled === "boolean",
    "App maintenance contract changed",
  );
  return spec.maintenance.enabled;
}

function defaultDomain(app) {
  const defaults = (app.spec?.domains ?? []).filter((domain) => domain?.type === "DEFAULT");
  assert(defaults.length === 1, "App must preserve exactly one provider DEFAULT domain");
  const value = defaults[0];
  assert(
    value.zone === undefined &&
      typeof value.domain === "string" &&
      /^[a-z0-9-]+\.ondigitalocean\.app$/u.test(value.domain),
    "Provider DEFAULT domain changed",
  );
  assert(
    [`https://${value.domain}`, `https://${value.domain}/`].includes(app.default_ingress),
    "Provider DEFAULT domain disagrees with its ingress URL",
  );
  return value;
}

function normalizeAttachedApp(app, contract, digest) {
  const normalized = structuredClone(app);
  normalized.spec.maintenance = { enabled: false };
  validateLiveApp({ app: normalized, appId: app.id, contract, digest });
  return normalized;
}

function rootIngress(contract) {
  return {
    rules: [
      {
        component: { name: contract.service.name, preserve_path_prefix: true },
        match: { path: { prefix: "/" } },
      },
    ],
  };
}

export function validateOperationalApp({ app, appId, contract, digest, revision }) {
  assert(app?.id === appId, "DigitalOcean App ID does not match the pinned authority");
  assert(app.in_progress_deployment == null, "A DigitalOcean deployment is already in progress");
  const enabled = maintenanceEnabled(app.spec);
  const domains = app.spec?.domains ?? [];
  const primary = domains.filter((domain) => domain?.type === "PRIMARY");
  const providerDefault = defaultDomain(app);

  if (primary.length === 1) {
    assert(domains.length === 2, "Attached App has an unexpected domain");
    normalizeAttachedApp(app, contract, digest);
    return enabled ? "attached-maintenance" : "attached-ready";
  }

  assert(primary.length === 0 && domains.length === 1, "Detached App domain contract changed");
  assert(enabled, "A detached production domain requires maintenance");
  assert(
    isDeepStrictEqual(app.spec.ingress, rootIngress(contract)),
    "Detached App ingress contract changed",
  );
  const normalized = structuredClone(app);
  const attached = renderSpec({
    contract,
    digest,
    liveApp: app,
    revision,
  });
  normalized.spec.domains = [...attached.domains, providerDefault];
  normalized.spec.ingress = attached.ingress;
  normalized.spec.maintenance = { enabled: false };
  validateLiveApp({ app: normalized, appId, contract, digest });
  return "detached-maintenance";
}

function component(spec, name) {
  const matches = [...(spec.services ?? []), ...(spec.jobs ?? [])].filter(
    (candidate) => candidate?.name === name,
  );
  assert(matches.length === 1, `${name} component authority changed`);
  return matches[0];
}

function selectedSecretPaths(input) {
  assert(input !== undefined, "Runtime secret rotation input is required");
  const components = input.components;
  assert(
    components !== null && typeof components === "object" && !Array.isArray(components),
    "Runtime secret rotation components are invalid",
  );
  const paths = [];
  for (const [componentName, values] of Object.entries(components)) {
    assert(
      values !== null && typeof values === "object" && !Array.isArray(values),
      "Runtime secret rotation component is invalid",
    );
    for (const key of Object.keys(values)) {
      paths.push([componentName, key]);
    }
  }
  assert(paths.length >= 1, "Runtime secret rotation must replace at least one value");
  return paths;
}

function assertOnlySelectedSecretsChanged(beforeApp, afterApp, contract, digest, paths) {
  const before = liveSemanticSpec(normalizeAttachedApp(beforeApp, contract, digest));
  const after = liveSemanticSpec(normalizeAttachedApp(afterApp, contract, digest));
  for (const [componentName, key] of paths) {
    const beforeEntries = component(before, componentName).envs.filter(
      (entry) => entry.key === key,
    );
    const afterEntries = component(after, componentName).envs.filter((entry) => entry.key === key);
    assert(
      beforeEntries.length === 1 && afterEntries.length === 1,
      "Selected runtime secret path changed",
    );
    assert(
      beforeEntries[0].type === "SECRET" && afterEntries[0].type === "SECRET",
      "Selected runtime secret classification changed",
    );
    assert(
      ENCRYPTED_VALUE_PATTERN.test(beforeEntries[0].value) &&
        ENCRYPTED_VALUE_PATTERN.test(afterEntries[0].value),
      "Selected runtime secret is not provider encrypted",
    );
    assert(
      beforeEntries[0].value !== afterEntries[0].value,
      "Runtime secret rotation had no effect",
    );
    afterEntries[0].value = beforeEntries[0].value;
  }
  assert(
    isDeepStrictEqual(before, after),
    "Runtime secret rotation changed an unreviewed App field",
  );
}

function assertOnlyRegistryChanged(beforeApp, afterApp, contract, digest) {
  const before = liveSemanticSpec(normalizeAttachedApp(beforeApp, contract, digest));
  const after = liveSemanticSpec(normalizeAttachedApp(afterApp, contract, digest));
  for (const name of [contract.service.name, contract.job.name]) {
    const beforeImage = component(before, name).image;
    const afterImage = component(after, name).image;
    assert(
      ENCRYPTED_VALUE_PATTERN.test(beforeImage.registry_credentials) &&
        ENCRYPTED_VALUE_PATTERN.test(afterImage.registry_credentials),
      "Registry credential is not provider encrypted",
    );
    assert(
      beforeImage.registry_credentials !== afterImage.registry_credentials,
      "Registry credential rotation had no effect",
    );
    afterImage.registry_credentials = beforeImage.registry_credentials;
  }
  assert(
    isDeepStrictEqual(before, after),
    "Registry credential rotation changed an unreviewed App field",
  );
}

function targetSpec(operation, { app, contract, digest, registryInput, revision, secretInput }) {
  const state = validateOperationalApp({ app, appId: app.id, contract, digest, revision });
  let expected;
  if (operation === "maintenance-enable") {
    assert(state === "attached-ready", "Maintenance can be enabled only from the ready App");
    expected = renderSpec({ contract, digest, liveApp: app, revision });
    expected.maintenance.enabled = true;
  } else if (operation === "maintenance-disable") {
    assert(
      state === "attached-maintenance",
      "Maintenance can be disabled only after the production domain is attached",
    );
    expected = renderSpec({ contract, digest, liveApp: app, revision });
  } else if (operation === "domain-detach") {
    assert(
      state === "attached-maintenance",
      "The production domain can be detached only under maintenance",
    );
    expected = renderSpec({ contract, digest, liveApp: app, revision });
    delete expected.domains;
    expected.ingress = rootIngress(contract);
    expected.maintenance.enabled = true;
  } else if (operation === "domain-attach") {
    assert(
      state === "detached-maintenance",
      "The production domain can be attached only to a detached maintenance App",
    );
    expected = renderSpec({ contract, digest, liveApp: app, revision });
    expected.maintenance.enabled = true;
  } else if (operation === "rotate-runtime-secrets") {
    assert(state !== "detached-maintenance", "Secrets cannot rotate while the domain is detached");
    expected = renderSpec({
      contract,
      digest,
      liveApp: app,
      revision,
      secretInput,
      secretMode: "rotate-selected",
    });
    expected.maintenance.enabled = state === "attached-maintenance";
  } else {
    assert(operation === "rotate-registry", "Configuration operation is invalid");
    assert(state !== "detached-maintenance", "Registry cannot rotate while the domain is detached");
    expected = renderSpec({
      contract,
      digest,
      liveApp: app,
      registryInput,
      registryMode: "rotate",
      revision,
    });
    expected.maintenance.enabled = state === "attached-maintenance";
  }
  return { expected, state };
}

function expectedFinalState(operation, initialState) {
  if (operation === "maintenance-enable") return "attached-maintenance";
  if (operation === "maintenance-disable") return "attached-ready";
  if (operation === "domain-detach") return "detached-maintenance";
  if (operation === "domain-attach") return "attached-maintenance";
  return initialState;
}

function targetAlreadyApplied(operation, state) {
  return (
    (operation === "maintenance-enable" && state === "attached-maintenance") ||
    (operation === "maintenance-disable" && state === "attached-ready") ||
    (operation === "domain-detach" && state === "detached-maintenance") ||
    (operation === "domain-attach" && state === "attached-maintenance")
  );
}

export async function runConfigurationOperation(
  operation,
  {
    digitalOceanClient,
    environment = process.env,
    fetchImplementation = fetch,
    githubClient,
    output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    readiness,
    readinessOptions,
    registryInput,
    secretInput,
  } = {},
) {
  assert(OPERATIONS.has(operation), "Configuration operation is invalid");
  const appId = requiredEnvironment(environment, "DIGITALOCEAN_APP_ID");
  const token = requiredEnvironment(environment, "DIGITALOCEAN_TOKEN");
  const githubToken = requiredEnvironment(environment, "GITHUB_TOKEN");
  const repository = requiredEnvironment(environment, "GITHUB_REPOSITORY").toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Configuration repository changed");
  const toolRevision = requiredEnvironment(environment, "CAPSTONE_TOOL_REVISION");
  assert(REVISION_PATTERN.test(toolRevision), "CAPSTONE_TOOL_REVISION is invalid");
  const baseDeploymentId = requiredEnvironment(
    environment,
    "CAPSTONE_CONFIGURATION_BASE_DEPLOYMENT_ID",
  );
  assert(
    /^[A-Za-z0-9-]{8,128}$/u.test(baseDeploymentId),
    "CAPSTONE_CONFIGURATION_BASE_DEPLOYMENT_ID is invalid",
  );
  const digitalOcean =
    digitalOceanClient ?? createDigitalOceanClient({ fetchImplementation, token });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  const verifyReadiness =
    readiness ??
    ((revision) => waitForPublicReadiness(revision, { fetchImplementation, ...readinessOptions }));
  const contract = readContract(`${repositoryDirectory}app.contract.yaml`, "live");
  assert(
    (await github.getMainHead()) === toolRevision,
    "Running configuration tooling is not protected main HEAD",
  );
  const initialReleases = await github.listAcceptedReleases();
  const activeRelease = initialReleases[0];
  assert(activeRelease !== undefined, "No accepted release authority exists");
  assert(activeRelease.digitalOceanAppId === appId, "Accepted release targets a different App");
  assert(DIGEST_PATTERN.test(activeRelease.digest), "Accepted release digest is invalid");
  assert(REVISION_PATTERN.test(activeRelease.revision), "Accepted release revision is invalid");
  const authority = acceptedAuthority(initialReleases);
  const selectedPaths =
    operation === "rotate-runtime-secrets" ? selectedSecretPaths(secretInput) : [];

  const initialApp = await digitalOcean.getApp(appId);
  assert(
    initialApp.active_deployment?.id === baseDeploymentId,
    "Active deployment differs from the reviewed configuration base",
  );
  assertSafeRollbackHistory(await digitalOcean.listDeployments(appId));
  assert(
    imageDigestFromSpec(initialApp.spec, repository) === activeRelease.digest,
    "Live App is ahead of accepted release authority",
  );
  const initialState = validateOperationalApp({
    app: initialApp,
    appId,
    contract,
    digest: activeRelease.digest,
    revision: activeRelease.revision,
  });

  if (targetAlreadyApplied(operation, initialState)) {
    if (initialState === "attached-ready") await verifyReadiness(activeRelease.revision);
    assert(
      (await github.getMainHead()) === toolRevision,
      "Protected main moved during configuration reconciliation",
    );
    assert(
      acceptedAuthority(await github.listAcceptedReleases()) === authority,
      "Accepted release authority changed during configuration reconciliation",
    );
    const immediate = await digitalOcean.getApp(appId);
    assert(
      immediate.active_deployment?.id === baseDeploymentId,
      "App changed during configuration reconciliation",
    );
    const evidence = {
      appId,
      digest: activeRelease.digest,
      digitalOceanDeploymentId: baseDeploymentId,
      operation: `${operation}-already-applied`,
      revision: activeRelease.revision,
      rotatedValues: 0,
      schema: 1,
    };
    output(evidence);
    return evidence;
  }

  const mutation = await guardedSpecMutation({
    appId,
    beforeSubmit: async () => {
      assert(
        (await github.getMainHead()) === toolRevision,
        "Running configuration tooling is not protected main HEAD",
      );
      assert(
        acceptedAuthority(await github.listAcceptedReleases()) === authority,
        "Accepted release authority changed before configuration submission",
      );
    },
    buildExpectedSpec: async (app) => {
      assert(
        app.active_deployment?.id === baseDeploymentId,
        "Active deployment differs from the reviewed configuration base",
      );
      assert(
        imageDigestFromSpec(app.spec, repository) === activeRelease.digest,
        "Live App is ahead of accepted release authority",
      );
      return targetSpec(operation, {
        app,
        contract,
        digest: activeRelease.digest,
        registryInput,
        revision: activeRelease.revision,
        secretInput,
      }).expected;
    },
    client: digitalOcean,
    validateFinal: async ({ finalApp, initialApp: submittedFrom }) => {
      const finalState = validateOperationalApp({
        app: finalApp,
        appId,
        contract,
        digest: activeRelease.digest,
        revision: activeRelease.revision,
      });
      assert(
        finalState === expectedFinalState(operation, initialState),
        "Configuration operation reached the wrong state",
      );
      if (operation === "rotate-runtime-secrets") {
        assertOnlySelectedSecretsChanged(
          submittedFrom,
          finalApp,
          contract,
          activeRelease.digest,
          selectedPaths,
        );
      } else if (operation === "rotate-registry") {
        assertOnlyRegistryChanged(submittedFrom, finalApp, contract, activeRelease.digest);
      }
      if (finalState === "attached-ready") {
        await verifyReadiness(activeRelease.revision);
      }
    },
  });

  const immediateReleases = await github.listAcceptedReleases();
  assert(
    acceptedAuthority(immediateReleases) === authority,
    "Accepted release authority changed during configuration",
  );
  const evidence = {
    appId,
    digest: activeRelease.digest,
    digitalOceanDeploymentId: mutation.deploymentId,
    operation,
    revision: activeRelease.revision,
    rotatedValues:
      operation === "rotate-runtime-secrets"
        ? selectedPaths.length
        : operation === "rotate-registry"
          ? 2
          : 0,
    schema: 1,
  };
  output(evidence);
  return evidence;
}
