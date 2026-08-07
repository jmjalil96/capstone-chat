import {
  ApiErrorSchema,
  ArchiveConversationRequestSchema,
  ArchiveConversationResponseSchema,
  ConversationDetailQuerySchema,
  ConversationDetailResponseSchema,
  ConversationListQuerySchema,
  ConversationListResponseSchema,
  ConversationParamsSchema,
  ConversationSearchRequestSchema,
  ConversationSearchResponseSchema,
  ConversationSelectionResponseSchema,
  CreateConversationRequestSchema,
  CreateConversationResponseSchema,
  DeleteConversationRequestSchema,
  DeleteConversationResponseSchema,
  DraftStateSchema,
  RenameConversationRequestSchema,
  RenameConversationResponseSchema,
  SaveDraftRequestSchema,
  SelectConversationLeafRequestSchema,
  UnarchiveConversationRequestSchema,
  UnarchiveConversationResponseSchema,
} from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createTrustedAuthHeaders, forwardAuthenticationCookies } from "../auth/request-headers.js";
import type { ConversationService } from "../conversations/service.js";
import { conversationCoreTuning } from "../conversations/settings.js";
import {
  type ActorResolver,
  type RequestActor,
  requireMemberActor,
} from "../identity/authorization.js";

const ordinaryErrorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  413: ApiErrorSchema,
  415: ApiErrorSchema,
  500: ApiErrorSchema,
} as const;

async function resolveMember(
  request: FastifyRequest,
  reply: FastifyReply,
  resolveActor: ActorResolver,
): Promise<RequestActor> {
  void reply.header("cache-control", "no-store");
  const resolution = await resolveActor(createTrustedAuthHeaders(request));
  forwardAuthenticationCookies(resolution.authenticationHeaders, reply);
  return requireMemberActor(resolution.actor);
}

export function registerConversationRoutes(
  fastify: FastifyInstance,
  dependencies: {
    readonly conversations: ConversationService;
    readonly resolveActor: ActorResolver;
  },
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    "/api/conversations",
    {
      schema: {
        querystring: ConversationListQuerySchema,
        response: { 200: ConversationListResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.list(actor, request.query.view, request.query.cursor),
        );
    },
  );

  server.post(
    "/api/conversations",
    {
      bodyLimit: 1_024,
      schema: {
        body: CreateConversationRequestSchema,
        response: { 201: CreateConversationResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply.code(201).send(await dependencies.conversations.create(actor));
    },
  );

  server.post(
    "/api/conversations/search",
    {
      bodyLimit: 4_096,
      schema: {
        body: ConversationSearchRequestSchema,
        response: { 200: ConversationSearchResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.search(actor, request.body.query, request.body.cursor),
        );
    },
  );

  server.get(
    "/api/drafts/new",
    { schema: { response: { 200: DraftStateSchema, ...ordinaryErrorResponses } } },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(await dependencies.conversations.getDraft(actor, { kind: "new" }));
    },
  );

  server.put(
    "/api/drafts/new",
    {
      bodyLimit: conversationCoreTuning.draftRequestBodyBytes,
      schema: {
        body: SaveDraftRequestSchema,
        response: { 200: DraftStateSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.saveDraft(
            actor,
            { kind: "new" },
            request.body.content,
            request.body.observedRevision,
          ),
        );
    },
  );

  server.get(
    "/api/conversations/:conversationId",
    {
      schema: {
        params: ConversationParamsSchema,
        querystring: ConversationDetailQuerySchema,
        response: { 200: ConversationDetailResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.get(
            actor,
            request.params.conversationId,
            request.query.cursor,
          ),
        );
    },
  );

  server.patch(
    "/api/conversations/:conversationId/title",
    {
      bodyLimit: 2_048,
      schema: {
        body: RenameConversationRequestSchema,
        params: ConversationParamsSchema,
        response: { 200: RenameConversationResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.rename(
            actor,
            request.params.conversationId,
            request.body.title,
            request.body.observedRevision,
          ),
        );
    },
  );

  server.put(
    "/api/conversations/:conversationId/selection",
    {
      bodyLimit: 2_048,
      schema: {
        body: SelectConversationLeafRequestSchema,
        params: ConversationParamsSchema,
        response: { 200: ConversationSelectionResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.selectLeaf(
            actor,
            request.params.conversationId,
            request.body.leafMessageId,
            request.body.observedRevision,
          ),
        );
    },
  );

  server.post(
    "/api/conversations/:conversationId/archive",
    {
      bodyLimit: 1_024,
      schema: {
        body: ArchiveConversationRequestSchema,
        params: ConversationParamsSchema,
        response: { 200: ArchiveConversationResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.setArchived(
            actor,
            request.params.conversationId,
            true,
            request.body.observedRevision,
          ),
        );
    },
  );

  server.post(
    "/api/conversations/:conversationId/unarchive",
    {
      bodyLimit: 1_024,
      schema: {
        body: UnarchiveConversationRequestSchema,
        params: ConversationParamsSchema,
        response: { 200: UnarchiveConversationResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.setArchived(
            actor,
            request.params.conversationId,
            false,
            request.body.observedRevision,
          ),
        );
    },
  );

  server.delete(
    "/api/conversations/:conversationId",
    {
      bodyLimit: 1_024,
      schema: {
        body: DeleteConversationRequestSchema,
        params: ConversationParamsSchema,
        response: { 204: DeleteConversationResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      await dependencies.conversations.remove(
        actor,
        request.params.conversationId,
        request.body.observedRevision,
      );
      return reply.code(204).send(null);
    },
  );

  server.get(
    "/api/conversations/:conversationId/draft",
    {
      schema: {
        params: ConversationParamsSchema,
        response: { 200: DraftStateSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply.code(200).send(
        await dependencies.conversations.getDraft(actor, {
          conversationId: request.params.conversationId,
          kind: "conversation",
        }),
      );
    },
  );

  server.put(
    "/api/conversations/:conversationId/draft",
    {
      bodyLimit: conversationCoreTuning.draftRequestBodyBytes,
      schema: {
        body: SaveDraftRequestSchema,
        params: ConversationParamsSchema,
        response: { 200: DraftStateSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.conversations.saveDraft(
            actor,
            { conversationId: request.params.conversationId, kind: "conversation" },
            request.body.content,
            request.body.observedRevision,
          ),
        );
    },
  );
}
