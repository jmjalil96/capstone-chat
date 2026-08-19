import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readContract, readProtectedJson, validateApp, validateContract } from "./contract.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const revision = "a".repeat(40);
const starterDomainBinding = ["$", "{STARTER_DOMAIN}"].join("");
const encrypted = (name) => `EV[1:${name.repeat(8)}]`;

function source(contract) {
  return {
    dockerfile_path: contract.source.dockerfile_path,
    github: { ...contract.source.github },
    source_dir: contract.source.source_dir,
  };
}

function environment(declaration, componentName) {
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
      value: encrypted(`${componentName}-${key}`),
    })),
  ];
}

function healthCheck(httpPath, liveness = false) {
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

function serviceAlerts(contract) {
  if (contract.mode === "bootstrap" || contract.mode === "rehearsal-bootstrap") {
    return undefined;
  }
  return [
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "CPU_UTILIZATION",
      value: 85,
      window: "FIVE_MINUTES",
    },
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "MEM_UTILIZATION",
      value: 85,
      window: "FIVE_MINUTES",
    },
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "RESTART_COUNT",
      value: 1,
      window: "FIVE_MINUTES",
    },
    {
      disabled: false,
      operator: "GREATER_THAN",
      rule: "REQUEST_DURATION_P95_MS",
      value: 750,
      window: "FIVE_MINUTES",
    },
  ];
}

function appFixture(contract) {
  const final = contract.mode === "live" || contract.mode === "rehearsal";
  const defaultDomain = `${contract.name}-fixture.ondigitalocean.app`;
  const service = {
    envs: environment(contract.service.environment, contract.service.name),
    health_check: healthCheck(contract.service.readiness_path),
    http_port: contract.service.http_port,
    instance_count: contract.service.instance_count,
    instance_size_slug: contract.service.instance_size_slug,
    liveness_health_check: healthCheck(contract.service.liveness_path, true),
    name: contract.service.name,
    protocol: "HTTP",
    run_command: contract.service.run_command,
    ...source(contract),
    termination: {
      drain_seconds: contract.service.drain_seconds,
      grace_period_seconds: contract.service.grace_period_seconds,
    },
  };
  const alerts = serviceAlerts(contract);
  if (alerts !== undefined) {
    service.alerts = alerts;
  }
  const spec = {
    alerts: contract.alerts.app.map((rule) => ({ rule })),
    features: [...contract.features],
    ingress: final
      ? {
          rules: [
            {
              match: { authority: { exact: starterDomainBinding }, path: { prefix: "/" } },
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
        }
      : {
          rules: [
            {
              component: { name: contract.service.name, preserve_path_prefix: true },
              match: { path: { prefix: "/" } },
            },
          ],
        },
    maintenance: { enabled: false },
    name: contract.name,
    region: contract.region,
    services: [service],
  };
  if (final) {
    Object.assign(spec, contract.edge, {
      domains: [{ domain: defaultDomain, type: "DEFAULT" }, { ...contract.domain }],
      egress: { ...contract.egress },
      jobs: [
        {
          envs: environment(contract.job.environment, contract.job.name),
          instance_count: contract.job.instance_count,
          instance_size_slug: contract.job.instance_size_slug,
          kind: contract.job.kind,
          name: contract.job.name,
          run_command: contract.job.run_command,
          ...source(contract),
          termination: { grace_period_seconds: contract.job.grace_period_seconds },
        },
      ],
    });
  } else {
    spec.domains = [{ domain: defaultDomain, type: "DEFAULT" }];
  }
  return {
    active_deployment: {
      id: "deployment-fixture-active",
      jobs: final ? [{ name: contract.job.name, source_commit_hash: revision }] : [],
      services: [{ name: contract.service.name, source_commit_hash: revision }],
      spec: structuredClone(spec),
    },
    dedicated_ips: final
      ? [
          { ip: "192.0.2.10", status: "ASSIGNED" },
          { ip: "192.0.2.11", status: "ASSIGNED" },
        ]
      : [],
    default_ingress: `https://${defaultDomain}`,
    id: final ? "app-fixture-final" : "app-fixture-bootstrap",
    in_progress_deployment: null,
    spec,
  };
}

function providerShapedFixture(contract) {
  const fixture = appFixture(contract);
  const final = contract.mode === "live" || contract.mode === "rehearsal";
  fixture.spec.maintenance = {};
  delete fixture.spec.services[0].github.deploy_on_push;
  delete fixture.spec.services[0].protocol;
  for (const entry of fixture.spec.services[0].envs) {
    if (entry.type === "GENERAL") {
      delete entry.type;
    }
  }
  for (const alert of fixture.spec.services[0].alerts ?? []) {
    delete alert.disabled;
  }
  for (const job of fixture.spec.jobs ?? []) {
    delete job.github.deploy_on_push;
    for (const entry of job.envs) {
      if (entry.type === "GENERAL") {
        delete entry.type;
      }
    }
  }
  if (fixture.spec.enhanced_threat_control_enabled === false) {
    delete fixture.spec.enhanced_threat_control_enabled;
  }
  if (final) {
    fixture.spec.domains = fixture.spec.domains.filter((domain) => domain.type === "PRIMARY");
  } else {
    delete fixture.spec.domains;
  }
  return fixture;
}

for (const [name, mode] of [
  ["app.contract.yaml", "live"],
  ["bootstrap.contract.yaml", "bootstrap"],
  ["rehearsal.contract.yaml", "rehearsal"],
  ["rehearsal-bootstrap.contract.yaml", "rehearsal-bootstrap"],
]) {
  const contents = readFileSync(path.join(directory, name), "utf8");
  assert.doesNotMatch(contents, /GHCR|digest|registry_credentials|sha256:/u);
  assert.match(contents, /deploy_on_push: false/u);
  assert.match(contents, /DEPLOYMENT_REVISION: \$\{_self\.COMMIT_HASH\}/u);
  const contract = readContract(path.join(directory, name), mode);
  const result = validateApp({ app: appFixture(contract), contract, expectedRevision: revision });
  assert.equal(result.mode, mode);
  assert.equal(result.revision, revision);
  assert.doesNotThrow(() =>
    validateApp({ app: providerShapedFixture(contract), contract, expectedRevision: revision }),
  );
}

{
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const result = validateApp({
    app: { app: appFixture(contract) },
    appId: "app-fixture-final",
    contract,
    expectedRevision: revision,
  });
  assert.deepEqual(result.dedicatedIps, ["192.0.2.10", "192.0.2.11"]);
}

{
  const contract = readContract(path.join(directory, "bootstrap.contract.yaml"), "bootstrap");
  const fixture = appFixture(contract);
  for (const field of [
    "disable_edge_cache",
    "disable_email_obfuscation",
    "enhanced_threat_control_enabled",
  ]) {
    fixture.spec[field] = false;
  }
  assert.doesNotThrow(() => validateApp({ app: fixture, contract, expectedRevision: revision }));
  fixture.spec.disable_edge_cache = true;
  assert.throws(
    () => validateApp({ app: fixture, contract, expectedRevision: revision }),
    /edge setting/u,
  );
}

{
  const contract = readContract(
    path.join(directory, "rehearsal-bootstrap.contract.yaml"),
    "rehearsal-bootstrap",
  );
  for (const features of [
    undefined,
    [],
    ["buildpack-stack=ubuntu-24"],
    [...contract.features, "unexpected"],
  ]) {
    const fixture = appFixture(contract);
    fixture.spec.features = features;
    assert.throws(
      () => validateApp({ app: fixture, contract, expectedRevision: revision }),
      /features/u,
    );
  }
  const activeMismatch = appFixture(contract);
  activeMismatch.active_deployment.spec.features = ["buildpack-stack=ubuntu-24"];
  assert.throws(
    () => validateApp({ app: activeMismatch, contract, expectedRevision: revision }),
    /features/u,
  );
}

{
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const fixture = appFixture(contract);
  fixture.spec.domains.find((domain) => domain.type === "DEFAULT").wildcard = true;
  assert.throws(
    () => validateApp({ app: fixture, contract, expectedRevision: revision }),
    /Live App DEFAULT domain/u,
  );
}

{
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const fixture = appFixture(contract);
  const defaultDomain = new URL(fixture.default_ingress).hostname;
  fixture.spec.ingress.rules[0].match.authority.exact = defaultDomain;
  assert.throws(
    () => validateApp({ app: fixture, contract, expectedRevision: revision }),
    /ingress/u,
  );
}

{
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const fixture = appFixture(contract);
  const defaultDomain = new URL(fixture.default_ingress).hostname;
  fixture.active_deployment.spec.ingress.rules[0].match.authority.exact = defaultDomain;
  assert.throws(
    () => validateApp({ app: fixture, contract, expectedRevision: revision }),
    /ingress/u,
  );
}

{
  const contract = readContract(path.join(directory, "bootstrap.contract.yaml"), "bootstrap");
  const fixture = appFixture(contract);
  fixture.spec.domains = [{ domain: "unexpected.example.test", type: "PRIMARY" }];
  assert.throws(
    () => validateApp({ app: fixture, contract, expectedRevision: revision }),
    /Bootstrap App domain/u,
  );
}

{
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const mutations = [
    {
      message: /source/u,
      mutate: (fixture) => {
        fixture.spec.services[0].github.deploy_on_push = true;
      },
    },
    {
      message: /source commit/u,
      mutate: (fixture) => {
        fixture.active_deployment.services[0].source_commit_hash = "b".repeat(40);
      },
    },
    {
      message: /service command/u,
      mutate: (fixture) => {
        fixture.active_deployment.spec.services[0].run_command = "node unexpected.js";
      },
    },
    {
      message: /prohibited workers/u,
      mutate: (fixture) => {
        fixture.active_deployment.workers = [
          { name: "unexpected-worker", source_commit_hash: revision },
        ];
      },
    },
    {
      message: /provider-encrypted/u,
      mutate: (fixture) => {
        fixture.spec.services[0].envs.find((entry) => entry.type === "SECRET").value =
          "plaintext-secret";
      },
    },
    {
      message: /DEPLOYMENT_REVISION/u,
      mutate: (fixture) => {
        fixture.spec.services[0].envs.find((entry) => entry.key === "DEPLOYMENT_REVISION").value =
          revision;
      },
    },
    {
      message: /dedicated egress/u,
      mutate: (fixture) => {
        fixture.dedicated_ips = [{ ip: "192.0.2.10", status: "ASSIGNED" }];
      },
    },
    {
      message: /already in progress/u,
      mutate: (fixture) => {
        fixture.in_progress_deployment = { id: "deployment-in-progress" };
      },
    },
  ];
  for (const { message, mutate } of mutations) {
    const fixture = appFixture(contract);
    mutate(fixture);
    assert.throws(
      () => validateApp({ app: fixture, contract, expectedRevision: revision }),
      message,
    );
  }
}

{
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const changed = structuredClone(contract);
  changed.source.github.branch = "main";
  assert.throws(() => validateContract(changed, "live"), /contract/u);
}

{
  const temporary = mkdtempSync(path.join(os.tmpdir(), "capstone-app-contract-"));
  const protectedPath = path.join(temporary, "live.json");
  const contract = readContract(path.join(directory, "app.contract.yaml"), "live");
  const fixture = [appFixture(contract)];
  writeFileSync(protectedPath, `${JSON.stringify(fixture)}\n`, { mode: 0o600 });
  assert.deepEqual(readProtectedJson(protectedPath, "Fixture"), fixture);
  const command = spawnSync(
    process.execPath,
    [
      path.join(directory, "live-contract.mjs"),
      "validate",
      "--mode",
      "live",
      "--live-file",
      protectedPath,
      "--app-id",
      "app-fixture-final",
      "--revision",
      revision,
    ],
    { encoding: "utf8" },
  );
  assert.equal(command.status, 0, command.stderr);
  assert.deepEqual(JSON.parse(command.stdout), {
    appId: "app-fixture-final",
    dedicatedIps: ["192.0.2.10", "192.0.2.11"],
    deploymentId: "deployment-fixture-active",
    mode: "live",
    operation: "validate",
    revision,
    schema: 1,
  });
  chmodSync(protectedPath, 0o644);
  assert.throws(() => readProtectedJson(protectedPath, "Fixture"), /0600/u);
  rmSync(temporary, { force: true, recursive: true });
}

process.stdout.write("App Platform native-source contract tests passed.\n");
