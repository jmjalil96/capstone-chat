import {
  AdminApproveEmployeeRequestSchema,
  AdminApproveEmployeeResponseSchema,
  AdminDeactivateEmployeeResponseSchema,
  AdminEmployeeListQuerySchema,
  AdminEmployeeListResponseSchema,
  AdminEmployeeParamsSchema,
  AdminEmployeeSoftBudgetRequestSchema,
  AdminEmployeeSoftBudgetResponseSchema,
  AdminEmptyRequestSchema,
  AdminInvitationResponseSchema,
  AdminSessionRevocationResponseSchema,
  AdminUsageQuerySchema,
  AdminUsageResponseSchema,
  ApiErrorSchema,
} from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Authentication } from "../auth/authentication.js";
import { createTrustedAuthHeaders, forwardAuthenticationCookies } from "../auth/request-headers.js";
import { ApplicationError } from "../errors.js";
import type { ActiveStreamRegistry } from "../generations/active-streams.js";
import type { GenerationAdministrationService } from "../generations/administration.js";
import type { EmployeeAdministrationService } from "../identity/administration.js";
import {
  EmployeeAdministrationConflictError,
  EmployeeAdministrationNotFoundError,
} from "../identity/administration.js";
import {
  type ActorResolver,
  type RequestActor,
  requireAdministratorRole,
  requireFreshAdministratorActor,
} from "../identity/authorization.js";
import type { EmailSender } from "../identity/email.js";
import { createInvitationEmail } from "../identity/email-templates.js";
import { IdentityConflictError, type IdentityService } from "../identity/service.js";
import { DecimalInputError } from "../model-policy/money.js";
import type { UsageService } from "../model-policy/usage-service.js";

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  415: ApiErrorSchema,
  500: ApiErrorSchema,
  503: ApiErrorSchema,
} as const;

const adminCopy = {
  approvalConflict: "La aprobación no puede cambiarse en su estado actual.",
  deactivationIncomplete:
    "El acceso quedó desactivado, pero falta completar la cancelación o el cierre de sesiones. Inténtalo de nuevo.",
  invitationFailed:
    "La aprobación quedó guardada, pero no se pudo enviar la invitación. Inténtalo de nuevo.",
  invalidBudget: "El presupuesto personal no es válido.",
  notFound: "No se encontró el empleado solicitado.",
  sessionRevocationFailed: "No se pudieron cerrar las sesiones. Inténtalo de nuevo.",
} as const;

async function resolveAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  resolveActor: ActorResolver,
  fresh: boolean,
): Promise<RequestActor> {
  void reply.header("cache-control", "no-store");
  const resolution = await resolveActor(createTrustedAuthHeaders(request));
  forwardAuthenticationCookies(resolution.authenticationHeaders, reply);
  return fresh
    ? requireFreshAdministratorActor(resolution.actor)
    : requireAdministratorRole(resolution.actor);
}

function translateEmployeeError(error: unknown): never {
  if (error instanceof EmployeeAdministrationNotFoundError) {
    throw new ApplicationError(404, "NOT_FOUND", adminCopy.notFound);
  }
  if (
    error instanceof EmployeeAdministrationConflictError ||
    error instanceof IdentityConflictError
  ) {
    throw new ApplicationError(409, "EMPLOYEE_APPROVAL_CONFLICT", adminCopy.approvalConflict);
  }
  if (error instanceof DecimalInputError) {
    throw new ApplicationError(400, "BAD_REQUEST", adminCopy.invalidBudget);
  }
  throw error;
}

export function registerAdminEmployeeRoutes(
  fastify: FastifyInstance,
  dependencies: {
    readonly authentication: Authentication;
    readonly employees: EmployeeAdministrationService;
    readonly emailSender: EmailSender;
    readonly generationAdministration: GenerationAdministrationService;
    readonly identity: IdentityService;
    readonly publicOrigin: string;
    readonly resolveActor: ActorResolver;
    readonly streamRegistry: ActiveStreamRegistry;
    readonly usage: UsageService;
  },
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();
  const sendInvitation = async (email: string): Promise<void> => {
    const signUpUrl = new URL("/sign-up", dependencies.publicOrigin).href;
    await dependencies.emailSender.send(createInvitationEmail(email, signUpUrl));
  };

  server.get(
    "/api/admin/employees",
    {
      schema: {
        querystring: AdminEmployeeListQuerySchema,
        response: { 200: AdminEmployeeListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      return reply
        .code(200)
        .send(await dependencies.employees.list(actor.workspace.id, request.query.cursor));
    },
  );

  server.post(
    "/api/admin/employees",
    {
      bodyLimit: 2_048,
      schema: {
        body: AdminApproveEmployeeRequestSchema,
        response: { 200: AdminApproveEmployeeResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        const approval = await dependencies.identity.approve({
          email: request.body.email,
          role: request.body.role,
          workspaceIdentity: actor.workspace.identity,
        });
        try {
          await sendInvitation(approval.normalizedEmail);
        } catch {
          throw new ApplicationError(503, "INVITATION_DELIVERY_FAILED", adminCopy.invitationFailed);
        }
        const employee = await dependencies.employees.get(actor.workspace.id, approval.approvalId);
        return reply.code(200).send({ employee, invitation: "sent", repeated: approval.repeated });
      } catch (error: unknown) {
        translateEmployeeError(error);
      }
    },
  );

  server.post(
    "/api/admin/employees/:approvalId/invitation",
    {
      bodyLimit: 1_024,
      schema: {
        body: AdminEmptyRequestSchema,
        params: AdminEmployeeParamsSchema,
        response: { 204: AdminInvitationResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        const target = await dependencies.employees.pendingInvitationTarget(
          actor.workspace.id,
          request.params.approvalId,
        );
        try {
          await sendInvitation(target.email);
        } catch {
          throw new ApplicationError(503, "INVITATION_DELIVERY_FAILED", adminCopy.invitationFailed);
        }
        return reply.code(204).send(null);
      } catch (error: unknown) {
        translateEmployeeError(error);
      }
    },
  );

  server.post(
    "/api/admin/employees/:approvalId/deactivate",
    {
      bodyLimit: 1_024,
      schema: {
        body: AdminEmptyRequestSchema,
        params: AdminEmployeeParamsSchema,
        response: { 200: AdminDeactivateEmployeeResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        const deactivated = await dependencies.employees.deactivate({
          actorUserId: actor.employee.id,
          approvalId: request.params.approvalId,
          workspaceId: actor.workspace.id,
        });
        if (deactivated.userId === null) {
          return reply.code(200).send({
            activeGenerationsCancelled: true,
            employee: deactivated.employee,
            repeated: deactivated.repeated,
            sessionsRevoked: true,
          });
        }
        const [generationCleanup, sessionCleanup] = await Promise.allSettled([
          dependencies.generationAdministration.cancelEmployeeWork(
            actor.workspace.id,
            deactivated.userId,
          ),
          dependencies.authentication.revokeUserSessions(deactivated.userId),
        ]);
        if (generationCleanup.status === "fulfilled") {
          for (const generationId of generationCleanup.value) {
            dependencies.streamRegistry.abort(generationId, "cancelled");
          }
        }
        if (generationCleanup.status === "rejected" || sessionCleanup.status === "rejected") {
          throw new ApplicationError(
            503,
            "EMPLOYEE_DEACTIVATION_INCOMPLETE",
            adminCopy.deactivationIncomplete,
          );
        }
        return reply.code(200).send({
          activeGenerationsCancelled: true,
          employee: deactivated.employee,
          repeated: deactivated.repeated,
          sessionsRevoked: true,
        });
      } catch (error: unknown) {
        translateEmployeeError(error);
      }
    },
  );

  server.post(
    "/api/admin/employees/:approvalId/sessions/revoke",
    {
      bodyLimit: 1_024,
      schema: {
        body: AdminEmptyRequestSchema,
        params: AdminEmployeeParamsSchema,
        response: { 204: AdminSessionRevocationResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        const employee = await dependencies.employees.get(
          actor.workspace.id,
          request.params.approvalId,
        );
        if (employee.status !== "active" || employee.userId === null) {
          throw new EmployeeAdministrationConflictError(
            "Only an activated employee can have sessions revoked",
          );
        }
        try {
          await dependencies.authentication.revokeUserSessions(employee.userId);
        } catch {
          throw new ApplicationError(
            503,
            "SESSION_REVOCATION_FAILED",
            adminCopy.sessionRevocationFailed,
          );
        }
        return reply.code(204).send(null);
      } catch (error: unknown) {
        translateEmployeeError(error);
      }
    },
  );

  server.put(
    "/api/admin/employees/:approvalId/soft-budget",
    {
      bodyLimit: 1_024,
      schema: {
        body: AdminEmployeeSoftBudgetRequestSchema,
        params: AdminEmployeeParamsSchema,
        response: { 200: AdminEmployeeSoftBudgetResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.employees.setSoftBudget(
              actor.workspace.id,
              request.params.approvalId,
              request.body.monthlySoftBudgetUsd,
            ),
          );
      } catch (error: unknown) {
        translateEmployeeError(error);
      }
    },
  );

  server.get(
    "/api/admin/usage",
    {
      schema: {
        querystring: AdminUsageQuerySchema,
        response: { 200: AdminUsageResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      return reply
        .code(200)
        .send(await dependencies.usage.currentMonth(actor.workspace.id, request.query.cursor));
    },
  );
}
