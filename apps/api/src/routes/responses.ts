import {
  ApiErrorSchema,
  CancelGenerationParamsSchema,
  CancelGenerationRequestSchema,
  CancelGenerationResponseSchema,
  ConversationParamsSchema,
  CreateResponseRequestHeadersSchema,
  CreateResponseRequestSchema,
  DeleteConversationRequestSchema,
  DeleteConversationResponseSchema,
  IdempotencyKeySchema,
  ResponseStateRequestSchema,
  ResponseStateResponseSchema,
} from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApplicationError } from "../errors.js";
import type { ActiveStreamRegistry } from "../generations/active-streams.js";
import type { ResponseStreamCoordinator } from "../generations/response-stream.js";
import type { GenerationService } from "../generations/service.js";
import { generationTuning } from "../generations/settings.js";
import type { ActorResolver } from "../identity/authorization.js";
import { resolveMember } from "./member.js";

const ordinaryErrorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  406: ApiErrorSchema,
  409: ApiErrorSchema,
  413: ApiErrorSchema,
  415: ApiErrorSchema,
  500: ApiErrorSchema,
  503: ApiErrorSchema,
} as const;

const idempotencyPattern = (IdempotencyKeySchema as { readonly pattern?: unknown }).pattern;
if (typeof idempotencyPattern !== "string") {
  throw new Error("IdempotencyKeySchema must define its canonical pattern");
}
const canonicalIdempotencyKey = new RegExp(idempotencyPattern, "u");

function responseHeaders(request: FastifyRequest): { readonly idempotencyKey: string } {
  const idempotencyKey = request.headers["idempotency-key"];
  if (idempotencyKey === undefined) {
    throw new ApplicationError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "La solicitud necesita una clave de idempotencia.",
    );
  }
  if (typeof idempotencyKey !== "string" || !canonicalIdempotencyKey.test(idempotencyKey)) {
    throw new ApplicationError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "La clave de idempotencia no es válida.",
    );
  }
  if (request.headers.accept !== "application/x-ndjson") {
    throw new ApplicationError(406, "BAD_REQUEST", "Esta operación requiere respuestas NDJSON.");
  }
  return { idempotencyKey };
}

export function registerResponseRoutes(
  fastify: FastifyInstance,
  dependencies: {
    readonly generations: GenerationService;
    readonly registry: ActiveStreamRegistry;
    readonly resolveActor: ActorResolver;
    readonly streams: ResponseStreamCoordinator;
  },
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.post(
    "/api/conversations/:conversationId/responses",
    {
      bodyLimit: generationTuning.requestBodyBytes,
      preValidation: (request, _reply, done) => {
        try {
          responseHeaders(request);
          done();
        } catch (error: unknown) {
          done(error as Error);
        }
      },
      schema: {
        body: CreateResponseRequestSchema,
        headers: CreateResponseRequestHeadersSchema,
        params: ConversationParamsSchema,
        response: ordinaryErrorResponses,
      },
    },
    async (request, reply) => {
      if (!dependencies.registry.isAccepting) {
        throw new ApplicationError(503, "INTERNAL_ERROR", "El servicio se está reiniciando.");
      }
      const headers = responseHeaders(request);
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      const started = await dependencies.generations.startResponse(
        actor,
        request.params.conversationId,
        headers.idempotencyKey,
        request.body,
      );
      await dependencies.streams.stream(started, request, reply);
    },
  );

  server.post(
    "/api/conversations/:conversationId/responses/:generationId/cancel",
    {
      bodyLimit: 1_024,
      schema: {
        body: CancelGenerationRequestSchema,
        params: CancelGenerationParamsSchema,
        response: { 204: CancelGenerationResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      const localCapture: {
        current: ReturnType<ActiveStreamRegistry["captureCancellation"]>;
      } = { current: undefined };
      try {
        await dependencies.generations.cancel(
          actor,
          request.params.conversationId,
          request.params.generationId,
          () => {
            localCapture.current = dependencies.registry.captureCancellation(
              request.params.generationId,
            );
            return localCapture.current?.snapshot;
          },
        );
        localCapture.current?.commit();
        dependencies.registry.abort(request.params.generationId, "cancelled");
      } catch (error: unknown) {
        localCapture.current?.release();
        throw error;
      }
      return reply.code(204).send(null);
    },
  );

  server.post(
    "/api/conversations/:conversationId/response-states",
    {
      bodyLimit: 4_096,
      schema: {
        body: ResponseStateRequestSchema,
        params: ConversationParamsSchema,
        response: { 200: ResponseStateResponseSchema, ...ordinaryErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = await resolveMember(request, reply, dependencies.resolveActor);
      return reply
        .code(200)
        .send(
          await dependencies.generations.responseStates(
            actor,
            request.params.conversationId,
            request.body.messageIds,
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
      const cancelledGenerationId = await dependencies.generations.removeConversation(
        actor,
        request.params.conversationId,
        request.body.observedRevision,
      );
      if (cancelledGenerationId !== null) {
        dependencies.registry.abort(cancelledGenerationId, "deleted");
      }
      return reply.code(204).send(null);
    },
  );
}
