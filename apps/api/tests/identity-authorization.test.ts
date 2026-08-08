import { describe, expect, it } from "vitest";
import { ApplicationError } from "../src/errors.js";
import {
  type RequestActor,
  requireAdministratorActor,
  requireAdministratorRole,
  requireFreshAdministratorActor,
  requireMemberActor,
} from "../src/identity/authorization.js";
import { identitySecurity } from "../src/identity/security.js";

const now = new Date("2026-08-06T18:00:00.000Z");

function actor(role: "admin" | "member", createdAt = now): RequestActor {
  return {
    employee: {
      email: "empleada@capstone.example",
      id: "user-123",
      name: "Empleada Capstone",
    },
    role,
    session: {
      createdAt,
      expiresAt: new Date("2026-08-13T18:00:00.000Z"),
    },
    workspace: {
      id: "workspace-123",
      identity: "capstone",
      name: "Capstone",
    },
  };
}

function expectApplicationError(
  action: () => unknown,
  expected: { code: string; message: string; statusCode: number },
): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error("Expected an ApplicationError");
}

describe("identitySecurity", () => {
  it("locks the selected Phase 2 security tuning values", () => {
    expect(identitySecurity).toEqual({
      authBodyLimitBytes: 16_384,
      fakeMailboxRetention: 100,
      freshSessionSeconds: 900,
      rateLimitPersistenceWindowSeconds: 900,
      rateLimit: {
        ordinary: { max: 100, window: 60 },
        forgotPassword: { max: 3, window: 900 },
        resetPassword: { max: 5, window: 900 },
        signIn: { max: 5, window: 60 },
        verification: { max: 10, window: 60 },
        verificationResend: { max: 3, window: 900 },
      },
      sessionExpiresInSeconds: 604_800,
      sessionUpdateAgeSeconds: 86_400,
      trustedProxy: false,
    });
    expect(Object.isFrozen(identitySecurity)).toBe(true);
    expect(Object.isFrozen(identitySecurity.rateLimit)).toBe(true);
    expect(Object.values(identitySecurity.rateLimit).every((rule) => Object.isFrozen(rule))).toBe(
      true,
    );
  });
});

describe("requireMemberActor", () => {
  it("returns the resolved active member unchanged", () => {
    const member = actor("member");

    expect(requireMemberActor(member)).toBe(member);
  });

  it("requires authentication when no actor was resolved", () => {
    expectApplicationError(() => requireMemberActor(null), {
      code: "AUTHENTICATION_REQUIRED",
      message: "Inicia sesi\u00f3n para continuar.",
      statusCode: 401,
    });
  });
});

describe("requireAdministratorActor", () => {
  it("returns a fresh administrator unchanged", () => {
    const administrator = actor("admin", new Date(now.getTime() - 60_000));

    expect(requireAdministratorActor(administrator, now)).toBe(administrator);
  });

  it("accepts a session exactly at the freshness threshold", () => {
    const threshold = new Date(now.getTime() - identitySecurity.freshSessionSeconds * 1_000);
    const administrator = actor("admin", threshold);

    expect(requireAdministratorActor(administrator, now)).toBe(administrator);
  });

  it("preserves the authentication-required failure for a missing actor", () => {
    expectApplicationError(() => requireAdministratorActor(null, now), {
      code: "AUTHENTICATION_REQUIRED",
      message: "Inicia sesi\u00f3n para continuar.",
      statusCode: 401,
    });
  });

  it("denies a member without revealing an administrator-only distinction", () => {
    expectApplicationError(() => requireAdministratorActor(actor("member"), now), {
      code: "WORKSPACE_ACCESS_DENIED",
      message: "Tu cuenta no tiene acceso activo a este espacio de trabajo.",
      statusCode: 403,
    });
  });

  it("requires a fresh session from an administrator", () => {
    const stale = new Date(now.getTime() - identitySecurity.freshSessionSeconds * 1_000 - 1);

    expectApplicationError(() => requireAdministratorActor(actor("admin", stale), now), {
      code: "SESSION_REFRESH_REQUIRED",
      message: "Vuelve a iniciar sesi\u00f3n antes de realizar esta acci\u00f3n.",
      statusCode: 403,
    });
  });
});

describe("requireAdministratorRole", () => {
  it("allows an administrator without applying mutation freshness", () => {
    const stale = new Date(now.getTime() - identitySecurity.freshSessionSeconds * 1_000 - 1);
    const administrator = actor("admin", stale);

    expect(requireAdministratorRole(administrator)).toBe(administrator);
  });

  it("preserves the authentication-required failure for a missing actor", () => {
    expectApplicationError(() => requireAdministratorRole(null), {
      code: "AUTHENTICATION_REQUIRED",
      message: "Inicia sesi\u00f3n para continuar.",
      statusCode: 401,
    });
  });

  it("returns the explicit administrator-only failure to a member", () => {
    expectApplicationError(() => requireAdministratorRole(actor("member")), {
      code: "ADMIN_ACCESS_REQUIRED",
      message: "Necesitas permisos de administraci\u00f3n para continuar.",
      statusCode: 403,
    });
  });
});

describe("requireFreshAdministratorActor", () => {
  it("accepts an administrator exactly at the freshness threshold", () => {
    const threshold = new Date(now.getTime() - identitySecurity.freshSessionSeconds * 1_000);
    const administrator = actor("admin", threshold);

    expect(requireFreshAdministratorActor(administrator, now)).toBe(administrator);
  });

  it("requires a fresh session for administrator mutations", () => {
    const stale = new Date(now.getTime() - identitySecurity.freshSessionSeconds * 1_000 - 1);

    expectApplicationError(() => requireFreshAdministratorActor(actor("admin", stale), now), {
      code: "SESSION_REFRESH_REQUIRED",
      message: "Vuelve a iniciar sesi\u00f3n antes de realizar esta acci\u00f3n.",
      statusCode: 403,
    });
  });
});
