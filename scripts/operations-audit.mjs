import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { readContract } from "../deploy/app-platform/contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployDirectory = path.join(root, "deploy/app-platform");
const operationsDirectory = path.join(root, "docs/operations");
const deploymentFiles = [
  "README.md",
  "common.contract.yaml",
  "contract.mjs",
  "contract.test.mjs",
  "live-contract.mjs",
  "production.contract.yaml",
  "staging.contract.yaml",
];
const runbooks = [
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
const pitrIntegrityKeys = [
  "applicationRoleDeniedAdministration",
  "authTables",
  "budgetTotals",
  "compactions",
  "conversationTrees",
  "dedicatedEgressRestricted",
  "drafts",
  "expectedMarkerBoundary",
  "extensionRecreated",
  "fakeReadWrite",
  "generations",
  "initialInvitationNotSent",
  "initializationLatchVerified",
  "initializationNotRepeated",
  "migrationLedger",
  "poolTimeouts",
  "postgresMajorVersion",
  "preDeployMigration",
  "readiness",
  "reconciliation",
  "reservations",
  "searchObjects",
  "selectedLeaves",
  "signIn",
  "workspaceMemberships",
];
const coldIntegrityKeys = [
  "databaseSourceUntouched",
  "defaultDomainRedirect",
  "dedicatedEgress",
  "domainDetachedBeforeDelete",
  "egressAllowlistReplaced",
  "exactAppContract",
  "initialInvitationNotSent",
  "initializationLatchVerified",
  "initializationNotRepeated",
  "offlineSourceBundle",
  "preDeployMigration",
  "readiness",
  "secretIsolation",
  "sourceCommitMatched",
  "telemetry",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} invalid`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(record(value, label)).sort();
  assert(actual.join("\n") === [...keys].sort().join("\n"), `${label} keys changed`);
}

function repositoryFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function yaml(relativePath, label) {
  const document = parseDocument(repositoryFile(relativePath), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  assert(document.errors.length === 0, `${label} is invalid YAML`);
  return record(document.toJS(), label);
}

function workflowCommands(workflow) {
  return Object.values(record(workflow.jobs, "workflow jobs"))
    .flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .join("\n");
}

function validateShellSteps(steps, label) {
  for (const step of steps) {
    if (typeof step?.run !== "string") continue;
    const result = spawnSync("bash", ["-n"], { cwd: root, encoding: "utf8", input: step.run });
    assert(result.status === 0, `${label} shell syntax failed: ${result.stderr.trim()}`);
  }
}

function validateDeploymentAuthority() {
  const actualFiles = readdirSync(deployDirectory)
    .filter((file) => lstatSync(path.join(deployDirectory, file)).isFile())
    .sort();
  assert(actualFiles.join("\n") === deploymentFiles.sort().join("\n"), "deployment files drifted");

  const common = path.join(deployDirectory, "common.contract.yaml");
  const staging = readContract(
    common,
    path.join(deployDirectory, "staging.contract.yaml"),
    "staging",
  );
  const production = readContract(
    common,
    path.join(deployDirectory, "production.contract.yaml"),
    "production",
  );
  assert(staging.source.github.branch === "app-platform-staging", "staging source drifted");
  assert(
    production.source.github.branch === "app-platform-production",
    "production source drifted",
  );
  assert(staging.service.run_command.endsWith("entrypoint.js server"), "server command drifted");
  assert(staging.job.run_command.endsWith("entrypoint.js migrate"), "migration command drifted");
  assert(
    staging.job.environment.secret_keys.join() === "DATABASE_URL",
    "staging job secrets drifted",
  );
  assert(
    production.job.environment.secret_keys.join() === "DATABASE_URL",
    "production job secrets drifted",
  );
  assert(
    staging.dedicatedEgress === false && production.dedicatedEgress === true,
    "egress drifted",
  );

  const ci = yaml(".github/workflows/ci.yml", "CI workflow");
  const productionWorkflow = yaml(".github/workflows/deploy-production.yml", "production workflow");
  const action = yaml(".github/actions/deploy-app-platform/action.yml", "deployment action");
  const ciJobs = record(ci.jobs, "CI jobs");
  const stagingJob = record(ciJobs.staging, "staging job");
  const release = record(record(productionWorkflow.jobs, "production jobs").release, "release job");
  const ciCommands = workflowCommands(ci);
  const productionCommands = workflowCommands(productionWorkflow);
  const actionText = repositoryFile(".github/actions/deploy-app-platform/action.yml");
  const actionCommands = action.runs.steps.map((step) => step.run ?? "").join("\n");
  for (const [label, workflow] of [
    ["CI", ci],
    ["production", productionWorkflow],
  ]) {
    for (const job of Object.values(workflow.jobs)) validateShellSteps(job.steps ?? [], label);
  }
  validateShellSteps(action.runs.steps, "deployment action");
  assert(stagingJob.needs.join() === "quality,playwright", "staging quality gates drifted");
  assert(stagingJob.environment?.name === "staging", "staging environment drifted");
  assert(stagingJob.if.includes("refs/heads/main"), "staging is not limited to main pushes");
  assert(release.environment?.name === "production", "production approval environment drifted");
  assert(
    productionWorkflow.on?.workflow_dispatch?.inputs?.release_revision?.required === true,
    "production fixed input drifted",
  );
  assert(
    repositoryFile(".github/workflows/ci.yml").includes(
      "uses: ./.github/actions/deploy-app-platform",
    ),
    "staging does not use shared action",
  );
  assert(
    repositoryFile(".github/workflows/deploy-production.yml").includes(
      "uses: ./.github/actions/deploy-app-platform",
    ),
    "production does not use shared action",
  );
  for (const fragment of [
    "refs/remotes/origin/main",
    "refs/remotes/origin/app-platform-production",
    "git merge-base --is-ancestor",
    "actions/workflows/ci.yml/runs",
    "conclusion",
  ]) {
    assert(productionCommands.includes(fragment), `production gate missing ${fragment}`);
  }
  for (const fragment of [
    "live-contract.mjs validate",
    "git merge-base --is-ancestor",
    "git push origin",
    "create-deployment",
    "prior active deployment remains authoritative",
    "x-capstone-revision",
    '.status == "ready"',
  ]) {
    assert(actionCommands.includes(fragment), `shared action missing ${fragment}`);
  }
  assert(
    actionText.match(/live-contract\.mjs validate/gu)?.length === 2,
    "both states are not validated",
  );
  assert(!/git push[^\n]*(?:--force|-f\b)/u.test(actionText), "release pointer can be forced");
  assert(
    !/prepare-source|managed.rehearsal|initialize-rehearsal/iu.test(
      `${actionText}\n${productionCommands}\n${ciCommands}`,
    ),
    "obsolete release path remains",
  );

  const active = [
    "README.md",
    "docs/prd/README.md",
    "docs/prd/02-system-architecture-and-data.md",
    "docs/prd/06-development-roadmap.md",
    ...runbooks.map((file) => `docs/operations/${file}`),
    "apps/api/src/config.ts",
  ]
    .map(repositoryFile)
    .join("\n");
  assert(active.includes("staging.chat.capstone.com.ec"), "staging authority is missing");
  assert(active.includes("CAPSTONE_STAGING_EMAIL_RECIPIENTS"), "staging allowlist is missing");
  assert(
    !/CAPSTONE_DEPLOYMENT_PROFILE|CAPSTONE_LOAD_DIAGNOSTICS_SECRET|initialize-rehearsal|rehearsal\.chat/iu.test(
      active,
    ),
    "obsolete hosted rehearsal authority remains",
  );
  const dockerfile = repositoryFile("apps/api/Dockerfile");
  assert(
    dockerfile.includes('CMD ["node", "apps/api/dist/entrypoint.js", "server"]'),
    "Docker command drifted",
  );
  assert(
    !/ARG DEPLOYMENT_REVISION|ENV DEPLOYMENT_REVISION/u.test(dockerfile),
    "revision entered image build",
  );
}

function runArtifactVerification() {
  for (const file of ["contract.mjs", "live-contract.mjs"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(deployDirectory, file)], {
      cwd: root,
      encoding: "utf8",
    });
    assert(result.status === 0, result.stderr.trim() || `${file} syntax failed`);
  }
  const test = spawnSync(process.execPath, [path.join(deployDirectory, "contract.test.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert(test.status === 0, test.stderr.trim() || test.stdout.trim() || "contract tests failed");
}

function validateRunbooks() {
  const actual = readdirSync(operationsDirectory)
    .filter((file) => file.endsWith(".md"))
    .sort();
  assert(actual.join("\n") === runbooks.sort().join("\n"), "operations runbook set changed");
  const packages = new Map(
    [".", "apps/api", "apps/web", "packages/brand", "packages/protocol"].map((location) => {
      const manifest = JSON.parse(repositoryFile(path.join(location, "package.json")));
      return [manifest.name, manifest.scripts ?? {}];
    }),
  );
  for (const file of actual) {
    const contents = readFileSync(path.join(operationsDirectory, file), "utf8");
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1]?.trim();
      if (target === undefined || /^(?:https?:|mailto:|#)/u.test(target)) continue;
      const clean = target.replace(/^<|>$/gu, "").split("#", 1)[0];
      assert(
        clean !== undefined && existsSync(path.resolve(operationsDirectory, clean)),
        `${file} has a broken link`,
      );
    }
    for (const match of contents.matchAll(/\bpnpm\s+([^`\n]+)/gu)) {
      const command = match[1]?.trim().split(/\s+/u) ?? [];
      let scripts = packages.get("capstone-chat");
      if (command[0] === "--filter") {
        scripts = packages.get(command[1]);
        command.splice(0, 2);
      }
      assert(
        command[0] !== undefined && scripts?.[command[0]] !== undefined,
        `${file} has an invalid pnpm command`,
      );
    }
  }
}

function utc(value, label) {
  assert(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value),
    `${label} is not UTC`,
  );
  const milliseconds = Date.parse(value);
  assert(Number.isFinite(milliseconds), `${label} is invalid`);
  return milliseconds;
}

function validateCommon(evidence) {
  assert(
    evidence.schemaVersion === 3 && evidence.status === "accepted",
    "recovery evidence is not accepted schema 3",
  );
  assert(
    typeof evidence.operatorRole === "string" &&
      /^[a-z][a-z0-9-]{1,63}$/u.test(evidence.operatorRole),
    "operator role is invalid",
  );
  exactKeys(evidence.release, ["expected", "observed"], "release");
  assert(
    /^[0-9a-f]{40}$/u.test(evidence.release.expected) &&
      evidence.release.observed === evidence.release.expected,
    "release identity failed",
  );
  exactKeys(evidence.migration, ["expected", "observed"], "migration");
  const latest = readdirSync(path.join(root, "apps/api/migrations"))
    .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
    .sort()
    .at(-1)
    ?.slice(0, 4);
  assert(
    evidence.migration.expected === latest && evidence.migration.observed === latest,
    "migration identity failed",
  );
}

function allTrue(value, keys, label) {
  exactKeys(value, keys, label);
  for (const key of keys) assert(value[key] === true, `${label}.${key} failed`);
}

function validatePitr(evidence) {
  exactKeys(
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
      "topology",
    ],
    "PITR evidence",
  );
  validateCommon(evidence);
  exactKeys(
    evidence.topology,
    [
      "architecture",
      "backupHours",
      "initialStorageGb",
      "maximumStorageGb",
      "plan",
      "postgresMajor",
      "region",
      "retentionHours",
      "singleNode",
    ],
    "PITR topology",
  );
  assert(
    isDeepStrictEqual(evidence.topology, {
      architecture: "arm",
      backupHours: 12,
      initialStorageGb: 10,
      maximumStorageGb: 15,
      plan: "PS-5",
      postgresMajor: 18,
      region: "us-east-1",
      retentionHours: 84,
      singleNode: true,
    }),
    "PITR topology drifted",
  );
  exactKeys(
    evidence.isolation,
    [
      "applicationProvidersContacted",
      "databaseIpRestricted",
      "dedicatedEgressAddressCount",
      "rolesSeparated",
      "sourceUntouched",
      "verifyFullTls",
    ],
    "PITR isolation",
  );
  assert(
    evidence.isolation.applicationProvidersContacted === false &&
      evidence.isolation.databaseIpRestricted === true &&
      evidence.isolation.dedicatedEgressAddressCount === 2 &&
      evidence.isolation.rolesSeparated === true &&
      evidence.isolation.sourceUntouched === true &&
      evidence.isolation.verifyFullTls === true,
    "PITR isolation failed",
  );
  allTrue(evidence.integrity, pitrIntegrityKeys, "PITR integrity");
  exactKeys(
    evidence.timing,
    [
      "incidentAt",
      "latestRecoveredMarkerAt",
      "rehearsalStartedAt",
      "selectedRestoreAt",
      "validationCompletedAt",
    ],
    "PITR timing",
  );
  const started = utc(evidence.timing.rehearsalStartedAt, "PITR start");
  const incident = utc(evidence.timing.incidentAt, "PITR incident");
  const selected = utc(evidence.timing.selectedRestoreAt, "PITR selection");
  const recovered = utc(evidence.timing.latestRecoveredMarkerAt, "PITR marker");
  const completed = utc(evidence.timing.validationCompletedAt, "PITR completion");
  assert(started <= incident && selected <= incident && recovered <= selected, "PITR order failed");
  assert(
    (incident - recovered) / 60_000 <= 15 && (completed - incident) / 60_000 <= 240,
    "PITR objective failed",
  );
  allTrue(
    evidence.cleanup,
    [
      "dedicatedEgressRulesRemoved",
      "evidenceAccepted",
      "recoveryBranchRemoved",
      "temporaryCredentialsRevoked",
      "temporaryDomainRemoved",
      "temporaryRolesRemoved",
      "validationAppRemoved",
    ],
    "PITR cleanup",
  );
}

function validateCold(evidence) {
  exactKeys(
    evidence,
    [
      "cleanup",
      "integrity",
      "kind",
      "migration",
      "operatorRole",
      "release",
      "schemaVersion",
      "status",
      "timing",
      "topology",
    ],
    "cold evidence",
  );
  validateCommon(evidence);
  exactKeys(
    evidence.topology,
    [
      "autoscaling",
      "dedicatedEgressAddressCount",
      "instanceCount",
      "jobSize",
      "region",
      "serviceSize",
    ],
    "cold topology",
  );
  assert(
    isDeepStrictEqual(evidence.topology, {
      autoscaling: false,
      dedicatedEgressAddressCount: 2,
      instanceCount: 1,
      jobSize: "apps-s-1vcpu-0.5gb",
      region: "ric",
      serviceSize: "apps-s-1vcpu-1gb-fixed",
    }),
    "cold topology drifted",
  );
  allTrue(evidence.integrity, coldIntegrityKeys, "cold integrity");
  exactKeys(
    evidence.timing,
    ["incidentAt", "rehearsalStartedAt", "validationCompletedAt"],
    "cold timing",
  );
  const started = utc(evidence.timing.rehearsalStartedAt, "cold start");
  const incident = utc(evidence.timing.incidentAt, "cold incident");
  const completed = utc(evidence.timing.validationCompletedAt, "cold completion");
  assert(
    started <= incident && incident <= completed && (completed - incident) / 60_000 <= 240,
    "cold objective failed",
  );
  allTrue(
    evidence.cleanup,
    [
      "evidenceAccepted",
      "supersededAppRemoved",
      "supersededEgressRulesRemoved",
      "temporaryCredentialsRevoked",
    ],
    "cold cleanup",
  );
}

function validateRecoveryEvidence(value) {
  const evidence = record(value, "recovery evidence");
  if (evidence.kind === "planetscale-pitr-rehearsal") return validatePitr(evidence);
  if (evidence.kind === "digitalocean-app-platform-controlled-recreation")
    return validateCold(evidence);
  throw new Error("recovery evidence kind is unexpected");
}

function validateRecoveryFailClosed() {
  for (const kind of [
    "planetscale-pitr-rehearsal",
    "digitalocean-app-platform-controlled-recreation",
    "unexpected",
  ]) {
    let rejected = false;
    try {
      validateRecoveryEvidence({ kind });
    } catch {
      rejected = true;
    }
    assert(rejected, `incomplete ${kind} evidence was accepted`);
  }
}

function recoveryPath(arguments_) {
  const values = arguments_.filter((value) => value !== "--");
  assert(values.length === 1, "Usage: pnpm verify:recovery -- <safe-evidence.json>");
  const candidate = path.resolve(root, values[0]);
  assert(existsSync(candidate) && lstatSync(candidate).isFile(), "recovery evidence is missing");
  return candidate;
}

try {
  const [mode, ...arguments_] = process.argv.slice(2);
  if (mode === "--self-test") {
    runArtifactVerification();
    validateDeploymentAuthority();
    validateRunbooks();
    validateRecoveryFailClosed();
    process.stdout.write("Hosted deployment, runbook, and recovery validators passed.\n");
  } else if (mode === "--recovery-evidence") {
    const candidate = recoveryPath(arguments_);
    validateRecoveryEvidence(JSON.parse(readFileSync(candidate, "utf8")));
    process.stdout.write(`Recovery evidence passed: ${path.relative(root, candidate)}\n`);
  } else {
    throw new Error("Use --self-test or --recovery-evidence <safe-evidence.json>");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
