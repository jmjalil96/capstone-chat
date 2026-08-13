import { closeSync, constants, lstatSync, openSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

export const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
export const ENCRYPTED_VALUE_PATTERN = /^EV\[[^\r\n]{8,2048}\]$/u;

const IPV4_PATTERN = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u;
const MODES = new Set(["bootstrap", "live", "rehearsal-bootstrap", "rehearsal"]);
const OTEL_ENDPOINTS = new Set(["https://otlp.nr-data.net", "https://otlp.eu01.nr-data.net"]);
const DEPLOYMENT_REVISION_BINDING = ["$", "{_self.COMMIT_HASH}"].join("");
const EDGE_FIELDS = [
  "disable_edge_cache",
  "disable_email_obfuscation",
  "enhanced_threat_control_enabled",
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function record(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} is invalid`,
  );
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(record(value, label)).sort();
  assert(isDeepStrictEqual(actual, [...expected].sort()), `${label} keys changed`);
}

function equal(actual, expected, label) {
  assert(isDeepStrictEqual(actual, expected), `${label} changed`);
}

function rehearsalMode(mode) {
  return mode.startsWith("rehearsal");
}

function finalMode(mode) {
  return mode === "live" || mode === "rehearsal";
}

function expectedSource(mode) {
  return {
    dockerfile_path: "apps/api/Dockerfile",
    github: {
      branch: rehearsalMode(mode) ? "app-platform-rehearsal" : "app-platform-production",
      deploy_on_push: false,
      repo: "jmjalil96/capstone-chat",
    },
    source_dir: "/",
  };
}

function expectedService(mode) {
  const general = {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_REVISION: DEPLOYMENT_REVISION_BINDING,
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: finalMode(mode) && rehearsalMode(mode) ? "test" : "production",
    PORT: "3000",
  };
  if (mode === "live") {
    Object.assign(general, {
      EMAIL_DELIVERY: "resend",
      EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      LOG_LEVEL: "info",
      MODEL_GATEWAY: "openrouter",
      PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
      WEB_ASSETS: "production-build",
    });
  }
  if (mode === "rehearsal") {
    Object.assign(general, {
      CAPSTONE_DEPLOYMENT_PROFILE: "managed-rehearsal",
      EMAIL_DELIVERY: "disabled",
      LOG_LEVEL: "info",
      MODEL_GATEWAY: "openrouter",
      PUBLIC_ORIGIN: "https://rehearsal.chat.capstone.com.ec",
      WEB_ASSETS: "production-build",
    });
  }
  const environment = {
    general,
    secret_keys:
      mode === "live"
        ? [
            "BETTER_AUTH_SECRET",
            "DATABASE_URL",
            "OPENROUTER_API_KEY",
            "OTEL_EXPORTER_OTLP_HEADERS",
            "RESEND_API_KEY",
          ]
        : mode === "rehearsal"
          ? [
              "BETTER_AUTH_SECRET",
              "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
              "DATABASE_URL",
              "OTEL_EXPORTER_OTLP_HEADERS",
            ]
          : [],
  };
  if (finalMode(mode)) {
    environment.general_keys = ["OTEL_EXPORTER_OTLP_ENDPOINT"];
  }
  return {
    drain_seconds: 110,
    environment,
    grace_period_seconds: 300,
    http_port: 3000,
    instance_count: 1,
    instance_size_slug: "apps-s-1vcpu-1gb-fixed",
    liveness_path: "/api/health/live",
    name: "capstone-chat",
    readiness_path: "/api/health/ready",
    run_command:
      mode === "live"
        ? "node apps/api/dist/entrypoint.js server"
        : mode === "rehearsal"
          ? "node --expose-gc apps/api/dist/entrypoint.js load-server --confirm-isolated-load-rehearsal"
          : "node apps/api/dist/entrypoint.js egress-bootstrap",
  };
}

function expectedJob(mode) {
  const general = {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    DEPLOYMENT_REVISION: DEPLOYMENT_REVISION_BINDING,
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    NODE_ENV: rehearsalMode(mode) ? "test" : "production",
  };
  if (rehearsalMode(mode)) {
    general.CAPSTONE_DEPLOYMENT_PROFILE = "managed-rehearsal";
  }
  return {
    environment: { general, secret_keys: ["DATABASE_URL"] },
    grace_period_seconds: 300,
    instance_count: 1,
    instance_size_slug: "apps-s-1vcpu-0.5gb",
    kind: "PRE_DEPLOY",
    name: "capstone-migrate",
    run_command: "node apps/api/dist/entrypoint.js migrate",
  };
}

function expectedAlerts(mode) {
  if (!finalMode(mode)) {
    return { app: ["DEPLOYMENT_FAILED"] };
  }
  return {
    app: ["DEPLOYMENT_FAILED", "DEPLOYMENT_LIVE", "DOMAIN_FAILED"],
    service: {
      cpu_percent: 85,
      memory_percent: 85,
      request_duration_p95_ms: 750,
      restart_count: 1,
    },
  };
}

function expectedContract(mode) {
  const value = {
    alerts: expectedAlerts(mode),
    features: ["buildpack-stack=ubuntu-22"],
    mode,
    name: rehearsalMode(mode) ? "capstone-chat-rehearsal" : "capstone-chat-production",
    region: "ric",
    schema: 1,
    service: expectedService(mode),
    source: expectedSource(mode),
  };
  if (finalMode(mode)) {
    value.domain = {
      domain: rehearsalMode(mode) ? "rehearsal.chat.capstone.com.ec" : "chat.capstone.com.ec",
      minimum_tls_version: "1.2",
      type: "PRIMARY",
    };
    value.edge = {
      disable_edge_cache: true,
      disable_email_obfuscation: true,
      enhanced_threat_control_enabled: false,
    };
    value.egress = { type: "DEDICATED_IP" };
    value.job = expectedJob(mode);
  }
  return value;
}

export function validateContract(contract, expectedMode) {
  record(contract, "App contract");
  assert(MODES.has(contract.mode), "App contract mode is invalid");
  if (expectedMode !== undefined) {
    assert(contract.mode === expectedMode, "App contract mode does not match the request");
  }
  equal(contract, expectedContract(contract.mode), "App contract");
  return contract;
}

export function readContract(path, expectedMode) {
  const document = parseDocument(readFileSync(path, "utf8"), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  assert(document.errors.length === 0, "App contract YAML is invalid");
  return validateContract(document.toJS(), expectedMode);
}

export function readProtectedJson(path, label = "Protected JSON", maximumBytes = 512 * 1024) {
  const status = lstatSync(path);
  assert(status.isFile() && !status.isSymbolicLink(), `${label} must be a regular file`);
  assert(status.uid === process.getuid(), `${label} owner is invalid`);
  assert((status.mode & 0o777) === 0o600, `${label} mode must be 0600`);
  assert(status.size >= 2 && status.size <= maximumBytes, `${label} size is invalid`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    try {
      const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
      if (Array.isArray(parsed)) {
        assert(parsed.length === 1, `${label} must contain exactly one App`);
        record(parsed[0], label);
      } else {
        record(parsed, label);
      }
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        fail(`${label} is not valid JSON`);
      }
      throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

function unwrapApp(value) {
  if (Array.isArray(value)) {
    assert(value.length === 1, "DigitalOcean App response must contain exactly one App");
  }
  const outer = record(Array.isArray(value) ? value[0] : value, "DigitalOcean App response");
  return outer.app === undefined ? outer : record(outer.app, "DigitalOcean App");
}

function validIpv4(value) {
  return (
    typeof value === "string" &&
    IPV4_PATTERN.test(value) &&
    value.split(".").every((part) => Number(part) <= 255)
  );
}

function providerDefaultDomain(app, spec) {
  const defaults = Array.isArray(spec.domains)
    ? spec.domains.filter((entry) => entry?.type === "DEFAULT")
    : [];
  assert(defaults.length <= 1, "DigitalOcean returned multiple DEFAULT domains");
  const declared = defaults[0]?.domain;
  if (declared !== undefined) {
    assert(
      typeof declared === "string" && /^[a-z0-9-]+\.ondigitalocean\.app$/u.test(declared),
      "DigitalOcean DEFAULT domain is invalid",
    );
    assert(defaults[0].zone === undefined, "DEFAULT domain cannot declare a managed zone");
  }
  let ingress;
  if (app.default_ingress !== undefined) {
    let parsed;
    try {
      parsed = new URL(app.default_ingress);
    } catch {
      fail("DigitalOcean default ingress is invalid");
    }
    assert(
      parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.port === "" &&
        parsed.pathname === "/" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        /^[a-z0-9-]+\.ondigitalocean\.app$/u.test(parsed.hostname),
      "DigitalOcean default ingress is invalid",
    );
    ingress = parsed.hostname;
  }
  if (declared !== undefined && ingress !== undefined) {
    assert(declared === ingress, "DigitalOcean DEFAULT domain disagrees with its ingress URL");
  }
  return declared ?? ingress;
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

function sourceFields(source) {
  const github = record(source.github, "DigitalOcean GitHub source");
  exactKeys(
    github,
    github.deploy_on_push === undefined ? ["branch", "repo"] : ["branch", "deploy_on_push", "repo"],
    "DigitalOcean GitHub source",
  );
  return {
    dockerfile_path: source.dockerfile_path,
    github: {
      branch: github.branch,
      deploy_on_push: github.deploy_on_push === undefined ? false : github.deploy_on_push,
      repo: github.repo,
    },
    source_dir: source.source_dir,
  };
}

function componentEnvironment(declaration, actual, componentName) {
  assert(Array.isArray(actual), `${componentName} environment is missing`);
  const entries = new Map();
  for (const entry of actual) {
    exactKeys(
      entry,
      entry.type === undefined ? ["key", "scope", "value"] : ["key", "scope", "type", "value"],
      `${componentName} environment entry`,
    );
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
      entry?.key === key &&
        entry.scope === "RUN_TIME" &&
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
        OTEL_ENDPOINTS.has(entry.value),
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

function serviceAlerts(contract) {
  if (!finalMode(contract.mode)) {
    return undefined;
  }
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

function normalizedServiceAlerts(value) {
  if (value === undefined) {
    return undefined;
  }
  assert(Array.isArray(value), "DigitalOcean service alerts are invalid");
  return value.map((entry) => {
    const alert = record(entry, "DigitalOcean service alert");
    exactKeys(
      alert,
      alert.disabled === undefined
        ? ["operator", "rule", "value", "window"]
        : ["disabled", "operator", "rule", "value", "window"],
      "DigitalOcean service alert",
    );
    assert(
      alert.disabled === undefined || alert.disabled === false,
      "DigitalOcean service alert cannot be disabled",
    );
    return { ...alert, disabled: false };
  });
}

function validateService(service, contract) {
  const declaration = contract.service;
  const expectedKeys = [
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
    expectedKeys.push("protocol");
  }
  if (finalMode(contract.mode)) {
    expectedKeys.push("alerts");
  }
  exactKeys(service, expectedKeys, "DigitalOcean service");
  equal(service.name, declaration.name, "DigitalOcean service name");
  equal(sourceFields(service), sourceFields(contract.source), "DigitalOcean service source");
  equal(service.http_port, declaration.http_port, "DigitalOcean service port");
  equal(
    service.protocol === undefined ? "HTTP" : service.protocol,
    "HTTP",
    "DigitalOcean service protocol",
  );
  equal(service.instance_count, declaration.instance_count, "DigitalOcean service count");
  equal(service.instance_size_slug, declaration.instance_size_slug, "DigitalOcean service size");
  equal(service.run_command, declaration.run_command, "DigitalOcean service command");
  equal(
    service.health_check,
    healthCheck(declaration.readiness_path),
    "DigitalOcean readiness check",
  );
  equal(
    service.liveness_health_check,
    healthCheck(declaration.liveness_path, true),
    "DigitalOcean liveness check",
  );
  equal(
    service.termination,
    {
      drain_seconds: declaration.drain_seconds,
      grace_period_seconds: declaration.grace_period_seconds,
    },
    "DigitalOcean service termination",
  );
  equal(
    normalizedServiceAlerts(service.alerts),
    serviceAlerts(contract),
    "DigitalOcean service alerts",
  );
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
    "DigitalOcean job",
  );
  equal(job.name, declaration.name, "DigitalOcean job name");
  equal(sourceFields(job), sourceFields(contract.source), "DigitalOcean job source");
  equal(job.kind, declaration.kind, "DigitalOcean job kind");
  equal(job.instance_count, declaration.instance_count, "DigitalOcean job count");
  equal(job.instance_size_slug, declaration.instance_size_slug, "DigitalOcean job size");
  equal(job.run_command, declaration.run_command, "DigitalOcean job command");
  equal(
    job.termination,
    { grace_period_seconds: declaration.grace_period_seconds },
    "DigitalOcean job termination",
  );
  componentEnvironment(declaration.environment, job.envs, declaration.name);
}

function expectedIngress(contract, defaultDomain) {
  if (!finalMode(contract.mode)) {
    return {
      rules: [
        {
          component: { name: contract.service.name, preserve_path_prefix: true },
          match: { path: { prefix: "/" } },
        },
      ],
    };
  }
  assert(defaultDomain !== undefined, "DigitalOcean DEFAULT domain is required");
  return {
    rules: [
      {
        match: { authority: { exact: defaultDomain }, path: { prefix: "/" } },
        redirect: {
          authority: contract.domain.domain,
          redirect_code: 308,
          scheme: "https",
        },
      },
      {
        component: { name: contract.service.name, preserve_path_prefix: true },
        match: { authority: { exact: contract.domain.domain }, path: { prefix: "/" } },
      },
    ],
  };
}

function validateDomains(spec, contract, defaultDomain) {
  if (!finalMode(contract.mode)) {
    if (spec.domains === undefined) {
      return;
    }
    assert(
      defaultDomain !== undefined && spec.domains.length === 1,
      "Bootstrap App has an unexpected domain",
    );
    equal(spec.domains[0], { domain: defaultDomain, type: "DEFAULT" }, "Bootstrap App domain");
    return;
  }
  assert(Array.isArray(spec.domains), "Live App domains changed");
  const primary = spec.domains.filter((entry) => entry?.type === "PRIMARY");
  const defaults = spec.domains.filter((entry) => entry?.type === "DEFAULT");
  assert(primary.length === 1, "Live App PRIMARY domain changed");
  assert(
    defaults.length <= 1 && spec.domains.length === primary.length + defaults.length,
    "Live App domains changed",
  );
  if (defaults.length === 1) {
    equal(defaults[0], { domain: defaultDomain, type: "DEFAULT" }, "Live App DEFAULT domain");
  }
  equal(primary[0], contract.domain, "Live App PRIMARY domain");
}

function validateDeploymentComponents(deployment, contract, revision) {
  const validateCollection = (value, declarations, label) => {
    assert(Array.isArray(value), `${label} source identity is missing`);
    assert(value.length === declarations.length, `${label} source identity changed`);
    for (const declaration of declarations) {
      const matches = value.filter((entry) => entry?.name === declaration.name);
      assert(matches.length === 1, `${label} component identity changed`);
      assert(
        matches[0].source_commit_hash === revision,
        `${label} source commit does not match the expected revision`,
      );
    }
  };
  validateCollection(deployment.services, [contract.service], "Deployment service");
  validateCollection(
    deployment.jobs ?? [],
    contract.job === undefined ? [] : [contract.job],
    "Deployment job",
  );
  for (const key of ["databases", "functions", "static_sites", "workers"]) {
    const components = deployment[key];
    assert(
      components === undefined || (Array.isArray(components) && components.length === 0),
      `Active deployment contains prohibited ${key}`,
    );
  }
}

function validateDedicatedIps(app, final) {
  const dedicated = Array.isArray(app.dedicated_ips) ? app.dedicated_ips : [];
  if (!final) {
    assert(dedicated.length === 0, "Bootstrap App unexpectedly owns dedicated egress");
    return [];
  }
  assert(dedicated.length === 2, "DigitalOcean must assign exactly two dedicated egress IPv4s");
  const addresses = dedicated.map((entry) => {
    assert(entry?.status === "ASSIGNED", "A dedicated egress address is not assigned");
    assert(validIpv4(entry.ip), "Dedicated egress IPv4 is invalid");
    return entry.ip;
  });
  assert(new Set(addresses).size === 2, "Dedicated egress IPv4s must be distinct");
  return addresses.sort();
}

function validateAppSpec(value, app, contract, label) {
  const spec = record(value, `${label} spec`);
  const allowedKeys = [
    "alerts",
    "features",
    "ingress",
    "maintenance",
    "name",
    "region",
    "services",
  ];
  if (spec.domains !== undefined) {
    allowedKeys.push("domains");
  }
  if (finalMode(contract.mode)) {
    allowedKeys.push("egress", "jobs");
    for (const field of EDGE_FIELDS) {
      if (contract.edge[field] === true || spec[field] !== undefined) {
        allowedKeys.push(field);
      }
    }
  } else {
    for (const field of EDGE_FIELDS) {
      if (spec[field] !== undefined) {
        assert(spec[field] === false, "Bootstrap App has an invalid custom-domain edge setting");
        allowedKeys.push(field);
      }
    }
  }
  exactKeys(spec, allowedKeys, `${label} spec`);
  equal(spec.name, contract.name, `${label} name`);
  equal(spec.region, contract.region, `${label} region`);
  equal(spec.features, contract.features, `${label} features`);
  const maintenance = record(spec.maintenance, `${label} maintenance policy`);
  exactKeys(
    maintenance,
    maintenance.enabled === undefined ? [] : ["enabled"],
    `${label} maintenance policy`,
  );
  assert(
    maintenance.enabled === undefined || maintenance.enabled === false,
    `${label} maintenance policy changed`,
  );
  equal(
    spec.alerts,
    contract.alerts.app.map((rule) => ({ rule })),
    `${label} alerts`,
  );
  assert(
    Array.isArray(spec.services) && spec.services.length === 1,
    `${label} service topology changed`,
  );
  validateService(spec.services[0], contract);
  assert(spec.envs === undefined, "App-level environment variables are prohibited");
  for (const key of ["databases", "functions", "static_sites", "workers", "vpc"]) {
    assert(spec[key] === undefined, `${label} contains prohibited ${key}`);
  }

  const defaultDomain = providerDefaultDomain(app, spec);
  validateDomains(spec, contract, defaultDomain);
  equal(spec.ingress, expectedIngress(contract, defaultDomain), `${label} ingress`);
  if (finalMode(contract.mode)) {
    equal(spec.egress, contract.egress, `${label} dedicated egress policy`);
    for (const field of EDGE_FIELDS) {
      const actual = spec[field] === undefined ? false : spec[field];
      assert(typeof actual === "boolean", `DigitalOcean ${field} is invalid`);
      equal(actual, contract.edge[field], `${label} ${field}`);
    }
    assert(Array.isArray(spec.jobs) && spec.jobs.length === 1, `${label} job topology changed`);
    validateJob(spec.jobs[0], contract);
  } else {
    assert(spec.jobs === undefined, "Bootstrap App cannot contain a job");
    assert(spec.egress === undefined, "Bootstrap App cannot request dedicated egress");
  }
}

export function validateApp({ app: value, appId, contract, expectedRevision }) {
  validateContract(contract);
  assert(REVISION_PATTERN.test(expectedRevision), "A full 40-character revision is required");
  const app = unwrapApp(value);
  if (appId !== undefined) {
    assert(app.id === appId, "DigitalOcean App ID does not match the pinned authority");
  }
  assert(typeof app.id === "string" && app.id.length > 0, "DigitalOcean App ID is missing");
  assert(app.in_progress_deployment == null, "A DigitalOcean deployment is already in progress");
  const deployment = record(app.active_deployment, "DigitalOcean active deployment");
  assert(
    typeof deployment.id === "string" && deployment.id.length > 0,
    "Active deployment ID is missing",
  );
  validateDeploymentComponents(deployment, contract, expectedRevision);
  validateAppSpec(app.spec, app, contract, "DigitalOcean desired App");
  validateAppSpec(deployment.spec, app, contract, "DigitalOcean active deployment");
  const dedicatedIps = validateDedicatedIps(app, finalMode(contract.mode));
  return {
    appId: app.id,
    dedicatedIps,
    deploymentId: deployment.id,
    mode: contract.mode,
    revision: expectedRevision,
  };
}
