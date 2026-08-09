import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operationsDirectory = path.join(repositoryRoot, "docs/operations");
const blueprintPath = path.join(repositoryRoot, "render.yaml");
const requiredRunbooks = [
  "README.md",
  "database-recovery.md",
  "deploy-and-rollback.md",
  "domain-and-tls.md",
  "employee-access.md",
  "incident-response.md",
  "providers-and-budget.md",
  "provision-and-deploy.md",
  "secret-rotation.md",
];
const integrityKeys = [
  "authTables",
  "budgetTotals",
  "compactions",
  "conversationTrees",
  "drafts",
  "expectedMarkerBoundary",
  "fakeReadWrite",
  "generations",
  "migrationLedger",
  "postgresMajorVersion",
  "readiness",
  "reconciliation",
  "reservations",
  "searchIndexes",
  "selectedLeaves",
  "signIn",
  "workspaceMemberships",
];

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
    `${label} must be an object`,
  );
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertRecord(value, label)).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} must contain exactly: ${wanted.join(", ")}`,
  );
}

function parseBlueprint() {
  const document = parseDocument(readFileSync(blueprintPath, "utf8"), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(`render.yaml is invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  return assertRecord(document.toJS(), "render.yaml");
}

function namedEnvironment(environment, key) {
  const matches = environment.filter((entry) => assertRecord(entry, `envVars.${key}`).key === key);
  assert(matches.length === 1, `render.yaml must define ${key} exactly once`);
  return matches[0];
}

function assertEnvironmentValue(environment, key, value) {
  const entry = namedEnvironment(environment, key);
  assertExactKeys(entry, ["key", "value"], `envVars.${key}`);
  assert(entry.value === value, `render.yaml ${key} must equal ${value}`);
}

function assertExternalSecret(environment, key) {
  const entry = namedEnvironment(environment, key);
  assertExactKeys(entry, ["key", "sync"], `envVars.${key}`);
  assert(entry.sync === false, `render.yaml ${key} must be supplied outside source control`);
}

function validateBlueprint() {
  const blueprint = parseBlueprint();
  assertExactKeys(blueprint, ["databases", "previews", "services"], "render.yaml");
  assertExactKeys(blueprint.previews, ["generation"], "render.yaml previews");
  assert(
    blueprint.previews.generation === "off",
    "Render preview environments must remain disabled",
  );
  assert(
    Array.isArray(blueprint.services) && blueprint.services.length === 1,
    "render.yaml must define exactly one service",
  );
  assert(
    Array.isArray(blueprint.databases) && blueprint.databases.length === 1,
    "render.yaml must define exactly one database",
  );

  const service = assertRecord(blueprint.services[0], "Render service");
  assertExactKeys(
    service,
    [
      "autoDeployTrigger",
      "branch",
      "dockerContext",
      "dockerfilePath",
      "domains",
      "envVars",
      "healthCheckPath",
      "maxShutdownDelaySeconds",
      "name",
      "numInstances",
      "plan",
      "preDeployCommand",
      "region",
      "renderSubdomainPolicy",
      "runtime",
      "type",
    ],
    "Render service",
  );
  const expectedServiceValues = {
    autoDeployTrigger: "checksPass",
    branch: "main",
    dockerContext: ".",
    dockerfilePath: "./apps/api/Dockerfile",
    healthCheckPath: "/api/health/ready",
    maxShutdownDelaySeconds: 270,
    name: "capstone-chat",
    numInstances: 1,
    preDeployCommand: "node apps/api/dist/database/migrate-command.js",
    region: "virginia",
    renderSubdomainPolicy: "disabled",
    runtime: "docker",
    type: "web",
  };
  for (const [key, value] of Object.entries(expectedServiceValues)) {
    assert(service[key] === value, `render.yaml service ${key} must equal ${String(value)}`);
  }
  assert(
    typeof service.plan === "string" && service.plan.length > 0,
    "Render service plan must be recorded",
  );
  assert(
    Array.isArray(service.domains) &&
      service.domains.length === 1 &&
      service.domains[0] === "chat.capstone.com.ec",
    "render.yaml must define only the approved custom domain",
  );
  assert(Array.isArray(service.envVars), "render.yaml service envVars must be an array");
  const environment = service.envVars;
  assert(
    environment.length === 13,
    "render.yaml must define the closed production environment set",
  );
  assertEnvironmentValue(environment, "NODE_ENV", "production");
  assertEnvironmentValue(environment, "HOST", "0.0.0.0");
  assertEnvironmentValue(environment, "PUBLIC_ORIGIN", "https://chat.capstone.com.ec");
  assertEnvironmentValue(environment, "MODEL_GATEWAY", "openrouter");
  assertEnvironmentValue(environment, "EMAIL_DELIVERY", "resend");
  assertEnvironmentValue(
    environment,
    "EMAIL_FROM",
    "Capstone Chat <no-reply@mail.capstone.com.ec>",
  );
  assertEnvironmentValue(environment, "LOG_LEVEL", "info");
  for (const key of [
    "OPENROUTER_API_KEY",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "RESEND_API_KEY",
  ]) {
    assertExternalSecret(environment, key);
  }
  const authSecret = namedEnvironment(environment, "BETTER_AUTH_SECRET");
  assertExactKeys(authSecret, ["generateValue", "key"], "envVars.BETTER_AUTH_SECRET");
  assert(authSecret.generateValue === true, "BETTER_AUTH_SECRET must be generated by Render");
  const databaseUrl = namedEnvironment(environment, "DATABASE_URL");
  assertExactKeys(databaseUrl, ["fromDatabase", "key"], "envVars.DATABASE_URL");
  assertExactKeys(
    databaseUrl.fromDatabase,
    ["name", "property"],
    "envVars.DATABASE_URL.fromDatabase",
  );
  assert(
    databaseUrl.fromDatabase.name === "capstone-chat-postgres" &&
      databaseUrl.fromDatabase.property === "connectionString",
    "DATABASE_URL must use the managed database private connection string",
  );

  const database = assertRecord(blueprint.databases[0], "Render database");
  assertExactKeys(
    database,
    [
      "connectionPool",
      "databaseName",
      "diskSizeGB",
      "highAvailability",
      "ipAllowList",
      "name",
      "plan",
      "postgresMajorVersion",
      "readReplicas",
      "region",
      "storageAutoscalingEnabled",
      "user",
    ],
    "Render database",
  );
  assert(database.name === "capstone-chat-postgres", "render.yaml database name is unexpected");
  assert(database.databaseName === "capstone_chat", "render.yaml databaseName is unexpected");
  assert(database.user === "capstone_chat", "render.yaml database user is unexpected");
  assert(database.region === "virginia", "Render database must remain in Virginia");
  assert(database.postgresMajorVersion === "18", "Render database must use PostgreSQL 18");
  assert(
    typeof database.plan === "string" && database.plan.length > 0,
    "Render database plan must be recorded",
  );
  assert(
    Number.isInteger(database.diskSizeGB) && database.diskSizeGB > 0,
    "Render database disk size must be explicit",
  );
  assert(
    database.storageAutoscalingEnabled === false,
    "database storage autoscaling must remain disabled",
  );
  assert(database.connectionPool === "none", "a separate database pooler is not approved");
  assertExactKeys(database.highAvailability, ["enabled"], "Render database highAvailability");
  assert(database.highAvailability.enabled === false, "database high availability is not approved");
  assert(
    Array.isArray(database.readReplicas) && database.readReplicas.length === 0,
    "database replicas are not approved",
  );
  assert(
    Array.isArray(database.ipAllowList) && database.ipAllowList.length === 0,
    "database public access must be disabled",
  );
}

function workspacePackages() {
  const packages = new Map();
  for (const location of [".", "apps/api", "apps/web", "packages/brand", "packages/protocol"]) {
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, location, "package.json"), "utf8"),
    );
    packages.set(manifest.name, manifest.scripts ?? {});
  }
  return packages;
}

function validateRunbooks() {
  const actual = readdirSync(operationsDirectory)
    .filter((file) => file.endsWith(".md"))
    .sort();
  assert(
    actual.length === requiredRunbooks.length &&
      actual.every((file, index) => file === requiredRunbooks[index]),
    `docs/operations must contain exactly: ${requiredRunbooks.join(", ")}`,
  );

  const packages = workspacePackages();
  const rootScripts = packages.get("capstone-chat");
  for (const file of actual) {
    const absolute = path.join(operationsDirectory, file);
    const contents = readFileSync(absolute, "utf8");
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1]?.trim();
      if (target === undefined || /^(?:https?:|mailto:|#)/u.test(target)) {
        continue;
      }
      const cleanTarget = target.replace(/^<|>$/gu, "").split("#", 1)[0];
      assert(
        cleanTarget !== undefined && existsSync(path.resolve(operationsDirectory, cleanTarget)),
        `${file} links to missing ${target}`,
      );
    }

    for (const match of contents.matchAll(/\bpnpm\s+([^`\n]+)/gu)) {
      const command = match[1]?.trim().split(/\s+/u) ?? [];
      let scripts = rootScripts;
      if (command[0] === "--filter") {
        const packageName = command[1];
        assert(
          packageName !== undefined && packages.has(packageName),
          `${file} references unknown workspace ${String(packageName)}`,
        );
        scripts = packages.get(packageName);
        command.splice(0, 2);
      }
      const script = command[0];
      assert(
        script !== undefined && scripts?.[script] !== undefined,
        `${file} references missing pnpm script ${String(script)}`,
      );
    }
  }
}

function utcMilliseconds(value, label) {
  assert(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value),
    `${label} must be an ISO UTC timestamp`,
  );
  const milliseconds = Date.parse(value);
  assert(Number.isFinite(milliseconds), `${label} must be a valid timestamp`);
  return milliseconds;
}

function latestMigration() {
  const migrations = readdirSync(path.join(repositoryRoot, "apps/api/migrations"))
    .map((file) => /^(\d{4})_.+\.sql$/u.exec(file)?.[1])
    .filter(Boolean)
    .sort();
  const latest = migrations.at(-1);
  assert(latest !== undefined, "at least one database migration must exist");
  return latest;
}

function validateRecoveryEvidence(value) {
  const evidence = assertRecord(value, "recovery evidence");
  assertExactKeys(
    evidence,
    [
      "cleanup",
      "integrity",
      "isolation",
      "kind",
      "migration",
      "operatorRole",
      "release",
      "schemaVersion",
      "status",
      "timing",
    ],
    "recovery evidence",
  );
  assert(evidence.schemaVersion === 1, "recovery evidence schemaVersion must equal 1");
  assert(evidence.kind === "render-pitr-rehearsal", "recovery evidence kind is unexpected");
  assert(
    evidence.status === "accepted",
    "recovery evidence must be accepted before cleanup is claimed",
  );
  assert(
    typeof evidence.operatorRole === "string" &&
      /^[a-z][a-z0-9-]{1,63}$/u.test(evidence.operatorRole),
    "operatorRole must be a safe role, not personal data",
  );

  assertExactKeys(evidence.release, ["expected", "observed"], "recovery evidence release");
  assert(
    /^[0-9a-f]{40}$/u.test(evidence.release.expected),
    "expected release must be a full lowercase commit identifier",
  );
  assert(
    evidence.release.observed === evidence.release.expected,
    "observed release must match the expected release",
  );
  assertExactKeys(evidence.migration, ["expected", "observed"], "recovery evidence migration");
  assert(
    evidence.migration.expected === latestMigration(),
    "expected migration must match the repository's latest migration",
  );
  assert(
    evidence.migration.observed === evidence.migration.expected,
    "observed migration must match the expected migration",
  );

  assertExactKeys(
    evidence.isolation,
    ["databasePrivate", "externalProvidersContacted", "sourceUntouched"],
    "recovery evidence isolation",
  );
  assert(evidence.isolation.databasePrivate === true, "the recovered database must remain private");
  assert(
    evidence.isolation.externalProvidersContacted === false,
    "recovery validation must not contact external providers",
  );
  assert(evidence.isolation.sourceUntouched === true, "the source database must remain untouched");

  assertExactKeys(evidence.integrity, integrityKeys, "recovery evidence integrity");
  for (const key of integrityKeys) {
    assert(evidence.integrity[key] === true, `recovery integrity check ${key} must pass`);
  }

  assertExactKeys(
    evidence.timing,
    [
      "incidentAt",
      "latestRecoveredMarkerAt",
      "rehearsalStartedAt",
      "selectedRestoreAt",
      "validationCompletedAt",
    ],
    "recovery evidence timing",
  );
  const startedAt = utcMilliseconds(evidence.timing.rehearsalStartedAt, "rehearsalStartedAt");
  const incidentAt = utcMilliseconds(evidence.timing.incidentAt, "incidentAt");
  const selectedAt = utcMilliseconds(evidence.timing.selectedRestoreAt, "selectedRestoreAt");
  const recoveredAt = utcMilliseconds(
    evidence.timing.latestRecoveredMarkerAt,
    "latestRecoveredMarkerAt",
  );
  const completedAt = utcMilliseconds(
    evidence.timing.validationCompletedAt,
    "validationCompletedAt",
  );
  assert(startedAt <= incidentAt && incidentAt <= completedAt, "recovery timing order is invalid");
  assert(selectedAt <= incidentAt, "selected restore point cannot be after the incident point");
  assert(recoveredAt <= incidentAt, "latest recovered marker cannot be after the incident point");
  assert(
    recoveredAt <= selectedAt,
    "latest recovered marker must be at or before the selected restore point",
  );
  assert((incidentAt - recoveredAt) / 60_000 <= 15, "observed RPO exceeds 15 minutes");
  assert((completedAt - incidentAt) / 60_000 <= 240, "observed RTO exceeds four hours");

  assertExactKeys(
    evidence.cleanup,
    ["applicationRemoved", "databaseRemoved", "evidenceAccepted"],
    "recovery evidence cleanup",
  );
  assert(
    evidence.cleanup.evidenceAccepted === true,
    "recovery evidence must be accepted before cleanup",
  );
  assert(
    evidence.cleanup.applicationRemoved === true,
    "the disposable recovery application must be removed",
  );
  assert(
    evidence.cleanup.databaseRemoved === true,
    "the disposable recovery database must be removed",
  );
}

function safeExample() {
  return {
    cleanup: { applicationRemoved: true, databaseRemoved: true, evidenceAccepted: true },
    integrity: Object.fromEntries(integrityKeys.map((key) => [key, true])),
    isolation: { databasePrivate: true, externalProvidersContacted: false, sourceUntouched: true },
    kind: "render-pitr-rehearsal",
    migration: { expected: latestMigration(), observed: latestMigration() },
    operatorRole: "recovery-operator",
    release: {
      expected: "0123456789abcdef0123456789abcdef01234567",
      observed: "0123456789abcdef0123456789abcdef01234567",
    },
    schemaVersion: 1,
    status: "accepted",
    timing: {
      incidentAt: "2026-08-08T12:15:00.000Z",
      latestRecoveredMarkerAt: "2026-08-08T12:05:00.000Z",
      rehearsalStartedAt: "2026-08-08T12:00:00.000Z",
      selectedRestoreAt: "2026-08-08T12:10:00.000Z",
      validationCompletedAt: "2026-08-08T13:00:00.000Z",
    },
  };
}

function runSelfTest() {
  validateRecoveryEvidence(safeExample());
  const unsafeExamples = [
    (evidence) => {
      evidence.isolation.sourceUntouched = false;
    },
    (evidence) => {
      evidence.timing.latestRecoveredMarkerAt = "2026-08-08T11:59:00.000Z";
    },
    (evidence) => {
      evidence.timing.validationCompletedAt = "2026-08-08T16:16:00.000Z";
    },
    (evidence) => {
      evidence.notes = "unexpected free-form field";
    },
  ];
  for (const makeUnsafe of unsafeExamples) {
    const unsafe = structuredClone(safeExample());
    makeUnsafe(unsafe);
    let rejected = false;
    try {
      validateRecoveryEvidence(unsafe);
    } catch {
      rejected = true;
    }
    assert(rejected, "recovery evidence self-test did not reject unsafe evidence");
  }
}

function evidencePath(arguments_) {
  const remaining = arguments_.filter((argument) => argument !== "--");
  assert(remaining.length === 1, "Usage: pnpm verify:recovery -- <safe-evidence.json>");
  const candidate = path.resolve(repositoryRoot, remaining[0]);
  assert(existsSync(candidate), `Recovery evidence does not exist: ${remaining[0]}`);
  return candidate;
}

try {
  validateBlueprint();
  validateRunbooks();
  const [mode, ...arguments_] = process.argv.slice(2);
  if (mode === "--self-test") {
    runSelfTest();
    process.stdout.write("Blueprint, runbook, and recovery-evidence validators passed.\n");
  } else if (mode === "--recovery-evidence") {
    const candidate = evidencePath(arguments_);
    validateRecoveryEvidence(JSON.parse(readFileSync(candidate, "utf8")));
    process.stdout.write(`Recovery evidence passed: ${path.relative(repositoryRoot, candidate)}\n`);
  } else {
    fail("Use --self-test or --recovery-evidence <safe-evidence.json>");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
