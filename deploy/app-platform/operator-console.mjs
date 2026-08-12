import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { DIGEST_PATTERN, REVISION_PATTERN, readContract, validateLiveApp } from "./contract.mjs";
import { createGitHubClient } from "./github-api.mjs";
import { createDigitalOceanClient } from "./provider-api.mjs";
import { imageDigestFromSpec, waitForPublicReadiness } from "./release.mjs";

const repositoryDirectory = fileURLToPath(new URL(".", import.meta.url));
const MAXIMUM_DOCUMENT_BYTES = 32 * 1024;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function required(environment, key) {
  const value = environment[key];
  assert(typeof value === "string" && value.length > 0, `${key} is required`);
  return value;
}

export async function readOperatorDocument(input = process.stdin) {
  const chunks = [];
  let size = 0;
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(String(raw));
      size += chunk.length;
      if (size > MAXIMUM_DOCUMENT_BYTES) {
        chunk.fill(0);
        fail("Operator document exceeds 32 KiB");
      }
      chunks.push(chunk);
    }
    assert(size > 0, "Operator document is required on standard input");
    const document = Buffer.concat(chunks, size);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(document);
    } catch {
      document.fill(0);
      fail("Operator document is not UTF-8");
    }
    return document;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function remoteCommand(operation, workspaceIdentity) {
  if (operation === "invite-initial") {
    return "node apps/api/dist/entrypoint.js invite-initial";
  }
  assert(operation === "privacy-attest", "Console operation is not approved");
  assert(
    typeof workspaceIdentity === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(workspaceIdentity),
    "Workspace identity is invalid",
  );
  return `node apps/api/dist/entrypoint.js model attest --workspace ${workspaceIdentity} --privacy-attestation -`;
}

const databaseAuthorityProbe = [
  'import pg from "pg";',
  "const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1});",
  "try {",
  "  const result = await pool.query(`",
  "    SELECT",
  "      NOT role.rolsuper",
  "        AND NOT role.rolcreatedb",
  "        AND NOT role.rolcreaterole",
  "        AND NOT role.rolreplication",
  "        AND NOT role.rolbypassrls",
  "        AND NOT has_database_privilege(current_user, current_database(), 'CREATE')",
  "        AND NOT has_schema_privilege(current_user, 'public', 'CREATE') AS \"leastPrivilege\",",
  "      (",
  "        SELECT count(*) = 1",
  "        FROM public.production_initialization",
  "        WHERE singleton_id = 1",
  "          AND schema_version = 1",
  "          AND phase = 'complete'",
  "          AND completed_at IS NOT NULL",
  '      ) AS "initialized"',
  "    FROM pg_roles AS role",
  "    WHERE role.rolname = current_user",
  "  `);",
  "  if (result.rows.length !== 1 || result.rows[0].leastPrivilege !== true || result.rows[0].initialized !== true) {",
  '    throw new Error("Application database authority is incomplete");',
  "  }",
  "} finally {",
  "  await pool.end();",
  "}",
].join("\n");

export function buildConsoleInput({ document, operation, revision, workspaceIdentity }) {
  assert(Buffer.isBuffer(document) && document.length > 0, "Operator document is invalid");
  assert(document.length <= MAXIMUM_DOCUMENT_BYTES, "Operator document exceeds 32 KiB");
  assert(REVISION_PATTERN.test(revision), "Console revision is invalid");
  const command = remoteCommand(operation, workspaceIdentity);
  const probe = Buffer.from(databaseAuthorityProbe, "utf8").toString("base64");
  const encodedDocument = document
    .toString("base64")
    .match(/.{1,512}/gu)
    ?.join("\n");
  assert(encodedDocument !== undefined, "Operator document encoding failed");
  return Buffer.from(
    [
      "set +x",
      "set -eu",
      "unset HISTFILE",
      'test "$(id -u)" = 1000',
      `test "$DEPLOYMENT_REVISION" = ${revision}`,
      `printf '%s' '${probe}' | base64 -d | node --input-type=module`,
      "printf '\\nCAPSTONE_OPERATOR_OUTPUT_BEGIN\\n'",
      `base64 -d <<'CAPSTONE_OPERATOR_DOCUMENT' | ${command}`,
      encodedDocument,
      "CAPSTONE_OPERATOR_DOCUMENT",
      "printf 'CAPSTONE_OPERATOR_EXIT:0\\n'",
      "exit",
      "",
    ].join("\n"),
    "utf8",
  );
}

function outputData(message) {
  assert(
    typeof message === "string" && Buffer.byteLength(message, "utf8") <= 64 * 1024,
    "DigitalOcean console output is invalid",
  );
  const parsed = JSON.parse(message);
  assert(
    parsed !== null && typeof parsed === "object" && typeof parsed.data === "string",
    "DigitalOcean console output is invalid",
  );
  return parsed.data;
}

export async function runExecSession({
  input,
  url,
  webSocketFactory = (value) => new WebSocket(value),
}) {
  assert(Buffer.isBuffer(input) && input.length > 0, "DigitalOcean console input is invalid");
  let socket;
  let output = "";
  let privateInputSent = false;
  let settled = false;
  let deadline;
  const cleanup = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    input.fill(0);
  };
  try {
    socket = webSocketFactory(url);
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error !== undefined) socket.close(1000, "failed");
        if (error === undefined) resolve();
        else reject(error);
      };
      deadline = setTimeout(() => {
        socket.close(1000, "timeout");
        finish(new Error("DigitalOcean console operation timed out"));
      }, 60_000);
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            data: "stty -echo && PS1='' && PS2='' && unset PROMPT_COMMAND && printf 'CAPSTONE_CONSOLE_READY\\n'\n",
            op: "stdin",
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        try {
          output += outputData(String(event.data));
          assert(
            Buffer.byteLength(output, "utf8") <= 64 * 1024,
            "DigitalOcean console output exceeded its bound",
          );
          if (!privateInputSent && output.includes("CAPSTONE_CONSOLE_READY\r\n")) {
            privateInputSent = true;
            output = "";
            socket.send(JSON.stringify({ data: input.toString("utf8"), op: "stdin" }));
            input.fill(0);
          }
        } catch {
          finish(new Error("DigitalOcean console output is invalid"));
        }
      });
      socket.addEventListener("error", () =>
        finish(new Error("DigitalOcean console connection failed")),
      );
      socket.addEventListener("close", (event) => {
        if (!privateInputSent) {
          finish(new Error("DigitalOcean console echo-disable handshake failed"));
          return;
        }
        if (event.code !== 1000) {
          finish(new Error("DigitalOcean console connection closed unexpectedly"));
          return;
        }
        finish();
      });
    });
  } finally {
    cleanup();
  }
  const start = output.indexOf("CAPSTONE_OPERATOR_OUTPUT_BEGIN\r\n");
  const end = output.indexOf("CAPSTONE_OPERATOR_EXIT:0\r\n", start + 1);
  assert(start >= 0 && end > start, "DigitalOcean console result is invalid");
  const resultText = output.slice(start + "CAPSTONE_OPERATOR_OUTPUT_BEGIN\r\n".length, end).trim();
  assert(
    resultText.length > 0 && !resultText.includes("\n"),
    "DigitalOcean console result is invalid",
  );
  const result = JSON.parse(resultText);
  assert(
    result !== null &&
      typeof result === "object" &&
      ["invite-initial", "attest"].includes(result.command) &&
      Object.keys(result).every((key) =>
        ["command", "outcome", "repeated", "retrySafe", "workspace"].includes(key),
      ),
    "DigitalOcean console result is not content-free",
  );
  return result;
}

function assertExactResultKeys(result, keys) {
  assert(
    Object.keys(result).toSorted().join("\n") === [...keys].toSorted().join("\n"),
    "DigitalOcean console result schema changed",
  );
}

export function validateConsoleResult(operation, result, workspaceIdentity) {
  assert(
    result !== null && typeof result === "object" && !Array.isArray(result),
    "DigitalOcean console result is invalid",
  );
  if (operation === "invite-initial") {
    assertExactResultKeys(result, ["command", "outcome", "retrySafe"]);
    assert(
      result.command === "invite-initial" && result.outcome === "sent" && result.retrySafe === true,
      "Initial invitation console result is invalid",
    );
    return;
  }
  assert(operation === "privacy-attest", "Console operation is not approved");
  assertExactResultKeys(result, ["command", "repeated", "workspace"]);
  assert(
    result.command === "attest" &&
      typeof result.repeated === "boolean" &&
      result.workspace === workspaceIdentity,
    "Privacy attestation console result is invalid",
  );
}

export async function runOperatorConsole(
  operation,
  {
    digitalOceanClient,
    document,
    environment = process.env,
    fetchImplementation = fetch,
    githubClient,
    readiness,
    webSocketFactory,
  } = {},
) {
  const appId = required(environment, "DIGITALOCEAN_APP_ID");
  const token = required(environment, "DIGITALOCEAN_CONSOLE_TOKEN");
  const githubToken = required(environment, "GITHUB_TOKEN");
  const repository = required(environment, "GITHUB_REPOSITORY").toLowerCase();
  assert(repository === "jmjalil96/capstone-chat", "Console repository changed");
  const toolRevision = required(environment, "CAPSTONE_TOOL_REVISION");
  assert(REVISION_PATTERN.test(toolRevision), "CAPSTONE_TOOL_REVISION is invalid");
  const digitalOcean =
    digitalOceanClient ?? createDigitalOceanClient({ fetchImplementation, token });
  const github =
    githubClient ?? createGitHubClient({ fetchImplementation, repository, token: githubToken });
  assert(
    (await github.getMainHead()) === toolRevision,
    "Running console tooling is not protected main HEAD",
  );
  const releases = await github.listAcceptedReleases();
  const release = releases[0];
  assert(release !== undefined, "No accepted release authority exists");
  assert(release.digitalOceanAppId === appId, "Accepted release targets a different App");
  assert(DIGEST_PATTERN.test(release.digest), "Accepted release digest is invalid");
  assert(REVISION_PATTERN.test(release.revision), "Accepted release revision is invalid");
  const app = await digitalOcean.getApp(appId);
  const activeDeploymentId = app.active_deployment?.id;
  assert(
    typeof activeDeploymentId === "string" && activeDeploymentId.length >= 8,
    "Console App has no active deployment",
  );
  const contract = readContract(`${repositoryDirectory}app.contract.yaml`, "live");
  validateLiveApp({ app, appId, contract, digest: release.digest });
  assert(
    imageDigestFromSpec(app.spec, repository) === release.digest,
    "Console image digest changed",
  );

  const health = await digitalOcean.getHealth(appId);
  const components = health.components ?? [];
  assert(components.length === 1, "DigitalOcean health topology changed");
  assert(
    components[0]?.name === "capstone-chat" &&
      components[0]?.state === "HEALTHY" &&
      components[0]?.replicas_desired === 1 &&
      components[0]?.replicas_ready === 1,
    "The service instance is not exactly ready",
  );
  const instances = (await digitalOcean.listInstances(appId)).filter(
    (instance) =>
      instance?.component_name === "capstone-chat" && instance?.component_type === "SERVICE",
  );
  assert(instances.length === 1, "Console requires exactly one service instance");
  const instanceName = instances[0].instance_name;
  assert(
    typeof instanceName === "string" && /^[a-z0-9-]{8,128}$/u.test(instanceName),
    "DigitalOcean service instance name is invalid",
  );
  const verifyReadiness =
    readiness ?? ((revision) => waitForPublicReadiness(revision, { fetchImplementation }));
  await verifyReadiness(release.revision);

  const immediate = await digitalOcean.getApp(appId);
  assert(
    immediate.active_deployment?.id === activeDeploymentId &&
      imageDigestFromSpec(immediate.spec, repository) === release.digest,
    "Console authority changed before execution",
  );
  assert(
    (await github.getMainHead()) === toolRevision,
    "Running console tooling is not protected main HEAD",
  );
  const execUrl = await digitalOcean.getExecUrl(
    appId,
    activeDeploymentId,
    "capstone-chat",
    instanceName,
  );
  const result = await runExecSession({
    input: buildConsoleInput({
      document,
      operation,
      revision: release.revision,
      workspaceIdentity: environment.CAPSTONE_WORKSPACE_IDENTITY,
    }),
    url: execUrl,
    webSocketFactory,
  });
  validateConsoleResult(operation, result, environment.CAPSTONE_WORKSPACE_IDENTITY);
  return {
    appId,
    deploymentId: activeDeploymentId,
    digest: release.digest,
    instanceName,
    operation,
    outcome: result.outcome ?? (result.repeated === true ? "repeated" : "completed"),
    revision: release.revision,
    schema: 1,
  };
}
