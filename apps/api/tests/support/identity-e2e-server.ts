import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type ApiApplication, createApplication } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { migrateDatabase } from "../../src/database/migrate.js";
import type { RequestActor } from "../../src/identity/authorization.js";
import { FakeEmailSender } from "../../src/identity/email.js";
import { createInvitationEmail } from "../../src/identity/email-templates.js";
import {
  conversationBrowserEmployee,
  conversationBrowserFixtures,
} from "./conversation-e2e-fixtures.js";

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
  const approval = await application.identity.approve({
    email: conversationBrowserEmployee.email,
    role: "member",
    workspaceIdentity: "capstone-ecuador",
  });
  const signUp = await application.server.inject({
    headers: { "content-type": "application/json", origin: publicOrigin },
    method: "POST",
    payload: {
      callbackURL: "/verify-email",
      email: conversationBrowserEmployee.email,
      name: conversationBrowserEmployee.name,
      password: conversationBrowserEmployee.password,
    },
    url: "/api/auth/sign-up/email",
  });
  if (signUp.statusCode !== 200) {
    throw new Error("The browser conversation employee could not register");
  }
  const verificationDelivery = emailSender
    .deliveries()
    .findLast(
      (delivery) =>
        delivery.purpose === "verification" && delivery.to === conversationBrowserEmployee.email,
    );
  const verificationLink = verificationDelivery?.text
    .split("\n")
    .find((line) => line.startsWith("http"));
  if (verificationLink === undefined) {
    throw new Error("The browser conversation employee received no verification link");
  }
  const verificationUrl = new URL(verificationLink);
  const verification = await application.server.inject({
    method: "GET",
    url: `${verificationUrl.pathname}${verificationUrl.search}`,
  });
  if (verification.statusCode !== 302) {
    throw new Error("The browser conversation employee could not verify");
  }
  const employeeRows = await application.database.query.user.findMany({
    limit: 2,
    where: (fields, operators) => operators.eq(fields.email, conversationBrowserEmployee.email),
  });
  const employee = employeeRows[0];
  if (employee === undefined || employeeRows.length !== 1) {
    throw new Error("The browser conversation employee is missing or ambiguous");
  }
  const fixtureActor: RequestActor = {
    employee: {
      email: employee.email,
      id: employee.id,
      name: employee.name,
    },
    role: "member",
    session: { createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    workspace: {
      id: approval.workspaceId,
      identity: "capstone-ecuador",
      name: "Capstone Ecuador",
    },
  };
  const active = await application.conversations.create(fixtureActor);
  const activeRenamed = await application.conversations.rename(
    fixtureActor,
    active.id,
    conversationBrowserFixtures.activeTitle,
    active.revision,
  );
  const root = await application.conversations.insertImmutableMessage(fixtureActor, {
    content: [{ type: "text", text: "Estado del proyecto Faro." }],
    conversationId: active.id,
    parentMessageId: null,
    role: "user",
  });
  const selected = await application.conversations.insertImmutableMessage(fixtureActor, {
    content: [{ type: "text", text: conversationBrowserFixtures.selectedText }],
    conversationId: active.id,
    parentMessageId: root.id,
    role: "assistant",
  });
  await application.conversations.insertImmutableMessage(fixtureActor, {
    content: [{ type: "text", text: conversationBrowserFixtures.alternativeText }],
    conversationId: active.id,
    parentMessageId: root.id,
    role: "assistant",
  });
  await application.conversations.selectLeaf(
    fixtureActor,
    active.id,
    selected.id,
    activeRenamed.revision,
  );
  await application.conversations.saveDraft(
    fixtureActor,
    { conversationId: active.id, kind: "conversation" },
    conversationBrowserFixtures.conversationDraft,
    0,
  );

  const archived = await application.conversations.create(fixtureActor);
  const archivedRenamed = await application.conversations.rename(
    fixtureActor,
    archived.id,
    conversationBrowserFixtures.archivedTitle,
    archived.revision,
  );
  const archivedMessage = await application.conversations.insertImmutableMessage(fixtureActor, {
    content: [{ type: "text", text: conversationBrowserFixtures.archivedText }],
    conversationId: archived.id,
    parentMessageId: null,
    role: "user",
  });
  const archivedSelected = await application.conversations.selectLeaf(
    fixtureActor,
    archived.id,
    archivedMessage.id,
    archivedRenamed.revision,
  );
  await application.conversations.setArchived(
    fixtureActor,
    archived.id,
    true,
    archivedSelected.conversation.revision,
  );
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
