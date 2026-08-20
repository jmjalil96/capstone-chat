import { loadEntrypoint } from "./entrypoint-loader.js";
import { loadEnvironmentFile } from "./environment.js";

const targets = Object.freeze({
  "health-bootstrap": () => import("./health-bootstrap.js"),
  initialize: () => import("./operator/production-initialization-command.js"),
  "invite-initial": () => import("./operator/initial-invitation-command.js"),
  identity: () => import("./operator/identity-command.js"),
  migrate: () => import("./database/migrate-command.js"),
  model: () => import("./operator/model-policy-command.js"),
  "recovery-marker": () => import("./operator/recovery-marker-command.js"),
  "recovery-prepare": () => import("./operator/recovery-preparation-command.js"),
  server: () => import("./server.js"),
});

const targetName = process.argv[2];
if (targetName === undefined || !Object.hasOwn(targets, targetName)) {
  throw new Error("A supported Capstone API entrypoint is required");
}
process.argv.splice(2, 1);
await loadEntrypoint(loadEnvironmentFile, targets[targetName as keyof typeof targets]);
