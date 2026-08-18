import {
  AdminAssistantRulesResponseSchema,
  ApiErrorSchema,
  ASSISTANT_RULES_HTTP_BODY_LIMIT_BYTES,
  AssistantRulesHistoryQuerySchema,
  AssistantRulesHistoryResponseSchema,
  AssistantRulesRevisionParamsSchema,
  MemberAssistantRulesResponseSchema,
  PreviewAssistantRulesRequestSchema,
  PreviewAssistantRulesResponseSchema,
  ResetAssistantRulesRequestSchema,
  RevertAssistantRulesRequestSchema,
  UpdateAssistantRulesRequestSchema,
} from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AssistantRulesChangedError,
  AssistantRulesConflictError,
  AssistantRulesNotFoundError,
} from "../assistant-rules/errors.js";
import { InvalidAssistantRulesError } from "../assistant-rules/prompt.js";
import type { AssistantRulesService } from "../assistant-rules/service.js";
import { ApplicationError } from "../errors.js";
import {
  type ActorResolver,
  type RequestActor,
  requireAdministratorRole,
  requireFreshAdministratorActor,
} from "../identity/authorization.js";
import { resolveMember } from "./member.js";

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  413: ApiErrorSchema,
  415: ApiErrorSchema,
  500: ApiErrorSchema,
} as const;

const assistantRulesCopy = {
  changed: "Las reglas cambiaron. Recarga la información e inténtalo de nuevo.",
  conflict: "Las reglas del asistente no pueden guardar esos cambios.",
  invalid: "El texto de las reglas no es válido.",
  notFound: "No se encontró la revisión solicitada.",
} as const;

async function resolveAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  resolveActor: ActorResolver,
  fresh: boolean,
): Promise<RequestActor> {
  const member = await resolveMember(request, reply, resolveActor);
  return fresh ? requireFreshAdministratorActor(member) : requireAdministratorRole(member);
}

function translateAssistantRulesError(error: unknown): never {
  if (error instanceof ApplicationError) {
    throw error;
  }
  if (error instanceof InvalidAssistantRulesError) {
    throw new ApplicationError(400, "BAD_REQUEST", assistantRulesCopy.invalid);
  }
  if (error instanceof AssistantRulesChangedError) {
    throw new ApplicationError(409, "ASSISTANT_RULES_CHANGED", assistantRulesCopy.changed);
  }
  if (error instanceof AssistantRulesNotFoundError) {
    throw new ApplicationError(404, "NOT_FOUND", assistantRulesCopy.notFound);
  }
  if (error instanceof AssistantRulesConflictError) {
    throw new ApplicationError(409, "ASSISTANT_RULES_CONFLICT", assistantRulesCopy.conflict);
  }
  throw error;
}

export function registerAssistantRulesRoutes(
  fastify: FastifyInstance,
  dependencies: {
    readonly assistantRules: AssistantRulesService;
    readonly resolveActor: ActorResolver;
  },
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    "/api/assistant-rules",
    {
      schema: {
        response: { 200: MemberAssistantRulesResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      try {
        return reply
          .code(200)
          .send(await dependencies.assistantRules.readMember(actor.workspace.id));
      } catch (error: unknown) {
        translateAssistantRulesError(error);
      }
    },
  );

  server.get(
    "/api/admin/assistant-rules",
    {
      schema: {
        response: { 200: AdminAssistantRulesResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      try {
        return reply
          .code(200)
          .send(await dependencies.assistantRules.readAdmin(actor.workspace.id));
      } catch (error: unknown) {
        translateAssistantRulesError(error);
      }
    },
  );

  server.post(
    "/api/admin/assistant-rules/preview",
    {
      bodyLimit: ASSISTANT_RULES_HTTP_BODY_LIMIT_BYTES,
      schema: {
        body: PreviewAssistantRulesRequestSchema,
        response: { 200: PreviewAssistantRulesResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.assistantRules.preview(
              actor.workspace.id,
              request.body.workspaceText,
            ),
          );
      } catch (error: unknown) {
        translateAssistantRulesError(error);
      }
    },
  );

  server.put(
    "/api/admin/assistant-rules",
    {
      bodyLimit: ASSISTANT_RULES_HTTP_BODY_LIMIT_BYTES,
      schema: {
        body: UpdateAssistantRulesRequestSchema,
        response: { 200: AdminAssistantRulesResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.assistantRules.save(
              actor.workspace.id,
              actor,
              request.body.observedRevision,
              request.body.workspaceText,
            ),
          );
      } catch (error: unknown) {
        translateAssistantRulesError(error);
      }
    },
  );

  server.post(
    "/api/admin/assistant-rules/reset",
    {
      bodyLimit: ASSISTANT_RULES_HTTP_BODY_LIMIT_BYTES,
      schema: {
        body: ResetAssistantRulesRequestSchema,
        response: { 200: AdminAssistantRulesResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.assistantRules.reset(
              actor.workspace.id,
              actor,
              request.body.observedRevision,
            ),
          );
      } catch (error: unknown) {
        translateAssistantRulesError(error);
      }
    },
  );

  server.get(
    "/api/admin/assistant-rules/revisions",
    {
      schema: {
        querystring: AssistantRulesHistoryQuerySchema,
        response: { 200: AssistantRulesHistoryResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, false);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.assistantRules.history(actor.workspace.id, request.query.cursor),
          );
      } catch (error: unknown) {
        translateAssistantRulesError(error);
      }
    },
  );

  server.post(
    "/api/admin/assistant-rules/revisions/:revision/revert",
    {
      bodyLimit: ASSISTANT_RULES_HTTP_BODY_LIMIT_BYTES,
      schema: {
        body: RevertAssistantRulesRequestSchema,
        params: AssistantRulesRevisionParamsSchema,
        response: { 200: AdminAssistantRulesResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor, true);
      try {
        return reply
          .code(200)
          .send(
            await dependencies.assistantRules.revert(
              actor.workspace.id,
              actor,
              request.params.revision,
              request.body.observedRevision,
            ),
          );
      } catch (error: unknown) {
        translateAssistantRulesError(error);
      }
    },
  );
}
