import { ApiErrorSchema, SessionResponseSchema } from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import { createTrustedAuthHeaders, forwardAuthenticationCookies } from "../auth/request-headers.js";
import { type ActorResolver, requireMemberActor } from "../identity/authorization.js";

export function registerSessionRoute(fastify: FastifyInstance, resolveActor: ActorResolver): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    "/api/session",
    {
      schema: {
        response: {
          200: SessionResponseSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      void reply.header("cache-control", "no-store");
      const resolution = await resolveActor(createTrustedAuthHeaders(request));
      forwardAuthenticationCookies(resolution.authenticationHeaders, reply);
      const actor = requireMemberActor(resolution.actor);

      return reply.code(200).send({
        employee: actor.employee,
        session: {
          createdAt: actor.session.createdAt.toISOString(),
          expiresAt: actor.session.expiresAt.toISOString(),
        },
        workspace: {
          id: actor.workspace.id,
          identity: actor.workspace.identity,
          name: actor.workspace.name,
          role: actor.role,
        },
      });
    },
  );
}
