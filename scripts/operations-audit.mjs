import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { readContract } from "../deploy/app-platform/contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operationsDirectory = path.join(repositoryRoot, "docs/operations");
const deploymentDirectory = path.join(repositoryRoot, "deploy/app-platform");
const legacyDeploymentDirectory = path.join(repositoryRoot, "deploy/digitalocean");
const requiredDeploymentFiles = [
  "README.md",
  "app.contract.yaml",
  "bootstrap.contract.yaml",
  "configuration.mjs",
  "configuration.test.mjs",
  "configure.mjs",
  "consumable-input.mjs",
  "consumable-input.test.mjs",
  "console.mjs",
  "contract.mjs",
  "contract.test.mjs",
  "deploy.mjs",
  "domain.contract.yaml",
  "egress.contract.yaml",
  "ghcr-retention.py",
  "ghcr-retention.test.py",
  "github-api.mjs",
  "github-api.test.mjs",
  "initialization.contract.yaml",
  "http-json.mjs",
  "live-contract.mjs",
  "mutate-app.mjs",
  "mutate-app.test.mjs",
  "provider-api.mjs",
  "provider-api.test.mjs",
  "release.mjs",
  "release.test.mjs",
  "rollback.mjs",
  "operator-console.mjs",
  "operator-console.test.mjs",
  "provision.mjs",
  "provisioning.mjs",
  "provisioning.test.mjs",
  "rehearsal-bootstrap.contract.yaml",
  "rehearsal-domain.contract.yaml",
  "rehearsal-egress.contract.yaml",
  "rehearsal-initialization.contract.yaml",
  "rehearsal.contract.yaml",
  "workflow.test.mjs",
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
  "immutableImage",
  "initialInvitationNotSent",
  "initializationLatchVerified",
  "initializationNotRepeated",
  "preDeployMigration",
  "readiness",
  "secretIsolation",
  "telemetry",
  "unsafeHistoryEvicted",
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

function readRepositoryFile(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function parseYaml(relativePath, label) {
  const document = parseDocument(readRepositoryFile(relativePath), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  assert(
    document.errors.length === 0,
    `${label} is invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`,
  );
  return assertRecord(document.toJS(), label);
}

function hasText(contents, pattern) {
  return typeof pattern === "string" ? contents.includes(pattern) : pattern.test(contents);
}

function workflowCommands(workflow) {
  const jobs = Object.values(assertRecord(workflow.jobs, "workflow jobs"));
  return jobs
    .flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .join("\n");
}

function latestMigrationFile() {
  const migrations = readdirSync(path.join(repositoryRoot, "apps/api/migrations"))
    .filter((file) => /^\d{4}_.+\.sql$/u.test(file))
    .sort();
  const latest = migrations.at(-1);
  assert(latest !== undefined, "at least one database migration must exist");
  return latest;
}

function latestMigration() {
  return latestMigrationFile().slice(0, 4);
}

function applicationPoolSettingsAreLocked(poolSource) {
  return [
    "connectionTimeoutMillis: 5_000",
    "idleTimeoutMillis: 30_000",
    "max: 10",
    "query_timeout: 5_000",
    "statement_timeout=5000",
    "lock_timeout=5000",
    "idle_in_transaction_session_timeout=5000",
  ].every((setting) => poolSource.includes(setting));
}

function activeAuthoritySources() {
  return [
    "README.md",
    ".env.example",
    "docs/prd/README.md",
    "docs/prd/02-system-architecture-and-data.md",
    "docs/prd/06-development-roadmap.md",
    ...requiredRunbooks.map((file) => `docs/operations/${file}`),
    ".github/workflows/ci.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/configure-production.yml",
    ".github/workflows/ghcr-retention.yml",
    "apps/api/Dockerfile",
  ].map(readRepositoryFile);
}

function inspectOperationsContract() {
  const bootstrap = readContract(
    path.join(deploymentDirectory, "bootstrap.contract.yaml"),
    "bootstrap",
  );
  const initialization = readContract(
    path.join(deploymentDirectory, "initialization.contract.yaml"),
    "initialization",
  );
  const egress = readContract(path.join(deploymentDirectory, "egress.contract.yaml"), "egress");
  const domain = readContract(path.join(deploymentDirectory, "domain.contract.yaml"), "domain");
  const live = readContract(path.join(deploymentDirectory, "app.contract.yaml"), "live");
  const rehearsal = readContract(
    path.join(deploymentDirectory, "rehearsal.contract.yaml"),
    "rehearsal",
  );
  const contractSources = [
    readRepositoryFile("deploy/app-platform/bootstrap.contract.yaml"),
    readRepositoryFile("deploy/app-platform/egress.contract.yaml"),
    readRepositoryFile("deploy/app-platform/domain.contract.yaml"),
    readRepositoryFile("deploy/app-platform/initialization.contract.yaml"),
    readRepositoryFile("deploy/app-platform/app.contract.yaml"),
    readRepositoryFile("deploy/app-platform/rehearsal-bootstrap.contract.yaml"),
    readRepositoryFile("deploy/app-platform/rehearsal-egress.contract.yaml"),
    readRepositoryFile("deploy/app-platform/rehearsal-domain.contract.yaml"),
    readRepositoryFile("deploy/app-platform/rehearsal-initialization.contract.yaml"),
    readRepositoryFile("deploy/app-platform/rehearsal.contract.yaml"),
  ].join("\n");
  const authoritySources = activeAuthoritySources().join("\n");
  const roadmap = readRepositoryFile("docs/prd/06-development-roadmap.md");
  const amendment = readRepositoryFile(
    "docs/implementation/08-digitalocean-app-platform-planetscale-amendment-plan.md",
  );
  const operationsReadme = readRepositoryFile("docs/operations/README.md");
  const provisioning = readRepositoryFile("docs/operations/provision-and-deploy.md");
  const deploymentRunbook = readRepositoryFile("docs/operations/deploy-and-rollback.md");
  const recoveryRunbook = readRepositoryFile("docs/operations/database-recovery.md");
  const domainRunbook = readRepositoryFile("docs/operations/domain-and-tls.md");
  const secretsRunbook = readRepositoryFile("docs/operations/secret-rotation.md");
  const dockerfile = readRepositoryFile("apps/api/Dockerfile");
  const apiConfig = readRepositoryFile("apps/api/src/config.ts");
  const clientAddress = readRepositoryFile("apps/api/src/security/client-address.ts");
  const secretEnvironment = readRepositoryFile("apps/api/src/secret-environment.ts");
  const databasePool = readRepositoryFile("apps/api/src/database/pool.ts");
  const entrypoint = readRepositoryFile("apps/api/src/entrypoint.ts");
  const identityCommand = readRepositoryFile("apps/api/src/operator/initial-invitation-command.ts");
  const initializationCommand = readRepositoryFile(
    "apps/api/src/operator/production-initialization-command.ts",
  );
  const logMirror = readRepositoryFile("apps/api/src/observability/new-relic-log-mirror.ts");
  const telemetry = readRepositoryFile("apps/api/src/observability/telemetry.ts");
  const productionDatabaseUrl = readRepositoryFile(
    "apps/api/src/database/production-database-url.ts",
  );
  const liveContractTool = readRepositoryFile("deploy/app-platform/live-contract.mjs");
  const mutationTool = readRepositoryFile("deploy/app-platform/mutate-app.mjs");
  const releaseTool = readRepositoryFile("deploy/app-platform/release.mjs");
  const deployTool = readRepositoryFile("deploy/app-platform/deploy.mjs");
  const rollbackTool = readRepositoryFile("deploy/app-platform/rollback.mjs");
  const configurationTool = readRepositoryFile("deploy/app-platform/configuration.mjs");
  const consoleTool = readRepositoryFile("deploy/app-platform/operator-console.mjs");
  const provisioningTool = readRepositoryFile("deploy/app-platform/provisioning.mjs");
  const retentionTool = readRepositoryFile("deploy/app-platform/ghcr-retention.py");
  const ci = parseYaml(".github/workflows/ci.yml", "CI workflow");
  const deployWorkflow = parseYaml(
    ".github/workflows/deploy-production.yml",
    "production deployment workflow",
  );
  const retentionWorkflow = parseYaml(
    ".github/workflows/ghcr-retention.yml",
    "GHCR retention workflow",
  );
  const configureWorkflow = parseYaml(
    ".github/workflows/configure-production.yml",
    "production configuration workflow",
  );
  const ciJobs = assertRecord(ci.jobs, "CI jobs");
  const quality = assertRecord(ciJobs.quality, "CI quality job");
  const publish = assertRecord(ciJobs["publish-image"], "CI publish-image job");
  const publishCommands = (Array.isArray(publish.steps) ? publish.steps : [])
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .join("\n");
  const deployJob = assertRecord(
    assertRecord(deployWorkflow.jobs, "deployment jobs").release,
    "deployment release job",
  );
  const deployInputs = assertRecord(
    assertRecord(deployWorkflow.on?.workflow_dispatch, "deployment workflow dispatch").inputs,
    "deployment workflow inputs",
  );
  const retentionJob = assertRecord(
    assertRecord(retentionWorkflow.jobs, "retention jobs").retention,
    "retention job",
  );
  const configureJob = assertRecord(
    assertRecord(configureWorkflow.jobs, "configuration jobs").configure,
    "configuration job",
  );
  const deployCommands = workflowCommands(deployWorkflow);
  const retentionCommands = workflowCommands(retentionWorkflow);
  const configureCommands = workflowCommands(configureWorkflow);
  const latestMigration = latestMigrationFile();
  const prohibitedHostInstruction =
    /deploy\/digitalocean|\/opt\/capstone-chat|\/run\/capstone-secrets|request-(?:deploy|operator)\.sh|\bsystemctl\b|\bjournalctl\b|cloud-init\.yaml|capstone-chat@\.service/iu;

  return {
    activeHostInstructionsAbsent: !prohibitedHostInstruction.test(authoritySources),
    activeRenderConfigurationAbsent: !existsSync(path.join(repositoryRoot, "render.yaml")),
    activeRenderInstructionsAbsent:
      !/RENDER_GIT_COMMIT|\brender\.yaml\b|\brender deploy\b|Render hosts|Render deploys/iu.test(
        authoritySources,
      ),
    appPlatformArtifactSetPresent: requiredDeploymentFiles.every((file) =>
      existsSync(path.join(deploymentDirectory, file)),
    ),
    appPlatformHostArtifactsAbsent: !readdirSync(deploymentDirectory).some(
      (file) =>
        file === "Caddyfile" ||
        file.endsWith(".service") ||
        file.endsWith(".sh") ||
        /cloud-init|fluent-bit|systemd|ufw/iu.test(file),
    ),
    applicationPoolSettingsLocked: applicationPoolSettingsAreLocked(databasePool),
    applicationRunsMigrationsAtStartup:
      /migrat/iu.test(readRepositoryFile("apps/api/src/server.ts")) ||
      !dockerfile.includes('CMD ["node", "apps/api/dist/entrypoint.js", "server"]') ||
      !entrypoint.includes('server: () => import("./server.js")'),
    backupHours: hasText(roadmap, /backups run every 12 hours/u) ? 12 : null,
    bootstrapBoundary:
      bootstrap.service.environment.secret_keys.length === 0 &&
      bootstrap.job === undefined &&
      bootstrap.egress === undefined &&
      bootstrap.domain === undefined &&
      bootstrap.service.run_command.endsWith("egress-bootstrap"),
    stagedProvisioningBoundary:
      egress.egress.type === "DEDICATED_IP" &&
      egress.domain === undefined &&
      egress.job === undefined &&
      egress.service.environment.secret_keys.length === 0 &&
      domain.egress.type === "DEDICATED_IP" &&
      domain.domain.domain === "chat.capstone.com.ec" &&
      domain.job === undefined &&
      domain.service.environment.secret_keys.length === 0,
    ciPublishesImmutableRevision:
      publishCommands.includes('image="$IMAGE_REPOSITORY:$GITHUB_SHA"') &&
      publishCommands.includes('docker push "$image"') &&
      publishCommands.includes('candidate_id="$(docker image inspect') &&
      publishCommands.includes('existing_digest="$(printf') &&
      publishCommands.includes('test "$existing_id" = "$candidate_id"') &&
      publishCommands.includes('test "$confirmed_digest" = "$digest"') &&
      publish.concurrency?.group === `capstone-chat-image-${"$"}{{ github.sha }}` &&
      publish.concurrency?.["cancel-in-progress"] === false &&
      !publishCommands.includes(":latest"),
    ciPublicationNeedsAllGates:
      Array.isArray(publish.needs) &&
      publish.needs.length === 2 &&
      publish.needs.includes("quality") &&
      publish.needs.includes("playwright") &&
      publish.permissions?.packages === "write",
    ciValidatesLatestMigration:
      workflowCommands(ci).includes(latestMigration) && deployCommands.includes(latestMigration),
    ciWiresOperationsAudit: (Array.isArray(quality.steps) ? quality.steps : []).some(
      (step) => typeof step?.run === "string" && step.run.includes("pnpm verify:operations"),
    ),
    clientAddressBoundary:
      clientAddress.includes('request.headers["do-connecting-ip"]') &&
      clientAddress.includes('header === "do-connecting-ip"') &&
      clientAddress.includes('header === "forwarded"') &&
      clientAddress.includes('header.startsWith("x-forwarded-")') &&
      clientAddress.includes('header === "x-real-ip"') &&
      clientAddress.includes('header === "cf-connecting-ip"') &&
      clientAddress.includes("healthRoutes.has(request.url)") &&
      clientAddress.includes('value.includes(",")') &&
      clientAddress.indexOf("const appPlatformAddress") <
        clientAddress.indexOf("stripForwardingHeaders(request)"),
    contractReleaseValuesAbsent: !/digest|registry_credentials|DEPLOYMENT_REVISION|sha256:/u.test(
      contractSources,
    ),
    databaseArchitecture: hasText(roadmap, /PS-5 ARM Single Node/u) ? "arm-single-node" : null,
    databaseInitialStorageGb: hasText(roadmap, /starts at 10 GB/u) ? 10 : null,
    databaseIpRestricted:
      hasText(roadmap, /both exclusive App Platform Dedicated Egress IPv4[\n ]+`\/32`s/u) &&
      hasText(amendment, /No step temporarily opens PlanetScale to `0\.0\.0\.0\/0`/u),
    databaseMaximumStorageGb: hasText(roadmap, /hard 15 GB storage[\n ]+ceiling/u) ? 15 : null,
    databasePlan: hasText(roadmap, /PS-5 ARM Single Node/u) ? "PS-5" : null,
    databaseRegion: hasText(roadmap, /AWS `us-east-1`/u) ? "us-east-1" : null,
    databaseTlsVerifyFull:
      apiConfig.includes("parseProductionDatabaseUrl(value)") &&
      productionDatabaseUrl.includes('url.searchParams.get("sslmode") !== "verify-full"') &&
      productionDatabaseUrl.includes('(url.port !== "" && url.port !== "5432")') &&
      hasText(roadmap, /direct port 5432[\s\S]{0,80}`verify-full`/u),
    deploymentToolBoundaries:
      liveContractTool.includes('operation === "render"') &&
      liveContractTool.includes('operation === "validate"') &&
      liveContractTool.includes('operation === "fingerprint"') &&
      liveContractTool.includes("assertSafeRollbackHistory") &&
      mutationTool.includes("liveFingerprint(initial)") &&
      mutationTool.includes("liveFingerprint(immediate)") &&
      mutationTool.includes("Another DigitalOcean deployment is in progress") &&
      mutationTool.includes("await waitForDeployment") &&
      releaseTool.includes("assertStrictForward") &&
      releaseTool.includes("Normal deployment revision is not protected main HEAD") &&
      releaseTool.includes("assertSafeRollbackHistory") &&
      releaseTool.includes("Accepted release baseline does not match the exact initial App") &&
      releaseTool.includes("History eviction revision is not protected main HEAD") &&
      deployTool.includes('runReleaseOperation("deploy")') &&
      deployTool.includes('operation === "adopt-initial"') &&
      deployTool.includes('operation === "history-eviction"') &&
      rollbackTool.includes('runReleaseOperation("rollback")') &&
      configurationTool.includes("guardedSpecMutation") &&
      configurationTool.includes("assertOnlySelectedSecretsChanged") &&
      configurationTool.includes("assertOnlyRegistryChanged") &&
      consoleTool.includes("CAPSTONE_CONSOLE_READY") &&
      consoleTool.includes("CAPSTONE_OPERATOR_EXIT:0") &&
      provisioningTool.includes("createBootstrapApp") &&
      provisioningTool.includes("advanceProvisioningStage") &&
      provisioningTool.includes("CAPSTONE_PROVISIONING_BASE_DEPLOYMENT_ID") &&
      provisioningTool.includes("getContainerDigestForRevision") &&
      provisioningTool.includes("guardedSpecMutation"),
    deploymentWorkflowBound:
      deployWorkflow.on?.workflow_dispatch !== undefined &&
      deployInputs.operation?.required === true &&
      deployInputs.operation?.type === "choice" &&
      Array.isArray(deployInputs.operation?.options) &&
      deployInputs.operation.options.length === 3 &&
      deployInputs.operation.options[0] === "deploy" &&
      deployInputs.operation.options[1] === "rollback" &&
      deployInputs.operation.options[2] === "reconcile" &&
      deployInputs.image_revision?.required === true &&
      deployInputs.image_revision?.type === "string" &&
      deployWorkflow.concurrency?.group === "capstone-chat-production-app-spec" &&
      deployWorkflow.concurrency?.["cancel-in-progress"] === false &&
      deployWorkflow.permissions?.actions === "read" &&
      deployWorkflow.permissions?.contents === "read" &&
      deployWorkflow.permissions?.deployments === "write" &&
      deployWorkflow.permissions?.packages === "read" &&
      deployJob.environment === "production" &&
      deployJob.if?.includes("refs/heads/main") &&
      deployCommands.includes("node deploy/app-platform/deploy.mjs deploy") &&
      deployCommands.includes("node deploy/app-platform/rollback.mjs") &&
      deployCommands.includes("docker buildx imagetools inspect") &&
      deployCommands.includes("$IMAGE_REPOSITORY@$digest") &&
      !deployCommands.includes(":latest"),
    configurationWorkflowBound:
      configureWorkflow.on?.workflow_dispatch !== undefined &&
      configureWorkflow.concurrency?.group === "capstone-chat-production-app-spec" &&
      configureWorkflow.concurrency?.["cancel-in-progress"] === false &&
      configureWorkflow.permissions?.contents === "read" &&
      configureWorkflow.permissions?.deployments === "read" &&
      configureJob.environment === "production" &&
      configureJob.if?.includes("refs/heads/main") &&
      configureCommands.includes("node deploy/app-platform/configure.mjs") &&
      configureCommands.includes("CAPSTONE_CONFIGURATION_BASE_DEPLOYMENT_ID") &&
      !configureCommands.includes("ROTATION") &&
      !configureCommands.includes("rotate-"),
    domainAndEdgeBoundary:
      live.domain.domain === "chat.capstone.com.ec" &&
      live.domain.type === "PRIMARY" &&
      live.domain.minimum_tls_version === "1.2" &&
      live.edge.disable_edge_cache === true &&
      live.edge.disable_email_obfuscation === true &&
      live.edge.enhanced_threat_control_enabled === false,
    imageBoundary:
      !dockerfile.includes("ENV CAPSTONE_SECRET_SOURCE=") &&
      !dockerfile.includes("ENV CLIENT_ADDRESS_SOURCE=") &&
      !dockerfile.includes("ENV DEPLOYMENT_TARGET=") &&
      !dockerfile.includes("ENV HOST=") &&
      !dockerfile.includes("ENV NODE_ENV=") &&
      !dockerfile.includes("ENV PORT=") &&
      dockerfile.includes("ENV DEPLOYMENT_REVISION=$DEPLOYMENT_REVISION") &&
      dockerfile.includes("USER node") &&
      dockerfile.includes('org.opencontainers.image.revision="$DEPLOYMENT_REVISION"') &&
      dockerfile.includes(
        'org.opencontainers.image.source="https://github.com/jmjalil96/capstone-chat"',
      ) &&
      !/caddy/iu.test(dockerfile),
    initializationBoundary:
      initialization.service.environment.secret_keys.length === 0 &&
      initialization.job.name === "capstone-initialize" &&
      initialization.job.environment.secret_keys.length === 4 &&
      initialization.job.environment.secret_keys.includes("CAPSTONE_INITIALIZATION_DOCUMENT") &&
      initialization.job.environment.secret_keys.includes("CAPSTONE_BOOTSTRAP_DATABASE_URL") &&
      initialization.job.environment.secret_keys.includes(
        "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
      ) &&
      !initialization.job.environment.secret_keys.includes("BETTER_AUTH_SECRET") &&
      !initialization.job.environment.secret_keys.includes("RESEND_API_KEY"),
    initializationCommandsBounded:
      apiConfig.includes("initializationDocumentMaximumBytes") &&
      initializationCommand.includes("loadInitializationOperatorConfig") &&
      initializationCommand.includes("parseProductionInitializationDocument") &&
      identityCommand.includes("readBoundedStdinDocument") &&
      identityCommand.includes("sendInvitationEmail") &&
      !initializationCommand.includes("sendInvitationEmail"),
    legacyDropletArtifactsAbsent:
      !existsSync(legacyDeploymentDirectory) || readdirSync(legacyDeploymentDirectory).length === 0,
    liveTopology:
      live.region === "ric" &&
      live.service.instance_size_slug === "apps-s-1vcpu-1gb-fixed" &&
      live.service.instance_count === 1 &&
      live.service.http_port === 3_000 &&
      live.service.drain_seconds === 110 &&
      live.service.grace_period_seconds === 300 &&
      live.egress.type === "DEDICATED_IP" &&
      live.job.kind === "PRE_DEPLOY" &&
      live.job.instance_size_slug === "apps-s-1vcpu-0.5gb" &&
      live.job.instance_count === 1,
    managedRehearsalBoundary:
      rehearsal.region === "ric" &&
      rehearsal.domain.domain === "rehearsal.chat.capstone.com.ec" &&
      rehearsal.egress.type === "DEDICATED_IP" &&
      rehearsal.service.run_command.endsWith("load-server --confirm-isolated-load-rehearsal") &&
      rehearsal.service.environment.general.CAPSTONE_DEPLOYMENT_PROFILE === "managed-rehearsal" &&
      rehearsal.service.environment.general.NODE_ENV === "test" &&
      rehearsal.service.environment.general.EMAIL_DELIVERY === "disabled" &&
      rehearsal.service.environment.secret_keys.includes("CAPSTONE_LOAD_DIAGNOSTICS_SECRET") &&
      !rehearsal.service.environment.secret_keys.includes("OPENROUTER_API_KEY") &&
      !rehearsal.service.environment.secret_keys.includes("RESEND_API_KEY") &&
      rehearsal.job.name === "capstone-migrate" &&
      deployTool.includes('operation === "history-eviction-rehearsal"'),
    loadEmployees: hasText(roadmap, /20 simultaneously signed-in employees/u) ? 20 : null,
    managedLoadOperatorBoundary:
      amendment.includes("`pscale role create ... --ttl 24h`") &&
      amendment.includes("force-closes its database pool") &&
      amendment.includes("removes the generator `/32`") &&
      amendment.includes("CAPSTONE_LOAD_AUTH_SECRET") &&
      hasText(provisioning, /provider-enforced[\n ]+24-hour TTL/u) &&
      hasText(provisioning, /never place its URL in an App[\n ]+spec/u) &&
      provisioning.includes("prove connection denial again"),
    loadResponseStartMilliseconds: hasText(
      roadmap,
      /response\.started` targets p95 at or below 500 ms/u,
    )
      ? 500
      : null,
    loadStreams: hasText(roadmap, /40 active[\n ]+employee streams/u) ? 40 : null,
    newRelicMirrorBoundary:
      logMirror.includes('return "https://log-api.newrelic.com/log/v1"') &&
      logMirror.includes('return "https://log-api.eu.newrelic.com/log/v1"') &&
      logMirror.includes("logApiEndpointFor(options.otlpEndpoint)") &&
      logMirror.includes("batchMaximumBytes: 128 * 1_024") &&
      logMirror.includes("batchMaximumRecords: 64") &&
      logMirror.includes("deliveryAttempts: 3") &&
      logMirror.includes("flushIntervalMs: 1_000") &&
      logMirror.includes("maximumRecordBytes: 2_048") &&
      logMirror.includes("queueMaximumBytes: 1_024 * 1_024") &&
      logMirror.includes("queueMaximumRecords: 1_024") &&
      logMirror.includes("requestTimeoutMs: 3_000") &&
      logMirror.includes("shutdownTimeoutMs: 5_000") &&
      logMirror.includes("queue.shift()") &&
      telemetry.includes("recordLogMirrorDrop"),
    operationsAuthorityDocumented:
      operationsReadme.includes("one active provisional Phase 8 path") &&
      operationsReadme.includes("Dedicated Egress") &&
      hasText(operationsReadme, /external[\n ]+mutation/u) &&
      provisioning.includes("health-only bootstrap App") &&
      provisioning.includes("document-hash latch") &&
      provisioning.includes("Send the initial invitation after readiness") &&
      deploymentRunbook.includes("native rollback action is prohibited") &&
      deploymentRunbook.includes("capstone-chat-production-app-spec") &&
      deploymentRunbook.includes("GHCR retention") &&
      recoveryRunbook.includes("Recovery must not receive the original") &&
      recoveryRunbook.includes("both new `/32`s") &&
      recoveryRunbook.includes("detach `chat.capstone.com.ec`") &&
      domainRunbook.includes("DNSSEC") &&
      domainRunbook.includes("CAA") &&
      domainRunbook.includes("do-connecting-ip") &&
      domainRunbook.includes("Cloudflare-backed edge") &&
      secretsRunbook.includes("component-scoped encrypted `SECRET`") &&
      secretsRunbook.includes("recovery role is") &&
      secretsRunbook.includes("GHCR pull credential"),
    productionRuntimeBoundary:
      apiConfig.includes('const appPlatformDeploymentTarget = "digitalocean-app-platform"') &&
      apiConfig.includes('const platformEnvironmentSecretSource = "platform-environment"') &&
      apiConfig.includes("HOST must be 0.0.0.0 in production") &&
      apiConfig.includes("CLIENT_ADDRESS_SOURCE must be digitalocean-app-platform in production") &&
      apiConfig.includes(
        "CAPSTONE_SECRET_FILE is prohibited for the production application and migration job",
      ),
    recoveryRetentionHours: hasText(roadmap, /retained for 84 hours/u) ? 84 : null,
    retentionToolBoundaries:
      retentionTool.includes('"active-serving"') &&
      retentionTool.includes('"desired-spec"') &&
      retentionTool.includes('"in-progress"') &&
      retentionTool.includes('"recent-five"') &&
      retentionTool.includes('"recovery-pin"') &&
      retentionTool.includes("unknownVersionsLeftUntouched") &&
      retentionTool.includes("Provider or recovery protection state changed after the dry run") &&
      retentionTool.includes("--plan-hash"),
    recoveryPinsFixturePresent: existsSync(
      path.join(deploymentDirectory, "fixtures/recovery-pins.example.json"),
    ),
    retentionWorkflowBound:
      retentionWorkflow.on?.workflow_dispatch !== undefined &&
      retentionWorkflow.concurrency?.group === "capstone-chat-production-app-spec" &&
      retentionWorkflow.concurrency?.["cancel-in-progress"] === false &&
      retentionWorkflow.permissions?.actions === "read" &&
      retentionWorkflow.permissions?.contents === "read" &&
      retentionWorkflow.permissions?.deployments === "read" &&
      retentionJob.environment === "production" &&
      retentionJob.if?.includes("refs/heads/main") &&
      retentionCommands.includes("python3 deploy/app-platform/ghcr-retention.py") &&
      retentionCommands.includes("--plan-hash") &&
      retentionCommands.includes("GHCR_RETENTION_TOKEN") &&
      (Array.isArray(retentionJob.steps) ? retentionJob.steps : []).some(
        (step) => step?.uses === "actions/upload-artifact@v5",
      ) &&
      retentionCommands.includes('rm -rf -- "$CAPSTONE_PROTECTED_DIRECTORY"') &&
      !retentionCommands.includes(":latest"),
    secretSourceBoundary:
      secretEnvironment.includes("active App Platform") &&
      secretEnvironment.includes(
        'source.DEPLOYMENT_TARGET?.trim() === "digitalocean-app-platform"',
      ) &&
      secretEnvironment.includes("readSecretEnvironmentFile") &&
      live.service.environment.secret_keys.length === 5 &&
      live.service.environment.general_keys.length === 1 &&
      live.service.environment.general_keys[0] === "OTEL_EXPORTER_OTLP_ENDPOINT" &&
      !live.service.environment.secret_keys.includes("CAPSTONE_SECRET_FILE") &&
      !live.job.environment.secret_keys.includes("CAPSTONE_SECRET_FILE"),
  };
}

function validateOperationsContract(contract) {
  const failures = [];
  const check = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };
  check(contract.appPlatformArtifactSetPresent, "required App Platform artifacts are missing");
  check(contract.appPlatformHostArtifactsAbsent, "a host-era artifact entered deploy/app-platform");
  check(contract.legacyDropletArtifactsAbsent, "the obsolete deploy/digitalocean path remains");
  check(contract.activeRenderConfigurationAbsent, "active render.yaml must remain absent");
  check(contract.activeRenderInstructionsAbsent, "an active Render operator path remains");
  check(contract.activeHostInstructionsAbsent, "an active host-era operator instruction remains");
  check(contract.contractReleaseValuesAbsent, "App contracts must remain digest- and secret-free");
  check(contract.bootstrapBoundary, "health-only bootstrap authority drifted");
  check(contract.stagedProvisioningBoundary, "egress/domain provisioning stages drifted");
  check(contract.initializationBoundary, "temporary initialization secret or job scope drifted");
  check(
    contract.initializationCommandsBounded,
    "initialization or invitation command scope drifted",
  );
  check(contract.liveTopology, "App Platform region, service, job, drain, or egress drifted");
  check(contract.managedRehearsalBoundary, "managed rehearsal contract drifted");
  check(contract.domainAndEdgeBoundary, "managed domain, TLS, or edge policy drifted");
  check(contract.deploymentToolBoundaries, "exact-digest deploy/rollback mutation fences drifted");
  check(contract.deploymentWorkflowBound, "protected production deployment workflow drifted");
  check(contract.configurationWorkflowBound, "protected configuration workflow drifted");
  check(contract.retentionToolBoundaries, "GHCR retention protection boundaries drifted");
  check(contract.recoveryPinsFixturePresent, "bounded recovery-pin fixture is missing");
  check(contract.retentionWorkflowBound, "protected GHCR retention workflow drifted");
  check(contract.imageBoundary, "production image or App Platform runtime defaults drifted");
  check(contract.productionRuntimeBoundary, "production runtime configuration authority drifted");
  check(contract.clientAddressBoundary, "App Platform client-address trust boundary drifted");
  check(contract.secretSourceBoundary, "platform secret scope or offline recovery seam drifted");
  check(contract.newRelicMirrorBoundary, "bounded New Relic log mirror contract drifted");
  check(contract.applicationPoolSettingsLocked, "database pool safety settings drifted");
  check(
    !contract.applicationRunsMigrationsAtStartup,
    "application startup must not run migrations",
  );
  check(contract.databaseTlsVerifyFull, "database TLS must remain direct verify-full on port 5432");
  check(contract.databaseIpRestricted, "PlanetScale must remain restricted to both egress /32s");
  check(
    contract.databasePlan === "PS-5" &&
      contract.databaseArchitecture === "arm-single-node" &&
      contract.databaseRegion === "us-east-1" &&
      contract.databaseInitialStorageGb === 10 &&
      contract.databaseMaximumStorageGb === 15,
    "PlanetScale topology or storage ceiling drifted",
  );
  check(
    contract.backupHours === 12 && contract.recoveryRetentionHours === 84,
    "backup cadence or retention drifted",
  );
  check(contract.ciWiresOperationsAudit, "CI no longer executes the operations audit");
  check(contract.ciPublicationNeedsAllGates, "GHCR publication must depend on all CI gates");
  check(contract.ciPublishesImmutableRevision, "CI must publish only a full-revision image tag");
  check(
    contract.ciValidatesLatestMigration,
    "CI/deployment image checks omit the latest migration",
  );
  check(contract.operationsAuthorityDocumented, "active runbook authority is incomplete");
  check(
    contract.managedLoadOperatorBoundary,
    "managed rehearsal load-operator or cleanup authority drifted",
  );
  check(
    contract.loadEmployees === 20 &&
      contract.loadStreams === 40 &&
      contract.loadResponseStartMilliseconds === 500,
    "managed workload or response-start objective was relaxed",
  );
  assert(failures.length === 0, failures.join("\n"));
}

function runCommand(command, arguments_, label) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || result.stdout.trim() || `${label} failed`);
  }
}

function runArtifactVerification() {
  for (const file of [
    "configuration.mjs",
    "configure.mjs",
    "consumable-input.mjs",
    "console.mjs",
    "contract.mjs",
    "deploy.mjs",
    "github-api.mjs",
    "http-json.mjs",
    "live-contract.mjs",
    "mutate-app.mjs",
    "operator-console.mjs",
    "provision.mjs",
    "provisioning.mjs",
    "provider-api.mjs",
    "release.mjs",
    "rollback.mjs",
  ]) {
    runCommand(
      process.execPath,
      ["--check", path.join(deploymentDirectory, file)],
      `${file} syntax`,
    );
  }
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "consumable-input.test.mjs")],
    "App Platform consumable input fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "contract.test.mjs")],
    "App Platform contract fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "mutate-app.test.mjs")],
    "App Platform mutation fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "github-api.test.mjs")],
    "App Platform GitHub authority fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "provider-api.test.mjs")],
    "App Platform provider API fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "release.test.mjs")],
    "App Platform release authority fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "configuration.test.mjs")],
    "App Platform configuration fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "operator-console.test.mjs")],
    "App Platform operator console fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "provisioning.test.mjs")],
    "App Platform provisioning fixtures",
  );
  runCommand(
    process.execPath,
    [path.join(deploymentDirectory, "workflow.test.mjs")],
    "App Platform workflow fixtures",
  );
  runCommand(
    "python3",
    [path.join(deploymentDirectory, "ghcr-retention.test.py")],
    "App Platform GHCR retention fixtures",
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
    const contents = readFileSync(path.join(operationsDirectory, file), "utf8");
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

function validateReleaseAndMigration(evidence) {
  assertExactKeys(evidence.release, ["expected", "observed"], "recovery evidence release");
  assert(
    typeof evidence.release.expected === "string" &&
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
}

function validateOperatorAndStatus(evidence) {
  assert(evidence.schemaVersion === 3, "recovery evidence schemaVersion must equal 3");
  assert(evidence.status === "accepted", "recovery evidence must be accepted");
  assert(
    typeof evidence.operatorRole === "string" &&
      /^[a-z][a-z0-9-]{1,63}$/u.test(evidence.operatorRole),
    "operatorRole must be a safe role, not personal data",
  );
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
    "PlanetScale recovery evidence",
  );
  validateOperatorAndStatus(evidence);
  validateReleaseAndMigration(evidence);
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
    "PlanetScale recovery topology",
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
    "PlanetScale recovery topology does not match the approved candidate",
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
    "PlanetScale recovery isolation",
  );
  assert(
    evidence.isolation.applicationProvidersContacted === false,
    "validation must not contact application providers",
  );
  assert(
    evidence.isolation.databaseIpRestricted === true,
    "recovery database must be IP-restricted",
  );
  assert(
    evidence.isolation.dedicatedEgressAddressCount === 2,
    "recovery database must restrict both dedicated egress addresses",
  );
  assert(evidence.isolation.rolesSeparated === true, "recovery roles must remain separate");
  assert(evidence.isolation.sourceUntouched === true, "the source database must remain untouched");
  assert(
    evidence.isolation.verifyFullTls === true,
    "recovery connections must verify TLS hostnames",
  );
  assertExactKeys(evidence.integrity, pitrIntegrityKeys, "PlanetScale recovery integrity");
  for (const key of pitrIntegrityKeys) {
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
    "PlanetScale recovery timing",
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
  assert(
    recoveredAt <= selectedAt,
    "latest recovered marker must be at or before the selected point",
  );
  assert((incidentAt - recoveredAt) / 60_000 <= 15, "observed RPO exceeds 15 minutes");
  assert((completedAt - incidentAt) / 60_000 <= 240, "observed RTO exceeds four hours");
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
    "PlanetScale recovery cleanup",
  );
  for (const value of Object.values(evidence.cleanup)) {
    assert(value === true, "every PlanetScale recovery cleanup gate must pass");
  }
}

function validateColdRecreationEvidence(evidence) {
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
    "DigitalOcean App recreation evidence",
  );
  validateOperatorAndStatus(evidence);
  validateReleaseAndMigration(evidence);
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
    "DigitalOcean App recreation topology",
  );
  assert(
    evidence.topology.region === "ric" &&
      evidence.topology.serviceSize === "apps-s-1vcpu-1gb-fixed" &&
      evidence.topology.jobSize === "apps-s-1vcpu-0.5gb" &&
      evidence.topology.instanceCount === 1 &&
      evidence.topology.autoscaling === false &&
      evidence.topology.dedicatedEgressAddressCount === 2,
    "cold App recreation topology does not match the approved candidate",
  );
  assertExactKeys(evidence.integrity, coldRecreationIntegrityKeys, "cold App recreation integrity");
  for (const key of coldRecreationIntegrityKeys) {
    assert(evidence.integrity[key] === true, `cold App recreation check ${key} must pass`);
  }
  assertExactKeys(
    evidence.timing,
    ["incidentAt", "rehearsalStartedAt", "validationCompletedAt"],
    "cold App recreation timing",
  );
  const startedAt = utcMilliseconds(evidence.timing.rehearsalStartedAt, "rehearsalStartedAt");
  const incidentAt = utcMilliseconds(evidence.timing.incidentAt, "incidentAt");
  const completedAt = utcMilliseconds(
    evidence.timing.validationCompletedAt,
    "validationCompletedAt",
  );
  assert(
    startedAt <= incidentAt && incidentAt <= completedAt,
    "cold App recreation timing order is invalid",
  );
  assert((completedAt - incidentAt) / 60_000 <= 240, "cold App recreation RTO exceeds four hours");
  assertExactKeys(
    evidence.cleanup,
    [
      "evidenceAccepted",
      "supersededAppRemoved",
      "supersededEgressRulesRemoved",
      "temporaryCredentialsRevoked",
    ],
    "cold App recreation cleanup",
  );
  for (const value of Object.values(evidence.cleanup)) {
    assert(value === true, "every cold App recreation cleanup gate must pass");
  }
}

function validateRecoveryEvidence(value) {
  const evidence = assertRecord(value, "recovery evidence");
  if (evidence.kind === "planetscale-pitr-rehearsal") {
    validatePitrEvidence(evidence);
    return;
  }
  if (evidence.kind === "digitalocean-app-platform-controlled-recreation") {
    validateColdRecreationEvidence(evidence);
    return;
  }
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

function safeColdRecreationExample() {
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

function expectRejected(makeUnsafe, safe, label, validator) {
  const unsafe = structuredClone(safe);
  makeUnsafe(unsafe);
  let rejected = false;
  try {
    validator(unsafe);
  } catch {
    rejected = true;
  }
  assert(rejected, `${label} self-test did not reject unsafe drift`);
}

function runSelfTest(contract) {
  for (const mutation of [
    (value) => {
      value.legacyDropletArtifactsAbsent = false;
    },
    (value) => {
      value.appPlatformHostArtifactsAbsent = false;
    },
    (value) => {
      value.activeHostInstructionsAbsent = false;
    },
    (value) => {
      value.contractReleaseValuesAbsent = false;
    },
    (value) => {
      value.bootstrapBoundary = false;
    },
    (value) => {
      value.initializationBoundary = false;
    },
    (value) => {
      value.liveTopology = false;
    },
    (value) => {
      value.domainAndEdgeBoundary = false;
    },
    (value) => {
      value.deploymentToolBoundaries = false;
    },
    (value) => {
      value.deploymentWorkflowBound = false;
    },
    (value) => {
      value.retentionWorkflowBound = false;
    },
    (value) => {
      value.recoveryPinsFixturePresent = false;
    },
    (value) => {
      value.clientAddressBoundary = false;
    },
    (value) => {
      value.secretSourceBoundary = false;
    },
    (value) => {
      value.newRelicMirrorBoundary = false;
    },
    (value) => {
      value.databaseIpRestricted = false;
    },
    (value) => {
      value.databaseMaximumStorageGb = 20;
    },
    (value) => {
      value.backupHours = 24;
    },
    (value) => {
      value.ciPublicationNeedsAllGates = false;
    },
    (value) => {
      value.ciValidatesLatestMigration = false;
    },
    (value) => {
      value.loadEmployees = 10;
      value.loadStreams = 20;
    },
    (value) => {
      value.managedLoadOperatorBoundary = false;
    },
  ]) {
    expectRejected(mutation, contract, "operations contract", validateOperationsContract);
  }

  const pitr = safePitrExample();
  validateRecoveryEvidence(pitr);
  for (const mutation of [
    (value) => {
      value.isolation.sourceUntouched = false;
    },
    (value) => {
      value.isolation.dedicatedEgressAddressCount = 1;
    },
    (value) => {
      value.integrity.initializationNotRepeated = false;
    },
    (value) => {
      value.topology.maximumStorageGb = 20;
    },
    (value) => {
      value.timing.latestRecoveredMarkerAt = "2026-08-11T11:59:00.000Z";
    },
    (value) => {
      value.timing.validationCompletedAt = "2026-08-11T16:16:00.000Z";
    },
    (value) => {
      value.notes = "unexpected free-form evidence";
    },
  ]) {
    expectRejected(mutation, pitr, "PlanetScale recovery evidence", validateRecoveryEvidence);
  }

  const cold = safeColdRecreationExample();
  validateRecoveryEvidence(cold);
  for (const mutation of [
    (value) => {
      value.integrity.databaseSourceUntouched = false;
    },
    (value) => {
      value.integrity.domainDetachedBeforeDelete = false;
    },
    (value) => {
      value.topology.dedicatedEgressAddressCount = 1;
    },
    (value) => {
      value.topology.region = "nyc3";
    },
    (value) => {
      value.timing.validationCompletedAt = "2026-08-11T16:06:00.000Z";
    },
    (value) => {
      value.cleanup.temporaryCredentialsRevoked = false;
    },
  ]) {
    expectRejected(
      mutation,
      cold,
      "DigitalOcean App recreation evidence",
      validateRecoveryEvidence,
    );
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
  runArtifactVerification();
  const contract = inspectOperationsContract();
  validateOperationsContract(contract);
  validateRunbooks();
  const [mode, ...arguments_] = process.argv.slice(2);
  if (mode === "--self-test") {
    runSelfTest(contract);
    process.stdout.write(
      "App Platform, PlanetScale, runbook, and recovery-evidence validators passed.\n",
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
