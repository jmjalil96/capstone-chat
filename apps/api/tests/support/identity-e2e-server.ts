import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type ApiApplication, createApplication } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { migrateDatabase } from "../../src/database/migrate.js";
import { FakeEmailSender } from "../../src/identity/email.js";
import { createInvitationEmail } from "../../src/identity/email-templates.js";

const apiPort = 3011;
const publicOrigin = "http://127.0.0.1:4173";
const administratorEmail = "admin.browser@example.test";

let application: ApiApplication | undefined;
let container: StartedPostgreSqlContainer | undefined;
let stopping: Promise<void> | undefined;

async function stop(): Promise<void> {
  stopping ??= (async () => {
    if (application !== undefined) {
      await application.shutdown();
    }
    if (container !== undefined) {
      await container.stop();
    }
  })();

  return stopping;
}

async function main(): Promise<void> {
  container = await new PostgreSqlContainer("postgres:18.4-alpine")
    .withDatabase("capstone_browser")
    .withUsername("capstone")
    .withPassword("capstone-browser-password")
    .start();
  const databaseUrl = container.getConnectionUri();
  await migrateDatabase(databaseUrl);

  const emailSender = new FakeEmailSender();
  application = createApplication(
    loadConfig({
      BETTER_AUTH_SECRET: "capstone-browser-test-secret-with-more-than-thirty-two-characters",
      DATABASE_URL: databaseUrl,
      EMAIL_DELIVERY: "fake",
      HOST: "127.0.0.1",
      LOG_LEVEL: "silent",
      NODE_ENV: "development",
      PORT: String(apiPort),
      PUBLIC_ORIGIN: publicOrigin,
    }),
    { emailSender },
  );

  await application.identity.bootstrap({
    adminEmail: administratorEmail,
    displayName: "Capstone Ecuador",
    workspaceIdentity: "capstone-ecuador",
  });
  await emailSender.send(
    createInvitationEmail(administratorEmail, new URL("/sign-up", publicOrigin).href),
  );

  await application.server.listen({ host: "127.0.0.1", port: apiPort });
  const readiness = await application.lifecycle.initialize();
  if (readiness.status !== "ready") {
    throw new Error("The browser test API did not become ready");
  }

  await new Promise<void>(() => undefined);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", outcome: "identity-e2e-server-failed" })}\n`,
  );
  await stop().catch(() => undefined);
  process.exitCode = 1;
});
