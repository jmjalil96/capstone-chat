import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { readContract } from "../deploy/app-platform/contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploymentDirectory = path.join(repositoryRoot, "deploy/app-platform");
const operationsDirectory = path.join(repositoryRoot, "docs/operations");
const deploymentRevisionBinding = ["$", "{_self.COMMIT_HASH}"].join("");
const starterDomainBinding = ["$", "{STARTER_DOMAIN}"].join("");
const releaseOperationBinding = ["$", "{{ inputs.operation }}"].join("");
const deployTokenBinding = ["$", "{{ secrets.DIGITALOCEAN_DEPLOY_TOKEN }}"].join("");
const exactDoctlVersionCheck = [
  'doctl_version="$(doctl version)"',
  `test "$(printf '%s\\n' "$doctl_version" | sed -n '1p')" = "doctl version 1.166.0-release"`,
  `test "$(printf '%s\\n' "$doctl_version" | sed -n '2p')" = "Git commit hash: b98e7442"`,
  `test "$(printf '%s\\n' "$doctl_version" | wc -l | tr -d ' ')" = "2"`,
].join("\n");
const requiredDeploymentFiles = [
  "README.md",
  "app.contract.yaml",
  "bootstrap.contract.yaml",
  "contract.mjs",
  "contract.test.mjs",
  "live-contract.mjs",
  "rehearsal-bootstrap.contract.yaml",
  "rehearsal.contract.yaml",
];
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
const coldRecreationIntegrityKeys = [
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

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
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

function readRepositoryFile(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function parseYaml(relativePath, label) {
  const document = parseDocument(readRepositoryFile(relativePath), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  assert(document.errors.length === 0, `${label} is invalid YAML`);
  return assertRecord(document.toJS(), label);
}

function commands(workflow) {
  return Object.values(assertRecord(workflow.jobs, "workflow jobs"))
    .flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .join("\n");
}

function latestMigrationFile() {
  const latest = readdirSync(path.join(repositoryRoot, "apps/api/migrations"))
    .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
    .sort()
    .at(-1);
  assert(latest !== undefined, "at least one migration must exist");
  return latest;
}

function latestMigration() {
  return latestMigrationFile().slice(0, 4);
}

function activeAuthority() {
  return [
    "README.md",
    "docs/prd/README.md",
    "docs/prd/02-system-architecture-and-data.md",
    "docs/prd/06-development-roadmap.md",
    ...requiredRunbooks.map((file) => `docs/operations/${file}`),
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-production.yml",
    "apps/api/Dockerfile",
  ]
    .map(readRepositoryFile)
    .join("\n");
}

function inspectOperationsContract() {
  const bootstrap = readContract(
    path.join(deploymentDirectory, "bootstrap.contract.yaml"),
    "bootstrap",
  );
  const live = readContract(path.join(deploymentDirectory, "app.contract.yaml"), "live");
  const rehearsalBootstrap = readContract(
    path.join(deploymentDirectory, "rehearsal-bootstrap.contract.yaml"),
    "rehearsal-bootstrap",
  );
  const rehearsal = readContract(
    path.join(deploymentDirectory, "rehearsal.contract.yaml"),
    "rehearsal",
  );
  const ci = parseYaml(".github/workflows/ci.yml", "CI workflow");
  const deployment = parseYaml(".github/workflows/deploy-production.yml", "deployment workflow");
  const ciJobs = assertRecord(ci.jobs, "CI jobs");
  const quality = assertRecord(ciJobs.quality, "quality job");
  const release = assertRecord(
    assertRecord(deployment.jobs, "deployment jobs").release,
    "release job",
  );
  const releaseSteps = Array.isArray(release.steps) ? release.steps : [];
  const releaseStep = (name) => releaseSteps.find((step) => step?.name === name);
  const preflightCommands = releaseStep("Validate App Platform source authority")?.run ?? "";
  const deploymentCommands = releaseStep("Build and deploy the source pointer")?.run ?? "";
  const postDeploymentCommands = releaseStep("Verify deployed component revisions")?.run ?? "";
  const ciCommands = commands(ci);
  const releaseCommands = commands(deployment);
  const dockerfile = readRepositoryFile("apps/api/Dockerfile");
  const apiConfig = readRepositoryFile("apps/api/src/config.ts");
  const clientAddress = readRepositoryFile("apps/api/src/security/client-address.ts");
  const secretEnvironment = readRepositoryFile("apps/api/src/secret-environment.ts");
  const databasePool = readRepositoryFile("apps/api/src/database/pool.ts");
  const productionDatabaseUrl = readRepositoryFile(
    "apps/api/src/database/production-database-url.ts",
  );
  const entrypoint = readRepositoryFile("apps/api/src/entrypoint.ts");
  const containerLoad = readRepositoryFile("scripts/container-load.mjs");
  const logMirror = readRepositoryFile("apps/api/src/observability/new-relic-log-mirror.ts");
  const telemetry = readRepositoryFile("apps/api/src/observability/telemetry.ts");
  const roadmap = readRepositoryFile("docs/prd/06-development-roadmap.md");
  const amendment = readRepositoryFile(
    "docs/implementation/08-digitalocean-app-platform-planetscale-amendment-plan.md",
  );
  const operations = readRepositoryFile("docs/operations/README.md");
  const provisioning = readRepositoryFile("docs/operations/provision-and-deploy.md");
  const deploymentRunbook = readRepositoryFile("docs/operations/deploy-and-rollback.md");
  const recovery = readRepositoryFile("docs/operations/database-recovery.md");
  const domain = readRepositoryFile("docs/operations/domain-and-tls.md");
  const employeeAccess = readRepositoryFile("docs/operations/employee-access.md");
  const providers = readRepositoryFile("docs/operations/providers-and-budget.md");
  const secrets = readRepositoryFile("docs/operations/secret-rotation.md");
  const authority = activeAuthority();
  const contractSources = requiredDeploymentFiles
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => readFileSync(path.join(deploymentDirectory, file), "utf8"))
    .join("\n");
  const forbiddenActiveRelease =
    /registry_credentials|^\s*image:\s*$|immutable GHCR|GHCR image|exact[- ]digest|ghcr-retention|deploy\/app-platform\/(?:deploy|rollback|provision|configure|operator-console)\.mjs/imu;
  const expectedSource = (contract, branch) =>
    contract.source.github.repo === "jmjalil96/capstone-chat" &&
    contract.source.github.branch === branch &&
    contract.source.github.deploy_on_push === false &&
    contract.source.source_dir === "/" &&
    contract.source.dockerfile_path === "apps/api/Dockerfile";
  return {
    activeHostInstructionsAbsent:
      !/deploy\/digitalocean|\/opt\/capstone-chat|systemctl|journalctl|cloud-init\.yaml/iu.test(
        authority,
      ),
    activeRenderInstructionsAbsent: !/\brender\.yaml\b|Render deploys|Render hosts/iu.test(
      authority,
    ),
    activeReleaseLegacyAbsent: !forbiddenActiveRelease.test(authority),
    artifactSetExact:
      readdirSync(deploymentDirectory)
        .filter((file) => lstatSync(path.join(deploymentDirectory, file)).isFile())
        .sort()
        .join("\n") === [...requiredDeploymentFiles].sort().join("\n"),
    bootstrapBoundary:
      bootstrap.service.environment.secret_keys.length === 0 &&
      bootstrap.job === undefined &&
      bootstrap.egress === undefined &&
      bootstrap.domain === undefined &&
      bootstrap.edge === undefined &&
      rehearsalBootstrap.edge === undefined &&
      bootstrap.service.run_command.endsWith("egress-bootstrap"),
    sourceContracts:
      expectedSource(bootstrap, "app-platform-production") &&
      expectedSource(live, "app-platform-production") &&
      expectedSource(rehearsalBootstrap, "app-platform-rehearsal") &&
      expectedSource(rehearsal, "app-platform-rehearsal") &&
      [bootstrap, live, rehearsalBootstrap, rehearsal].every(
        (contract) =>
          Array.isArray(contract.features) &&
          contract.features.length === 1 &&
          contract.features[0] === "buildpack-stack=ubuntu-22",
      ) &&
      contractSources.includes(`DEPLOYMENT_REVISION: ${deploymentRevisionBinding}`) &&
      !forbiddenActiveRelease.test(contractSources),
    liveTopology:
      live.region === "ric" &&
      live.egress.type === "DEDICATED_IP" &&
      live.service.instance_size_slug === "apps-s-1vcpu-1gb-fixed" &&
      live.service.instance_count === 1 &&
      live.job.instance_size_slug === "apps-s-1vcpu-0.5gb" &&
      live.job.kind === "PRE_DEPLOY" &&
      live.service.drain_seconds === 110 &&
      live.service.grace_period_seconds === 300 &&
      live.domain.domain === "chat.capstone.com.ec" &&
      live.edge.disable_edge_cache === true &&
      live.edge.disable_email_obfuscation === true &&
      live.edge.enhanced_threat_control_enabled === false,
    rehearsalBoundary:
      rehearsal.service.environment.general.EMAIL_DELIVERY === "disabled" &&
      rehearsal.service.environment.secret_keys.includes("CAPSTONE_LOAD_DIAGNOSTICS_SECRET") &&
      !rehearsal.service.environment.secret_keys.includes("OPENROUTER_API_KEY") &&
      !rehearsal.service.environment.secret_keys.includes("RESEND_API_KEY"),
    secretScope:
      live.service.environment.secret_keys.length === 5 &&
      live.job.environment.secret_keys.length === 1 &&
      live.job.environment.secret_keys[0] === "DATABASE_URL" &&
      !contractSources.includes("CAPSTONE_SECRET_FILE"),
    workflowBoundary:
      deployment.on?.workflow_dispatch?.inputs?.operation?.default === "deploy" &&
      deployment.on?.workflow_dispatch?.inputs?.release_revision?.required === true &&
      deployment.permissions?.actions === "read" &&
      deployment.permissions?.contents === "write" &&
      deployment.permissions?.deployments === undefined &&
      deployment.concurrency?.group === "capstone-chat-production-release" &&
      deployment.concurrency?.["cancel-in-progress"] === false &&
      release["timeout-minutes"] === 80 &&
      release.environment?.name === "production" &&
      release.if?.includes("refs/heads/main") &&
      release.env?.CAPSTONE_RELEASE_BRANCH === "app-platform-production" &&
      release.env?.CAPSTONE_RELEASE_OPERATION === releaseOperationBinding &&
      releaseStep("Check out the authorized main revision")?.uses ===
        "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803" &&
      releaseStep("Install pnpm")?.uses ===
        "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320" &&
      releaseStep("Set up Node.js")?.uses ===
        "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38" &&
      releaseStep("Install doctl")?.uses ===
        "digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f" &&
      releaseStep("Install doctl")?.with?.no_auth === true &&
      releaseStep("Install doctl")?.with?.version === "1.166.0" &&
      releaseStep("Install doctl")?.with?.token === undefined &&
      releaseStep("Install locked validator dependency")?.if?.includes("operation == 'deploy'") &&
      releaseStep("Install locked validator dependency")?.run ===
        "pnpm install --frozen-lockfile --ignore-scripts --filter capstone-chat" &&
      releaseStep("Verify exact doctl version")?.if?.includes("operation == 'deploy'") &&
      releaseStep("Verify exact doctl version")?.run === exactDoctlVersionCheck &&
      [
        "Validate App Platform source authority",
        "Build and deploy the source pointer",
        "Verify deployed component revisions",
      ].every((name) => releaseStep(name)?.env?.DIGITALOCEAN_ACCESS_TOKEN === deployTokenBinding) &&
      [preflightCommands, postDeploymentCommands].every(
        (value) =>
          value.indexOf("doctl apps get") < value.indexOf("unset DIGITALOCEAN_ACCESS_TOKEN") &&
          value.indexOf("unset DIGITALOCEAN_ACCESS_TOKEN") <
            value.indexOf("live-contract.mjs validate"),
      ) &&
      releaseCommands.includes("git merge-base --is-ancestor") &&
      releaseCommands.includes('test "$CAPSTONE_RELEASE_OPERATION" = "prepare-source"') &&
      releaseCommands.includes('test "$current_revision" = "$CAPSTONE_RELEASE_REVISION"') &&
      releaseCommands.includes('test -n "$current_revision"') &&
      releaseCommands.includes("git push origin") &&
      !/git push[^\n]*(?:--force|-f\b)/u.test(releaseCommands) &&
      releaseStep("Record prepared source pointer")?.if?.includes("prepare-source") &&
      [
        "Install doctl",
        "Validate App Platform source authority",
        "Build and deploy the source pointer",
        "Verify deployed component revisions",
        "Verify public readiness revision",
      ].every((name) => releaseStep(name)?.if?.includes("operation == 'deploy'")) &&
      releaseSteps.findIndex((step) => step?.name === "Validate App Platform source authority") <
        releaseSteps.findIndex(
          (step) => step?.name === "Fast-forward the protected App Platform source pointer",
        ) &&
      releaseSteps.findIndex(
        (step) => step?.name === "Fast-forward the protected App Platform source pointer",
      ) < releaseSteps.findIndex((step) => step?.name === "Build and deploy the source pointer") &&
      releaseCommands.includes("create-deployment") &&
      releaseCommands.includes("--force-rebuild") &&
      !releaseCommands.includes("--wait") &&
      deploymentCommands.includes("get-deployment") &&
      deploymentCommands.includes("seq 1 360") &&
      deploymentCommands.includes("Requested deployment") &&
      deploymentCommands.indexOf("deployment_id=%s") <
        deploymentCommands.indexOf("get-deployment") &&
      releaseCommands.includes("source_commit_hash") &&
      releaseCommands.includes("x-capstone-revision") &&
      releaseCommands.includes("actions/workflows/ci.yml/runs") &&
      releaseCommands.match(/live-contract\.mjs validate/gu)?.length === 2 &&
      releaseCommands.includes("umask 077") &&
      releaseCommands.includes("trap 'rm -f") &&
      !forbiddenActiveRelease.test(releaseCommands),
    ciBoundary:
      ciJobs["publish-image"] === undefined &&
      Array.isArray(quality.steps) &&
      ciCommands.includes("pnpm verify:operations") &&
      ciCommands.includes("docker build --file apps/api/Dockerfile") &&
      ciCommands.includes("pnpm smoke:container") &&
      ciCommands.includes(latestMigrationFile()) &&
      !/docker push|docker login|ghcr\.io/iu.test(ciCommands),
    dockerBoundary:
      !dockerfile.includes("ARG DEPLOYMENT_REVISION") &&
      !dockerfile.includes("ENV DEPLOYMENT_REVISION") &&
      dockerfile.startsWith(
        "# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e",
      ) &&
      dockerfile.match(
        /node:24\.13\.0-alpine@sha256:cd6fb7efa6490f039f3471a189214d5f548c11df1ff9e5b181aa49e22c14383e/gu,
      )?.length === 2 &&
      dockerfile.includes("USER node") &&
      dockerfile.includes('CMD ["node", "apps/api/dist/entrypoint.js", "server"]') &&
      dockerfile.includes(
        'org.opencontainers.image.source="https://github.com/jmjalil96/capstone-chat"',
      ),
    productionRuntime:
      apiConfig.includes('const appPlatformDeploymentTarget = "digitalocean-app-platform"') &&
      apiConfig.includes("DEPLOYMENT_REVISION is required in production") &&
      apiConfig.includes("full Git commit identifier") &&
      secretEnvironment.includes(
        'source.DEPLOYMENT_TARGET?.trim() === "digitalocean-app-platform"',
      ) &&
      !/migrat/iu.test(readRepositoryFile("apps/api/src/server.ts")) &&
      entrypoint.includes('server: () => import("./server.js")'),
    clientAddressBoundary:
      clientAddress.includes('request.headers["do-connecting-ip"]') &&
      clientAddress.includes('header === "forwarded"') &&
      clientAddress.includes('header.startsWith("x-forwarded-")') &&
      clientAddress.includes('header === "cf-connecting-ip"') &&
      clientAddress.includes("healthRoutes.has(request.url)") &&
      clientAddress.includes('value.includes(",")') &&
      !apiConfig.includes('"caddy"') &&
      !clientAddress.includes("caddy"),
    databaseBoundary:
      productionDatabaseUrl.includes('url.searchParams.get("sslmode") !== "verify-full"') &&
      productionDatabaseUrl.includes('(url.port !== "" && url.port !== "5432")') &&
      databasePool.includes("connectionTimeoutMillis: 5_000") &&
      databasePool.includes("max: 10") &&
      roadmap.includes("PS-5 ARM Single Node") &&
      roadmap.includes("hard 15 GB storage") &&
      amendment.includes("Never use `0.0.0.0/0`") &&
      roadmap.includes("retained for 84 hours"),
    telemetryBoundary:
      logMirror.includes('return "https://log-api.newrelic.com/log/v1"') &&
      logMirror.includes("queueMaximumRecords: 1_024") &&
      logMirror.includes("queueMaximumBytes: 1_024 * 1_024") &&
      logMirror.includes("requestTimeoutMs: 3_000") &&
      telemetry.includes("recordLogMirrorDrop"),
    runbookAuthority:
      operations.includes("source-built") &&
      provisioning.includes("health-only App") &&
      provisioning.includes("document-hash latch") &&
      provisioning.includes("provisional active deployment") &&
      provisioning.includes("active_deployment.spec") &&
      deploymentRunbook.includes("operation=prepare-source") &&
      deploymentRunbook.includes("DIGITALOCEAN_DEPLOY_TOKEN") &&
      deploymentRunbook.includes("app:update") &&
      deploymentRunbook.includes("git revert") &&
      deploymentRunbook.includes("native rollback") &&
      recovery.includes("offline Git bundle") &&
      recovery.includes("both new `/32`s") &&
      domain.includes("DNSSEC") &&
      domain.includes("CAA") &&
      domain.includes(starterDomainBinding) &&
      domain.includes("do-connecting-ip") &&
      employeeAccess.includes("app:access_console") &&
      employeeAccess.includes('doctl apps console "$DIGITALOCEAN_APP_ID" capstone-chat') &&
      employeeAccess.includes('--deployment "$EXPECTED_DEPLOYMENT_ID"') &&
      employeeAccess.includes("node apps/api/dist/entrypoint.js invite-initial") &&
      employeeAccess.includes("stty -echo") &&
      employeeAccess.includes("trap 'stty echo' EXIT HUP INT TERM") &&
      employeeAccess.includes("fresh PlanetScale") &&
      employeeAccess.includes("doctl auth remove --context capstone-production-console") &&
      providers.includes("node apps/api/dist/entrypoint.js model attest") &&
      providers.includes("--privacy-attestation -") &&
      providers.includes(
        "unset BETTER_AUTH_SECRET OPENROUTER_API_KEY OTEL_EXPORTER_OTLP_HEADERS RESEND_API_KEY",
      ) &&
      providers.includes("stty -echo") &&
      !providers.includes("console helper") &&
      secrets.includes("component-scoped encrypted `RUN_TIME`"),
    workload:
      /20 simultaneously signed-in employees/u.test(roadmap) &&
      /40 active/u.test(roadmap) &&
      /response\.started` targets p95 at or below 500 ms/u.test(roadmap) &&
      containerLoad.includes('const candidateCpu = "1"') &&
      containerLoad.includes('const candidateMemory = "1g"') &&
      containerLoad.includes("1000000000 1073741824 1073741824 256 node"),
  };
}

function validateOperationsContract(contract) {
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  check(contract.artifactSetExact, "App Platform adapter contains missing or obsolete files");
  check(contract.activeHostInstructionsAbsent, "active host-era instructions remain");
  check(contract.activeRenderInstructionsAbsent, "active Render instructions remain");
  check(contract.activeReleaseLegacyAbsent, "active GHCR/digest/mutation authority remains");
  check(contract.sourceContracts, "native GitHub source contract drifted");
  check(contract.bootstrapBoundary, "health-only bootstrap boundary drifted");
  check(contract.liveTopology, "App Platform topology/domain/edge boundary drifted");
  check(contract.rehearsalBoundary, "managed rehearsal provider boundary drifted");
  check(contract.secretScope, "component secret scope drifted");
  check(contract.workflowBoundary, "protected source-release workflow drifted");
  check(contract.ciBoundary, "CI source-build gate or no-publication boundary drifted");
  check(contract.dockerBoundary, "source-build Docker runtime boundary drifted");
  check(contract.productionRuntime, "production runtime configuration boundary drifted");
  check(contract.clientAddressBoundary, "App Platform client-address boundary drifted");
  check(contract.databaseBoundary, "PlanetScale safety/recovery boundary drifted");
  check(contract.telemetryBoundary, "New Relic mirror boundary drifted");
  check(contract.runbookAuthority, "active runbook authority is incomplete");
  check(contract.workload, "managed workload or response-start objective drifted");
  assert(failures.length === 0, failures.join("\n"));
}

function runCommand(command, arguments_, label) {
  const result = spawnSync(command, arguments_, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr.trim() || result.stdout.trim() || `${label} failed`);
}

function runArtifactVerification() {
  for (const file of ["contract.mjs", "live-contract.mjs"]) {
    runCommand(
      process.execPath,
      ["--check", path.join(deploymentDirectory, file)],
      `${file} syntax`,
    );
  }
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "contract.test.mjs")],
    "App Platform contract fixtures",
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
    actual.join("\n") === requiredRunbooks.sort().join("\n"),
    "operations runbook set changed",
  );
  const packages = workspacePackages();
  const rootScripts = packages.get("capstone-chat");
  for (const file of actual) {
    const contents = readFileSync(path.join(operationsDirectory, file), "utf8");
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1]?.trim();
      if (target === undefined || /^(?:https?:|mailto:|#)/u.test(target)) continue;
      const clean = target.replace(/^<|>$/gu, "").split("#", 1)[0];
      assert(
        clean !== undefined && existsSync(path.resolve(operationsDirectory, clean)),
        `${file} links to missing ${target}`,
      );
    }
    for (const match of contents.matchAll(/\bpnpm\s+([^`\n]+)/gu)) {
      const command = match[1]?.trim().split(/\s+/u) ?? [];
      let scripts = rootScripts;
      if (command[0] === "--filter") {
        scripts = packages.get(command[1]);
        assert(scripts !== undefined, `${file} references an unknown workspace`);
        command.splice(0, 2);
      }
      assert(
        command[0] !== undefined && scripts?.[command[0]] !== undefined,
        `${file} references missing pnpm script ${String(command[0])}`,
      );
    }
  }
}

function utcMilliseconds(value, label) {
  assert(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value),
    `${label} must be UTC`,
  );
  const milliseconds = Date.parse(value);
  assert(Number.isFinite(milliseconds), `${label} is invalid`);
  return milliseconds;
}

function validateReleaseAndMigration(evidence) {
  assertExactKeys(evidence.release, ["expected", "observed"], "recovery release");
  assert(
    /^[0-9a-f]{40}$/u.test(evidence.release.expected),
    "expected release must be a full commit",
  );
  assert(
    evidence.release.observed === evidence.release.expected,
    "observed release must match expected",
  );
  assertExactKeys(evidence.migration, ["expected", "observed"], "recovery migration");
  assert(evidence.migration.expected === latestMigration(), "expected migration is stale");
  assert(
    evidence.migration.observed === evidence.migration.expected,
    "observed migration must match expected",
  );
}

function validateCommon(evidence) {
  assert(evidence.schemaVersion === 3, "recovery evidence schemaVersion must equal 3");
  assert(evidence.status === "accepted", "recovery evidence must be accepted");
  assert(
    typeof evidence.operatorRole === "string" &&
      /^[a-z][a-z0-9-]{1,63}$/u.test(evidence.operatorRole),
    "operatorRole is invalid",
  );
  validateReleaseAndMigration(evidence);
}

function validatePitrEvidence(evidence) {
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
      "topology",
    ],
    "PITR evidence",
  );
  validateCommon(evidence);
  assertExactKeys(
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
    evidence.topology.plan === "PS-5" &&
      evidence.topology.architecture === "arm" &&
      evidence.topology.singleNode === true &&
      evidence.topology.region === "us-east-1" &&
      evidence.topology.postgresMajor === 18 &&
      evidence.topology.initialStorageGb === 10 &&
      evidence.topology.maximumStorageGb === 15 &&
      evidence.topology.backupHours === 12 &&
      evidence.topology.retentionHours === 84,
    "PITR topology drifted",
  );
  assertExactKeys(
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
  assertExactKeys(evidence.integrity, pitrIntegrityKeys, "PITR integrity");
  for (const key of pitrIntegrityKeys)
    assert(evidence.integrity[key] === true, `PITR integrity ${key} failed`);
  assertExactKeys(
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
  const started = utcMilliseconds(evidence.timing.rehearsalStartedAt, "rehearsalStartedAt");
  const incident = utcMilliseconds(evidence.timing.incidentAt, "incidentAt");
  const selected = utcMilliseconds(evidence.timing.selectedRestoreAt, "selectedRestoreAt");
  const recovered = utcMilliseconds(
    evidence.timing.latestRecoveredMarkerAt,
    "latestRecoveredMarkerAt",
  );
  const completed = utcMilliseconds(evidence.timing.validationCompletedAt, "validationCompletedAt");
  assert(
    started <= incident && selected <= incident && recovered <= selected && incident <= completed,
    "PITR timing order failed",
  );
  assert((incident - recovered) / 60_000 <= 15, "RPO exceeds 15 minutes");
  assert((completed - incident) / 60_000 <= 240, "RTO exceeds four hours");
  assertExactKeys(
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
  for (const value of Object.values(evidence.cleanup))
    assert(value === true, "PITR cleanup failed");
}

function validateColdEvidence(evidence) {
  assertExactKeys(
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
    "cold recreation evidence",
  );
  validateCommon(evidence);
  assertExactKeys(
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
    evidence.topology.region === "ric" &&
      evidence.topology.serviceSize === "apps-s-1vcpu-1gb-fixed" &&
      evidence.topology.jobSize === "apps-s-1vcpu-0.5gb" &&
      evidence.topology.instanceCount === 1 &&
      evidence.topology.autoscaling === false &&
      evidence.topology.dedicatedEgressAddressCount === 2,
    "cold topology drifted",
  );
  assertExactKeys(evidence.integrity, coldRecreationIntegrityKeys, "cold integrity");
  for (const key of coldRecreationIntegrityKeys)
    assert(evidence.integrity[key] === true, `cold integrity ${key} failed`);
  assertExactKeys(
    evidence.timing,
    ["incidentAt", "rehearsalStartedAt", "validationCompletedAt"],
    "cold timing",
  );
  const started = utcMilliseconds(evidence.timing.rehearsalStartedAt, "rehearsalStartedAt");
  const incident = utcMilliseconds(evidence.timing.incidentAt, "incidentAt");
  const completed = utcMilliseconds(evidence.timing.validationCompletedAt, "validationCompletedAt");
  assert(
    started <= incident && incident <= completed && (completed - incident) / 60_000 <= 240,
    "cold recreation timing failed",
  );
  assertExactKeys(
    evidence.cleanup,
    [
      "evidenceAccepted",
      "supersededAppRemoved",
      "supersededEgressRulesRemoved",
      "temporaryCredentialsRevoked",
    ],
    "cold cleanup",
  );
  for (const value of Object.values(evidence.cleanup))
    assert(value === true, "cold cleanup failed");
}

function validateRecoveryEvidence(value) {
  const evidence = assertRecord(value, "recovery evidence");
  if (evidence.kind === "planetscale-pitr-rehearsal") return validatePitrEvidence(evidence);
  if (evidence.kind === "digitalocean-app-platform-controlled-recreation")
    return validateColdEvidence(evidence);
  fail("recovery evidence kind is unexpected");
}

function safePitrExample() {
  return {
    cleanup: {
      dedicatedEgressRulesRemoved: true,
      evidenceAccepted: true,
      recoveryBranchRemoved: true,
      temporaryCredentialsRevoked: true,
      temporaryDomainRemoved: true,
      temporaryRolesRemoved: true,
      validationAppRemoved: true,
    },
    integrity: Object.fromEntries(pitrIntegrityKeys.map((key) => [key, true])),
    isolation: {
      applicationProvidersContacted: false,
      databaseIpRestricted: true,
      dedicatedEgressAddressCount: 2,
      rolesSeparated: true,
      sourceUntouched: true,
      verifyFullTls: true,
    },
    kind: "planetscale-pitr-rehearsal",
    migration: { expected: latestMigration(), observed: latestMigration() },
    operatorRole: "recovery-operator",
    release: {
      expected: "0123456789abcdef0123456789abcdef01234567",
      observed: "0123456789abcdef0123456789abcdef01234567",
    },
    schemaVersion: 3,
    status: "accepted",
    timing: {
      incidentAt: "2026-08-11T12:15:00.000Z",
      latestRecoveredMarkerAt: "2026-08-11T12:05:00.000Z",
      rehearsalStartedAt: "2026-08-11T12:00:00.000Z",
      selectedRestoreAt: "2026-08-11T12:10:00.000Z",
      validationCompletedAt: "2026-08-11T13:00:00.000Z",
    },
    topology: {
      architecture: "arm",
      backupHours: 12,
      initialStorageGb: 10,
      maximumStorageGb: 15,
      plan: "PS-5",
      postgresMajor: 18,
      region: "us-east-1",
      retentionHours: 84,
      singleNode: true,
    },
  };
}

function safeColdExample() {
  return {
    cleanup: {
      evidenceAccepted: true,
      supersededAppRemoved: true,
      supersededEgressRulesRemoved: true,
      temporaryCredentialsRevoked: true,
    },
    integrity: Object.fromEntries(coldRecreationIntegrityKeys.map((key) => [key, true])),
    kind: "digitalocean-app-platform-controlled-recreation",
    migration: { expected: latestMigration(), observed: latestMigration() },
    operatorRole: "recovery-operator",
    release: {
      expected: "0123456789abcdef0123456789abcdef01234567",
      observed: "0123456789abcdef0123456789abcdef01234567",
    },
    schemaVersion: 3,
    status: "accepted",
    timing: {
      incidentAt: "2026-08-11T12:05:00.000Z",
      rehearsalStartedAt: "2026-08-11T12:00:00.000Z",
      validationCompletedAt: "2026-08-11T13:00:00.000Z",
    },
    topology: {
      autoscaling: false,
      dedicatedEgressAddressCount: 2,
      instanceCount: 1,
      jobSize: "apps-s-1vcpu-0.5gb",
      region: "ric",
      serviceSize: "apps-s-1vcpu-1gb-fixed",
    },
  };
}

function expectRejected(mutate, safe, validator, label) {
  const unsafe = structuredClone(safe);
  mutate(unsafe);
  let rejected = false;
  try {
    validator(unsafe);
  } catch {
    rejected = true;
  }
  assert(rejected, `${label} self-test failed`);
}

function runSelfTest(contract) {
  for (const key of [
    "artifactSetExact",
    "activeReleaseLegacyAbsent",
    "sourceContracts",
    "bootstrapBoundary",
    "liveTopology",
    "secretScope",
    "workflowBoundary",
    "ciBoundary",
    "dockerBoundary",
    "clientAddressBoundary",
    "databaseBoundary",
    "runbookAuthority",
    "workload",
  ]) {
    expectRejected(
      (value) => {
        value[key] = false;
      },
      contract,
      validateOperationsContract,
      key,
    );
  }
  const pitr = safePitrExample();
  validateRecoveryEvidence(pitr);
  expectRejected(
    (value) => {
      value.isolation.sourceUntouched = false;
    },
    pitr,
    validateRecoveryEvidence,
    "PITR isolation",
  );
  expectRejected(
    (value) => {
      value.timing.latestRecoveredMarkerAt = "2026-08-11T11:59:00.000Z";
    },
    pitr,
    validateRecoveryEvidence,
    "PITR RPO",
  );
  const cold = safeColdExample();
  validateRecoveryEvidence(cold);
  expectRejected(
    (value) => {
      value.integrity.sourceCommitMatched = false;
    },
    cold,
    validateRecoveryEvidence,
    "source identity",
  );
  expectRejected(
    (value) => {
      value.timing.validationCompletedAt = "2026-08-11T16:06:00.000Z";
    },
    cold,
    validateRecoveryEvidence,
    "cold RTO",
  );
}

function evidencePath(arguments_) {
  const remaining = arguments_.filter((argument) => argument !== "--");
  assert(remaining.length === 1, "Usage: pnpm verify:recovery -- <safe-evidence.json>");
  const candidate = path.resolve(repositoryRoot, remaining[0]);
  assert(
    existsSync(candidate) && lstatSync(candidate).isFile(),
    "Recovery evidence does not exist",
  );
  return candidate;
}

try {
  runArtifactVerification();
  const contract = inspectOperationsContract();
  validateOperationsContract(contract);
  validateRunbooks();
  const [mode, ...arguments_] = process.argv.slice(2);
  if (mode === "--self-test") {
    runSelfTest(contract);
    process.stdout.write(
      "App Platform source-build, PlanetScale, runbook, and recovery validators passed.\n",
    );
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
