import {
  ApiErrorSchema,
  LivenessResponseSchema,
  ReadinessResponseSchema,
} from "@capstone/protocol";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";
import type { ApplicationLifecycle } from "../lifecycle.js";

export function registerHealthRoutes(
  fastify: FastifyInstance,
  lifecycle: ApplicationLifecycle,
  deploymentRevision: string,
): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    "/api/health/live",
    {
      schema: {
        response: {
          200: LivenessResponseSchema,
          500: ApiErrorSchema,
        },
      },
    },
    (_request, reply) => {
      void reply.header("x-capstone-revision", deploymentRevision);
      return { status: "live" } as const;
    },
  );

  server.get(
    "/api/health/ready",
    {
      schema: {
        response: {
          200: ReadinessResponseSchema,
          500: ApiErrorSchema,
          503: ReadinessResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      void reply.header("x-capstone-revision", deploymentRevision);
      const readiness = await lifecycle.checkReadiness();

      if (readiness.status === "unavailable") {
        return reply.code(503).send(readiness);
      }

      return reply.code(200).send(readiness);
    },
  );
}
