import { createApplication } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { DatabasePool } from "../../src/database/pool.js";
import type { EmailSender } from "../../src/identity/email.js";
import type { CostControlMaintenance } from "../../src/model-policy/maintenance.js";
import type { ApplicationTelemetry } from "../../src/observability/telemetry-contract.js";
import { installShutdownHandlers } from "../../src/start.js";

const never = new Promise<never>(() => undefined);
const pool: DatabasePool = {
  end: () => never,
  query: async () => ({ rows: [{ result: 1 }] }),
};
const emailSender: EmailSender = {
  close: async () => undefined,
  kind: "disabled",
  send: async () => undefined,
};
const maintenance: CostControlMaintenance = {
  runOnce: async () => ({ catalogRefresh: null, reconciliation: null }),
  start: () => undefined,
  stop: async () => undefined,
};
const telemetry = {
  shutdown: async () => undefined,
} as unknown as ApplicationTelemetry;

const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
  emailSender,
  maintenance,
  pool,
  telemetry,
});
await application.server.listen({ host: "127.0.0.1", port: 0 });
await application.lifecycle.initialize();
installShutdownHandlers(application);
process.stdout.write("ready\n");
