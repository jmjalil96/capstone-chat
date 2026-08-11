import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { generateRandomString } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { ApiConfig } from "../config.js";
import type { AppDatabase } from "../database/database.js";
import * as databaseSchema from "../database/schema.js";
import type { EmailPurpose, EmailSender } from "../identity/email.js";
import { dispatchIdentityEmail } from "../identity/email.js";
import { normalizeEmail } from "../identity/email-normalization.js";
import { createPasswordResetEmail, createVerificationEmail } from "../identity/email-templates.js";
import { identitySecurity } from "../identity/security.js";
import type { IdentityService } from "../identity/service.js";

const disabledAuthPaths = [
  "/account-info",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/refresh-token",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/sign-in/social",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-password",
] as const;

export interface AuthenticationEvents {
  emailDeliveryFailed(purpose: EmailPurpose, errorName: string): void;
  identityHookFailed(hook: "activation" | "registration-link", errorName: string): void;
}

export function createAuthentication(input: {
  config: Pick<ApiConfig, "authSecret" | "nodeEnv" | "publicOrigin">;
  database: AppDatabase;
  emailSender: EmailSender;
  events: AuthenticationEvents;
  identity: IdentityService;
}) {
  const { config, database, emailSender, events, identity } = input;
  const auth = betterAuth({
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: config.nodeEnv === "production",
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: {
        ipAddressHeaders: ["x-capstone-client-ip"],
      },
      useSecureCookies: config.nodeEnv === "production",
    },
    basePath: "/api/auth",
    baseURL: config.publicOrigin,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: databaseSchema,
    }),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              await identity.linkRegisteredUser(user);
            } catch (error: unknown) {
              events.identityHookFailed(
                "registration-link",
                error instanceof Error ? error.name : "UnknownError",
              );
            }
          },
        },
      },
    },
    disabledPaths: [...disabledAuthPaths],
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ token, user }) => {
        dispatchIdentityEmail(
          emailSender,
          createPasswordResetEmail(user.email, config.publicOrigin, token),
          events.emailDeliveryFailed,
        );
      },
    },
    emailVerification: {
      afterEmailVerification: async (user) => {
        try {
          await identity.activateMembership(user);
        } catch (error: unknown) {
          events.identityHookFailed(
            "activation",
            error instanceof Error ? error.name : "UnknownError",
          );
          throw new APIError("INTERNAL_SERVER_ERROR", {
            code: "MEMBERSHIP_ACTIVATION_FAILED",
            message: "Membership activation failed",
          });
        }
      },
      autoSignInAfterVerification: false,
      sendOnSignIn: false,
      sendOnSignUp: true,
      sendVerificationEmail: async ({ token, user }) => {
        dispatchIdentityEmail(
          emailSender,
          createVerificationEmail(user.email, config.publicOrigin, token),
          events.emailDeliveryFailed,
        );
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === "/sign-up/email" && context.body !== undefined) {
          const body = context.body as { email?: unknown; name?: unknown; password?: unknown };
          const email = typeof body.email === "string" ? body.email : "";
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const password = typeof body.password === "string" ? body.password : "";

          if (name.length === 0) {
            throw new APIError("BAD_REQUEST", {
              code: "NAME_REQUIRED",
              message: "Name is required",
            });
          }
          if (password.length < context.context.password.config.minPasswordLength) {
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_TOO_SHORT",
              message: "Password is too short",
            });
          }
          if (password.length > context.context.password.config.maxPasswordLength) {
            throw new APIError("BAD_REQUEST", {
              code: "PASSWORD_TOO_LONG",
              message: "Password is too long",
            });
          }

          if (!(await identity.findPendingApproval(email))) {
            await context.context.password.hash(password);
            const now = new Date();
            const generatedId = context.context.generateId({ model: "user" });
            return context.json({
              token: null,
              user: {
                createdAt: now,
                email: normalizeEmail(email),
                emailVerified: false,
                id:
                  generatedId === false
                    ? generateRandomString(32, "a-z", "A-Z", "0-9")
                    : generatedId,
                image: null,
                name,
                updatedAt: now,
              },
            });
          }
        }

        if (context.path === "/sign-in/email" && context.body !== undefined) {
          const body = context.body as { email?: unknown; password?: unknown };
          const email = typeof body.email === "string" ? body.email : "";
          const password = typeof body.password === "string" ? body.password : "";

          if (!(await identity.prepareSignIn(email))) {
            await context.context.password.hash(password);
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_EMAIL_OR_PASSWORD",
              message: "Invalid email or password",
            });
          }
        }

        if (context.path === "/change-password" && context.body !== undefined) {
          return {
            context: {
              ...context,
              body: {
                ...context.body,
                revokeOtherSessions: true,
              },
            },
          };
        }

        return undefined;
      }),
    },
    logger: {
      disabled: true,
    },
    rateLimit: {
      customRules: {
        "/change-password": identitySecurity.rateLimit.ordinary,
        "/request-password-reset": identitySecurity.rateLimit.forgotPassword,
        "/reset-password": identitySecurity.rateLimit.resetPassword,
        "/reset-password/*": identitySecurity.rateLimit.resetPassword,
        "/send-verification-email": identitySecurity.rateLimit.verificationResend,
        "/sign-in/email": identitySecurity.rateLimit.signIn,
        "/sign-out": identitySecurity.rateLimit.ordinary,
        "/sign-up/email": identitySecurity.rateLimit.ordinary,
        "/verify-email": identitySecurity.rateLimit.verification,
        "/**": identitySecurity.rateLimit.ordinary,
      },
      enabled: true,
      max: identitySecurity.rateLimit.ordinary.max,
      modelName: "rateLimit",
      storage: "database",
      // Better Auth prunes database rows using its base window, so it must retain the longest
      // custom rule. The catch-all above preserves the selected 60-second ordinary behavior.
      window: identitySecurity.rateLimitPersistenceWindowSeconds,
    },
    secret: config.authSecret,
    session: {
      cookieCache: { enabled: false },
      expiresIn: identitySecurity.sessionExpiresInSeconds,
      freshAge: identitySecurity.freshSessionSeconds,
      updateAge: identitySecurity.sessionUpdateAgeSeconds,
    },
    trustedOrigins: [config.publicOrigin],
  });

  async function revokeUserSessions(userId: string): Promise<void> {
    await database.delete(databaseSchema.session).where(eq(databaseSchema.session.userId, userId));
  }

  return Object.freeze({ auth, revokeUserSessions });
}

export type Authentication = ReturnType<typeof createAuthentication>;
