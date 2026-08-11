import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operationsDirectory = path.join(repositoryRoot, "docs/operations");
const deploymentDirectory = path.join(repositoryRoot, "deploy/digitalocean");
const expectedDeploymentFiles = [
  "Caddyfile",
  "README.md",
  "capstone-boot.service",
  "capstone-caddy.service",
  "capstone-chat@.service",
  "capstone-deploy.service",
  "capstone-fluent-bit.service",
  "capstone-operator.service",
  "ci-evidence.example.json",
  "cleanup-migrations.sh",
  "cloud-init.yaml",
  "deploy-state-machine.test.sh",
  "deploy.sh",
  "fluent-bit-parsers.conf",
  "fluent-bit-privacy.test.mjs",
  "fluent-bit-secret.test.sh",
  "fluent-bit.conf",
  "ghcr-retention.py",
  "ghcr-retention.test.py",
  "host.env",
  "maintenance.caddy",
  "migration-cleanup.test.sh",
  "operator-entrypoint.mjs",
  "operator-secret.test.sh",
  "operator.sh",
  "request-deploy.sh",
  "request-lifecycle.sh",
  "request-lifecycle.test.sh",
  "request-operator.sh",
  "start-fluent-bit.sh",
  "verify-artifacts.sh",
  "verify-host-negative.test.sh",
  "verify-host.sh",
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
  "drafts",
  "expectedMarkerBoundary",
  "extensionRecreated",
  "fakeReadWrite",
  "generations",
  "migrationLedger",
  "poolTimeouts",
  "postgresMajorVersion",
  "readiness",
  "reconciliation",
  "reservations",
  "searchObjects",
  "selectedLeaves",
  "signIn",
  "workspaceMemberships",
];
const coldRebuildIntegrityKeys = [
  "caddyTls",
  "cloudInit",
  "databaseSourceUntouched",
  "encryptedVolume",
  "firewall",
  "hostAudit",
  "immutableImage",
  "readiness",
  "reservedAddressReassigned",
  "secretIsolation",
  "telemetry",
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

function applicationPoolSettingsAreLocked(poolSource) {
  return [
    "connectionTimeoutMillis: 5_000",
    "idleTimeoutMillis: 30_000",
    "max: 10",
    "statement_timeout=5000",
    "lock_timeout=5000",
    "idle_in_transaction_session_timeout=5000",
    "query_timeout: 5_000",
  ].every((setting) => poolSource.includes(setting));
}

function inspectOperationsContract() {
  const deploymentFiles = readdirSync(deploymentDirectory).sort();
  const cloudInit = parseYaml("deploy/digitalocean/cloud-init.yaml", "cloud-init.yaml");
  const commands = Array.isArray(cloudInit.runcmd) ? cloudInit.runcmd : [];
  const firewallAllows = commands.filter(
    (command) => Array.isArray(command) && command[0] === "ufw" && command[1] === "allow",
  );
  const publicPorts = firewallAllows
    .filter((command) => !command.includes("from"))
    .map((command) => Number(String(command[2]).split("/", 1)[0]))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const sshRestricted = firewallAllows.some(
    (command) =>
      command.includes("from") &&
      command.includes("__OPERATOR_IPV4_CIDR__") &&
      command.includes("port") &&
      command.includes("22"),
  );

  const roadmap = readRepositoryFile("docs/prd/06-development-roadmap.md");
  const amendment = readRepositoryFile(
    "docs/implementation/08-digitalocean-planetscale-amendment-plan.md",
  );
  const provisioning = readRepositoryFile("docs/operations/provision-and-deploy.md");
  const deployRunbook = readRepositoryFile("docs/operations/deploy-and-rollback.md");
  const hostReadme = readRepositoryFile("deploy/digitalocean/README.md");
  const caddy = readRepositoryFile("deploy/digitalocean/Caddyfile");
  const caddyService = readRepositoryFile("deploy/digitalocean/capstone-caddy.service");
  const applicationService = readRepositoryFile("deploy/digitalocean/capstone-chat@.service");
  const bootService = readRepositoryFile("deploy/digitalocean/capstone-boot.service");
  const deployService = readRepositoryFile("deploy/digitalocean/capstone-deploy.service");
  const deploy = readRepositoryFile("deploy/digitalocean/deploy.sh");
  const migrationCleanup = readRepositoryFile("deploy/digitalocean/cleanup-migrations.sh");
  const operator = readRepositoryFile("deploy/digitalocean/operator.sh");
  const operatorEntrypoint = readRepositoryFile("deploy/digitalocean/operator-entrypoint.mjs");
  const operatorService = readRepositoryFile("deploy/digitalocean/capstone-operator.service");
  const requestDeploy = readRepositoryFile("deploy/digitalocean/request-deploy.sh");
  const requestLifecycle = readRepositoryFile("deploy/digitalocean/request-lifecycle.sh");
  const requestOperator = readRepositoryFile("deploy/digitalocean/request-operator.sh");
  const fluentBitLauncher = readRepositoryFile("deploy/digitalocean/start-fluent-bit.sh");
  const verifyHost = readRepositoryFile("deploy/digitalocean/verify-host.sh");
  const verifyHostNegative = readRepositoryFile("deploy/digitalocean/verify-host-negative.test.sh");
  const retentionProgram = readRepositoryFile("deploy/digitalocean/ghcr-retention.py");
  const fluentBit = readRepositoryFile("deploy/digitalocean/fluent-bit.conf");
  const fluentBitService = readRepositoryFile("deploy/digitalocean/capstone-fluent-bit.service");
  const hostEnvironment = readRepositoryFile("deploy/digitalocean/host.env");
  const dockerfile = readRepositoryFile("apps/api/Dockerfile");
  const apiConfig = readRepositoryFile("apps/api/src/config.ts");
  const productionDatabaseUrl = readRepositoryFile(
    "apps/api/src/database/production-database-url.ts",
  );
  const secretEnvironment = readRepositoryFile("apps/api/src/secret-environment.ts");
  const databasePool = readRepositoryFile("apps/api/src/database/pool.ts");
  const entrypoint = readRepositoryFile("apps/api/src/entrypoint.ts");
  const server = readRepositoryFile("apps/api/src/server.ts");
  const workflow = parseYaml(".github/workflows/ci.yml", "CI workflow");
  const jobs = assertRecord(workflow.jobs, "CI jobs");
  const publish = assertRecord(jobs["publish-image"], "publish-image job");
  const publishSteps = Array.isArray(publish.steps) ? publish.steps : [];
  const publishCommands = publishSteps
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .join("\n");
  const migrationCall = deploy.search(/\n {2}run_migrations "\$\{revision\}" "\$\{digest\}"/u);
  const startCall = deploy.search(/\n {2}start_release "\$\{candidate_release\}"/u);
  const deploymentExitBody = deploy.split("on_exit() {", 2)[1]?.split("\n}\n", 1)[0] ?? "";
  const headerClaims = ["Forwarded", "X-Forwarded-*", "CF-Connecting-IP", "X-Capstone-Client-IP"];
  const activeProductionSources = [
    readRepositoryFile("README.md"),
    ...readdirSync(path.join(repositoryRoot, "docs/prd"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => readRepositoryFile(`docs/prd/${file}`)),
    ...requiredRunbooks.map((file) => readRepositoryFile(`docs/operations/${file}`)),
    readRepositoryFile(".github/workflows/ci.yml"),
    readRepositoryFile(".env.example"),
    dockerfile,
  ].join("\n");

  return {
    activeRenderConfigurationAbsent: !existsSync(path.join(repositoryRoot, "render.yaml")),
    activeRenderInstructionsAbsent:
      !/RENDER_GIT_COMMIT|render\.yaml|render\.com|\brender deploy\b|Render hosts|Render deploys/iu.test(
        activeProductionSources,
      ),
    applicationServiceCount: deploymentFiles.filter((file) => file === "capstone-chat@.service")
      .length,
    applicationRoleSeparated:
      hasText(amendment, /Use three credential boundaries/u) &&
      hasText(amendment, /\*\*application role:\*\*/u) &&
      hasText(amendment, /\*\*migration role:\*\*/u) &&
      hasText(amendment, /\*\*default near-superuser role:\*\*/u),
    applicationRunsMigrationsAtStartup:
      /migrat/iu.test(server) ||
      !dockerfile.includes('CMD ["node", "apps/api/dist/entrypoint.js", "server"]') ||
      !entrypoint.includes('server: () => import("./server.js")'),
    applicationLoopbackOnly:
      applicationService.includes("--network host") &&
      applicationService.includes("--env HOST=127.0.0.1") &&
      apiConfig.includes("HOST must be 127.0.0.1 in production"),
    applicationPoolSettingsLocked: applicationPoolSettingsAreLocked(databasePool),
    artifactSetExact:
      deploymentFiles.length === expectedDeploymentFiles.length &&
      deploymentFiles.every((file, index) => file === expectedDeploymentFiles[index]),
    backupHours: hasText(roadmap, /backups run every 12 hours/u) ? 12 : null,
    caddyAdminUnix: caddy.includes("admin unix//run/capstone-caddy/admin.sock"),
    caddyEncryptedState:
      caddyService.includes("XDG_DATA_HOME=/srv/capstone-secure/caddy/data") &&
      caddyService.includes("XDG_CONFIG_HOME=/srv/capstone-secure/caddy/config"),
    caddyHeaderOverwrite: deploy.includes(
      "header_up X-Capstone-Client-IP {http.request.remote.host}",
    ),
    caddyHeaderStripCount: headerClaims.filter((header) => deploy.includes(`header_up -${header}`))
      .length,
    caddyHasAccessLog: /(^|\n)[\t ]*log(?:[\t {]|$)/u.test(caddy),
    caddyHasNegativeFlush: /flush_interval[\t ]+-/u.test(`${caddy}\n${deploy}`),
    caddyPersistsApiConfig: !caddy.includes("persist_config off"),
    caddyTransformsStreams: /(^|\n)[\t ]*encode(?:[\t {]|$)/u.test(caddy),
    caddyUser: /^User=caddy$/mu.test(caddyService) ? "caddy" : "root",
    caddyLeastPrivilege:
      caddyService.includes("CapabilityBoundingSet=CAP_NET_BIND_SERVICE") &&
      caddyService.includes("AmbientCapabilities=CAP_NET_BIND_SERVICE") &&
      caddyService.includes(
        "InaccessiblePaths=/srv/capstone-secure/runtime /srv/capstone-secure/migration /srv/capstone-secure/registry /srv/capstone-secure/fluent-bit",
      ) &&
      caddy.includes("protocols h1 h2") &&
      caddy.includes('Strict-Transport-Security "max-age=31536000"') &&
      !caddy.includes("includeSubDomains"),
    ciPublishesImmutableRevision:
      publishCommands.includes('image="$IMAGE_REPOSITORY:$GITHUB_SHA"') &&
      publishCommands.includes('docker push "$image"') &&
      !publishCommands.includes(":latest"),
    imageRequiresFullRevision: dockerfile.includes(
      `printf '%s\\n' "$DEPLOYMENT_REVISION" | grep -Eq '^[0-9a-f]{40}$'`,
    ),
    ciPublicationNeedsAllGates:
      Array.isArray(publish.needs) &&
      publish.needs.length === 2 &&
      publish.needs.includes("quality") &&
      publish.needs.includes("playwright") &&
      publish.permissions?.packages === "write",
    containerCapabilitiesDropped: applicationService.includes("--cap-drop ALL"),
    containerCoreDumpsDisabled: applicationService.includes("--ulimit core=0:0"),
    containerMemoryMiB: applicationService.includes("--memory 640m") ? 640 : null,
    containerPids: applicationService.includes("--pids-limit 256") ? 256 : null,
    containerReadOnly: applicationService.includes("--read-only"),
    containerUser: applicationService.includes("--user 1000:1000") ? "1000:1000" : "root",
    credentialPathsSeparated:
      applicationService.includes("/run/capstone-secrets/runtime.json") &&
      deploy.includes("/run/capstone-secrets/migration.json") &&
      !applicationService.includes("migration.json") &&
      operator.includes("secret_target=/run/capstone-secrets/operator.json") &&
      !operator.includes("secret_target=/run/capstone-secrets/runtime.json") &&
      hostEnvironment.includes("/srv/capstone-secure/registry") &&
      !applicationService.includes("/srv/capstone-secure/registry"),
    databaseArchitecture: hasText(roadmap, /PS-5 ARM Single[\n ]+Node/u) ? "arm-single-node" : null,
    databaseInitialStorageGb: hasText(roadmap, /starts at 10 GB/u) ? 10 : null,
    databaseIpRestricted:
      hasText(roadmap, /accepts new connections only from the verified Droplet `\/32`/u) &&
      hasText(amendment, /never opens to[\n ]+`0\.0\.0\.0\/0`/u),
    databaseMaximumStorageGb: hasText(roadmap, /hard 15 GB storage[\n ]+ceiling/u) ? 15 : null,
    databasePlan: hasText(roadmap, /PS-5 ARM Single[\n ]+Node/u) ? "PS-5" : null,
    databasePostgresMajor: hasText(amendment, /PostgreSQL 18\.4, PS-5 ARM Single Node/u)
      ? 18
      : null,
    databaseRegion: hasText(roadmap, /AWS `us-east-1`/u) ? "us-east-1" : null,
    databaseTlsVerifyFull:
      apiConfig.includes("parseProductionDatabaseUrl(value)") &&
      productionDatabaseUrl.includes('some((key) => key !== "sslmode")') &&
      productionDatabaseUrl.includes('url.searchParams.getAll("sslmode").length !== 1') &&
      productionDatabaseUrl.includes('url.searchParams.get("sslmode") !== "verify-full"') &&
      productionDatabaseUrl.includes('url.searchParams.has("sslrootcert")') &&
      productionDatabaseUrl.includes('url.searchParams.has("options")') &&
      productionDatabaseUrl.includes('(url.port !== "" && url.port !== "5432")') &&
      hasText(roadmap, /direct[\n ]+port 5432, `verify-full` TLS/u),
    deploymentAtomicAuthority: /mv -fT "\$\{temporary\}" "\$\{ACTIVE_LINK\}"/u.test(deploy),
    deploymentActivationEvidence:
      /activation-evidence schema=1 activatedAt=\$\{activated_at\} revision=\$\{revision\} digest=\$\{digest\}/u.test(
        deploy,
      ) &&
      (deploy.match(/record_activation_evidence "\$\{(?:candidate_release|previous)\}"/gu)
        ?.length ?? 0) === 2 &&
      provisioning.includes(
        "journalctl --unit=capstone-deploy.service --lines=1 --no-pager --output=cat",
      ) &&
      provisioning.includes("--grep='^capstone-deploy: activation-evidence schema=1 '") &&
      provisioning.includes("authorized external change record") &&
      provisioning.includes("pre-activation `createdAt`") &&
      deployRunbook.includes(
        "journalctl --unit=capstone-deploy.service --lines=1 --no-pager --output=cat",
      ) &&
      deployRunbook.includes("authorized external change record") &&
      deployRunbook.includes("Collect the rollback's exact final activation record"),
    deploymentBootBudget:
      bootService.includes("TimeoutStartSec=900s") &&
      bootService.includes("TimeoutStopSec=900s") &&
      bootService.includes("KillMode=mixed"),
    deploymentCleanShutdown:
      !applicationService.includes("docker run --rm --name capstone-chat-") &&
      deploy.includes("$container.State.ExitCode == 0") &&
      deploy.includes("write_shutdown_acknowledgement") &&
      deploy.search(/write_shutdown_acknowledgement "\$\{slot\}" "\$\{inspection\}"/u) <
        deploy.search(/docker rm "\$\{initial_id\}"/u) &&
      applicationService.includes("docker stop --time 300") &&
      applicationService.includes("TimeoutStopSec=330s") &&
      deployService.includes("TimeoutStartSec=2400s") &&
      deployService.includes("TimeoutStopSec=1200s") &&
      deployService.includes("KillMode=mixed"),
    deploymentCredentialFreeSmoke:
      deploy.includes("static_application_is_served") &&
      deploy.includes("anonymous_session_is_rejected") &&
      deploy.includes("X-Capstone-Client-IP: 192.0.2.1") &&
      deploy.includes("verify_direct_smoke") &&
      deploy.includes("verify_public_smoke"),
    deploymentDigestOnly: /\$\{CAPSTONE_IMAGE_REPOSITORY\}@\$\{digest\}/u.test(deploy),
    deploymentExternalSourceGated:
      deploy.includes("https://icanhazip.com/") &&
      (deploy.match(/^ {2}validate_external_outbound_source$/gmu)?.length ?? 0) === 2,
    deploymentFailureConvergence:
      deploymentExitBody.indexOf("reconcile_unlocked || reconcile_status=$?") <
        deploymentExitBody.indexOf("remove_uncommitted_candidate") &&
      deploymentExitBody.includes("preserving the candidate for boot reconciliation"),
    deploymentIsSupervised:
      deploy.includes("CAPSTONE_DEPLOY_SUPERVISED") &&
      requestDeploy.includes("capstone-deploy.service"),
    deploymentRequestsAreLifecycleBound:
      requestLifecycle.includes("ActiveState") &&
      requestLifecycle.includes("Job") &&
      /active_state\} == inactive \|\| \$\{active_state\} == failed/u.test(requestLifecycle) &&
      requestDeploy.includes("capstone_request_unit_accepts_new_work capstone-deploy.service") &&
      requestOperator.includes("capstone_request_unit_accepts_new_work capstone-operator.service"),
    deploymentDockerCallsAreBounded:
      deploy.includes("inspect_container_if_present") &&
      deploy.includes("capture_value_interruptible") &&
      deployService.includes(
        "timeout --signal=TERM --kill-after=10s 60s /opt/capstone-chat/bin/cleanup-migrations.sh post-stop",
      ),
    deploymentRunsMigrationBeforeStart:
      migrationCall >= 0 && startCall >= 0 && migrationCall < startCall,
    migrationSecretSchemaExact:
      deploy.includes('keys == ["DATABASE_URL"]') &&
      deploy.includes("migration secret must contain only DATABASE_URL") &&
      /validate_migration_secret_file "\$\{secret_source\}" "\$\{secret_gid\}"/u.test(operator),
    initialPolicyBootstrap:
      requestOperator.includes("model-policy-initialize") &&
      operator.includes("initial_release_is_absent") &&
      operator.includes("validate_ci_evidence") &&
      operator.includes("pull_and_verify_initial_image") &&
      operator.includes("run_initial_migrations") &&
      operatorEntrypoint.includes('request.operation === "model-policy-initialize"'),
    dnsOnly: hasText(roadmap, /DNS-only IPv4 record/u),
    dropletCpu: hasText(roadmap, /one vCPU and 1 GiB RAM/u) ? 1 : null,
    dropletRamMiB: hasText(roadmap, /one vCPU and 1 GiB RAM/u) ? 1_024 : null,
    dropletRegion: hasText(roadmap, /in RIC1/u) ? "ric1" : null,
    fluentBitDiskBuffer: /storage\.path|filesystem/iu.test(fluentBit),
    fluentBitFieldAllowlist:
      fluentBit.includes("Name                      record_modifier") &&
      fluentBit.includes("Reserve_Data              Off") &&
      fluentBit.includes("Buffer_Max_Size           16K") &&
      !/^\s*Allowlist_key\s+(?:authorization|cookie|databaseUrl|email|prompt|providerBody|query|raw|response|url)\s*$/mu.test(
        fluentBit,
      ),
    fluentBitInput: /Unix_Path[\t ]+\/run\/capstone-fluent-bit\/docker\.sock/u.test(fluentBit)
      ? "unix"
      : "tcp",
    fluentBitMemoryMiB: /Mem_Buf_Limit[\t ]+8M/u.test(fluentBit) ? 8 : null,
    fluentBitOutput: /Name[\t ]+http/u.test(fluentBit) ? "builtin-http" : "external-plugin",
    fluentBitRetryLimit: /Retry_Limit[\t ]+10/u.test(fluentBit) ? 10 : null,
    fluentBitUser: /^User=capstone-fluent-bit$/mu.test(fluentBitService)
      ? "capstone-fluent-bit"
      : "root",
    fluentBitSecretLauncher:
      fluentBitService.includes("ExecStart=/opt/capstone-chat/bin/start-fluent-bit.sh") &&
      !fluentBitService.includes("EnvironmentFile=") &&
      fluentBitService.includes("ReadOnlyPaths=/etc/capstone-chat /opt/fluent-bit") &&
      fluentBitLauncher.includes("NEW_RELIC_LICENSE_KEY=[A-Za-z0-9._-]+") &&
      fluentBitLauncher.includes("exec /opt/fluent-bit/bin/fluent-bit") &&
      verifyHost.includes("start-fluent-bit.sh root capstone-fluent-bit-secrets 550"),
    freshHostStartOrder:
      !hostReadme.includes("systemctl enable --now") &&
      hostReadme.indexOf(
        "systemctl enable capstone-fluent-bit.service capstone-caddy.service capstone-boot.service",
      ) < hostReadme.indexOf("systemctl start capstone-fluent-bit.service") &&
      hostReadme.indexOf("systemctl start capstone-fluent-bit.service") <
        hostReadme.indexOf("systemctl start capstone-caddy.service") &&
      hostReadme.indexOf("systemctl start capstone-caddy.service") <
        hostReadme.indexOf("systemctl start capstone-boot.service") &&
      !provisioning.includes("systemctl enable --now") &&
      provisioning.indexOf(
        "systemctl enable capstone-fluent-bit.service capstone-caddy.service capstone-boot.service",
      ) < provisioning.indexOf("systemctl start capstone-fluent-bit.service") &&
      provisioning.indexOf("systemctl start capstone-fluent-bit.service") <
        provisioning.indexOf("systemctl start capstone-caddy.service") &&
      provisioning.indexOf("systemctl start capstone-caddy.service") <
        provisioning.indexOf("systemctl start capstone-boot.service"),
    hostCoreDumpsDisabled:
      hasText(readRepositoryFile("deploy/digitalocean/cloud-init.yaml"), "Storage=none") &&
      hasText(
        readRepositoryFile("deploy/digitalocean/cloud-init.yaml"),
        "kernel.core_pattern=/dev/null",
      ),
    hostVolumeEncryptedBoundary:
      hostEnvironment.includes("CAPSTONE_SECURE_ROOT=/srv/capstone-secure") &&
      hasText(amendment, /encrypted 1 GiB Volume/u),
    hostVolumeDeviceBoundary:
      deploy.includes("mount_field / MAJ:MIN") &&
      /\/sys\/dev\/block\/\$\{identity\}\/size/u.test(deploy) &&
      operator.includes("mount_field / MAJ:MIN") &&
      operator.includes("validate_secure_mount") &&
      verifyHost.includes("mount_field / MAJ:MIN") &&
      verifyHost.includes("block_device_size_bytes"),
    hostSecretDirectoriesExact:
      verifyHost.includes("directory_exact /srv/capstone-secure root root 711") &&
      verifyHost.includes(
        "directory_exact /srv/capstone-secure/runtime root capstone-runtime-secrets 750",
      ) &&
      verifyHost.includes(
        "directory_exact /srv/capstone-secure/migration root capstone-migration-secrets 750",
      ) &&
      verifyHost.includes("service_identities_cannot_cross_read"),
    hostNegativeEvidenceFailsClosed:
      verifyHost.includes("systemd_unit_snapshot") &&
      verifyHost.includes("unit_is_quiescent capstone-deploy.service") &&
      verifyHost.includes("unit_is_quiescent capstone-operator.service") &&
      verifyHost.includes("docker ps --all --quiet --filter name=^/capstone-operator$") &&
      verifyHost.includes("tcp_listener_allowlist_is_exact") &&
      verifyHost.includes("rule_count} -eq 3") &&
      verifyHost.includes("deny \\(incoming\\), allow \\(outgoing\\), disabled \\(routed\\)") &&
      verifyHost.includes("net.ipv6.conf.lo.disable_ipv6") &&
      verifyHost.includes("managed_container_inventory_is_exact") &&
      verifyHost.includes("docker ps --all --quiet) || return 1") &&
      verifyHostNegative.includes("failed swap inventory") &&
      verifyHostNegative.includes("two failed route commands with empty output") &&
      verifyHostNegative.includes("unexpected public Docker listener") &&
      verifyHostNegative.includes("extra UFW allow rule") &&
      verifyHostNegative.includes("default-allow incoming firewall") &&
      verifyHostNegative.includes("failed slot systemd query") &&
      verifyHostNegative.includes("stopped extra application container") &&
      verifyHostNegative.includes("unlabeled exact-name stale slot container") &&
      verifyHostNegative.includes("unlabeled initial migration container") &&
      verifyHostNegative.includes("arbitrary foreign stopped container"),
    imageOriginExact:
      dockerfile.includes(
        'org.opencontainers.image.source="https://github.com/jmjalil96/capstone-chat"',
      ) &&
      deploy.includes("org.opencontainers.image.source") &&
      operator.includes("org.opencontainers.image.source") &&
      requestDeploy.includes("capstone-chat$"),
    incomingRuleCount: firewallAllows.length,
    loadEmployees: hasText(amendment, /20-employee\/40-stream/u) ? 20 : null,
    loadResponseStartMilliseconds: hasText(amendment, /500 ms response-start/u) ? 500 : null,
    loadStreams: hasText(amendment, /20-employee\/40-stream/u) ? 40 : null,
    loggingCacheDisabled: applicationService.includes("cache-disabled=true"),
    loggingNonBlocking: applicationService.includes("mode=non-blocking"),
    operatorBoundary:
      operatorService.includes("CAPSTONE_OPERATOR_SUPERVISED=1") &&
      operatorService.includes("ProtectSystem=strict") &&
      operatorService.includes("TimeoutStartSec=1800s") &&
      operatorService.includes("TimeoutStopSec=210s") &&
      operatorService.includes("KillMode=mixed") &&
      operator.includes("flock --exclusive --nonblock") &&
      operator.includes("CAPSTONE_MIGRATION_SECRET_PATH") &&
      operator.includes("BETTER_AUTH_SECRET: $runtime.BETTER_AUTH_SECRET") &&
      operator.includes("RESEND_API_KEY: $runtime.RESEND_API_KEY") &&
      operator.includes("OPENROUTER_API_KEY: $runtime.OPENROUTER_API_KEY") &&
      operator.includes("--user 1000:1000") &&
      operator.includes("--read-only") &&
      operator.includes("--log-driver none") &&
      operator.includes("timeout --signal=TERM --kill-after=30s 180s") &&
      operator.includes("timeout --signal=TERM --kill-after=30s 300s") &&
      operator.includes("timeout --signal=TERM --kill-after=30s 540s") &&
      operatorEntrypoint.includes("apps/api/dist/entrypoint.js") &&
      requestOperator.includes("/dev/tty"),
    remoteRetentionFenced:
      requestOperator.includes("ghcr-retention-plan") &&
      requestOperator.includes("ghcr-retention-show") &&
      requestOperator.includes("ghcr-retention-delete") &&
      requestOperator.includes("candidateVersions: .core.candidateVersions") &&
      requestOperator.includes("Short-lived classic PAT") &&
      retentionProgram.includes('"recent-five"') &&
      retentionProgram.includes('"recovery-pin"') &&
      retentionProgram.includes("unknownVersionsLeftUntouched") &&
      retentionProgram.includes("GHCR or local protection state changed after the dry run") &&
      retentionProgram.includes("--token-file"),
    previousDigestProtected:
      requestDeploy.includes("prune") &&
      deploy.includes("previousRelease") &&
      deploy.includes("recovery-pins") &&
      deploy.includes("five newest plus active, previous, and recovery-pinned releases") &&
      /docker ps --all --quiet --filter "label=io\.capstone\.revision=\$\{revision\}"/u.test(
        deploy,
      ) &&
      deploy.includes("docker image ls --digests --no-trunc --format") &&
      deploy.search(/docker image rm "\$\{image\}"/u) <
        deploy.search(/find "\$\{release\}" -depth -delete/u),
    migrationSurvivorCleanup:
      migrationCleanup.includes('io.capstone.migration"] == "true"') &&
      migrationCleanup.includes("acquire_cleanup_lock") &&
      deployService.includes("cleanup-migrations.sh post-stop") &&
      operatorService.includes("cleanup-migrations.sh post-stop"),
    productionSecretFileEnforced:
      apiConfig.includes("source === process.env && !hasLoadedSecretEnvironment(source)") &&
      apiConfig.includes("CAPSTONE_SECRET_FILE must be the exclusive source") &&
      entrypoint.includes("loadEntrypoint(") &&
      entrypoint.includes("loadEnvironmentFile,") &&
      !entrypoint.includes('from "./server.js"') &&
      secretEnvironment.includes("loadedSecretEnvironments.set(source") &&
      secretEnvironment.includes("source.CAPSTONE_SECRET_FILE?.trim() === loaded.configuredPath"),
    publicPorts,
    recoveryRetentionHours: hasText(roadmap, /retained for 84 hours/u) ? 84 : null,
    sshRestricted,
    volumeGiB: hasText(roadmap, /encrypted 1 GiB DigitalOcean Volume/u) ? 1 : null,
  };
}

function validateOperationsContract(contract) {
  assert(contract.activeRenderConfigurationAbsent, "active render.yaml must be removed");
  assert(contract.activeRenderInstructionsAbsent, "an active Render operator path remains");
  assert(contract.artifactSetExact, "DigitalOcean artifact set changed or gained a second service");
  assert(
    contract.applicationServiceCount === 1,
    "exactly one application service template is allowed",
  );
  assert(
    contract.dropletCpu === 1 &&
      contract.dropletRamMiB === 1_024 &&
      contract.dropletRegion === "ric1" &&
      contract.volumeGiB === 1,
    "Droplet or encrypted-Volume topology drifted",
  );
  assert(
    contract.databasePlan === "PS-5" &&
      contract.databaseArchitecture === "arm-single-node" &&
      contract.databaseRegion === "us-east-1" &&
      contract.databasePostgresMajor === 18 &&
      contract.databaseInitialStorageGb === 10 &&
      contract.databaseMaximumStorageGb === 15,
    "PlanetScale topology or storage ceiling drifted",
  );
  assert(
    contract.backupHours === 12 && contract.recoveryRetentionHours === 84,
    "backup cadence or retention drifted",
  );
  assert(
    contract.incomingRuleCount === 3 &&
      contract.publicPorts.length === 2 &&
      contract.publicPorts[0] === 80 &&
      contract.publicPorts[1] === 443 &&
      contract.sshRestricted,
    "incoming firewall rules must be exact and SSH must remain source-restricted",
  );
  assert(contract.dnsOnly, "the public origin must remain direct DNS-only IPv4");
  assert(contract.applicationLoopbackOnly, "application slots must remain loopback-only");
  assert(contract.databaseIpRestricted, "PlanetScale must remain restricted to the Droplet /32");
  assert(contract.caddyAdminUnix, "Caddy admin must remain a Unix socket");
  assert(contract.caddyHeaderStripCount === 4, "Caddy must strip every public forwarding claim");
  assert(contract.caddyHeaderOverwrite, "Caddy must overwrite the private client address");
  assert(!contract.caddyHasNegativeFlush, "negative Caddy flush is prohibited");
  assert(!contract.caddyHasAccessLog, "Caddy access logging is prohibited");
  assert(!contract.caddyTransformsStreams, "Caddy response transformation is prohibited");
  assert(!contract.caddyPersistsApiConfig, "Caddy API configuration persistence is prohibited");
  assert(contract.caddyEncryptedState, "Caddy state must remain on the encrypted Volume");
  assert(contract.caddyUser === "caddy", "Caddy must remain an unprivileged host service");
  assert(contract.caddyLeastPrivilege, "Caddy capability, secret, or HSTS boundary drifted");
  assert(
    contract.containerUser === "1000:1000" &&
      contract.containerReadOnly &&
      contract.containerCapabilitiesDropped &&
      contract.containerPids === 256 &&
      contract.containerMemoryMiB === 640 &&
      contract.containerCoreDumpsDisabled,
    "application container restrictions drifted",
  );
  assert(contract.hostCoreDumpsDisabled, "host-wide core-dump denial is missing");
  assert(contract.fluentBitUser === "capstone-fluent-bit", "Fluent Bit must be unprivileged");
  assert(
    contract.fluentBitSecretLauncher,
    "Fluent Bit must load one exact data-only secret through its least-privilege launcher",
  );
  assert(
    contract.freshHostStartOrder,
    "fresh-host units must be enabled without starting, then start Fluent Bit, Caddy, and boot only after their prerequisites",
  );
  assert(
    contract.fluentBitFieldAllowlist,
    "Fluent Bit must drop unreviewed fields and reject oversized raw records",
  );
  assert(
    contract.fluentBitInput === "unix" &&
      contract.fluentBitOutput === "builtin-http" &&
      contract.fluentBitMemoryMiB === 8 &&
      contract.fluentBitRetryLimit === 10 &&
      !contract.fluentBitDiskBuffer,
    "Fluent Bit must remain built-in, Unix-only, bounded, and memory-only",
  );
  assert(
    contract.loggingCacheDisabled && contract.loggingNonBlocking,
    "Docker logging must remain non-blocking without a dual-log cache",
  );
  assert(contract.deploymentDigestOnly, "deployment must use an immutable image digest");
  assert(contract.deploymentAtomicAuthority, "active release authority must change atomically");
  assert(
    contract.deploymentActivationEvidence,
    "final activation evidence must bind UTC time to revision and digest outside release authority",
  );
  assert(contract.deploymentIsSupervised, "deployment must remain systemd-supervised");
  assert(
    contract.deploymentRequestsAreLifecycleBound,
    "request replacement must reject an activating unit or queued systemd job",
  );
  assert(
    contract.deploymentDockerCallsAreBounded,
    "Docker authority probes and post-stop migration cleanup must remain bounded",
  );
  assert(contract.deploymentBootBudget, "boot reconciliation must enclose two bounded slot stops");
  assert(
    contract.deploymentCleanShutdown,
    "forced container or systemd shutdown must not be accepted as clean",
  );
  assert(
    contract.deploymentFailureConvergence,
    "failed activation must restore durable traffic before candidate cleanup",
  );
  assert(
    contract.deploymentCredentialFreeSmoke,
    "activation must run direct and public credential-free smoke",
  );
  assert(
    contract.deploymentExternalSourceGated,
    "deploy and rollback must verify the externally observed reserved IPv4",
  );
  assert(
    contract.operatorBoundary,
    "operator commands must remain supervised, least-privilege, and strict-entrypoint routed",
  );
  assert(
    contract.remoteRetentionFenced,
    "GHCR retention must retain its explicit dry-run and protected-digest fences",
  );
  assert(
    contract.deploymentRunsMigrationBeforeStart,
    "migration must precede candidate activation",
  );
  assert(
    contract.migrationSecretSchemaExact,
    "migration container secret must reject every key except DATABASE_URL",
  );
  assert(
    contract.initialPolicyBootstrap,
    "first-release migrations and model policy need a CI-evidenced pre-activation path",
  );
  assert(
    !contract.applicationRunsMigrationsAtStartup,
    "application startup must not run migrations",
  );
  assert(contract.previousDigestProtected, "rollback and protected-digest retention drifted");
  assert(contract.migrationSurvivorCleanup, "migration survivor cleanup or lock deferral drifted");
  assert(contract.hostVolumeEncryptedBoundary, "secret state must remain on the encrypted Volume");
  assert(
    contract.hostVolumeDeviceBoundary,
    "deploy, operator, and host verification must reject a root-device bind mount",
  );
  assert(
    contract.hostSecretDirectoriesExact,
    "secure directory ownership/modes or cross-read denial drifted",
  );
  assert(
    contract.hostNegativeEvidenceFailsClosed,
    "host negative-evidence probes, network allowlists, or all-state inventory drifted",
  );
  assert(contract.imageOriginExact, "GHCR package or OCI source repository drifted");
  assert(contract.credentialPathsSeparated, "runtime, migration, and registry credentials crossed");
  assert(
    contract.productionSecretFileEnforced,
    "production credentials must come from the strict file",
  );
  assert(contract.ciPublicationNeedsAllGates, "GHCR publication must depend on all CI jobs");
  assert(contract.ciPublishesImmutableRevision, "CI must publish only the full-revision image tag");
  assert(
    contract.imageRequiresFullRevision,
    "the production image must reject an invalid revision",
  );
  assert(contract.databaseTlsVerifyFull, "database TLS must remain direct verify-full");
  assert(
    contract.applicationRoleSeparated,
    "application and migration/recovery roles must be separate",
  );
  assert(contract.applicationPoolSettingsLocked, "database pool safety settings drifted");
  assert(
    contract.loadEmployees === 20 &&
      contract.loadStreams === 40 &&
      contract.loadResponseStartMilliseconds === 500,
    "managed workload or response-start objective was relaxed",
  );
}

function runArtifactVerification() {
  const result = spawnSync("bash", [path.join(deploymentDirectory, "verify-artifacts.sh")], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(
      result.stderr.trim() || result.stdout.trim() || "DigitalOcean artifact verification failed",
    );
  }
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

function latestMigration() {
  const migrations = readdirSync(path.join(repositoryRoot, "apps/api/migrations"))
    .map((file) => /^(\d{4})_.+\.sql$/u.exec(file)?.[1])
    .filter(Boolean)
    .sort();
  const latest = migrations.at(-1);
  assert(latest !== undefined, "at least one database migration must exist");
  return latest;
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
  assert(evidence.schemaVersion === 2, "recovery evidence schemaVersion must equal 2");
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
      "databaseIpRestricted",
      "externalProvidersContacted",
      "rolesSeparated",
      "sourceUntouched",
      "verifyFullTls",
    ],
    "PlanetScale recovery isolation",
  );
  assert(
    evidence.isolation.databaseIpRestricted === true,
    "recovery database must be IP-restricted",
  );
  assert(
    evidence.isolation.externalProvidersContacted === false,
    "validation must not contact app providers",
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
      "evidenceAccepted",
      "ipRuleRemoved",
      "recoveryBranchRemoved",
      "temporaryRoleRemoved",
      "validationApplicationRemoved",
    ],
    "PlanetScale recovery cleanup",
  );
  for (const value of Object.values(evidence.cleanup)) {
    assert(value === true, "every PlanetScale recovery cleanup gate must pass");
  }
}

function validateColdRebuildEvidence(evidence) {
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
    "DigitalOcean cold-rebuild evidence",
  );
  validateOperatorAndStatus(evidence);
  validateReleaseAndMigration(evidence);
  assertExactKeys(
    evidence.topology,
    ["cpu", "ramMiB", "region", "volumeGiB"],
    "DigitalOcean cold-rebuild topology",
  );
  assert(
    evidence.topology.cpu === 1 &&
      evidence.topology.ramMiB === 1_024 &&
      evidence.topology.region === "ric1" &&
      evidence.topology.volumeGiB === 1,
    "cold-rebuild topology does not match the approved candidate",
  );
  assertExactKeys(evidence.integrity, coldRebuildIntegrityKeys, "cold-rebuild integrity");
  for (const key of coldRebuildIntegrityKeys) {
    assert(evidence.integrity[key] === true, `cold-rebuild integrity check ${key} must pass`);
  }
  assertExactKeys(
    evidence.timing,
    ["incidentAt", "rehearsalStartedAt", "validationCompletedAt"],
    "cold-rebuild timing",
  );
  const startedAt = utcMilliseconds(evidence.timing.rehearsalStartedAt, "rehearsalStartedAt");
  const incidentAt = utcMilliseconds(evidence.timing.incidentAt, "incidentAt");
  const completedAt = utcMilliseconds(
    evidence.timing.validationCompletedAt,
    "validationCompletedAt",
  );
  assert(
    startedAt <= incidentAt && incidentAt <= completedAt,
    "cold-rebuild timing order is invalid",
  );
  assert((completedAt - incidentAt) / 60_000 <= 240, "cold-rebuild RTO exceeds four hours");
  assertExactKeys(
    evidence.cleanup,
    ["dropletRemoved", "evidenceAccepted", "volumeRemoved"],
    "cold-rebuild cleanup",
  );
  for (const value of Object.values(evidence.cleanup)) {
    assert(value === true, "every cold-rebuild cleanup gate must pass");
  }
}

function validateRecoveryEvidence(value) {
  const evidence = assertRecord(value, "recovery evidence");
  if (evidence.kind === "planetscale-pitr-rehearsal") {
    validatePitrEvidence(evidence);
    return;
  }
  if (evidence.kind === "digitalocean-cold-rebuild-rehearsal") {
    validateColdRebuildEvidence(evidence);
    return;
  }
  fail("recovery evidence kind is unexpected");
}

function safePitrExample() {
  return {
    cleanup: {
      evidenceAccepted: true,
      ipRuleRemoved: true,
      recoveryBranchRemoved: true,
      temporaryRoleRemoved: true,
      validationApplicationRemoved: true,
    },
    integrity: Object.fromEntries(pitrIntegrityKeys.map((key) => [key, true])),
    isolation: {
      databaseIpRestricted: true,
      externalProvidersContacted: false,
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
    schemaVersion: 2,
    status: "accepted",
    timing: {
      incidentAt: "2026-08-10T12:15:00.000Z",
      latestRecoveredMarkerAt: "2026-08-10T12:05:00.000Z",
      rehearsalStartedAt: "2026-08-10T12:00:00.000Z",
      selectedRestoreAt: "2026-08-10T12:10:00.000Z",
      validationCompletedAt: "2026-08-10T13:00:00.000Z",
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

function safeColdRebuildExample() {
  return {
    cleanup: { dropletRemoved: true, evidenceAccepted: true, volumeRemoved: true },
    integrity: Object.fromEntries(coldRebuildIntegrityKeys.map((key) => [key, true])),
    kind: "digitalocean-cold-rebuild-rehearsal",
    migration: { expected: latestMigration(), observed: latestMigration() },
    operatorRole: "recovery-operator",
    release: {
      expected: "0123456789abcdef0123456789abcdef01234567",
      observed: "0123456789abcdef0123456789abcdef01234567",
    },
    schemaVersion: 2,
    status: "accepted",
    timing: {
      incidentAt: "2026-08-10T12:05:00.000Z",
      rehearsalStartedAt: "2026-08-10T12:00:00.000Z",
      validationCompletedAt: "2026-08-10T13:00:00.000Z",
    },
    topology: { cpu: 1, ramMiB: 1_024, region: "ric1", volumeGiB: 1 },
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
  const contractMutations = [
    (value) => {
      value.applicationServiceCount = 2;
    },
    (value) => {
      value.publicPorts.push(3_000);
      value.incomingRuleCount += 1;
    },
    (value) => {
      value.sshRestricted = false;
    },
    (value) => {
      value.dnsOnly = false;
    },
    (value) => {
      value.databaseIpRestricted = false;
    },
    (value) => {
      value.caddyAdminUnix = false;
    },
    (value) => {
      value.caddyHeaderStripCount = 3;
    },
    (value) => {
      value.caddyHasNegativeFlush = true;
    },
    (value) => {
      value.caddyHasAccessLog = true;
    },
    (value) => {
      value.caddyTransformsStreams = true;
    },
    (value) => {
      value.caddyPersistsApiConfig = true;
    },
    (value) => {
      value.containerUser = "root";
    },
    (value) => {
      value.caddyUser = "root";
    },
    (value) => {
      value.caddyLeastPrivilege = false;
    },
    (value) => {
      value.fluentBitUser = "root";
    },
    (value) => {
      value.fluentBitSecretLauncher = false;
    },
    (value) => {
      value.freshHostStartOrder = false;
    },
    (value) => {
      value.deploymentDigestOnly = false;
    },
    (value) => {
      value.deploymentAtomicAuthority = false;
    },
    (value) => {
      value.deploymentRequestsAreLifecycleBound = false;
    },
    (value) => {
      value.deploymentDockerCallsAreBounded = false;
    },
    (value) => {
      value.deploymentRunsMigrationBeforeStart = false;
    },
    (value) => {
      value.applicationRunsMigrationsAtStartup = true;
    },
    (value) => {
      value.hostVolumeEncryptedBoundary = false;
    },
    (value) => {
      value.hostSecretDirectoriesExact = false;
    },
    (value) => {
      value.imageOriginExact = false;
    },
    (value) => {
      value.caddyEncryptedState = false;
    },
    (value) => {
      value.credentialPathsSeparated = false;
    },
    (value) => {
      value.productionSecretFileEnforced = false;
    },
    (value) => {
      value.hostCoreDumpsDisabled = false;
    },
    (value) => {
      value.loggingCacheDisabled = false;
    },
    (value) => {
      value.loggingNonBlocking = false;
    },
    (value) => {
      value.fluentBitInput = "tcp";
    },
    (value) => {
      value.fluentBitDiskBuffer = true;
    },
    (value) => {
      value.fluentBitRetryLimit = null;
    },
    (value) => {
      value.fluentBitOutput = "external-plugin";
    },
    (value) => {
      value.databaseTlsVerifyFull = false;
    },
    (value) => {
      value.applicationRoleSeparated = false;
    },
    (value) => {
      value.applicationPoolSettingsLocked = false;
    },
    (value) => {
      value.databaseMaximumStorageGb = 20;
    },
    (value) => {
      value.backupHours = 24;
    },
    (value) => {
      value.recoveryRetentionHours = 48;
    },
    (value) => {
      value.loadEmployees = 10;
      value.loadStreams = 20;
    },
    (value) => {
      value.loadResponseStartMilliseconds = 750;
    },
    (value) => {
      value.previousDigestProtected = false;
    },
    (value) => {
      value.migrationSurvivorCleanup = false;
    },
    (value) => {
      value.ciPublicationNeedsAllGates = false;
    },
    (value) => {
      value.imageRequiresFullRevision = false;
    },
    (value) => {
      value.activeRenderConfigurationAbsent = false;
    },
    (value) => {
      value.activeRenderInstructionsAbsent = false;
    },
  ];
  for (const mutation of contractMutations) {
    expectRejected(mutation, contract, "operations contract", validateOperationsContract);
  }

  const pitr = safePitrExample();
  validateRecoveryEvidence(pitr);
  for (const mutation of [
    (value) => {
      value.isolation.sourceUntouched = false;
    },
    (value) => {
      value.isolation.databaseIpRestricted = false;
    },
    (value) => {
      value.topology.maximumStorageGb = 20;
    },
    (value) => {
      value.timing.latestRecoveredMarkerAt = "2026-08-10T11:59:00.000Z";
    },
    (value) => {
      value.timing.validationCompletedAt = "2026-08-10T16:16:00.000Z";
    },
    (value) => {
      value.notes = "unexpected free-form evidence";
    },
  ]) {
    expectRejected(mutation, pitr, "PlanetScale recovery evidence", validateRecoveryEvidence);
  }

  const cold = safeColdRebuildExample();
  validateRecoveryEvidence(cold);
  for (const mutation of [
    (value) => {
      value.integrity.databaseSourceUntouched = false;
    },
    (value) => {
      value.topology.ramMiB = 512;
    },
    (value) => {
      value.timing.validationCompletedAt = "2026-08-10T16:06:00.000Z";
    },
    (value) => {
      value.cleanup.volumeRemoved = false;
    },
  ]) {
    expectRejected(mutation, cold, "DigitalOcean cold-rebuild evidence", validateRecoveryEvidence);
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
      "DigitalOcean, PlanetScale, runbook, and recovery-evidence validators passed.\n",
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
