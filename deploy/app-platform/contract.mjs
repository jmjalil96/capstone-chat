import { closeSync, constants, lstatSync, openSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
export const ENCRYPTED_VALUE_PATTERN = /^EV\[[^\r\n]{8,2048}\]$/u;

const environments = new Set(["staging", "production"]);
const otlpEndpoints = new Set(["https://otlp.nr-data.net", "https://otlp.eu01.nr-data.net"]);
const revisionBinding = ["$", "{_self.COMMIT_HASH}"].join("");
const starterDomainBinding = ["$", "{STARTER_DOMAIN}"].join("");
const edgeFields = [
  "disable_edge_cache",
  "disable_email_obfuscation",
  "enhanced_threat_control_enabled",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} is invalid`,
  );
  return value;
}

function equal(actual, expected, label) {
  assert(isDeepStrictEqual(actual, expected), `${label} changed`);
}

function exactKeys(value, expected, label) {
  equal(Object.keys(record(value, label)).sort(), [...expected].sort(), `${label} keys`);
}

function deeplyFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deeplyFreeze(child);
    }
  }
  return value;
}

const commonContract = deeplyFreeze({
  alerts: {
    app: ["DEPLOYMENT_FAILED", "DEPLOYMENT_LIVE", "DOMAIN_FAILED"],
    service: {
      cpu_percent: 85,
      memory_percent: 85,
      request_duration_p95_ms: 750,
      restart_count: 1,
    },
  },
  edge: {
    disable_edge_cache: true,
    disable_email_obfuscation: true,
    enhanced_threat_control_enabled: false,
  },
  features: ["buildpack-stack=ubuntu-22"],
  job: {
    environment: {
      general: {
        DEPLOYMENT_REVISION: revisionBinding,
        NODE_ENV: "production",
      },
      secret_keys: ["DATABASE_URL"],
    },
    grace_period_seconds: 300,
    instance_count: 1,
    kind: "PRE_DEPLOY",
    name: "capstone-migrate",
    run_command: "node apps/api/dist/entrypoint.js migrate",
  },
  region: "ric",
  service: {
    drain_seconds: 110,
    environment: {
      general: {
        DEPLOYMENT_REVISION: revisionBinding,
        EMAIL_DELIVERY: "resend",
        HOST: "0.0.0.0",
        LOG_LEVEL: "info",
        MODEL_GATEWAY: "openrouter",
        NODE_ENV: "production",
        PORT: "3000",
      },
      general_keys: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
      secret_keys: [
        "BETTER_AUTH_SECRET",
        "DATABASE_URL",
        "OPENROUTER_API_KEY",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "RESEND_API_KEY",
      ],
    },
    grace_period_seconds: 300,
    http_port: 3000,
    instance_count: 1,
    liveness_path: "/api/health/live",
    name: "capstone-chat",
    readiness_path: "/api/health/ready",
    run_command: "node apps/api/dist/entrypoint.js server",
  },
  source: {
    dockerfile_path: "apps/api/Dockerfile",
    github: { deploy_on_push: false, repo: "jmjalil96/capstone-chat" },
    source_dir: "/",
  },
});

const environmentOverlays = deeplyFreeze({
  staging: {
    branch: "app-platform-staging",
    dedicatedEgress: false,
    domain: "staging.chat.capstone.com.ec",
    jobSizeSlug: "apps-s-1vcpu-0.5gb",
    name: "capstone-chat-staging",
    serviceEnvironment: {
      general: {
        CAPSTONE_ENVIRONMENT: "staging",
        EMAIL_FROM: "Capstone Chat Staging <no-reply@staging.mail.capstone.com.ec>",
        PUBLIC_ORIGIN: "https://staging.chat.capstone.com.ec",
      },
      secret_keys: ["CAPSTONE_STAGING_EMAIL_RECIPIENTS"],
    },
    serviceSizeSlug: "apps-s-1vcpu-0.5gb",
  },
  production: {
    branch: "app-platform-production",
    dedicatedEgress: true,
    domain: "chat.capstone.com.ec",
    jobSizeSlug: "apps-s-1vcpu-0.5gb",
    name: "capstone-chat-production",
    serviceEnvironment: {
      general: {
        CAPSTONE_ENVIRONMENT: "production",
        EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
        PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
      },
      secret_keys: [],
    },
    serviceSizeSlug: "apps-s-1vcpu-1gb-fixed",
  },
});

function createContract(environment, overlay) {
  return deeplyFreeze({
    alerts: commonContract.alerts,
    dedicatedEgress: overlay.dedicatedEgress,
    domain: {
      domain: overlay.domain,
      minimum_tls_version: "1.2",
      type: "PRIMARY",
    },
    edge: commonContract.edge,
    environment,
    features: commonContract.features,
    job: {
      ...commonContract.job,
      environment: {
        general: {
          ...commonContract.job.environment.general,
          CAPSTONE_ENVIRONMENT: environment,
          ...(overlay.jobEnvironment?.general ?? {}),
        },
        secret_keys: commonContract.job.environment.secret_keys,
      },
      instance_size_slug: overlay.jobSizeSlug,
    },
    name: overlay.name,
    region: commonContract.region,
    service: {
      ...commonContract.service,
      environment: {
        general: {
          ...commonContract.service.environment.general,
          ...overlay.serviceEnvironment.general,
        },
        general_keys: commonContract.service.environment.general_keys,
        secret_keys: [
          ...commonContract.service.environment.secret_keys,
          ...overlay.serviceEnvironment.secret_keys,
        ],
      },
      instance_size_slug: overlay.serviceSizeSlug,
    },
    source: {
      ...commonContract.source,
      github: { ...commonContract.source.github, branch: overlay.branch },
    },
  });
}

const hostedContracts = deeplyFreeze({
  production: createContract("production", environmentOverlays.production),
  staging: createContract("staging", environmentOverlays.staging),
});

export function readContract(environment) {
  assert(environments.has(environment), "Hosted environment is invalid");
  return hostedContracts[environment];
}

export function readProtectedJson(path, label = "Protected JSON", maximumBytes = 512 * 1024) {
  const status = lstatSync(path);
  assert(status.isFile() && !status.isSymbolicLink(), `${label} must be a regular file`);
  assert(status.uid === process.getuid(), `${label} owner is invalid`);
  assert((status.mode & 0o777) === 0o600, `${label} mode must be 0600`);
  assert(status.size >= 2 && status.size <= maximumBytes, `${label} size is invalid`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    if (Array.isArray(parsed)) {
      assert(parsed.length === 1, `${label} must contain exactly one App`);
    }
    record(Array.isArray(parsed) ? parsed[0] : parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} is not valid JSON`);
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function unwrapApp(value) {
  if (Array.isArray(value)) {
    assert(value.length === 1, "DigitalOcean response must contain exactly one App");
  }
  const outer = record(Array.isArray(value) ? value[0] : value, "DigitalOcean response");
  return outer.app === undefined ? outer : record(outer.app, "DigitalOcean App");
}

function sourceFields(source) {
  const github = record(source.github, "GitHub source");
  return {
    dockerfile_path: source.dockerfile_path,
    github: {
      branch: github.branch,
      deploy_on_push: github.deploy_on_push ?? false,
      repo: github.repo,
    },
    source_dir: source.source_dir,
  };
}

function componentEnvironment(declaration, actual, componentName) {
  assert(Array.isArray(actual), `${componentName} environment is missing`);
  const entries = new Map();
  for (const value of actual) {
    const entry = record(value, `${componentName} environment entry`);
    assert(
      typeof entry.key === "string" && !entries.has(entry.key),
      `${componentName} environment key is duplicated`,
    );
    entries.set(entry.key, entry);
  }
  const expectedKeys = [
    ...Object.keys(declaration.general),
    ...(declaration.general_keys ?? []),
    ...declaration.secret_keys,
  ];
  equal([...entries.keys()].sort(), expectedKeys.sort(), `${componentName} environment keys`);
  for (const [key, value] of Object.entries(declaration.general)) {
    const entry = entries.get(key);
    assert(
      entry?.scope === "RUN_TIME" &&
        (entry.type === undefined || entry.type === "GENERAL") &&
        entry.value === value,
      `${componentName}.${key} changed`,
    );
  }
  for (const key of declaration.general_keys ?? []) {
    const entry = entries.get(key);
    assert(
      entry?.scope === "RUN_TIME" &&
        (entry.type === undefined || entry.type === "GENERAL") &&
        key === "OTEL_EXPORTER_OTLP_ENDPOINT" &&
        otlpEndpoints.has(entry.value),
      `${componentName}.${key} is invalid`,
    );
  }
  for (const key of declaration.secret_keys) {
    const entry = entries.get(key);
    assert(
      entry?.scope === "RUN_TIME" &&
        entry.type === "SECRET" &&
        ENCRYPTED_VALUE_PATTERN.test(entry.value),
      `${componentName}.${key} is not provider-encrypted`,
    );
  }
}

function healthCheck(path, liveness = false) {
  return {
    failure_threshold: liveness ? 18 : 3,
    http_path: path,
    initial_delay_seconds: liveness ? 15 : 5,
    period_seconds: 10,
    port: 3000,
    success_threshold: liveness ? 1 : 2,
    timeout_seconds: 3,
  };
}

function expectedServiceAlerts(contract) {
  return [
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "CPU_UTILIZATION",
      value: contract.alerts.service.cpu_percent,
      window: "FIVE_MINUTES",
    },
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "MEM_UTILIZATION",
      value: contract.alerts.service.memory_percent,
      window: "FIVE_MINUTES",
    },
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "RESTART_COUNT",
      value: contract.alerts.service.restart_count,
      window: "FIVE_MINUTES",
    },
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "REQUEST_DURATION_P95_MS",
      value: contract.alerts.service.request_duration_p95_ms,
      window: "FIVE_MINUTES",
    },
  ];
}

function normalizeAlerts(value) {
  assert(Array.isArray(value), "Service alerts are missing");
  return value.map((entry) => ({ ...entry, disabled: entry.disabled ?? false }));
}

function validateService(service, contract) {
  const declaration = contract.service;
  const keys = [
    "alerts",
    "envs",
    "health_check",
    "http_port",
    "instance_count",
    "instance_size_slug",
    "liveness_health_check",
    "name",
    "run_command",
    "termination",
    ...Object.keys(sourceFields(contract.source)),
  ];
  if (service.protocol !== undefined) {
    keys.push("protocol");
  }
  exactKeys(service, keys, "Service");
  equal(service.name, declaration.name, "Service name");
  equal(sourceFields(service), sourceFields(contract.source), "Service source");
  equal(service.http_port, declaration.http_port, "Service port");
  equal(service.protocol ?? "HTTP", "HTTP", "Service protocol");
  equal(service.instance_count, 1, "Service count");
  equal(service.instance_size_slug, declaration.instance_size_slug, "Service size");
  equal(service.run_command, declaration.run_command, "Service command");
  equal(service.health_check, healthCheck(declaration.readiness_path), "Readiness check");
  equal(
    service.liveness_health_check,
    healthCheck(declaration.liveness_path, true),
    "Liveness check",
  );
  equal(
    service.termination,
    {
      drain_seconds: declaration.drain_seconds,
      grace_period_seconds: declaration.grace_period_seconds,
    },
    "Service termination",
  );
  equal(normalizeAlerts(service.alerts), expectedServiceAlerts(contract), "Service alerts");
  componentEnvironment(declaration.environment, service.envs, declaration.name);
}

function validateJob(job, contract) {
  const declaration = contract.job;
  exactKeys(
    job,
    [
      "envs",
      "instance_count",
      "instance_size_slug",
      "kind",
      "name",
      "run_command",
      "termination",
      ...Object.keys(sourceFields(contract.source)),
    ],
    "Migration job",
  );
  equal(job.name, declaration.name, "Migration job name");
  equal(sourceFields(job), sourceFields(contract.source), "Migration job source");
  equal(job.kind, "PRE_DEPLOY", "Migration job kind");
  equal(job.instance_count, 1, "Migration job count");
  equal(job.instance_size_slug, declaration.instance_size_slug, "Migration job size");
  equal(job.run_command, declaration.run_command, "Migration job command");
  equal(job.termination, { grace_period_seconds: 300 }, "Migration job termination");
  componentEnvironment(declaration.environment, job.envs, declaration.name);
}

function defaultDomain(app, spec) {
  const defaults = Array.isArray(spec.domains)
    ? spec.domains.filter((entry) => entry?.type === "DEFAULT")
    : [];
  assert(defaults.length <= 1, "Multiple DEFAULT domains are prohibited");
  const declared = defaults[0]?.domain;
  const ingress =
    typeof app.default_ingress === "string" ? new URL(app.default_ingress).hostname : undefined;
  if (declared !== undefined) {
    assert(/^[a-z0-9-]+\.ondigitalocean\.app$/u.test(declared), "DEFAULT domain is invalid");
  }
  if (ingress !== undefined) {
    assert(/^[a-z0-9-]+\.ondigitalocean\.app$/u.test(ingress), "Default ingress is invalid");
  }
  if (declared !== undefined && ingress !== undefined) {
    equal(declared, ingress, "Default domain identity");
  }
  return declared ?? ingress;
}

function validateDomainsAndIngress(spec, app, contract) {
  assert(Array.isArray(spec.domains), "Hosted domains are missing");
  const primary = spec.domains.filter((entry) => entry?.type === "PRIMARY");
  const defaults = spec.domains.filter((entry) => entry?.type === "DEFAULT");
  assert(
    primary.length === 1 && spec.domains.length === primary.length + defaults.length,
    "Hosted domains changed",
  );
  equal(primary[0], contract.domain, "PRIMARY domain");
  const providerDomain = defaultDomain(app, spec);
  assert(providerDomain !== undefined, "DEFAULT domain is required");
  equal(
    spec.ingress,
    {
      rules: [
        {
          match: { authority: { exact: starterDomainBinding }, path: { prefix: "/" } },
          redirect: { authority: contract.domain.domain, redirect_code: 308, scheme: "https" },
        },
        {
          component: { name: contract.service.name, preserve_path_prefix: true },
          match: { authority: { exact: contract.domain.domain }, path: { prefix: "/" } },
        },
      ],
    },
    "Hosted ingress",
  );
}

function validateSpec(value, app, contract, label) {
  const spec = record(value, `${label} spec`);
  const keys = [
    "alerts",
    "disable_edge_cache",
    "disable_email_obfuscation",
    "domains",
    "features",
    "ingress",
    "jobs",
    "maintenance",
    "name",
    "region",
    "services",
  ];
  if (spec.enhanced_threat_control_enabled !== undefined) {
    keys.push("enhanced_threat_control_enabled");
  }
  if (contract.dedicatedEgress) {
    keys.push("egress");
  }
  exactKeys(spec, keys, `${label} spec`);
  equal(spec.name, contract.name, `${label} name`);
  equal(spec.region, contract.region, `${label} region`);
  equal(spec.features, contract.features, `${label} features`);
  equal(
    spec.alerts,
    contract.alerts.app.map((rule) => ({ rule })),
    `${label} alerts`,
  );
  assert(
    spec.maintenance?.enabled === undefined || spec.maintenance.enabled === false,
    "Maintenance mode is prohibited",
  );
  assert(
    Array.isArray(spec.services) && spec.services.length === 1,
    `${label} service topology changed`,
  );
  assert(Array.isArray(spec.jobs) && spec.jobs.length === 1, `${label} job topology changed`);
  validateService(spec.services[0], contract);
  validateJob(spec.jobs[0], contract);
  validateDomainsAndIngress(spec, app, contract);
  for (const field of edgeFields) {
    equal(spec[field] ?? false, contract.edge[field], `${label} ${field}`);
  }
  if (contract.dedicatedEgress) {
    equal(spec.egress, { type: "DEDICATED_IP" }, `${label} production egress`);
  }
}

function validateDeploymentComponents(deployment, contract, revision) {
  const check = (components, declaration, label) => {
    assert(Array.isArray(components) && components.length === 1, `${label} identity changed`);
    assert(
      components[0]?.name === declaration.name && components[0]?.source_commit_hash === revision,
      `${label} source commit does not match the expected revision`,
    );
  };
  check(deployment.services, contract.service, "Deployment service");
  check(deployment.jobs, contract.job, "Deployment job");
  for (const key of ["databases", "functions", "static_sites", "workers"]) {
    const components = deployment[key];
    assert(
      components === undefined || (Array.isArray(components) && components.length === 0),
      `Active deployment contains prohibited ${key}`,
    );
  }
}

function validateEgress(app, contract) {
  const dedicated = Array.isArray(app.dedicated_ips) ? app.dedicated_ips : [];
  if (!contract.dedicatedEgress) {
    assert(dedicated.length === 0, "Staging cannot own dedicated egress");
    return [];
  }
  assert(dedicated.length === 2, "Production must own exactly two dedicated egress addresses");
  const addresses = dedicated.map((entry) => {
    assert(entry?.status === "ASSIGNED", "A production egress address is not assigned");
    assert(
      typeof entry.ip === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(entry.ip),
      "Production egress IPv4 is invalid",
    );
    return entry.ip;
  });
  assert(new Set(addresses).size === 2, "Production egress addresses must be distinct");
  return addresses.sort();
}

export function validateApp({ app: value, appId, contract, expectedRevision }) {
  assert(REVISION_PATTERN.test(expectedRevision), "A full 40-character revision is required");
  const app = unwrapApp(value);
  if (appId !== undefined) {
    equal(app.id, appId, "Pinned App ID");
  }
  assert(typeof app.id === "string" && app.id.length > 0, "App ID is missing");
  assert(app.in_progress_deployment == null, "A deployment is already in progress");
  const deployment = record(app.active_deployment, "Active deployment");
  assert(typeof deployment.id === "string" && deployment.id.length > 0, "Deployment ID is missing");
  validateDeploymentComponents(deployment, contract, expectedRevision);
  validateSpec(app.spec, app, contract, "Desired App");
  validateSpec(deployment.spec, app, contract, "Active deployment");
  return Object.freeze({
    appId: app.id,
    dedicatedIps: validateEgress(app, contract),
    deploymentId: deployment.id,
    environment: contract.environment,
    revision: expectedRevision,
  });
}
