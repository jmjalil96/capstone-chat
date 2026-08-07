import { createAuthentication } from "../auth/authentication.js";
import { loadConfig } from "../config.js";
import { createDatabase } from "../database/database.js";
import { createDatabasePool } from "../database/pool.js";
import { createEmailSender } from "../identity/email.js";
import { createInvitationEmail } from "../identity/email-templates.js";
import {
  createIdentityService,
  IdentityConflictError,
  type WorkspaceRole,
} from "../identity/service.js";

type Command = "approve" | "bootstrap" | "deactivate";

function parseArguments(values: readonly string[]): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();

  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      key === undefined ||
      !key.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("Arguments must use --name value pairs");
    }
    if (parsed.has(key)) {
      throw new Error(`Argument ${key} may be provided only once`);
    }
    parsed.set(key, value);
  }

  return parsed;
}

function required(argumentsMap: ReadonlyMap<string, string>, name: string): string {
  const value = argumentsMap.get(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function workspaceIdentity(argumentsMap: ReadonlyMap<string, string>): string {
  const identity = required(argumentsMap, "--workspace");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(identity)) {
    throw new Error(
      "--workspace must be a lowercase identifier using letters, numbers, and hyphens",
    );
  }
  return identity;
}

function role(argumentsMap: ReadonlyMap<string, string>): WorkspaceRole {
  const value = required(argumentsMap, "--role");
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

  const argumentsMap = parseArguments(process.argv.slice(3));
  const config = loadConfig();
  const pool = createDatabasePool(config.databaseUrl);
  const database = createDatabase(pool);
  const identity = createIdentityService(database);
  const emailSender = createEmailSender(config.emailDelivery);

  try {
    if (command === "bootstrap") {
      const result = await identity.bootstrap({
        adminEmail: required(argumentsMap, "--email"),
        displayName: required(argumentsMap, "--name"),
        workspaceIdentity: workspaceIdentity(argumentsMap),
      });

      try {
        await sendInvitation(emailSender, config.publicOrigin, result.normalizedEmail);
      } catch (error: unknown) {
        process.stderr.write(
          `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", outcome: "approval-committed", retrySafe: true })}\n`,
        );
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
        email: required(argumentsMap, "--email"),
        role: role(argumentsMap),
        workspaceIdentity: workspaceIdentity(argumentsMap),
      });

      try {
        await sendInvitation(emailSender, config.publicOrigin, result.normalizedEmail);
      } catch (error: unknown) {
        process.stderr.write(
          `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", outcome: "approval-committed", retrySafe: true })}\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `${JSON.stringify({ command, repeated: result.repeated, role: result.role, signUpPath: "/sign-up", workspace: workspaceIdentity(argumentsMap) })}\n`,
      );
      return;
    }

    const result = await identity.deactivate({
      email: required(argumentsMap, "--email"),
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

      try {
        await authentication.revokeUserSessions(result.userId);
      } catch (error: unknown) {
        process.stderr.write(
          `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", outcome: "access-blocked-cleanup-incomplete", retrySafe: true })}\n`,
        );
        process.exitCode = 1;
        return;
      }
    }

    process.stdout.write(
      `${JSON.stringify({ alreadyRevoked: result.alreadyRevoked, command, outcome: "access-blocked", workspace: workspaceIdentity(argumentsMap) })}\n`,
    );
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  const conflict = error instanceof IdentityConflictError;
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", outcome: conflict ? "conflict" : "failed" })}\n`,
  );
  process.exitCode = 1;
});
