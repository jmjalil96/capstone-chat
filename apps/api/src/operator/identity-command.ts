import { createAuthentication } from "../auth/authentication.js";
import { loadConfig } from "../config.js";
import { createCursorCodec } from "../conversations/cursor.js";
import { createDatabase } from "../database/database.js";
import { createDatabasePool } from "../database/pool.js";
import { createGenerationAdministrationService } from "../generations/administration.js";
import {
  createEmployeeAdministrationService,
  EmployeeAdministrationConflictError,
  EmployeeAdministrationNotFoundError,
} from "../identity/administration.js";
import { createEmailSender } from "../identity/email.js";
import { createInvitationEmail } from "../identity/email-templates.js";
import { ResendEmailError } from "../identity/resend-email.js";
import {
  createIdentityService,
  IdentityConflictError,
  type WorkspaceRole,
} from "../identity/service.js";
import { createBudgetService } from "../model-policy/budget-service.js";
import { parseOperatorArguments, requiredOperatorArgument } from "./arguments.js";

type Command = "approve" | "bootstrap" | "deactivate";

function deliveryFailureMetadata(error: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({
    errorName: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof ResendEmailError
      ? {
          category: error.category,
          durationMs: error.durationMs,
          ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
        }
      : {}),
    outcome: "approval-committed",
    retrySafe: true,
  });
}

function workspaceIdentity(argumentsMap: ReadonlyMap<string, string>): string {
  const identity = requiredOperatorArgument(argumentsMap, "--workspace");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(identity)) {
    throw new Error(
      "--workspace must be a lowercase identifier using letters, numbers, and hyphens",
    );
  }
  return identity;
}

function role(argumentsMap: ReadonlyMap<string, string>): WorkspaceRole {
  const value = requiredOperatorArgument(argumentsMap, "--role");
  if (value !== "admin" && value !== "member") {
    throw new Error("--role must be admin or member");
  }
  return value;
}

async function sendInvitation(
  sender: ReturnType<typeof createEmailSender>,
  publicOrigin: string,
  normalizedEmail: string,
): Promise<void> {
  const signUpUrl = new URL("/sign-up", publicOrigin).href;
  await sender.send(createInvitationEmail(normalizedEmail, signUpUrl));
}

async function run(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command !== "approve" && command !== "bootstrap" && command !== "deactivate") {
    throw new Error("Command must be bootstrap, approve, or deactivate");
  }

  const argumentsMap = parseOperatorArguments(process.argv.slice(3));
  const config = loadConfig();
  const pool = createDatabasePool(config.databaseUrl);
  const database = createDatabase(pool);
  const identity = createIdentityService(database);
  const emailSender = createEmailSender(config.emailDelivery, {
    emailFrom: config.emailFrom,
    resendApiKey: config.resendApiKey,
  });

  try {
    if (command === "bootstrap") {
      const result = await identity.bootstrap({
        adminEmail: requiredOperatorArgument(argumentsMap, "--email"),
        displayName: requiredOperatorArgument(argumentsMap, "--name"),
        workspaceIdentity: workspaceIdentity(argumentsMap),
      });

      try {
        await sendInvitation(emailSender, config.publicOrigin, result.normalizedEmail);
      } catch (error: unknown) {
        process.stderr.write(`${JSON.stringify(deliveryFailureMetadata(error))}\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `${JSON.stringify({ command, repeated: result.repeated, role: result.role, signUpPath: "/sign-up", workspace: result.workspaceIdentity })}\n`,
      );
      return;
    }

    if (command === "approve") {
      const result = await identity.approve({
        email: requiredOperatorArgument(argumentsMap, "--email"),
        role: role(argumentsMap),
        workspaceIdentity: workspaceIdentity(argumentsMap),
      });

      try {
        await sendInvitation(emailSender, config.publicOrigin, result.normalizedEmail);
      } catch (error: unknown) {
        process.stderr.write(`${JSON.stringify(deliveryFailureMetadata(error))}\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `${JSON.stringify({ command, repeated: result.repeated, role: result.role, signUpPath: "/sign-up", workspace: workspaceIdentity(argumentsMap) })}\n`,
      );
      return;
    }

    const result = await createEmployeeAdministrationService(
      database,
      createCursorCodec(config.authSecret),
    ).deactivateByIdentity({
      email: requiredOperatorArgument(argumentsMap, "--email"),
      workspaceIdentity: workspaceIdentity(argumentsMap),
    });

    if (result.userId !== null) {
      const authentication = createAuthentication({
        config,
        database,
        emailSender,
        events: {
          emailDeliveryFailed() {},
          identityHookFailed() {},
        },
        identity,
      });

      const [generationCleanup, sessionCleanup] = await Promise.allSettled([
        createGenerationAdministrationService(
          database,
          createBudgetService(database),
        ).cancelEmployeeWork(result.workspaceId, result.userId),
        authentication.revokeUserSessions(result.userId),
      ]);
      if (generationCleanup.status === "rejected" || sessionCleanup.status === "rejected") {
        const errorName =
          generationCleanup.status === "rejected"
            ? generationCleanup.reason instanceof Error
              ? generationCleanup.reason.name
              : "UnknownError"
            : sessionCleanup.status === "rejected" && sessionCleanup.reason instanceof Error
              ? sessionCleanup.reason.name
              : "UnknownError";
        process.stderr.write(
          `${JSON.stringify({ errorName, outcome: "access-blocked-cleanup-incomplete", retrySafe: true })}\n`,
        );
        process.exitCode = 1;
        return;
      }
    }

    process.stdout.write(
      `${JSON.stringify({ alreadyRevoked: result.repeated, command, outcome: "access-blocked", workspace: workspaceIdentity(argumentsMap) })}\n`,
    );
  } finally {
    try {
      await emailSender.close();
    } finally {
      await pool.end();
    }
  }
}

run().catch((error: unknown) => {
  const conflict =
    error instanceof IdentityConflictError ||
    error instanceof EmployeeAdministrationConflictError ||
    error instanceof EmployeeAdministrationNotFoundError;
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", outcome: conflict ? "conflict" : "failed" })}\n`,
  );
  process.exitCode = 1;
});
