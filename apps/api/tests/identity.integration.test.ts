import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiApplication, createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  rateLimit as rateLimitTable,
  session as sessionTable,
  user as userTable,
} from "../src/database/auth-schema.generated.js";
import { createDatabase } from "../src/database/database.js";
import {
  employeeApprovals,
  workspaceMemberships,
  workspaces,
} from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import type { ModelGateway } from "../src/generations/model-gateway.js";
import { type EmailSender, FakeEmailSender } from "../src/identity/email.js";
import { ResendEmailSender } from "../src/identity/resend-email.js";
import { createIdentityService, type IdentityService } from "../src/identity/service.js";

const publicOrigin = "http://localhost:5173";
const adminEmail = "admin.identity@example.test";
const originalPassword = "correct-horse-battery";
const inertProductionGateway: ModelGateway = {
  async *stream() {
    yield { errorCode: "GENERATION_FAILED", type: "response.failed" };
  },
};

function cookieHeader(response: LightMyRequestResponse): string {
  const values = response.headers["set-cookie"];
  const cookies = Array.isArray(values) ? values : values === undefined ? [] : [values];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function setCookies(response: LightMyRequestResponse): readonly string[] {
  const values = response.headers["set-cookie"];
  return Array.isArray(values) ? values : values === undefined ? [] : [values];
}

function linkFromDelivery(
  sender: FakeEmailSender,
  purpose: "password-reset" | "verification",
): URL {
  const delivery = sender.deliveries().findLast((message) => message.purpose === purpose);
  if (delivery === undefined) {
    throw new Error(`No ${purpose} delivery was captured`);
  }

  const link = delivery.text.split("\n").find((line) => line.startsWith("http"));
  if (link === undefined) {
    throw new Error(`The ${purpose} delivery did not contain a link`);
  }

  return new URL(link);
}

function credentialFromLink(url: URL): string {
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (token === null) {
    throw new Error("The identity delivery did not contain a fragment credential");
  }
  return token;
}

describe.sequential("identity integration", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let application: ApiApplication | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_identity")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl);
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(
        'TRUNCATE TABLE "rate_limit", "verification", "session", "account", "workspace_memberships", "employee_approvals", "user", "workspaces" RESTART IDENTITY CASCADE',
      );
    } finally {
      await pool.end();
    }
  });

  afterEach(async () => {
    if (application !== undefined) {
      await application.shutdown();
      application = undefined;
    }
  });

  afterAll(async () => {
    await container.stop();
  });

  function startApplication(
    sender: EmailSender = new FakeEmailSender(),
    clientAddressSource?: "caddy" | "socket",
  ): ApiApplication {
    const started = createApplication(
      loadConfig({
        BETTER_AUTH_SECRET: "capstone-chat-test-secret-with-more-than-thirty-two-characters",
        ...(clientAddressSource === undefined
          ? {}
          : { CLIENT_ADDRESS_SOURCE: clientAddressSource }),
        DATABASE_URL: databaseUrl,
        EMAIL_DELIVERY: "fake",
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: publicOrigin,
      }),
      { emailSender: sender },
    );
    application = started;
    return started;
  }

  async function authPost(
    app: ApiApplication,
    path: string,
    payload: Record<string, unknown>,
    cookie?: string,
    extraHeaders: Record<string, string> = {},
    remoteAddress = "127.0.0.1",
  ): Promise<LightMyRequestResponse> {
    return app.server.inject({
      method: "POST",
      url: `/api/auth${path}`,
      headers: {
        "content-type": "application/json",
        origin: publicOrigin,
        ...(cookie === undefined ? {} : { cookie }),
        ...extraHeaders,
      },
      payload,
      remoteAddress,
    });
  }

  async function registerActiveAdministrator(
    app: ApiApplication,
    sender: FakeEmailSender,
    email = adminEmail,
  ): Promise<void> {
    await app.identity.bootstrap({
      adminEmail: email,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });

    const signUp = await authPost(app, "/sign-up/email", {
      callbackURL: "/verify-email",
      email: `  ${email.toUpperCase()}  `,
      name: "Administradora Capstone",
      password: originalPassword,
    });
    expect(signUp.statusCode).toBe(200);

    const verificationUrl = linkFromDelivery(sender, "verification");
    const verification = await authPost(
      app,
      "/verify-email",
      { token: credentialFromLink(verificationUrl) },
      undefined,
      {},
      "127.0.0.1",
    );
    expect(verification.statusCode).toBe(204);
  }

  async function seedAdditionalActiveAdministrator(app: ApiApplication): Promise<void> {
    const workspace = await app.database.query.workspaces.findFirst();
    if (workspace === undefined) {
      throw new Error("The administrator fixture workspace is unavailable");
    }
    const userId = "identity-recovery-administrator";
    const email = "recovery.identity@example.test";
    const now = new Date();
    await app.database.insert(userTable).values({
      email,
      emailVerified: true,
      id: userId,
      name: "Administradora de Recuperación",
    });
    await app.database.insert(employeeApprovals).values({
      activatedAt: now,
      normalizedEmail: email,
      role: "admin",
      status: "activated",
      userId,
      workspaceId: workspace.id,
    });
    await app.database.insert(workspaceMemberships).values({
      activatedAt: now,
      role: "admin",
      status: "active",
      userId,
      workspaceId: workspace.id,
    });
  }

  async function signIn(
    app: ApiApplication,
    password = originalPassword,
    rememberMe = true,
  ): Promise<LightMyRequestResponse> {
    return authPost(app, "/sign-in/email", {
      email: adminEmail,
      password,
      rememberMe,
    });
  }

  it("keeps approval status generic while enforcing identical registration bounds", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);

    const unapproved = await authPost(
      app,
      "/sign-up/email",
      {
        callbackURL: "/verify-email",
        email: "unapproved@example.test",
        name: "Persona Sintética",
        password: originalPassword,
      },
      undefined,
      {},
      "127.0.0.10",
    );
    expect(unapproved.statusCode).toBe(200);
    expect(unapproved.json()).toMatchObject({ token: null, user: { emailVerified: false } });

    const unapprovedTooShort = await authPost(
      app,
      "/sign-up/email",
      {
        email: "unapproved-short@example.test",
        name: "Persona Sintética",
        password: "short",
      },
      undefined,
      {},
      "127.0.0.11",
    );
    const unapprovedTooLong = await authPost(
      app,
      "/sign-up/email",
      {
        email: "unapproved-long@example.test",
        name: "Persona Sintética",
        password: "x".repeat(129),
      },
      undefined,
      {},
      "127.0.0.12",
    );
    const unapprovedBlankName = await authPost(
      app,
      "/sign-up/email",
      {
        email: "unapproved-name@example.test",
        name: "   ",
        password: originalPassword,
      },
      undefined,
      {},
      "127.0.0.15",
    );

    await app.identity.bootstrap({
      adminEmail,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });
    const approvedBlankName = await authPost(
      app,
      "/sign-up/email",
      {
        email: adminEmail,
        name: "   ",
        password: originalPassword,
      },
      undefined,
      {},
      "127.0.0.16",
    );
    const tooShort = await authPost(
      app,
      "/sign-up/email",
      {
        email: adminEmail,
        name: "Administradora Capstone",
        password: "short",
      },
      undefined,
      {},
      "127.0.0.11",
    );
    const tooLong = await authPost(
      app,
      "/sign-up/email",
      {
        email: adminEmail,
        name: "Administradora Capstone",
        password: "x".repeat(129),
      },
      undefined,
      {},
      "127.0.0.12",
    );

    expect(tooShort.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
    expect(unapprovedTooShort.statusCode).toBe(tooShort.statusCode);
    expect(unapprovedTooLong.statusCode).toBe(tooLong.statusCode);
    expect(unapprovedTooShort.json()).toEqual(tooShort.json());
    expect(unapprovedTooLong.json()).toEqual(tooLong.json());
    expect(approvedBlankName.statusCode).toBe(400);
    expect(unapprovedBlankName.statusCode).toBe(approvedBlankName.statusCode);
    expect(unapprovedBlankName.json()).toEqual(approvedBlankName.json());

    const approved = await authPost(
      app,
      "/sign-up/email",
      {
        callbackURL: "/verify-email",
        email: adminEmail,
        name: "Persona Aprobada",
        password: originalPassword,
      },
      undefined,
      { host: "attacker.example" },
      "127.0.0.13",
    );
    const duplicate = await authPost(
      app,
      "/sign-up/email",
      {
        callbackURL: "/verify-email",
        email: adminEmail,
        name: "Persona Aprobada",
        password: originalPassword,
      },
      undefined,
      {},
      "127.0.0.13",
    );
    expect(approved.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(approved.headers["cache-control"]).toBe("no-store");
    expect(approved.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(Object.keys(approved.json()).sort()).toEqual(Object.keys(unapproved.json()).sort());
    expect(Object.keys(duplicate.json()).sort()).toEqual(Object.keys(unapproved.json()).sort());
    expect(Object.keys(approved.json().user).sort()).toEqual(
      Object.keys(unapproved.json().user).sort(),
    );
    expect(Object.keys(duplicate.json().user).sort()).toEqual(
      Object.keys(unapproved.json().user).sort(),
    );
    expect(unapproved.json().user.id).toMatch(/^[A-Za-z0-9]{32}$/u);
    expect(approved.json().user.id).toMatch(/^[A-Za-z0-9]{32}$/u);
    expect(duplicate.json().user.id).toMatch(/^[A-Za-z0-9]{32}$/u);
    for (const result of [unapproved.json(), approved.json(), duplicate.json()]) {
      expect(result).toEqual({
        token: null,
        user: {
          createdAt: expect.any(String),
          email: expect.any(String),
          emailVerified: false,
          id: expect.any(String),
          image: null,
          name: expect.any(String),
          updatedAt: expect.any(String),
        },
      });
    }
    expect(sender.deliveries().filter(({ purpose }) => purpose === "verification")).toHaveLength(1);
    expect(linkFromDelivery(sender, "verification").origin).toBe(publicOrigin);

    expect(await app.database.query.user.findMany()).toHaveLength(1);
    expect(await app.database.query.workspaceMemberships.findMany()).toEqual([]);
    const preVerificationSignIn = await authPost(
      app,
      "/sign-in/email",
      { email: adminEmail, password: originalPassword },
      undefined,
      {},
      "127.0.0.20",
    );
    expect(preVerificationSignIn.statusCode).toBe(401);
    expect(await app.database.query.session.findMany()).toEqual([]);
    const beforeVerification = await app.server.inject({ method: "GET", url: "/api/session" });
    expect(beforeVerification.statusCode).toBe(401);
    const oversized = await app.server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json", origin: publicOrigin },
      payload: JSON.stringify({
        email: "oversized@example.test",
        name: "x".repeat(17_000),
        password: originalPassword,
      }),
      remoteAddress: "127.0.0.14",
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(
      (
        await app.server.inject({
          method: "GET",
          url: "/api/dev/mailbox",
          remoteAddress: "127.0.0.1",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("wires the app-owned mutation boundary into Fastify", async () => {
    const app = startApplication();
    const crossOrigin = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      payload: {},
    });
    const wrongContentType = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "text/plain", origin: publicOrigin },
      payload: "{}",
    });
    const allowedBoundary = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json", origin: publicOrigin },
      payload: {},
    });

    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(wrongContentType.statusCode).toBe(415);
    expect(wrongContentType.json()).toMatchObject({ code: "JSON_REQUIRED" });
    expect(allowedBoundary.statusCode).toBe(404);
  });

  it("supports the supervised anonymous-session smoke through the Caddy address boundary", async () => {
    const app = startApplication(new FakeEmailSender(), "caddy");

    const missingPrivateHeader = await app.server.inject({
      method: "GET",
      url: "/api/session",
      remoteAddress: "127.0.0.1",
    });
    const trustedLoopback = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { "x-capstone-client-ip": "192.0.2.1" },
      remoteAddress: "127.0.0.1",
    });
    const untrustedSocket = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { "x-capstone-client-ip": "192.0.2.1" },
      remoteAddress: "198.51.100.10",
    });

    expect(missingPrivateHeader.statusCode).toBe(400);
    expect(missingPrivateHeader.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(trustedLoopback.statusCode).toBe(401);
    expect(trustedLoopback.headers["cache-control"]).toBe("no-store");
    expect(trustedLoopback.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(untrustedSocket.statusCode).toBe(400);
    expect(untrustedSocket.json()).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts verification credentials only through the bounded same-origin JSON wrapper", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await app.identity.bootstrap({
      adminEmail,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });
    const signUp = await authPost(app, "/sign-up/email", {
      email: adminEmail,
      name: "Administradora Capstone",
      password: originalPassword,
    });
    expect(signUp.statusCode).toBe(200);
    const validToken = credentialFromLink(linkFromDelivery(sender, "verification"));
    const wrongOrigin = await app.server.inject({
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      method: "POST",
      payload: { token: "synthetic-token" },
      url: "/api/auth/verify-email",
    });
    const wrongContentType = await app.server.inject({
      headers: { "content-type": "text/plain", origin: publicOrigin },
      method: "POST",
      payload: JSON.stringify({ token: "synthetic-token" }),
      url: "/api/auth/verify-email",
    });
    const unexpectedField = await authPost(app, "/verify-email", {
      token: "synthetic-token",
      url: "https://attacker.example/credential",
    });
    const oversized = await authPost(app, "/verify-email", { token: "x".repeat(4_097) });
    const invalid = await authPost(app, "/verify-email", { token: "synthetic-invalid-token" });
    const legacyGet = await app.server.inject({
      method: "GET",
      url: `/api/auth/verify-email?token=${encodeURIComponent(validToken)}`,
    });
    const queryPost = await authPost(app, `/verify-email?token=${encodeURIComponent(validToken)}`, {
      token: validToken,
    });

    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(wrongContentType.statusCode).toBe(415);
    expect(wrongContentType.json()).toMatchObject({ code: "JSON_REQUIRED" });
    expect(unexpectedField.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(401);
    expect(invalid.payload).toBe("");
    expect(legacyGet.statusCode).toBe(404);
    expect(queryPost.statusCode).toBe(400);
    expect((await app.database.query.user.findFirst())?.emailVerified).toBe(false);
    expect((await authPost(app, "/verify-email", { token: validToken })).statusCode).toBe(204);
  });

  it("returns public sign-up before a tracked provider request settles", async () => {
    const providerRequest = Promise.withResolvers<Response>();
    const providerEntered = Promise.withResolvers<void>();
    const sender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async () => {
        providerEntered.resolve();
        return providerRequest.promise;
      },
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
    });
    const app = startApplication(sender);
    await app.identity.bootstrap({
      adminEmail,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });

    const signUpPromise = authPost(app, "/sign-up/email", {
      email: adminEmail,
      name: "Administradora Capstone",
      password: originalPassword,
    });
    await providerEntered.promise;
    const signUp = await signUpPromise;

    expect(signUp.statusCode).toBe(200);
    providerRequest.resolve(
      new Response(JSON.stringify({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    await sender.close();
  });

  it("registers the fake mailbox only for loopback development requests", async () => {
    const sender = new FakeEmailSender();
    await sender.send({
      html: "<p>Crea tu cuenta</p>",
      purpose: "invitation",
      subject: "Invitación sintética",
      text: "Crea tu cuenta en http://localhost:5173/sign-up",
      to: "mailbox@example.test",
    });
    const app = createApplication(
      loadConfig({
        BETTER_AUTH_SECRET: "capstone-chat-test-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: databaseUrl,
        EMAIL_DELIVERY: "fake",
        LOG_LEVEL: "silent",
        NODE_ENV: "development",
        PUBLIC_ORIGIN: publicOrigin,
      }),
      { emailSender: sender },
    );
    application = app;

    const allowed = await app.server.inject({
      method: "GET",
      url: "/api/dev/mailbox",
      remoteAddress: "127.0.0.1",
    });
    const denied = await app.server.inject({
      method: "GET",
      url: "/api/dev/mailbox",
      remoteAddress: "203.0.113.10",
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["cache-control"]).toBe("no-store");
    expect(allowed.json()).toMatchObject({
      messages: [
        {
          html: "<p>Crea tu cuenta</p>",
          purpose: "invitation",
          subject: "Invitación sintética",
        },
      ],
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "DEVELOPMENT_MAILBOX_DENIED" });
  });

  it("accepts passwords at both exact boundaries without activating membership", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await app.identity.bootstrap({
      adminEmail,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });
    await app.identity.approve({
      email: "member.boundary@example.test",
      role: "member",
      workspaceIdentity: "capstone-ecuador",
    });

    const minimum = await authPost(app, "/sign-up/email", {
      email: adminEmail,
      name: "Contraseña Mínima",
      password: "a".repeat(12),
    });
    const maximum = await authPost(
      app,
      "/sign-up/email",
      {
        email: "member.boundary@example.test",
        name: "Contraseña Máxima",
        password: "z".repeat(128),
      },
      undefined,
      {},
      "127.0.0.2",
    );

    expect(minimum.statusCode).toBe(200);
    expect(maximum.statusCode).toBe(200);
    expect(await app.database.query.user.findMany()).toHaveLength(2);
    expect(await app.database.query.workspaceMemberships.findMany()).toEqual([]);
  });

  it("does not activate a revoked approval from a delayed verification callback", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await app.identity.bootstrap({
      adminEmail,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });
    const signUp = await authPost(app, "/sign-up/email", {
      callbackURL: "/verify-email",
      email: adminEmail,
      name: "Administradora Revocada",
      password: originalPassword,
    });
    expect(signUp.statusCode).toBe(200);
    await app.employeeAdministration.deactivateByIdentity({
      email: adminEmail,
      workspaceIdentity: "capstone-ecuador",
    });

    const verificationUrl = linkFromDelivery(sender, "verification");
    const delayed = await authPost(app, "/verify-email", {
      token: credentialFromLink(verificationUrl),
    });
    expect(delayed.statusCode).toBe(204);
    expect((await app.database.query.user.findFirst())?.emailVerified).toBe(true);
    expect((await app.database.query.employeeApprovals.findFirst())?.status).toBe("revoked");
    expect(await app.database.query.workspaceMemberships.findMany()).toEqual([]);
    expect((await signIn(app)).statusCode).toBe(401);
  });

  it("preserves an approved member role and denies a valid session after membership loss", async () => {
    const memberEmail = "member.identity@example.test";
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await app.identity.bootstrap({
      adminEmail,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });
    await app.identity.approve({
      email: memberEmail,
      role: "member",
      workspaceIdentity: "capstone-ecuador",
    });
    const signUp = await authPost(app, "/sign-up/email", {
      callbackURL: "/verify-email",
      email: memberEmail,
      name: "Miembro Capstone",
      password: originalPassword,
      role: "admin",
      workspace: "attacker-workspace",
    });
    expect(signUp.statusCode).toBe(200);
    const verificationUrl = linkFromDelivery(sender, "verification");
    const verification = await authPost(app, "/verify-email", {
      token: credentialFromLink(verificationUrl),
    });
    expect(verification.statusCode).toBe(204);
    const signedIn = await authPost(app, "/sign-in/email", {
      email: memberEmail,
      password: originalPassword,
    });
    expect(signedIn.statusCode).toBe(200);

    const active = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: cookieHeader(signedIn) },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({
      employee: { email: memberEmail },
      workspace: { identity: "capstone-ecuador", role: "member" },
    });

    await app.database.delete(workspaceMemberships);
    const missingMembership = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: cookieHeader(signedIn) },
    });
    expect(missingMembership.statusCode).toBe(403);
    expect(missingMembership.json()).toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
  });

  it("repairs a verified pending approval after the activation hook fails", async () => {
    const sender = new FakeEmailSender();
    const pool = new Pool({ connectionString: databaseUrl });
    const database = createDatabase(pool);
    const baseIdentity = createIdentityService(database);
    let failActivation = true;
    const identity: IdentityService = Object.freeze({
      ...baseIdentity,
      async activateMembership(user) {
        if (failActivation) {
          failActivation = false;
          throw new Error("Synthetic activation interruption");
        }
        return baseIdentity.activateMembership(user);
      },
    });
    const app = createApplication(
      loadConfig({
        BETTER_AUTH_SECRET: "capstone-chat-test-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: databaseUrl,
        EMAIL_DELIVERY: "fake",
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: publicOrigin,
      }),
      { database, emailSender: sender, identity, pool },
    );
    application = app;

    await app.identity.bootstrap({
      adminEmail,
      displayName: "Capstone Ecuador",
      workspaceIdentity: "capstone-ecuador",
    });
    const signUp = await authPost(app, "/sign-up/email", {
      callbackURL: "/verify-email",
      email: adminEmail,
      name: "Administradora Capstone",
      password: originalPassword,
    });
    expect(signUp.statusCode).toBe(200);

    const verificationUrl = linkFromDelivery(sender, "verification");
    const interruptedVerification = await authPost(app, "/verify-email", {
      token: credentialFromLink(verificationUrl),
    });
    expect(interruptedVerification.statusCode).toBe(500);
    expect(interruptedVerification.payload).toBe("");
    expect((await app.database.query.user.findFirst())?.emailVerified).toBe(true);
    expect(await app.database.query.workspaceMemberships.findMany()).toEqual([]);
    expect((await app.database.query.employeeApprovals.findFirst())?.status).toBe("pending");

    const repairedSignIn = await signIn(app);
    expect(repairedSignIn.statusCode).toBe(200);
    expect(await app.database.query.workspaceMemberships.findMany()).toHaveLength(1);
    expect((await app.database.query.employeeApprovals.findFirst())?.status).toBe("activated");
  });

  it("activates one membership on verification and persists a database session across restart", async () => {
    const sender = new FakeEmailSender();
    let app = startApplication(sender);
    await registerActiveAdministrator(app, sender);

    const memberships = await app.database.query.workspaceMemberships.findMany();
    const approvals = await app.database.query.employeeApprovals.findMany();
    const registeredUsers = await app.database.query.user.findMany();
    expect(registeredUsers[0]).toMatchObject({ email: adminEmail, emailVerified: true });
    expect(approvals[0]?.userId).toBe(registeredUsers[0]?.id);
    expect(approvals[0]).toMatchObject({ role: "admin", status: "activated" });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: "admin", status: "active" });

    const crossOrigin = await authPost(
      app,
      "/sign-in/email",
      { email: adminEmail, password: originalPassword },
      undefined,
      { origin: "https://attacker.example" },
      "127.0.0.2",
    );
    expect(crossOrigin.statusCode).toBe(403);
    for (const disabled of [
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
    ]) {
      for (const method of ["GET", "POST"] as const) {
        const response = await app.server.inject({
          method,
          url: `/api/auth${disabled}`,
          headers: { "content-type": "application/json", origin: publicOrigin },
          ...(method === "POST" ? { payload: {} } : {}),
        });
        expect(response.statusCode).toBe(404);
      }
    }

    const user = (await app.database.query.user.findMany())[0];
    if (user === undefined) {
      throw new Error("The verified user was not created");
    }
    await expect(
      app.identity.activateMembership({
        email: user.email,
        emailVerified: user.emailVerified,
        id: user.id,
      }),
    ).resolves.toBe("already-active");
    expect(await app.database.query.workspaceMemberships.findMany()).toHaveLength(1);

    const signedIn = await signIn(app, originalPassword, false);
    expect(signedIn.statusCode).toBe(200);
    const cookies = setCookies(signedIn);
    expect(cookies.length).toBeGreaterThanOrEqual(2);
    expect(cookies.join(";")).not.toContain("session_data");
    for (const cookie of cookies) {
      expect(cookie).toMatch(/HttpOnly/iu);
      expect(cookie).toMatch(/SameSite=Lax/iu);
      expect(cookie).not.toMatch(/;\s*Secure/iu);
    }

    const cookie = cookieHeader(signedIn);
    const sessionResponse = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.headers["cache-control"]).toBe("no-store");
    expect(sessionResponse.json()).toMatchObject({
      employee: { email: adminEmail, name: "Administradora Capstone" },
      workspace: { identity: "capstone-ecuador", name: "Capstone Ecuador", role: "admin" },
    });

    await app.shutdown();
    application = undefined;
    app = startApplication(sender);
    const afterRestart = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(afterRestart.statusCode).toBe(200);

    await app.shutdown();
    application = undefined;
    const productionOrigin = "https://chat.capstone.com.ec";
    const productionEmailSender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async () =>
        new Response(JSON.stringify({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
    });
    app = createApplication(
      {
        ...loadConfig({
          BETTER_AUTH_SECRET: "capstone-chat-test-secret-with-more-than-thirty-two-characters",
          DATABASE_URL: databaseUrl,
          DEPLOYMENT_REVISION: "0123456789abcdef0123456789abcdef01234567",
          EMAIL_DELIVERY: "resend",
          EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
          LOG_LEVEL: "silent",
          MODEL_GATEWAY: "openrouter",
          NODE_ENV: "test",
          OPENROUTER_API_KEY: "test-openrouter-key-never-sent",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
          OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key",
          PUBLIC_ORIGIN: productionOrigin,
          RESEND_API_KEY: "re_test_only",
        }),
        nodeEnv: "production",
        publicOrigin: productionOrigin,
        webAssetsDirectory: null,
      },
      { emailSender: productionEmailSender, modelGateway: inertProductionGateway },
    );
    application = app;
    const productionSignIn = await app.server.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        "content-type": "application/json",
        origin: productionOrigin,
      },
      payload: { email: adminEmail, password: originalPassword },
    });
    expect(productionSignIn.statusCode).toBe(200);
    const productionCookies = setCookies(productionSignIn);
    expect(productionCookies).not.toEqual([]);
    expect(productionCookies.every((cookie) => /;\s*Secure/iu.test(cookie))).toBe(true);
    expect(productionCookies.some((cookie) => /Max-Age=604800/iu.test(cookie))).toBe(true);
  });

  it("slides remembered database sessions and forwards the refreshed cookie", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await registerActiveAdministrator(app, sender);
    const signedIn = await signIn(app);
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieHeader(signedIn);
    const stored = (await app.database.query.session.findMany())[0];
    if (stored === undefined) {
      throw new Error("The remembered session was not stored");
    }
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeGreaterThanOrEqual(
      604_790_000,
    );
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeLessThanOrEqual(
      604_810_000,
    );

    const agedExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1_000);
    await app.database
      .update(sessionTable)
      .set({ expiresAt: agedExpiry, updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000) })
      .where(eq(sessionTable.id, stored.id));

    const refreshed = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(setCookies(refreshed)).not.toEqual([]);
    expect(setCookies(refreshed).every((value) => /HttpOnly/iu.test(value))).toBe(true);
    const updated = (await app.database.query.session.findMany())[0];
    expect(updated?.expiresAt.getTime()).toBeGreaterThan(
      agedExpiry.getTime() + 24 * 60 * 60 * 1_000,
    );
  });

  it("keeps sensitive identity values out of captured request logs", async () => {
    const sender = new FakeEmailSender();
    const capturedLogs: string[] = [];
    const app = createApplication(
      loadConfig({
        BETTER_AUTH_SECRET: "capstone-chat-test-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: databaseUrl,
        EMAIL_DELIVERY: "fake",
        LOG_LEVEL: "info",
        NODE_ENV: "development",
        PUBLIC_ORIGIN: publicOrigin,
      }),
      {
        emailSender: sender,
        loggerStream: {
          write(message) {
            capturedLogs.push(message);
          },
        },
      },
    );
    application = app;
    await registerActiveAdministrator(app, sender);
    const signedIn = await signIn(app);
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieHeader(signedIn);
    const databaseSessionToken = (await app.database.query.session.findMany())[0]?.token;
    if (databaseSessionToken === undefined || databaseSessionToken.length < 20) {
      throw new Error("The signed-in session did not persist a usable token");
    }
    const verificationUrl = linkFromDelivery(sender, "verification");
    const verificationToken = credentialFromLink(verificationUrl);

    await app.server.inject({
      method: "GET",
      url: "/api/session?token=query-secret-not-for-logs",
      headers: {
        authorization: "Bearer authorization-secret-not-for-logs",
        cookie,
      },
    });
    await authPost(app, "/sign-in/email", {
      email: adminEmail,
      password: "invalid-password-not-for-logs",
    });
    const resetRequest = await authPost(app, "/request-password-reset", {
      email: adminEmail,
      redirectTo: "/reset-password",
    });
    expect(resetRequest.statusCode).toBe(200);
    const resetUrl = linkFromDelivery(sender, "password-reset");
    const deliveredResetToken = credentialFromLink(resetUrl);
    const resetLinkSecrets = [deliveredResetToken];
    expect(resetUrl.pathname).toBe("/reset-password");
    expect(resetUrl.search).toBe("");
    await authPost(app, "/reset-password", {
      newPassword: "reset-password-not-for-logs",
      token: deliveredResetToken,
    });
    const mailbox = await app.server.inject({
      method: "GET",
      url: "/api/dev/mailbox?token=mailbox-query-secret-not-for-logs",
      remoteAddress: "127.0.0.1",
    });
    expect(mailbox.statusCode).toBe(200);

    const output = capturedLogs.join("");
    expect(output).toContain('"route":"/api/auth/*"');
    expect(output).toContain('"route":"/api/dev/mailbox"');
    expect(output).toContain('"route":"/api/session"');
    const cookieFragments = cookie
      .split("; ")
      .map((part) => part.split("=").slice(1).join("="))
      .filter((part) => part.length > 0);
    const decodedCookieFragments = cookieFragments.flatMap((value) => {
      const decoded = decodeURIComponent(value);
      return [decoded, ...decoded.split(".").filter((part) => part.length >= 12)];
    });
    const emailBodyFragments = sender.deliveries().flatMap(({ text }) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("http") && line.length >= 24)
        .flatMap((line) => [line, line.slice(0, 24)]),
    );
    expect(emailBodyFragments).not.toEqual([]);
    for (const sensitiveValue of [
      adminEmail,
      originalPassword,
      "invalid-password-not-for-logs",
      "reset-password-not-for-logs",
      "query-secret-not-for-logs",
      "mailbox-query-secret-not-for-logs",
      "authorization-secret-not-for-logs",
      cookie,
      ...cookieFragments,
      ...decodedCookieFragments,
      verificationToken,
      verificationUrl.href,
      resetUrl.href,
      deliveredResetToken,
      ...resetLinkSecrets,
      databaseSessionToken,
      databaseSessionToken.slice(0, 16),
      ...sender.deliveries().map(({ text }) => text),
      ...emailBodyFragments,
    ]) {
      expect(output).not.toContain(sensitiveValue);
    }
  });

  it("fails closed when a valid session resolves more than one active workspace", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await registerActiveAdministrator(app, sender);
    const signedIn = await signIn(app);
    const activeUser = (await app.database.query.user.findMany())[0];
    if (activeUser === undefined) {
      throw new Error("The active user was not created");
    }
    const secondWorkspace = (
      await app.database
        .insert(workspaces)
        .values({ displayName: "Workspace Ambiguo", identity: "workspace-ambiguo" })
        .returning()
    )[0];
    if (secondWorkspace === undefined) {
      throw new Error("The ambiguous workspace was not created");
    }
    await app.database.insert(workspaceMemberships).values({
      role: "member",
      userId: activeUser.id,
      workspaceId: secondWorkspace.id,
    });
    await app.database.insert(employeeApprovals).values({
      activatedAt: new Date(),
      normalizedEmail: activeUser.email,
      role: "member",
      status: "activated",
      userId: activeUser.id,
      workspaceId: secondWorkspace.id,
    });

    const denied = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: {
        cookie: cookieHeader(signedIn),
        "x-capstone-role": "admin",
        "x-capstone-workspace": secondWorkspace.id,
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
  });

  it("fails closed when an approval is revoked but its membership remains active", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await registerActiveAdministrator(app, sender);
    const signedIn = await signIn(app);
    await app.database
      .update(employeeApprovals)
      .set({ revokedAt: new Date(), status: "revoked", updatedAt: new Date() });

    const denied = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: cookieHeader(signedIn) },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
    expect((await app.database.query.workspaceMemberships.findFirst())?.status).toBe("active");
  });

  it("fails closed when an active membership belongs to an unverified identity", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await registerActiveAdministrator(app, sender);
    const signedIn = await signIn(app);
    const activeUser = (await app.database.query.user.findMany())[0];
    if (activeUser === undefined) {
      throw new Error("The active user was not created");
    }
    await app.database
      .update(userTable)
      .set({ emailVerified: false })
      .where(eq(userTable.id, activeUser.id));

    const denied = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: cookieHeader(signedIn) },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
  });

  it("forces password-change revocation, resets every session, and denies deactivated access before cleanup", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);
    await registerActiveAdministrator(app, sender);

    const first = await signIn(app);
    const second = await signIn(app);
    const firstCookie = cookieHeader(first);
    const secondCookie = cookieHeader(second);
    expect(await app.database.query.session.findMany()).toHaveLength(2);

    const changed = await authPost(
      app,
      "/change-password",
      {
        currentPassword: originalPassword,
        newPassword: "new-password-after-change",
        revokeOtherSessions: false,
      },
      firstCookie,
    );
    expect(changed.statusCode).toBe(200);
    expect(await app.database.query.session.findMany()).toHaveLength(1);
    const changedCookie = cookieHeader(changed);
    expect(changedCookie).not.toBe("");

    const currentSession = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: changedCookie },
    });
    const replacedCurrent = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: firstCookie },
    });
    const revokedOther = await app.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: secondCookie },
    });
    expect(currentSession.statusCode).toBe(200);
    expect(replacedCurrent.statusCode).toBe(401);
    expect(revokedOther.statusCode).toBe(401);

    const third = await signIn(app, "new-password-after-change");
    const thirdCookie = cookieHeader(third);
    const resetRequest = await authPost(app, "/request-password-reset", {
      email: adminEmail,
      redirectTo: "/reset-password",
    });
    expect(resetRequest.statusCode).toBe(200);

    const resetUrl = linkFromDelivery(sender, "password-reset");
    const token = credentialFromLink(resetUrl);
    expect(resetUrl.pathname).toBe("/reset-password");
    expect(resetUrl.search).toBe("");

    const legacyReset = await app.server.inject({
      method: "GET",
      url: `/api/auth/reset-password/${encodeURIComponent(token)}?callbackURL=${encodeURIComponent(
        "/reset-password",
      )}`,
    });
    const queryReset = await authPost(app, `/reset-password?token=${encodeURIComponent(token)}`, {
      newPassword: "password-from-query-must-not-apply",
    });
    expect(legacyReset.statusCode).toBe(404);
    expect(queryReset.statusCode).toBe(400);

    const reset = await authPost(app, "/reset-password", {
      newPassword: "password-after-complete-reset",
      token,
    });
    expect(reset.statusCode).toBe(200);
    expect(await app.database.query.session.findMany()).toEqual([]);

    const afterReset = await signIn(app, "password-after-complete-reset");
    const staleCookie = cookieHeader(afterReset);
    await seedAdditionalActiveAdministrator(app);
    const replica = createApplication(
      loadConfig({
        BETTER_AUTH_SECRET: "capstone-chat-test-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: databaseUrl,
        EMAIL_DELIVERY: "fake",
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: publicOrigin,
      }),
      { emailSender: sender },
    );
    try {
      const deactivation = await app.employeeAdministration.deactivateByIdentity({
        email: adminEmail,
        workspaceIdentity: "capstone-ecuador",
      });
      expect(deactivation.userId).not.toBeNull();

      const deniedBeforeCleanup = await replica.server.inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie: staleCookie },
      });
      expect(deniedBeforeCleanup.statusCode).toBe(403);
      expect(deniedBeforeCleanup.json()).toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });

      if (deactivation.userId === null) {
        throw new Error("The deactivated identity was not linked");
      }
      await app.authentication.revokeUserSessions(deactivation.userId);
      expect(await app.database.query.session.findMany()).toEqual([]);

      const deniedAfterCleanup = await replica.server.inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie: staleCookie },
      });
      expect(deniedAfterCleanup.statusCode).toBe(401);
      expect(setCookies(deniedAfterCleanup)).not.toEqual([]);
      expect(thirdCookie).not.toBe("");
    } finally {
      await replica.shutdown();
    }
  });

  it("shares PostgreSQL rate limits across instances and ignores spoofed forwarding headers", async () => {
    const sender = new FakeEmailSender();
    const firstApp = startApplication(sender);
    await registerActiveAdministrator(firstApp, sender);
    const secondApp = createApplication(
      loadConfig({
        BETTER_AUTH_SECRET: "capstone-chat-test-secret-with-more-than-thirty-two-characters",
        DATABASE_URL: databaseUrl,
        EMAIL_DELIVERY: "fake",
        LOG_LEVEL: "silent",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: publicOrigin,
      }),
      { emailSender: sender },
    );

    try {
      const responses: LightMyRequestResponse[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        responses.push(
          await authPost(
            attempt % 2 === 0 ? firstApp : secondApp,
            "/sign-in/email",
            {
              email: adminEmail,
              password: "definitely-wrong-password",
            },
            undefined,
            {
              "x-forwarded-for": `203.0.113.${attempt + 1}`,
              "x-capstone-client-ip": `198.51.100.${attempt + 1}`,
            },
          ),
        );
      }

      expect(responses.slice(0, 5).every((response) => response.statusCode === 401)).toBe(true);
      expect(responses[5]?.statusCode).toBe(429);
      const counters = await firstApp.database.query.rateLimit.findMany();
      expect(counters.filter((counter) => counter.count === 5)).toHaveLength(1);
    } finally {
      await secondApp.shutdown();
    }
  });

  it("applies every selected strict recovery and verification rate limit", async () => {
    const sender = new FakeEmailSender();
    const app = startApplication(sender);

    const resendStatuses: number[] = [];
    const forgotStatuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      resendStatuses.push(
        (
          await authPost(app, "/send-verification-email", {
            callbackURL: "/verify-email",
            email: "unknown@example.test",
          })
        ).statusCode,
      );
      forgotStatuses.push(
        (
          await authPost(
            app,
            "/request-password-reset",
            { email: "unknown@example.test", redirectTo: "/reset-password" },
            undefined,
            {},
            "127.0.0.2",
          )
        ).statusCode,
      );
    }
    expect(resendStatuses).toEqual([200, 200, 200, 429]);
    expect(forgotStatuses).toEqual([200, 200, 200, 429]);

    const resetStatuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      resetStatuses.push(
        (
          await authPost(
            app,
            "/reset-password",
            { newPassword: originalPassword, token: "invalid-reset-token" },
            undefined,
            {},
            "127.0.0.3",
          )
        ).statusCode,
      );
    }
    expect(resetStatuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(resetStatuses[5]).toBe(429);

    const verificationStatuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      verificationStatuses.push(
        (
          await authPost(
            app,
            "/verify-email",
            { token: "invalid-verification-token" },
            undefined,
            {},
            "127.0.0.4",
          )
        ).statusCode,
      );
    }
    expect(verificationStatuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
    expect(verificationStatuses[10]).toBe(429);
  });

  it("retains long-window counters when an ordinary rate-limit row rolls over", async () => {
    const app = startApplication();
    const strictAddress = "127.0.0.5";
    const ordinaryAddress = "127.0.0.6";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (
          await authPost(
            app,
            "/request-password-reset",
            { email: "unknown@example.test", redirectTo: "/reset-password" },
            undefined,
            {},
            strictAddress,
          )
        ).statusCode,
      ).toBe(200);
    }
    await authPost(app, "/sign-out", {}, undefined, {}, ordinaryAddress);

    const now = Date.now();
    await app.database
      .update(rateLimitTable)
      .set({ count: 3, lastRequest: now - 2 * 60 * 1_000 })
      .where(eq(rateLimitTable.key, `${strictAddress}|/request-password-reset`));
    await app.database
      .update(rateLimitTable)
      .set({ count: 100, lastRequest: now - 61 * 1_000 })
      .where(eq(rateLimitTable.key, `${ordinaryAddress}|/sign-out`));

    const ordinaryRollover = await authPost(app, "/sign-out", {}, undefined, {}, ordinaryAddress);
    expect(ordinaryRollover.statusCode).not.toBe(429);

    const stillLimited = await authPost(
      app,
      "/request-password-reset",
      { email: "unknown@example.test", redirectTo: "/reset-password" },
      undefined,
      {},
      strictAddress,
    );
    expect(stillLimited.statusCode).toBe(429);
  });

  it("applies the ordinary window to uncatalogued authentication paths", async () => {
    const app = startApplication();
    const remoteAddress = "127.0.0.7";
    const path = "/uncatalogued/nested-path";

    await app.database.insert(rateLimitTable).values({
      count: 100,
      id: "uncatalogued-path-rate-limit",
      key: `${remoteAddress}|${path}`,
      lastRequest: Date.now() - 61 * 1_000,
    });

    const response = await authPost(app, path, {}, undefined, {}, remoteAddress);
    expect(response.statusCode).not.toBe(429);

    const [counter] = await app.database
      .select()
      .from(rateLimitTable)
      .where(eq(rateLimitTable.key, `${remoteAddress}|${path}`));
    expect(counter?.count).toBe(1);
  });
});
