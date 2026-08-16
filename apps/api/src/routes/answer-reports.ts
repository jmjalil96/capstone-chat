import {
  AdminAnswerReportDetailSchema,
  AdminAnswerReportListQuerySchema,
  AdminAnswerReportListResponseSchema,
  AdminAnswerReportParamsSchema,
  AnswerReportParamsSchema,
  AnswerReportStateRequestSchema,
  AnswerReportStateResponseSchema,
  ApiErrorSchema,
  ConversationParamsSchema,
  CreateAnswerReportRequestSchema,
  CreateAnswerReportResponseSchema,
} from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createTrustedAuthHeaders, forwardAuthenticationCookies } from "../auth/request-headers.js";
import type { AnswerReportService } from "../conversations/answer-reports.js";
import {
  type ActorResolver,
  type RequestActor,
  requireAdministratorRole,
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

async function resolveAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
  resolveActor: ActorResolver,
): Promise<RequestActor> {
  void reply.header("cache-control", "no-store");
  const resolution = await resolveActor(createTrustedAuthHeaders(request));
  forwardAuthenticationCookies(resolution.authenticationHeaders, reply);
  return requireAdministratorRole(resolution.actor);
}

export function registerAnswerReportRoutes(
  fastify: FastifyInstance,
  dependencies: {
    readonly reports: AnswerReportService;
    readonly resolveActor: ActorResolver;
  },
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.post(
    "/api/conversations/:conversationId/messages/:messageId/report",
    {
      bodyLimit: 8_192,
      schema: {
        body: CreateAnswerReportRequestSchema,
        params: AnswerReportParamsSchema,
        response: { 200: CreateAnswerReportResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.reports.create(
            actor,
            request.params.conversationId,
            request.params.messageId,
            request.body,
          ),
        );
    },
  );

  server.post(
    "/api/conversations/:conversationId/answer-report-states",
    {
      bodyLimit: 4_096,
      schema: {
        body: AnswerReportStateRequestSchema,
        params: ConversationParamsSchema,
        response: { 200: AnswerReportStateResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.reports.reportedStates(
            actor,
            request.params.conversationId,
            request.body.messageIds,
          ),
        );
    },
  );

  server.get(
    "/api/admin/answer-reports",
    {
      schema: {
        querystring: AdminAnswerReportListQuerySchema,
        response: { 200: AdminAnswerReportListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.reports.listForWorkspace(actor.workspace.id, request.query.cursor),
        );
    },
  );

  server.get(
    "/api/admin/answer-reports/:reportId",
    {
      schema: {
        params: AdminAnswerReportParamsSchema,
        response: { 200: AdminAnswerReportDetailSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveAdministrator(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.reports.detailForWorkspace(
            actor.workspace.id,
            request.params.reportId,
          ),
        );
    },
  );
}
