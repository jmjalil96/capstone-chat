import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { type ApiApplication, createApplication } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { session as authenticationSessions } from "../../src/database/auth-schema.generated.js";
import { generations } from "../../src/database/generation-schema.js";
import { migrateDatabase } from "../../src/database/migrate.js";
import { modelCatalog } from "../../src/database/model-policy-schema.js";
import type { RequestActor } from "../../src/identity/authorization.js";
import { FakeEmailSender } from "../../src/identity/email.js";
import { createInvitationEmail } from "../../src/identity/email-templates.js";
import {
  conversationBrowserAuthentication,
  conversationBrowserEmployee,
  conversationBrowserFixtures,
  phaseFiveBrowserFixtures,
  phaseSevenBrowserFixtures,
  responseGalleryAssistantMarkdown,
} from "./conversation-e2e-fixtures.js";
import { bootstrapSimulatedModelPolicy } from "./model-policy.js";

const apiPort = 3011;
const publicOrigin = "http://127.0.0.1:4173";
const identityBrowserAdministrators = Object.freeze([
  Object.freeze({ email: "admin.chromium.browser@example.test", name: "Administradora Chromium" }),
  Object.freeze({ email: "admin.firefox.browser@example.test", name: "Administradora Firefox" }),
  Object.freeze({ email: "admin.webkit.browser@example.test", name: "Administradora WebKit" }),
]);

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

async function seedTerminalResponse(
  currentApplication: ApiApplication,
  actor: RequestActor,
  conversationId: string,
  assistantMessageId: string,
  outcome:
    | { readonly status: "completed"; readonly reason: "stop" }
    | {
        readonly status: "incomplete";
        readonly reason: "error";
        readonly errorCode: "STREAM_INTERRUPTED";
      },
): Promise<void> {
  const timestamp = new Date();
  await currentApplication.database.insert(generations).values({
    assistantMessageId,
    completedAt: timestamp,
    conversationId,
    createdAt: timestamp,
    effectiveParameters: {},
    errorCode: outcome.status === "incomplete" ? outcome.errorCode : null,
    firstTokenAt: timestamp,
    idempotencyKey: randomUUID(),
    requestedTier: "balanced",
    startedAt: timestamp,
    status: outcome.status,
    systemPromptVersion: "capstone-chat-v1",
    terminalReason: outcome.reason,
    updatedAt: timestamp,
    userId: actor.employee.id,
    workspaceId: actor.workspace.id,
  });
}

async function seedResponseGallery(
  currentApplication: ApiApplication,
  actor: RequestActor,
): Promise<void> {
  const conversation = await currentApplication.conversations.create(actor);
  const renamed = await currentApplication.conversations.rename(
    actor,
    conversation.id,
    phaseFiveBrowserFixtures.galleryTitle,
    conversation.revision,
  );
  const root = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: phaseFiveBrowserFixtures.galleryUser }],
    conversationId: conversation.id,
    parentMessageId: null,
    role: "user",
  });
  const gallery = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: responseGalleryAssistantMarkdown }],
    conversationId: conversation.id,
    parentMessageId: root.id,
    role: "assistant",
  });
  const secondUser = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: phaseFiveBrowserFixtures.gallerySecondUser }],
    conversationId: conversation.id,
    parentMessageId: gallery.id,
    role: "user",
  });
  const partial = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: phaseFiveBrowserFixtures.galleryPartial }],
    conversationId: conversation.id,
    parentMessageId: secondUser.id,
    role: "assistant",
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  const alternative = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: phaseFiveBrowserFixtures.galleryAlternative }],
    conversationId: conversation.id,
    parentMessageId: secondUser.id,
    role: "assistant",
  });
  await currentApplication.conversations.selectLeaf(
    actor,
    conversation.id,
    partial.id,
    renamed.revision,
  );
  await Promise.all([
    seedTerminalResponse(currentApplication, actor, conversation.id, gallery.id, {
      status: "completed",
      reason: "stop",
    }),
    seedTerminalResponse(currentApplication, actor, conversation.id, partial.id, {
      status: "incomplete",
      reason: "error",
      errorCode: "STREAM_INTERRUPTED",
    }),
    seedTerminalResponse(currentApplication, actor, conversation.id, alternative.id, {
      status: "completed",
      reason: "stop",
    }),
  ]);
}

async function seedControlConversation(
  currentApplication: ApiApplication,
  actor: RequestActor,
  title: string,
): Promise<void> {
  const conversation = await currentApplication.conversations.create(actor);
  const renamed = await currentApplication.conversations.rename(
    actor,
    conversation.id,
    title,
    conversation.revision,
  );
  const root = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: phaseFiveBrowserFixtures.controlsOriginalRoot }],
    conversationId: conversation.id,
    parentMessageId: null,
    role: "user",
  });
  const firstAnswer = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: "Primera respuesta preservada." }],
    conversationId: conversation.id,
    parentMessageId: root.id,
    role: "assistant",
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  const secondAnswer = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: "Segunda respuesta preservada." }],
    conversationId: conversation.id,
    parentMessageId: root.id,
    role: "assistant",
  });
  const firstFollowUp = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: "Seguimiento de la primera alternativa." }],
    conversationId: conversation.id,
    parentMessageId: firstAnswer.id,
    role: "user",
  });
  const firstLeaf = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: phaseFiveBrowserFixtures.controlsOriginalBranchText }],
    conversationId: conversation.id,
    parentMessageId: firstFollowUp.id,
    role: "assistant",
  });
  const secondFollowUp = await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: "Seguimiento de la segunda alternativa." }],
    conversationId: conversation.id,
    parentMessageId: secondAnswer.id,
    role: "user",
  });
  await currentApplication.conversations.insertImmutableMessage(actor, {
    content: [{ type: "text", text: phaseFiveBrowserFixtures.controlsNextBranchText }],
    conversationId: conversation.id,
    parentMessageId: secondFollowUp.id,
    role: "assistant",
  });
  await currentApplication.conversations.selectLeaf(
    actor,
    conversation.id,
    firstLeaf.id,
    renamed.revision,
  );
  await currentApplication.conversations.saveDraft(
    actor,
    { conversationId: conversation.id, kind: "conversation" },
    phaseFiveBrowserFixtures.controlsDraft,
    0,
  );
}

async function seedDeepSearchConversation(
  currentApplication: ApiApplication,
  actor: RequestActor,
): Promise<void> {
  const conversation = await currentApplication.conversations.create(actor);
  const renamed = await currentApplication.conversations.rename(
    actor,
    conversation.id,
    phaseFiveBrowserFixtures.searchTitle,
    conversation.revision,
  );
  let parentMessageId: string | null = null;
  let selectedLeafId: string | undefined;
  for (let index = 0; index < 42; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const message = await currentApplication.conversations.insertImmutableMessage(actor, {
      content: [
        {
          type: "text",
          text:
            index === 0
              ? phaseFiveBrowserFixtures.searchRootText
              : `${role === "user" ? "Pregunta" : "Respuesta"} histórica ${index + 1}.`,
        },
      ],
      conversationId: conversation.id,
      parentMessageId,
      role,
    });
    parentMessageId = message.id;
    selectedLeafId = message.id;
  }
  if (selectedLeafId === undefined) {
    throw new Error("The deep-search browser fixture has no selected message");
  }
  await currentApplication.conversations.selectLeaf(
    actor,
    conversation.id,
    selectedLeafId,
    renamed.revision,
  );
}

async function seedCompactionConversation(
  currentApplication: ApiApplication,
  actor: RequestActor,
): Promise<void> {
  const conversation = await currentApplication.conversations.create(actor);
  const renamed = await currentApplication.conversations.rename(
    actor,
    conversation.id,
    phaseSevenBrowserFixtures.compactionTitle,
    conversation.revision,
  );
  let parentMessageId: string | null = null;
  let selectedLeafId: string | undefined;
  for (let index = 0; index < 28; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const inAgedPrefix = index < 12;
    const textBytes = inAgedPrefix ? 13_000 : 200;
    const message = await currentApplication.conversations.insertImmutableMessage(actor, {
      content: [
        {
          type: "text",
          text: `${role === "user" ? "Pregunta" : "Respuesta"} extensa ${index + 1}: ${"x".repeat(textBytes)}`,
        },
      ],
      conversationId: conversation.id,
      parentMessageId,
      role,
    });
    parentMessageId = message.id;
    selectedLeafId = message.id;
  }
  if (selectedLeafId === undefined) {
    throw new Error("The compaction browser fixture has no selected message");
  }
  await currentApplication.conversations.selectLeaf(
    actor,
    conversation.id,
    selectedLeafId,
    renamed.revision,
  );
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
      BETTER_AUTH_SECRET: conversationBrowserAuthentication.secret,
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

  const primaryAdministrator = identityBrowserAdministrators[0];
  if (primaryAdministrator === undefined) {
    throw new Error("The browser identity fixture has no administrator");
  }
  await application.identity.bootstrap({
    adminEmail: primaryAdministrator.email,
    displayName: "Capstone Ecuador",
    workspaceIdentity: "capstone-ecuador",
  });
  for (const administrator of identityBrowserAdministrators.slice(1)) {
    await application.identity.approve({
      email: administrator.email,
      role: "admin",
      workspaceIdentity: "capstone-ecuador",
    });
  }
  await bootstrapSimulatedModelPolicy(application.modelPolicy, "capstone-ecuador", {
    employeeActiveGenerationLimit: 2,
    monthlyBudgetUsd: "100",
  });
  await application.database
    .update(modelCatalog)
    .set({ contextLength: 200_000 })
    .where(eq(modelCatalog.metadataSource, "simulated"));
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
    headers: { "content-type": "application/json", origin: publicOrigin },
    method: "POST",
    payload: {
      token: new URLSearchParams(verificationUrl.hash.slice(1)).get("token"),
    },
    url: "/api/auth/verify-email",
  });
  if (verification.statusCode !== 204) {
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
  const browserSessionTimestamp = new Date();
  const browserSessionId = randomUUID();
  await application.database.insert(authenticationSessions).values({
    createdAt: browserSessionTimestamp,
    expiresAt: new Date(browserSessionTimestamp.getTime() + 7 * 24 * 60 * 60 * 1_000),
    id: browserSessionId,
    token: conversationBrowserAuthentication.sessionToken,
    updatedAt: browserSessionTimestamp,
    userId: employee.id,
  });
  const fixtureActor: RequestActor = {
    employee: {
      email: employee.email,
      id: employee.id,
      name: employee.name,
    },
    role: "member",
    session: {
      createdAt: browserSessionTimestamp,
      expiresAt: new Date(browserSessionTimestamp.getTime() + 7 * 24 * 60 * 60 * 1_000),
      id: browserSessionId,
    },
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

  await seedResponseGallery(application, fixtureActor);
  await seedDeepSearchConversation(application, fixtureActor);
  await seedCompactionConversation(application, fixtureActor);
  for (const title of Object.values(phaseFiveBrowserFixtures.controlsTitles)) {
    await seedControlConversation(application, fixtureActor, title);
  }

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
  for (const administrator of identityBrowserAdministrators) {
    await emailSender.send(
      createInvitationEmail(administrator.email, new URL("/sign-up", publicOrigin).href),
    );
  }

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
