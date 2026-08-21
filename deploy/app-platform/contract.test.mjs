import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readContract, validateApp } from "./contract.mjs";

const liveContractPath = fileURLToPath(new URL("./live-contract.mjs", import.meta.url));
const revision = "a".repeat(40);
const encrypted = (name) => `EV[1:${name.repeat(8)}]`;
const starterDomainBinding = ["$", "{STARTER_DOMAIN}"].join("");

function contract(environment) {
  return readContract(environment);
}

function source(declaration) {
  return {
    dockerfile_path: declaration.source.dockerfile_path,
    github: { ...declaration.source.github },
    source_dir: declaration.source.source_dir,
  };
}

function environment(declaration, component) {
  return [
    ...Object.entries(declaration.general).map(([key, value]) => ({
      key,
      scope: "RUN_TIME",
      type: "GENERAL",
      value,
    })),
    ...(declaration.general_keys ?? []).map((key) => ({
      key,
      scope: "RUN_TIME",
      type: "GENERAL",
      value: "https://otlp.nr-data.net",
    })),
    ...declaration.secret_keys.map((key) => ({
      key,
      scope: "RUN_TIME",
      type: "SECRET",
      value: encrypted(`${component}-${key}`),
    })),
  ];
}

function health(httpPath, liveness = false) {
  return {
    failure_threshold: liveness ? 18 : 3,
    http_path: httpPath,
    initial_delay_seconds: liveness ? 15 : 5,
    period_seconds: 10,
    port: 3000,
    success_threshold: liveness ? 1 : 2,
    timeout_seconds: 3,
  };
}

function serviceAlerts(declaration) {
  return [
    ["CPU_UTILIZATION", declaration.alerts.service.cpu_percent],
    ["MEM_UTILIZATION", declaration.alerts.service.memory_percent],
    ["RESTART_COUNT", declaration.alerts.service.restart_count],
    ["REQUEST_DURATION_P95_MS", declaration.alerts.service.request_duration_p95_ms],
  ].map(([rule, value]) => ({
    disabled: false,
    operator: "GREATER_THAN",
    rule,
    value,
    window: "FIVE_MINUTES",
  }));
}

function spec(declaration, defaultDomain) {
  const value = {
    alerts: declaration.alerts.app.map((rule) => ({ rule })),
    disable_edge_cache: declaration.edge.disable_edge_cache,
    disable_email_obfuscation: declaration.edge.disable_email_obfuscation,
    domains: [{ domain: defaultDomain, type: "DEFAULT" }, { ...declaration.domain }],
    enhanced_threat_control_enabled: declaration.edge.enhanced_threat_control_enabled,
    features: declaration.features,
    ingress: {
      rules: [
        {
          match: { authority: { exact: starterDomainBinding }, path: { prefix: "/" } },
          redirect: {
            authority: declaration.domain.domain,
            redirect_code: 308,
            scheme: "https",
          },
        },
        {
          component: { name: declaration.service.name, preserve_path_prefix: true },
          match: { authority: { exact: declaration.domain.domain }, path: { prefix: "/" } },
        },
      ],
    },
    jobs: [
      {
        envs: environment(declaration.job.environment, declaration.job.name),
        instance_count: 1,
        instance_size_slug: declaration.job.instance_size_slug,
        kind: "PRE_DEPLOY",
        name: declaration.job.name,
        run_command: declaration.job.run_command,
        ...source(declaration),
        termination: { grace_period_seconds: 300 },
      },
    ],
    maintenance: {},
    name: declaration.name,
    region: declaration.region,
    services: [
      {
        alerts: serviceAlerts(declaration),
        envs: environment(declaration.service.environment, declaration.service.name),
        health_check: health(declaration.service.readiness_path),
        http_port: 3000,
        instance_count: 1,
        instance_size_slug: declaration.service.instance_size_slug,
        liveness_health_check: health(declaration.service.liveness_path, true),
        name: declaration.service.name,
        run_command: declaration.service.run_command,
        ...source(declaration),
        termination: { drain_seconds: 110, grace_period_seconds: 300 },
      },
    ],
  };
  if (declaration.dedicatedEgress) {
    value.egress = { type: "DEDICATED_IP" };
  }
  return value;
}

function app(environmentName) {
  const declaration = contract(environmentName);
  const defaultDomain = `capstone-${environmentName}.ondigitalocean.app`;
  const desired = spec(declaration, defaultDomain);
  return {
    active_deployment: {
      id: `deployment-${environmentName}`,
      jobs: [{ name: declaration.job.name, source_commit_hash: revision }],
      services: [{ name: declaration.service.name, source_commit_hash: revision }],
      spec: structuredClone(desired),
    },
    dedicated_ips: declaration.dedicatedEgress
      ? [
          { ip: "203.0.113.20", status: "ASSIGNED" },
          { ip: "203.0.113.21", status: "ASSIGNED" },
        ]
      : [],
    default_ingress: `https://${defaultDomain}`,
    id: `app-${environmentName}`,
    in_progress_deployment: null,
    spec: desired,
  };
}

test("validates exact desired and active staging and production contracts", () => {
  for (const environmentName of ["staging", "production"]) {
    const result = validateApp({
      app: app(environmentName),
      appId: `app-${environmentName}`,
      contract: contract(environmentName),
      expectedRevision: revision,
    });
    assert.equal(result.environment, environmentName);
    assert.equal(result.revision, revision);
    assert.equal(result.dedicatedIps.length, environmentName === "production" ? 2 : 0);
  }
});

test("accepts provider omission of disabled enhanced threat control", () => {
  const value = app("staging");
  delete value.spec.enhanced_threat_control_enabled;
  delete value.active_deployment.spec.enhanced_threat_control_enabled;

  assert.equal(
    validateApp({
      app: value,
      appId: "app-staging",
      contract: contract("staging"),
      expectedRevision: revision,
    }).environment,
    "staging",
  );
});

test("locks overlays to fixed branches, sizes, domains, email, and egress", () => {
  const staging = contract("staging");
  const production = contract("production");
  assert(Object.isFrozen(staging));
  assert(Object.isFrozen(staging.service.environment.general));
  assert(Object.isFrozen(production));
  assert.equal(staging.source.github.branch, "app-platform-staging");
  assert.equal(production.source.github.branch, "app-platform-production");
  assert.equal(staging.service.instance_size_slug, "apps-s-1vcpu-0.5gb");
  assert.equal(production.service.instance_size_slug, "apps-s-1vcpu-1gb-fixed");
  assert.equal(staging.job.instance_size_slug, "apps-s-1vcpu-0.5gb");
  assert.equal(staging.domain.domain, "staging.chat.capstone.com.ec");
  assert.equal(production.domain.domain, "chat.capstone.com.ec");
  assert.equal(staging.dedicatedEgress, false);
  assert.equal(production.dedicatedEgress, true);
  assert.deepEqual(Object.keys(staging.job.environment.general).sort(), [
    "CAPSTONE_ENVIRONMENT",
    "DEPLOYMENT_REVISION",
    "NODE_ENV",
  ]);
  assert.deepEqual(Object.keys(production.job.environment.general).sort(), [
    "CAPSTONE_ENVIRONMENT",
    "CAPSTONE_SECRET_SOURCE",
    "DEPLOYMENT_REVISION",
    "DEPLOYMENT_TARGET",
    "NODE_ENV",
  ]);
  assert.deepEqual(Object.keys(staging.service.environment.general).sort(), [
    "CAPSTONE_ENVIRONMENT",
    "DEPLOYMENT_REVISION",
    "EMAIL_DELIVERY",
    "EMAIL_FROM",
    "HOST",
    "LOG_LEVEL",
    "MODEL_GATEWAY",
    "NODE_ENV",
    "PORT",
    "PUBLIC_ORIGIN",
  ]);
  assert.deepEqual(Object.keys(production.service.environment.general).sort(), [
    "CAPSTONE_ENVIRONMENT",
    "CAPSTONE_SECRET_SOURCE",
    "CLIENT_ADDRESS_SOURCE",
    "DEPLOYMENT_REVISION",
    "DEPLOYMENT_TARGET",
    "EMAIL_DELIVERY",
    "EMAIL_FROM",
    "HOST",
    "LOG_LEVEL",
    "MODEL_GATEWAY",
    "NODE_ENV",
    "PORT",
    "PUBLIC_ORIGIN",
    "WEB_ASSETS",
  ]);
  assert.deepEqual(staging.job.environment.secret_keys, ["DATABASE_URL"]);
  assert.deepEqual(production.job.environment.secret_keys, ["DATABASE_URL"]);
  assert(staging.service.environment.secret_keys.includes("CAPSTONE_STAGING_EMAIL_RECIPIENTS"));
  assert(!production.service.environment.secret_keys.includes("CAPSTONE_STAGING_EMAIL_RECIPIENTS"));
});

test("rejects source, command, topology, encryption, domain, edge, and egress drift", () => {
  const cases = [
    (value) => {
      value.active_deployment.services[0].source_commit_hash = "b".repeat(40);
    },
    (value) => {
      value.active_deployment.jobs[0].source_commit_hash = "b".repeat(40);
    },
    (value) => {
      value.spec.services[0].run_command = "node other.js";
    },
    (value) => {
      value.active_deployment.spec.jobs[0].run_command = "node other.js";
    },
    (value) => {
      value.spec.services.push(structuredClone(value.spec.services[0]));
    },
    (value) => {
      value.spec.workers = [{ name: "extra" }];
    },
    (value) => {
      value.spec.services[0].envs.find((entry) => entry.type === "SECRET").value = "plaintext";
    },
    (value) => {
      value.spec.domains[1].domain = "other.example";
    },
    (value) => {
      value.spec.disable_edge_cache = false;
    },
    (value) => {
      value.spec.egress = undefined;
    },
    (value) => {
      value.in_progress_deployment = { id: "deploying" };
    },
    (value) => {
      value.active_deployment.workers = [{ name: "extra" }];
    },
  ];
  for (const mutate of cases) {
    const value = app("production");
    mutate(value);
    assert.throws(() =>
      validateApp({
        app: value,
        contract: contract("production"),
        expectedRevision: revision,
      }),
    );
  }
});

test("rejects dedicated egress in staging", () => {
  const value = app("staging");
  value.dedicated_ips = [
    { ip: "203.0.113.20", status: "ASSIGNED" },
    { ip: "203.0.113.21", status: "ASSIGNED" },
  ];
  assert.throws(
    () => validateApp({ app: value, contract: contract("staging"), expectedRevision: revision }),
    /Staging cannot own dedicated egress/u,
  );
});

test("rejects duplicated live-validator arguments", () => {
  const result = spawnSync(process.execPath, [
    liveContractPath,
    "validate",
    "--environment",
    "staging",
    "--environment",
    "production",
    "--live-file",
    "unused",
    "--revision",
    revision,
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr.toString()).outcome, "failed");
});
