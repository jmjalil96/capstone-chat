import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

export const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const ENCRYPTED_VALUE_PATTERN = /^EV\[[^\r\n]{8,2048}\]$/u;
const IPV4_PATTERN = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u;
const ALLOWED_MODES = new Set([
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
const EXPECTED_IMAGE = {
  registry: "jmjalil96",
  registry_type: "GHCR",
  repository: "capstone-chat",
};
const EXPECTED_SERVICE_GENERAL = {
  bootstrap: {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
  },
  egress: {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
  },
  domain: {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
  },
  initialization: {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
  },
  live: {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    EMAIL_DELIVERY: "resend",
    EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    MODEL_GATEWAY: "openrouter",
    NODE_ENV: "production",
    PORT: "3000",
    PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
    WEB_ASSETS: "production-build",
  },
  rehearsal: {
    CAPSTONE_DEPLOYMENT_PROFILE: "managed-rehearsal",
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    EMAIL_DELIVERY: "disabled",
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    MODEL_GATEWAY: "openrouter",
    NODE_ENV: "test",
    PORT: "3000",
    PUBLIC_ORIGIN: "https://rehearsal.chat.capstone.com.ec",
    WEB_ASSETS: "production-build",
  },
  "rehearsal-bootstrap": {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
  },
  "rehearsal-domain": {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
  },
  "rehearsal-egress": {
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
  },
  "rehearsal-initialization": {
    CAPSTONE_DEPLOYMENT_PROFILE: "managed-rehearsal",
    CAPSTONE_SECRET_SOURCE: "platform-environment",
    CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
    DEPLOYMENT_TARGET: "digitalocean-app-platform",
    EMAIL_DELIVERY: "disabled",
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    MODEL_GATEWAY: "openrouter",
    NODE_ENV: "test",
    PORT: "3000",
    PUBLIC_ORIGIN: "https://rehearsal.chat.capstone.com.ec",
    WEB_ASSETS: "production-build",
  },
};
const EXPECTED_SERVICE_SECRETS = {
  bootstrap: [],
  egress: [],
  domain: [],
  initialization: [],
  live: [
    "BETTER_AUTH_SECRET",
    "DATABASE_URL",
    "OPENROUTER_API_KEY",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "RESEND_API_KEY",
  ],
  rehearsal: [
    "BETTER_AUTH_SECRET",
    "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
    "DATABASE_URL",
    "OTEL_EXPORTER_OTLP_HEADERS",
  ],
  "rehearsal-bootstrap": [],
  "rehearsal-domain": [],
  "rehearsal-egress": [],
  "rehearsal-initialization": [
    "BETTER_AUTH_SECRET",
    "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
    "DATABASE_URL",
    "OTEL_EXPORTER_OTLP_HEADERS",
  ],
};
const EXPECTED_JOBS = {
  initialization: {
    environment: {
      general: {
        CAPSTONE_INITIALIZATION_SCHEMA_VERSION: "1",
        CAPSTONE_SECRET_SOURCE: "platform-environment",
        DEPLOYMENT_TARGET: "digitalocean-app-platform",
        MODEL_GATEWAY: "openrouter",
        NODE_ENV: "production",
      },
      secret_keys: [
        "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
        "CAPSTONE_BOOTSTRAP_DATABASE_URL",
        "OPENROUTER_API_KEY",
        "CAPSTONE_INITIALIZATION_DOCUMENT",
      ],
    },
    grace_period_seconds: 300,
    instance_count: 1,
    instance_size_slug: "apps-s-1vcpu-0.5gb",
    kind: "PRE_DEPLOY",
    name: "capstone-initialize",
    run_command: "node apps/api/dist/entrypoint.js initialize",
  },
  live: {
    environment: {
      general: {
        CAPSTONE_SECRET_SOURCE: "platform-environment",
        DEPLOYMENT_TARGET: "digitalocean-app-platform",
        NODE_ENV: "production",
      },
      secret_keys: ["DATABASE_URL"],
    },
    grace_period_seconds: 300,
    instance_count: 1,
    instance_size_slug: "apps-s-1vcpu-0.5gb",
    kind: "PRE_DEPLOY",
    name: "capstone-migrate",
    run_command: "node apps/api/dist/entrypoint.js migrate",
  },
  rehearsal: {
    environment: {
      general: {
        CAPSTONE_DEPLOYMENT_PROFILE: "managed-rehearsal",
        CAPSTONE_SECRET_SOURCE: "platform-environment",
        DEPLOYMENT_TARGET: "digitalocean-app-platform",
        NODE_ENV: "test",
      },
      secret_keys: ["DATABASE_URL"],
    },
    grace_period_seconds: 300,
    instance_count: 1,
    instance_size_slug: "apps-s-1vcpu-0.5gb",
    kind: "PRE_DEPLOY",
    name: "capstone-migrate",
    run_command: "node apps/api/dist/entrypoint.js migrate",
  },
  "rehearsal-initialization": {
    environment: {
      general: {
        CAPSTONE_DEPLOYMENT_PROFILE: "managed-rehearsal",
        CAPSTONE_INITIALIZATION_SCHEMA_VERSION: "1",
        CAPSTONE_SECRET_SOURCE: "platform-environment",
        DEPLOYMENT_TARGET: "digitalocean-app-platform",
        NODE_ENV: "test",
      },
      secret_keys: [
        "CAPSTONE_BOOTSTRAP_DATABASE_URL",
        "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
        "CAPSTONE_INITIALIZATION_DOCUMENT",
      ],
    },
    grace_period_seconds: 300,
    instance_count: 1,
    instance_size_slug: "apps-s-1vcpu-0.5gb",
    kind: "PRE_DEPLOY",
    name: "capstone-rehearsal-initialize",
    run_command: "node apps/api/dist/entrypoint.js initialize-rehearsal",
  },
};
const APP_ALERTS = {
  bootstrap: ["DEPLOYMENT_FAILED"],
  egress: ["DEPLOYMENT_FAILED"],
  domain: ["DEPLOYMENT_FAILED"],
  initialization: ["DEPLOYMENT_FAILED"],
  live: ["DEPLOYMENT_FAILED", "DEPLOYMENT_LIVE", "DOMAIN_FAILED"],
  rehearsal: ["DEPLOYMENT_FAILED", "DEPLOYMENT_LIVE", "DOMAIN_FAILED"],
  "rehearsal-bootstrap": ["DEPLOYMENT_FAILED"],
  "rehearsal-domain": ["DEPLOYMENT_FAILED"],
  "rehearsal-egress": ["DEPLOYMENT_FAILED"],
  "rehearsal-initialization": ["DEPLOYMENT_FAILED"],
};
const PROVISIONING_SOURCES = {
  bootstrap: [],
  egress: ["bootstrap"],
  domain: ["egress"],
  initialization: ["domain"],
  live: ["domain", "initialization", "live"],
  rehearsal: ["rehearsal-domain", "rehearsal-initialization", "rehearsal"],
  "rehearsal-bootstrap": [],
  "rehearsal-egress": ["rehearsal-bootstrap"],
  "rehearsal-domain": ["rehearsal-egress"],
  "rehearsal-initialization": ["rehearsal-domain"],
};

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function assertRecord(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} is invalid`,
  );
  return value;
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(assertRecord(value, label)).sort();
  const wanted = [...expected].sort();
  assert(isDeepStrictEqual(keys, wanted), `${label} keys changed`);
}

function assertEqual(actual, expected, label) {
  assert(isDeepStrictEqual(actual, expected), `${label} changed`);
}

function recursivelyRejectReleaseValues(value, path = "contract") {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      recursivelyRejectReleaseValues(item, `${path}[${index}]`);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assert(
      !["digest", "tag", "registry_credentials", "DEPLOYMENT_REVISION"].includes(key),
      `${path} contains a release value`,
    );
    recursivelyRejectReleaseValues(item, `${path}.${key}`);
  }
}

function expectedService(mode) {
  const environment = {
    general: EXPECTED_SERVICE_GENERAL[mode],
    secret_keys: EXPECTED_SERVICE_SECRETS[mode],
  };
  if (["live", "rehearsal", "rehearsal-initialization"].includes(mode)) {
    environment.general_keys = ["OTEL_EXPORTER_OTLP_ENDPOINT"];
  }
  return {
    environment,
    grace_period_seconds: 300,
    http_port: 3000,
    instance_count: 1,
    instance_size_slug: "apps-s-1vcpu-1gb-fixed",
    liveness_path: "/api/health/live",
    name: "capstone-chat",
    readiness_path: "/api/health/ready",
    run_command: ["rehearsal", "rehearsal-initialization"].includes(mode)
      ? "node --expose-gc apps/api/dist/entrypoint.js load-server --confirm-isolated-load-rehearsal"
      : mode === "live"
        ? "node apps/api/dist/entrypoint.js server"
        : "node apps/api/dist/entrypoint.js egress-bootstrap",
    drain_seconds: 110,
  };
}

export function validateContract(contract, expectedMode) {
  assertRecord(contract, "App contract");
  assert(ALLOWED_MODES.has(contract.mode), "App contract mode is invalid");
  if (expectedMode !== undefined) {
    assert(
      contract.mode === expectedMode,
      "App contract mode does not match the requested operation",
    );
  }
  const mode = contract.mode;
  const keys = ["alerts", "edge", "image", "mode", "name", "region", "schema", "service"];
  const hasEgress = !["bootstrap", "rehearsal-bootstrap"].includes(mode);
  const hasDomain = [
    "domain",
    "initialization",
    "live",
    "rehearsal",
    "rehearsal-domain",
    "rehearsal-initialization",
  ].includes(mode);
  const hasJob = ["initialization", "live", "rehearsal", "rehearsal-initialization"].includes(mode);
  if (hasEgress) {
    keys.push("egress");
  }
  if (hasDomain) {
    keys.push("domain");
  }
  if (hasJob) {
    keys.push("job");
  }
  assertExactKeys(contract, keys, "App contract");
  assert(contract.schema === 1, "App contract schema changed");
  assert(
    contract.name ===
      (mode.startsWith("rehearsal") ? "capstone-chat-rehearsal" : "capstone-chat-production"),
    "App contract name changed",
  );
  assert(contract.region === "ric", "App contract region changed");
  assertEqual(contract.image, EXPECTED_IMAGE, "App contract image source");
  assertEqual(
    contract.edge,
    {
      disable_edge_cache: true,
      disable_email_obfuscation: true,
      enhanced_threat_control_enabled: false,
    },
    "App contract edge policy",
  );
  assertEqual(contract.service, expectedService(mode), "App contract service");
  assertEqual(contract.alerts.app, APP_ALERTS[mode], "App contract app alerts");
  if (["live", "rehearsal"].includes(mode)) {
    assertEqual(
      contract.alerts.service,
      {
        cpu_percent: 85,
        memory_percent: 85,
        request_duration_p95_ms: 750,
        restart_count: 1,
      },
      "App contract service alerts",
    );
  } else {
    assertExactKeys(contract.alerts, ["app"], "App contract alerts");
  }
  if (hasEgress) {
    assertEqual(contract.egress, { type: "DEDICATED_IP" }, "App contract egress");
  }
  if (hasDomain) {
    assertEqual(
      contract.domain,
      {
        domain: mode.startsWith("rehearsal")
          ? "rehearsal.chat.capstone.com.ec"
          : "chat.capstone.com.ec",
        minimum_tls_version: "1.2",
        type: "PRIMARY",
      },
      "App contract domain",
    );
  }
  if (hasJob) {
    assertEqual(contract.job, EXPECTED_JOBS[mode], "App contract job");
  }
  recursivelyRejectReleaseValues(contract);
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

export function assertProvisioningTransition(sourceMode, targetMode) {
  assert(ALLOWED_MODES.has(targetMode), "Provisioning target mode is invalid");
  if (["bootstrap", "rehearsal-bootstrap"].includes(targetMode)) {
    assert(sourceMode === undefined, "Bootstrap cannot replace an existing App state");
    return;
  }
  assert(
    typeof sourceMode === "string" && PROVISIONING_SOURCES[targetMode].includes(sourceMode),
    "Provisioning source mode cannot transition to the requested target",
  );
}

export function readProtectedJson(path, label, maximumBytes = 128 * 1024) {
  const status = lstatSync(path);
  assert(status.isFile() && !status.isSymbolicLink(), `${label} must be a regular file`);
  assert(status.uid === process.getuid(), `${label} owner is invalid`);
  assert((status.mode & 0o777) === 0o600, `${label} mode must be 0600`);
  assert(status.size >= 2 && status.size <= maximumBytes, `${label} size is invalid`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    try {
      const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
      return assertRecord(parsed, label);
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

export function writeProtectedJson(path, value) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, "utf8");
}

export function sha256(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function unwrapApp(value) {
  const record = assertRecord(value, "DigitalOcean App response");
  return record.app === undefined ? record : assertRecord(record.app, "DigitalOcean App");
}

function componentMap(spec) {
  const components = new Map();
  for (const collection of [spec?.services, spec?.jobs]) {
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const component of collection) {
      if (
        component !== null &&
        typeof component === "object" &&
        typeof component.name === "string"
      ) {
        components.set(component.name, component);
      }
    }
  }
  return components;
}

function parseInputDocument(input, label) {
  if (input === undefined) {
    return new Map();
  }
  assertExactKeys(input, ["components", "schema"], label);
  assert(input.schema === 1, `${label} schema changed`);
  const components = assertRecord(input.components, `${label} components`);
  return new Map(
    Object.entries(components).map(([name, values]) => [
      name,
      new Map(Object.entries(assertRecord(values, `${label} ${name}`))),
    ]),
  );
}

function assertPlainSecret(value, label, maximumBytes = 8192) {
  assert(
    typeof value === "string" &&
      Buffer.byteLength(value, "utf8") >= 16 &&
      Buffer.byteLength(value, "utf8") <= maximumBytes,
    `${label} is invalid`,
  );
  assert(!ENCRYPTED_VALUE_PATTERN.test(value), `${label} must be plaintext for first submission`);
  assert(!/[\0\r\n]/u.test(value), `${label} contains invalid characters`);
  return value;
}

function assertDeclaredSecret(value, componentName, key, maximumBytes) {
  return assertPlainSecret(value, `${componentName}.${key}`, maximumBytes);
}

function declaredGeneral(value, componentName, key) {
  assert(
    key === "OTEL_EXPORTER_OTLP_ENDPOINT" &&
      ["https://otlp.nr-data.net", "https://otlp.eu01.nr-data.net"].includes(value),
    `${componentName}.${key} is invalid`,
  );
  return value;
}

function registryCredential(value, label) {
  assertPlainSecret(value, label);
  const separator = value.indexOf(":");
  assert(separator > 0 && separator < value.length - 1, `${label} must use username:token`);
  return value;
}

function encryptedValue(value, label) {
  assert(
    typeof value === "string" && ENCRYPTED_VALUE_PATTERN.test(value),
    `${label} is not encrypted`,
  );
  return value;
}

function environmentFor(
  declaration,
  liveComponent,
  inputs,
  inputMode,
  componentName,
  generalInputs,
  generalMode,
) {
  assert(
    ["introduce", "preserve", "rotate", "rotate-selected"].includes(inputMode),
    "Secret input mode is invalid",
  );
  const liveByKey = new Map(
    Array.isArray(liveComponent?.envs) ? liveComponent.envs.map((entry) => [entry.key, entry]) : [],
  );
  const componentInput = inputs.get(componentName) ?? new Map();
  const result = Object.entries(declaration.general)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, scope: "RUN_TIME", type: "GENERAL", value }));
  const generalComponentInput = generalInputs.get(componentName) ?? new Map();
  for (const key of [...(declaration.general_keys ?? [])].sort()) {
    const existing = liveByKey.get(key);
    const supplied = generalComponentInput.get(key);
    const value =
      generalMode === "introduce"
        ? declaredGeneral(supplied, componentName, key)
        : declaredGeneral(
            existing?.type === "GENERAL" && supplied === undefined ? existing.value : undefined,
            componentName,
            key,
          );
    result.push({ key, scope: "RUN_TIME", type: "GENERAL", value });
    generalComponentInput.delete(key);
  }
  assert(generalComponentInput.size === 0, `${componentName} has unexpected general input`);
  generalInputs.delete(componentName);
  for (const key of [...declaration.secret_keys].sort()) {
    const existing = liveByKey.get(key)?.value;
    const supplied = componentInput.get(key);
    let value;
    const maximumBytes = key === "CAPSTONE_INITIALIZATION_DOCUMENT" ? 32 * 1024 : 8192;
    if (inputMode === "rotate") {
      value = assertDeclaredSecret(supplied, componentName, key, maximumBytes);
    } else if (inputMode === "rotate-selected") {
      value =
        supplied === undefined
          ? encryptedValue(existing, `${componentName}.${key}`)
          : assertDeclaredSecret(supplied, componentName, key, maximumBytes);
    } else if (existing !== undefined) {
      value = encryptedValue(existing, `${componentName}.${key}`);
      assert(supplied === undefined, `${componentName}.${key} cannot replace an encrypted value`);
    } else {
      assert(inputMode === "introduce", `${componentName}.${key} has no encrypted value`);
      value = assertDeclaredSecret(supplied, componentName, key, maximumBytes);
    }
    result.push({ key, scope: "RUN_TIME", type: "SECRET", value });
    componentInput.delete(key);
  }
  assert(componentInput.size === 0, `${componentName} has unexpected secret input`);
  inputs.delete(componentName);
  return result;
}

function imageFor(contract, digest, liveComponent, inputs, inputMode, componentName) {
  const existing = liveComponent?.image?.registry_credentials;
  const componentInput = inputs.get(componentName) ?? new Map();
  const supplied = componentInput.get("registry_credentials");
  let registryCredentials;
  if (inputMode === "rotate") {
    registryCredentials = registryCredential(supplied, `${componentName} registry credential`);
  } else if (existing !== undefined) {
    registryCredentials = encryptedValue(existing, `${componentName} registry credential`);
    assert(
      supplied === undefined,
      `${componentName} cannot replace its encrypted registry credential`,
    );
  } else {
    assert(inputMode === "introduce", `${componentName} has no encrypted registry credential`);
    registryCredentials = registryCredential(supplied, `${componentName} registry credential`);
  }
  componentInput.delete("registry_credentials");
  assert(componentInput.size === 0, `${componentName} has unexpected registry input`);
  inputs.delete(componentName);
  return {
    ...contract.image,
    digest,
    registry_credentials: registryCredentials,
  };
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

function serviceAlerts(contract) {
  if (!["live", "rehearsal"].includes(contract.mode)) {
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

function providerDefaultHostname(value) {
  assert(typeof value === "string", "DigitalOcean DEFAULT ingress is invalid");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("DigitalOcean DEFAULT ingress is invalid");
  }
  const hostname = parsed.hostname;
  assert(
    parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      /^[a-z0-9-]+\.ondigitalocean\.app$/u.test(hostname) &&
      [`https://${hostname}`, `https://${hostname}/`].includes(value),
    "DigitalOcean DEFAULT ingress is invalid",
  );
  return hostname;
}

function providerDefaultDomain(app, liveSpec) {
  const defaultDomains = Array.isArray(liveSpec?.domains)
    ? liveSpec.domains.filter((domain) => domain?.type === "DEFAULT")
    : [];
  assert(defaultDomains.length <= 1, "DigitalOcean returned multiple DEFAULT domains");
  const declared = defaultDomains[0]?.domain;
  if (declared !== undefined) {
    assert(
      typeof declared === "string" && /^[a-z0-9-]+\.ondigitalocean\.app$/u.test(declared),
      "DigitalOcean DEFAULT domain is invalid",
    );
  }
  const ingress =
    app?.default_ingress === undefined ? undefined : providerDefaultHostname(app.default_ingress);
  if (declared !== undefined && ingress !== undefined) {
    assert(declared === ingress, "DigitalOcean DEFAULT domain disagrees with its ingress URL");
  }
  const value = declared ?? ingress;
  if (value === undefined) {
    return undefined;
  }
  return value;
}

function ingressFor(contract, defaultDomain) {
  if (contract.domain === undefined) {
    return {
      rules: [
        {
          component: { name: contract.service.name, preserve_path_prefix: true },
          match: { path: { prefix: "/" } },
        },
      ],
    };
  }
  assert(
    defaultDomain !== undefined,
    "The provider DEFAULT domain is required before domain routing",
  );
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
        match: {
          authority: { exact: contract.domain.domain },
          path: { prefix: "/" },
        },
      },
    ],
  };
}

export function renderSpec({
  contract,
  digest,
  generalInput,
  generalMode = "preserve",
  revision,
  liveApp,
  registryInput,
  registryMode = "preserve",
  secretInput,
  secretMode = "preserve",
}) {
  validateContract(contract);
  assert(DIGEST_PATTERN.test(digest), "An exact sha256 image digest is required");
  assert(REVISION_PATTERN.test(revision), "A full 40-character revision is required");
  const app = liveApp === undefined ? undefined : unwrapApp(liveApp);
  const liveSpec = app?.spec;
  const liveComponents = componentMap(liveSpec);
  const registryInputs = parseInputDocument(registryInput, "Registry credential input");
  const secretInputs = parseInputDocument(secretInput, "Runtime secret input");
  const generalInputs = parseInputDocument(generalInput, "Runtime general input");
  const service = contract.service;
  const renderedService = {
    envs: environmentFor(
      service.environment,
      liveComponents.get(service.name),
      secretInputs,
      secretMode,
      service.name,
      generalInputs,
      generalMode,
    ),
    health_check: healthCheck(service.readiness_path),
    http_port: service.http_port,
    image: imageFor(
      contract,
      digest,
      liveComponents.get(service.name),
      registryInputs,
      registryMode,
      service.name,
    ),
    instance_count: service.instance_count,
    instance_size_slug: service.instance_size_slug,
    liveness_health_check: healthCheck(service.liveness_path, true),
    name: service.name,
    protocol: "HTTP",
    run_command: service.run_command,
    termination: {
      drain_seconds: service.drain_seconds,
      grace_period_seconds: service.grace_period_seconds,
    },
  };
  const componentAlerts = serviceAlerts(contract);
  if (componentAlerts !== undefined) {
    renderedService.alerts = componentAlerts;
  }
  const spec = {
    alerts: contract.alerts.app.map((rule) => ({ rule })),
    disable_edge_cache: contract.edge.disable_edge_cache,
    disable_email_obfuscation: contract.edge.disable_email_obfuscation,
    enhanced_threat_control_enabled: contract.edge.enhanced_threat_control_enabled,
    ingress: ingressFor(contract, providerDefaultDomain(app, liveSpec)),
    maintenance: { enabled: false },
    name: contract.name,
    region: contract.region,
    services: [renderedService],
  };
  if (contract.domain !== undefined) {
    spec.domains = [{ ...contract.domain }];
  }
  if (contract.egress !== undefined) {
    spec.egress = { ...contract.egress };
  }
  if (contract.job !== undefined) {
    const job = contract.job;
    spec.jobs = [
      {
        envs: environmentFor(
          job.environment,
          liveComponents.get(job.name),
          secretInputs,
          secretMode,
          job.name,
          generalInputs,
          generalMode,
        ),
        image: imageFor(
          contract,
          digest,
          liveComponents.get(job.name),
          registryInputs,
          registryMode,
          job.name,
        ),
        instance_count: job.instance_count,
        instance_size_slug: job.instance_size_slug,
        kind: job.kind,
        name: job.name,
        run_command: job.run_command,
        termination: { grace_period_seconds: job.grace_period_seconds },
      },
    ];
  }
  assert(registryInputs.size === 0, "Registry input contains an unexpected component");
  assert(secretInputs.size === 0, "Runtime secret input contains an unexpected component");
  assert(generalInputs.size === 0, "Runtime general input contains an unexpected component");
  assert(spec.envs === undefined, "App-level environment variables are prohibited");
  assert(
    JSON.stringify(spec).includes(revision) === false,
    "The App spec must not override revision authority",
  );
  return spec;
}

function projectedDomains(domains) {
  assert(Array.isArray(domains), "Live App domains are missing");
  const primary = domains.filter((domain) => domain?.type === "PRIMARY");
  const defaults = domains.filter((domain) => domain?.type === "DEFAULT");
  assert(primary.length === 1 && defaults.length === 1, "Live App domains changed");
  assert(domains.length === 2, "Live App has an unexpected domain");
  assert(defaults[0].zone === undefined, "DEFAULT domain cannot declare a managed DNS zone");
  return primary;
}

function assertNoExtraTopology(spec) {
  for (const key of ["databases", "functions", "static_sites", "workers"]) {
    assert(
      spec[key] === undefined || spec[key]?.length === 0,
      `Live App contains prohibited ${key}`,
    );
  }
  assert(spec.vpc === undefined, "Live App VPC is prohibited with Dedicated Egress");
  assert(
    spec.envs === undefined || spec.envs.length === 0,
    "App-level environment variables are prohibited",
  );
}

function assertEncryptedComponents(spec) {
  for (const component of [...(spec.services ?? []), ...(spec.jobs ?? [])]) {
    encryptedValue(component.image?.registry_credentials, `${component.name} registry credential`);
    for (const env of component.envs ?? []) {
      if (env.type === "SECRET") {
        encryptedValue(env.value, `${component.name}.${env.key}`);
      }
    }
  }
}

function semanticProjection(spec, mode) {
  const projected = structuredClone(spec);
  const hasDefault =
    Array.isArray(spec.domains) && spec.domains.some((domain) => domain?.type === "DEFAULT");
  if (
    ["bootstrap", "egress", "rehearsal-bootstrap", "rehearsal-egress"].includes(mode) &&
    hasDefault
  ) {
    const defaults = spec.domains.filter((domain) => domain?.type === "DEFAULT");
    assert(
      defaults.length === 1 && spec.domains.length === 1,
      "Bootstrap App has an unexpected domain",
    );
    assert(defaults[0].zone === undefined, "DEFAULT domain cannot declare a managed DNS zone");
    delete projected.domains;
  } else if (!["bootstrap", "egress", "rehearsal-bootstrap", "rehearsal-egress"].includes(mode)) {
    projected.domains = hasDefault ? projectedDomains(spec.domains) : spec.domains;
  }
  return projected;
}

export function liveSemanticSpec(appValue) {
  const app = unwrapApp(appValue);
  return semanticProjection(assertRecord(app.spec, "Live App spec"), "live");
}

export function validateApp({ app: appValue, contract, digest, appId }) {
  validateContract(contract);
  assert(DIGEST_PATTERN.test(digest), "An exact sha256 image digest is required");
  const app = unwrapApp(appValue);
  if (appId !== undefined) {
    assert(app.id === appId, "DigitalOcean App ID does not match the pinned authority");
  }
  assert(typeof app.id === "string" && app.id.length > 0, "DigitalOcean App ID is missing");
  assert(app.in_progress_deployment == null, "A DigitalOcean deployment is already in progress");
  assertNoExtraTopology(assertRecord(app.spec, "Live App spec"));
  assertEncryptedComponents(app.spec);
  const expected = renderSpec({
    contract,
    digest,
    liveApp: app,
    registryMode: "preserve",
    revision: "0".repeat(40),
    secretMode: "preserve",
  });
  assertEqual(
    semanticProjection(app.spec, contract.mode),
    semanticProjection(expected, contract.mode),
    "Live App contract",
  );
  if (["bootstrap", "rehearsal-bootstrap"].includes(contract.mode)) {
    assert(
      app.dedicated_ips === undefined || app.dedicated_ips.length === 0,
      "Bootstrap App unexpectedly owns dedicated egress",
    );
    return { appId: app.id, dedicatedIps: [], fingerprint: liveFingerprint(app) };
  }
  const dedicated = Array.isArray(app.dedicated_ips) ? app.dedicated_ips : [];
  assert(dedicated.length === 2, "DigitalOcean must assign exactly two dedicated egress IPv4s");
  const addresses = dedicated.map((entry) => {
    assert(entry?.status === "ASSIGNED", "A dedicated egress address is not assigned");
    assert(typeof entry.ip === "string" && validIpv4(entry.ip), "Dedicated egress IPv4 is invalid");
    return entry.ip;
  });
  assert(new Set(addresses).size === 2, "Dedicated egress IPv4s must be distinct");
  return { appId: app.id, dedicatedIps: addresses.sort(), fingerprint: liveFingerprint(app) };
}

export function validateLiveApp(options) {
  validateContract(options.contract, "live");
  return validateApp(options);
}

function validIpv4(value) {
  if (!IPV4_PATTERN.test(value)) {
    return false;
  }
  return value.split(".").every((part) => Number(part) <= 255);
}

export function captureLiveState(appValue) {
  const app = unwrapApp(appValue);
  assert(typeof app.id === "string" && app.id.length > 0, "DigitalOcean App ID is missing");
  assert(
    typeof app.updated_at === "string" && app.updated_at.length > 0,
    "App update timestamp is missing",
  );
  const dedicatedIps = Array.isArray(app.dedicated_ips)
    ? app.dedicated_ips
        .map((entry) => ({ ip: entry?.ip, status: entry?.status }))
        .sort((left, right) => String(left.ip).localeCompare(String(right.ip)))
    : [];
  return {
    activeDeploymentId: app.active_deployment?.id ?? null,
    appId: app.id,
    dedicatedIps,
    inProgressDeployment:
      app.in_progress_deployment == null
        ? null
        : {
            id: app.in_progress_deployment.id ?? null,
            phase: app.in_progress_deployment.phase ?? null,
          },
    spec: app.spec,
    updatedAt: app.updated_at,
  };
}

export function liveFingerprint(appValue) {
  return sha256(captureLiveState(appValue));
}

export function classifyDeploymentSpec(spec) {
  if (spec?.egress?.type !== "DEDICATED_IP") {
    return "unsafe-pre-egress";
  }
  if (
    (spec?.jobs ?? []).some((job) =>
      ["capstone-initialize", "capstone-rehearsal-initialize"].includes(job?.name),
    )
  ) {
    return "unsafe-initialization";
  }
  const services = spec?.services ?? [];
  const jobs = spec?.jobs ?? [];
  const isProductionSteady =
    services[0]?.run_command === "node apps/api/dist/entrypoint.js server" &&
    jobs[0]?.name === "capstone-migrate" &&
    jobs[0]?.run_command === "node apps/api/dist/entrypoint.js migrate";
  const isRehearsalSteady =
    services[0]?.run_command ===
      "node --expose-gc apps/api/dist/entrypoint.js load-server --confirm-isolated-load-rehearsal" &&
    jobs[0]?.name === "capstone-migrate" &&
    jobs[0]?.run_command === "node apps/api/dist/entrypoint.js migrate";
  if (
    services.length !== 1 ||
    services[0]?.name !== "capstone-chat" ||
    jobs.length !== 1 ||
    (!isProductionSteady && !isRehearsalSteady)
  ) {
    return "unsafe-bootstrap";
  }
  return isRehearsalSteady ? "steady-rehearsal" : "steady";
}

export function assertSafeRollbackHistory(deployments, { expectedClassification = "steady" } = {}) {
  assert(Array.isArray(deployments), "DigitalOcean deployment history is invalid");
  assert(
    ["steady", "steady-rehearsal"].includes(expectedClassification),
    "Rollback history classification is invalid",
  );
  const successful = deployments.filter((deployment) =>
    ["ACTIVE", "SUPERSEDED"].includes(deployment?.phase),
  );
  assert(successful.length >= 10, "Ten successful rollbackable deployments are required");
  const timestamps = new Set();
  for (const deployment of successful) {
    const createdAt = deployment?.created_at;
    const timestamp = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    const normalized = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
    assert(
      createdAt === normalized || createdAt === normalized.replace(".000Z", "Z"),
      "DigitalOcean deployment timestamp is invalid",
    );
    assert(!timestamps.has(timestamp), "DigitalOcean deployment order is ambiguous");
    timestamps.add(timestamp);
  }
  successful.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  for (const deployment of successful.slice(0, 10)) {
    assert(
      classifyDeploymentSpec(deployment.spec) === expectedClassification,
      "Unsafe bootstrap history remains rollbackable",
    );
  }
  return successful.slice(0, 10).map((deployment) => deployment.id);
}
