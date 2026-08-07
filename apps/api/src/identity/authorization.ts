import type { Authentication } from "../auth/authentication.js";
import { ApplicationError } from "../errors.js";
import { identitySecurity } from "./security.js";
import type { IdentityService, WorkspaceRole } from "./service.js";

const authorizationCopy = {
  authenticationRequired: "Inicia sesión para continuar.",
  freshSessionRequired: "Vuelve a iniciar sesión antes de realizar esta acción.",
  workspaceAccessDenied: "Tu cuenta no tiene acceso activo a este espacio de trabajo.",
} as const;

export interface RequestActor {
  readonly employee: {
    readonly email: string;
    readonly id: string;
    readonly name: string;
  };
  readonly role: WorkspaceRole;
  readonly session: {
    readonly createdAt: Date;
    readonly expiresAt: Date;
  };
  readonly workspace: {
    readonly id: string;
    readonly identity: string;
    readonly name: string;
  };
}

export interface ActorResolution {
  readonly actor: RequestActor | null;
  readonly authenticationHeaders: Headers;
}

export function requireMemberActor(actor: RequestActor | null): RequestActor {
  if (actor === null) {
    throw new ApplicationError(
      401,
      "AUTHENTICATION_REQUIRED",
      authorizationCopy.authenticationRequired,
    );
  }

  return actor;
}

export function requireAdministratorActor(
  actor: RequestActor | null,
  now = new Date(),
): RequestActor {
  const member = requireMemberActor(actor);

  if (member.role !== "admin") {
    throw new ApplicationError(
      403,
      "WORKSPACE_ACCESS_DENIED",
      authorizationCopy.workspaceAccessDenied,
    );
  }

  const freshAfter = now.getTime() - identitySecurity.freshSessionSeconds * 1_000;
  if (member.session.createdAt.getTime() < freshAfter) {
    throw new ApplicationError(
      403,
      "SESSION_REFRESH_REQUIRED",
      authorizationCopy.freshSessionRequired,
    );
  }

  return member;
}

export function createActorResolver(authentication: Authentication, identity: IdentityService) {
  return async function resolveActor(headers: Headers): Promise<ActorResolution> {
    const authenticationResult = await authentication.auth.api.getSession({
      headers,
      returnHeaders: true,
    });
    const authSession = authenticationResult.response;
    if (authSession === null) {
      return Object.freeze({
        actor: null,
        authenticationHeaders: authenticationResult.headers,
      });
    }

    const memberships = await identity.findActiveMemberships({
      email: authSession.user.email,
      emailVerified: authSession.user.emailVerified,
      id: authSession.user.id,
    });
    const membership = memberships[0];
    if (membership === undefined || memberships.length !== 1) {
      throw new ApplicationError(
        403,
        "WORKSPACE_ACCESS_DENIED",
        authorizationCopy.workspaceAccessDenied,
      );
    }

    return Object.freeze({
      actor: Object.freeze({
        employee: Object.freeze({
          email: authSession.user.email,
          id: authSession.user.id,
          name: authSession.user.name,
        }),
        role: membership.role,
        session: Object.freeze({
          createdAt: new Date(authSession.session.createdAt),
          expiresAt: new Date(authSession.session.expiresAt),
        }),
        workspace: Object.freeze({
          id: membership.workspaceId,
          identity: membership.workspaceIdentity,
          name: membership.workspaceDisplayName,
        }),
      }),
      authenticationHeaders: authenticationResult.headers,
    });
  };
}

export type ActorResolver = ReturnType<typeof createActorResolver>;
