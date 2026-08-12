import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expression = (value) => ["$", `{{ ${value} }}`].join("");

function workflow(relativePath) {
  const document = parseDocument(readFileSync(path.join(repositoryRoot, relativePath), "utf8"), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  assert.equal(document.errors.length, 0, `${relativePath} must be valid YAML`);
  return document.toJS();
}

const deploy = workflow(".github/workflows/deploy-production.yml");
const configure = workflow(".github/workflows/configure-production.yml");
const retention = workflow(".github/workflows/ghcr-retention.yml");
const ci = workflow(".github/workflows/ci.yml");

for (const [name, value] of [
  ["deploy", deploy],
  ["configure", configure],
  ["retention", retention],
]) {
  assert.deepEqual(value.concurrency, {
    "cancel-in-progress": false,
    group: "capstone-chat-production-app-spec",
  });
  assert.deepEqual(Object.keys(value.on), ["workflow_dispatch"]);
  assert.equal(value.jobs[Object.keys(value.jobs)[0]].environment, "production");
  assert.equal(
    value.jobs[Object.keys(value.jobs)[0]].if,
    expression("github.ref == 'refs/heads/main'"),
  );
  const commands = value.jobs[Object.keys(value.jobs)[0]].steps
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n");
  assert.match(commands, /git rev-parse HEAD/u, `${name} must bind checked-out tooling`);
  assert.match(JSON.stringify(value), /CAPSTONE_TOOL_REVISION/u);
  assert.doesNotMatch(
    JSON.stringify(value),
    /\/v2\/apps\/.+\/rollback/u,
    `${name} must not use native rollback`,
  );
}

assert.deepEqual(deploy.permissions, {
  actions: "read",
  contents: "read",
  deployments: "write",
  packages: "read",
});
assert.equal(deploy.jobs.release.env.DIGITALOCEAN_APP_ID, expression("vars.DIGITALOCEAN_APP_ID"));
assert.equal(
  deploy.jobs.release.steps.at(-1).env.DIGITALOCEAN_TOKEN,
  expression("secrets.DIGITALOCEAN_DEPLOY_TOKEN"),
);
assert.equal(deploy.jobs.release.env.DIGITALOCEAN_TOKEN, undefined);
const deployCommands = deploy.jobs.release.steps
  .map((step) => (typeof step.run === "string" ? step.run : ""))
  .join("\n");
for (const required of [
  "docker buildx imagetools inspect",
  "org.opencontainers.image.revision",
  "deploy/app-platform/deploy.mjs deploy",
  "deploy/app-platform/deploy.mjs reconcile",
  "deploy/app-platform/rollback.mjs",
]) {
  assert.match(deployCommands, new RegExp(required.replaceAll("/", "\\/"), "u"));
}
assert.doesNotMatch(deployCommands, /latest|doctl apps rollback|force_build: true/u);

const publication = ci.jobs["publish-image"];
assert.deepEqual(publication.concurrency, {
  "cancel-in-progress": false,
  group: `capstone-chat-image-${expression("github.sha")}`,
});
const publicationCommands = publication.steps
  .map((step) => (typeof step.run === "string" ? step.run : ""))
  .join("\n");
for (const required of [
  "candidate_id=",
  "existing_digest=",
  "existing_id=",
  "manifest unknown|not found",
  "outcome=reused",
  "outcome=published",
  "confirmed_digest=",
  'test "$confirmed_digest" = "$digest"',
]) {
  assert.ok(publicationCommands.includes(required), `publication must include ${required}`);
}
assert.ok(
  publicationCommands.indexOf("if existing_manifest=") <
    publicationCommands.indexOf('push_output="$(docker push "$image")"'),
);
assert.ok(
  publicationCommands.indexOf('test "$existing_id" = "$candidate_id"') <
    publicationCommands.indexOf("outcome=reused"),
);

assert.deepEqual(configure.permissions, {
  contents: "read",
  deployments: "read",
});
assert.equal(
  configure.jobs.configure.env.DIGITALOCEAN_APP_ID,
  expression("vars.DIGITALOCEAN_APP_ID"),
);
assert.equal(configure.jobs.configure.env.DIGITALOCEAN_TOKEN, undefined);
assert.equal(
  configure.jobs.configure.env.CAPSTONE_CONFIGURATION_BASE_DEPLOYMENT_ID,
  expression("inputs.base_deployment_id"),
);
const configureCommands = configure.jobs.configure.steps
  .map((step) => (typeof step.run === "string" ? step.run : ""))
  .join("\n");
for (const required of ["configure.mjs", "CAPSTONE_CONFIGURATION_BASE_DEPLOYMENT_ID"]) {
  assert.match(configureCommands, new RegExp(required.replaceAll("/", "\\/"), "u"));
}
assert.doesNotMatch(JSON.stringify(configure), /rotate-|ROTATION|APP_PLATFORM_RUNTIME_SECRET/u);
assert.equal(
  configure.jobs.configure.steps.find(
    (step) => step.name === "Apply maintenance or domain transition",
  ).env.DIGITALOCEAN_TOKEN,
  expression("secrets.DIGITALOCEAN_DEPLOY_TOKEN"),
);

assert.deepEqual(retention.permissions, {
  actions: "read",
  contents: "read",
  deployments: "read",
});
assert.equal(
  retention.jobs.retention.steps.find((step) => step.name === "Prepare protected inputs").env
    .GHCR_RETENTION_TOKEN,
  expression("secrets.GHCR_RETENTION_TOKEN"),
);
assert.notEqual(
  retention.jobs.retention.steps.find((step) => step.name === "Prepare protected inputs").env
    .GHCR_RETENTION_TOKEN,
  retention.jobs.retention.steps.find((step) => step.name === "Prepare protected inputs").env
    .DIGITALOCEAN_TOKEN,
);
assert.equal(retention.jobs.retention.env.GHCR_RETENTION_TOKEN, undefined);
const retentionCommands = retention.jobs.retention.steps
  .map((step) => (typeof step.run === "string" ? step.run : ""))
  .join("\n");
for (const required of [
  "gh run download",
  "--plan-hash",
  "deploy/app-platform/ghcr-retention.py",
  "chmod 0600",
  "--tool-revision",
]) {
  assert.match(retentionCommands, new RegExp(required.replaceAll("/", "\\/"), "u"));
}

process.stdout.write("App Platform workflow fixtures passed.\n");
